import type { ExecutionFrame } from "./agent.js";
import { TesseractError, errorInfo, fail } from "./errors.js";
import { immutable, type Clock, type IdGenerator } from "./json.js";
import { AgentEvents, type ToolPreparation } from "./events/catalog.js";
import type { AnyEvent, PayloadOf, ResultOf } from "./events/definition.js";
import { MessageCodec } from "./messages/codec.js";
import { ToolMessage, type MessageData } from "./messages/message.js";
import type {
  ModelProviderRegistration,
  ModelResponse,
  ToolDescription,
} from "./models/contract.js";
import type { CheckpointCause, RecordEntry } from "./state/schema.js";
import type {
  ModelAttemptRecord,
  ToolExecutionRecord,
  TurnRecord,
} from "./trace/records.js";
import { aggregateUsage, normalizeUsage } from "./trace/usage.js";
import { toolResult, type Tool } from "./tools/tool.js";
import { ContextAssembler } from "./engine/context.js";
import { executeTool } from "./engine/tool-executor.js";
import { Suspension } from "./engine/interrupt.js";
import { providerCall, streamModel } from "./models/stream.js";
import type { TrackedServices } from "./engine/tracked-effects.js";

type LoopContext = {
  ids: IdGenerator;
  clock: Clock;
  hook<D extends AnyEvent>(
    frame: ExecutionFrame,
    definition: D,
    payload: PayloadOf<D>,
  ): Promise<ResultOf<D>>;
  put(
    frame: ExecutionFrame,
    kind: RecordEntry["kind"],
    data: RecordEntry["data"],
  ): void;
  rows<T>(frame: ExecutionFrame, kind: RecordEntry["kind"]): T[];
  commit(frame: ExecutionFrame, cause: CheckpointCause): Promise<void>;
  updateUsage(frame: ExecutionFrame): Promise<void>;
  appendMessage(frame: ExecutionFrame, message: MessageData): Promise<void>;
  services(frame: ExecutionFrame, toolExecutionId?: string): TrackedServices;
  finish(
    frame: ExecutionFrame,
    status: "completed" | "stopped",
    reason: string | null,
  ): Promise<void>;
};

// Shared by new input, resume and recovery; checkpoints retain the next phase.
export async function loop(
  frame: ExecutionFrame,
  context: LoopContext,
): Promise<void> {
  while (true) {
    if (frame.sink.controller.signal.aborted)
      throw new TesseractError("Cancelled", "Execution cancelled");
    const position = frame.cp.execution!;
    if (position.phase === "BeforeTurn") {
      if (position.budgets.turns >= position.budgets.limits.maxTurns) {
        await context.finish(frame, "stopped", "MaxTurns");
        return;
      }
      const turn: TurnRecord = {
        id: context.ids.next("turn"),
        streamId: frame.stream.id,
        scope: frame.cp.state.scope,
        index: position.budgets.turns++,
        contextRevision: frame.cp.revision,
        assistantMessageId: null,
        status: "running",
        stopReason: null,
        startedAt: context.clock.now(),
        endedAt: null,
        durationMs: null,
        error: null,
        usage: aggregateUsage([]),
      };
      context.put(frame, "turns", turn);
      position.turnId = turn.id;
      position.phase = "BeforeModel";
      await context.commit(frame, "ExecutionTransition");
      await context.hook(frame, AgentEvents.TurnStart, {
        turnId: turn.id,
        index: turn.index,
      });
      continue;
    }
    if (position.phase === "BeforeModel") {
      if (!(await callModel(frame, context))) return;
      continue;
    }
    if (position.phase === "BeforeTool") {
      await callTool(frame, context);
      if (frame.stream.endedAt) return;
      continue;
    }
    if (position.phase === "TurnBoundary") {
      const turn = context
        .rows<TurnRecord>(frame, "turns")
        .find((t) => t.id === position.turnId)!;
      turn.status = "completed";
      turn.endedAt = context.clock.now();
      turn.durationMs = Date.parse(turn.endedAt) - Date.parse(turn.startedAt);
      await context.updateUsage(frame);
      await context.commit(frame, "ExecutionTransition");
      await context.hook(frame, AgentEvents.TurnEnd, {
        turnId: turn.id,
        usage: turn.usage,
      });
      const hadTools = !!frame.cp.state.messages
        .find((m) => m.id === turn.assistantMessageId)
        ?.content.some((p) => p.type === "tool-call");
      const decision = await context.hook(frame, AgentEvents.TurnDecision, {
        turnId: turn.id,
        hadTools,
      });
      if (decision?.decision === "stop" || decision?.decision === "deny") {
        await context.finish(
          frame,
          "stopped",
          decision.reason ?? "PolicyStopped",
        );
        return;
      }
      if (!hadTools && decision?.decision !== "continue") {
        await context.finish(frame, "completed", null);
        return;
      }
      position.phase = "BeforeTurn";
      await context.commit(frame, "ExecutionTransition");
      continue;
    }
    fail("RecoveryRequired", "Execution is at a pending operation boundary");
  }
}
async function callModel(
  frame: ExecutionFrame,
  context: LoopContext,
): Promise<boolean> {
  const position = frame.cp.execution!,
    budgets = position.budgets;
  if (budgets.modelAttempts >= budgets.limits.maxModelAttempts) {
    await context.finish(frame, "stopped", "MaxModelAttempts");
    return false;
  }
  const selection = await context.hook(frame, AgentEvents.ModelSelect, {
    model: position.modelRef,
  });
  if (selection?.decision === "select") position.modelRef = selection.model;
  const provider = frame.registry.find<ModelProviderRegistration>(
    "provider",
    position.modelRef.providerId,
  );
  if (!provider) fail("MissingProvider", "Model provider is not registered");
  const adapter = providerCall(position.modelRef, () => provider.create(position.modelRef.modelId));
  const tools = frame.registry.list<Tool>("tool"),
    descriptions: ToolDescription[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input.jsonSchema,
    }));
  const selected = await context.hook(
    frame,
    AgentEvents.ToolsSelect,
    immutable(descriptions),
  );
  if (selected.some((t) => !tools.some((tool) => tool.name === t.name)))
    fail("UnknownTool", "Tool selection includes unregistered tool");
  let request = new ContextAssembler().build(
    frame.cp,
    position.baseInstructions,
    selected,
    position.modelRef,
  );
  request = await context.hook(frame, AgentEvents.ContextPrepare, request);
  request = await context.hook(
    frame,
    AgentEvents.ModelRequest,
    immutable(request),
  );
  if (
    request.model.providerId !== position.modelRef.providerId ||
    request.model.modelId !== position.modelRef.modelId
  )
    fail(
      "ModelContextIncompatible",
      "Request transform must not bypass ModelSelect",
    );
  providerCall(position.modelRef, () => adapter.validate(request));
  const attempt: ModelAttemptRecord = {
    id: context.ids.next("attempt"),
    turnId: position.turnId!,
    streamId: frame.stream.id,
    scope: frame.cp.state.scope,
    callId: context.ids.next("call"),
    attemptIndex: 0,
    purpose: "primary",
    parentToolExecutionId: null,
    providerId: position.modelRef.providerId,
    modelId: position.modelRef.modelId,
    providerRequestId: null,
    responseMessageId: null,
    contextRevision: frame.cp.revision,
    requestSnapshotRef: null,
    startedAt: context.clock.now(),
    firstOutputAt: null,
    endedAt: null,
    durationMs: null,
    timeToFirstOutputMs: null,
    status: "running",
    finishReason: null,
    error: null,
    usage: normalizeUsage({}),
  };
  const priorAttempts = context
    .rows<ModelAttemptRecord>(frame, "model_attempts")
    .filter((a) => a.turnId === position.turnId && a.purpose === "primary");
  if (priorAttempts.length) {
    attempt.callId = priorAttempts[0]!.callId;
    attempt.attemptIndex = priorAttempts.length;
  }
  context.put(frame, "model_attempts", attempt);
  budgets.modelAttempts++;
  position.phase = "ModelPending";
  await context.commit(frame, "ExecutionTransition");
  await context.hook(frame, AgentEvents.ModelStart, {
    attemptId: attempt.id,
    model: position.modelRef,
  });
  let response: ModelResponse | undefined;
  try {
    for await (const chunk of streamModel(adapter, immutable(request), {
      signal: frame.sink.controller.signal,
    })) {
      if (chunk.type === "message-delta") {
        if (!attempt.firstOutputAt) attempt.firstOutputAt = context.clock.now();
        await context.hook(frame, AgentEvents.MessageDelta, {
          ...chunk,
          attemptId: attempt.id,
        });
      }
      if (chunk.type === "usage") {
        attempt.usage = chunk.usage;
        await context.hook(frame, AgentEvents.ModelUsage, {
          attemptId: attempt.id,
          usage: chunk.usage,
        });
      }
      if (chunk.type === "response") response = chunk.response;
    }
    if (!response)
      fail("ProviderError", "Model stream ended without complete response");
    response = await context.hook(frame, AgentEvents.ModelResponse, response);
    if (response.message.role !== "assistant")
      fail("InvalidMessage", "Model response must be assistant");
    attempt.usage = response.usage ?? attempt.usage;
    attempt.status = "succeeded";
    attempt.endedAt = context.clock.now();
    attempt.finishReason = response.finishReason ?? null;
    attempt.providerRequestId = response.providerRequestId ?? null;
    attempt.responseMessageId = response.message.id;
    const turn = context
      .rows<TurnRecord>(frame, "turns")
      .find((t) => t.id === position.turnId)!;
    turn.assistantMessageId = response.message.id;
    const pending: ToolExecutionRecord[] = [];
    for (const part of response.message.content)
      if (part.type === "tool-call")
        pending.push({
          id: context.ids.next("tool"),
          turnId: turn.id,
          streamId: frame.stream.id,
          scope: frame.cp.state.scope,
          toolCallId: part.toolCallId,
          parentToolExecutionId: null,
          toolName: part.name,
          arguments: part.arguments,
          policyDecision: null,
          status: "pending",
          startedAt: null,
          endedAt: null,
          durationMs: null,
          resultMessageId: null,
          resultRef: null,
          result: null,
          error: null,
          idempotencyKey: null,
        });
    for (const record of pending) context.put(frame, "tool_executions", record);
    frame.cp.execution!.pendingToolExecutionIds = pending.map((t) => t.id);
    frame.cp.execution!.phase = pending.length ? "BeforeTool" : "TurnBoundary";
    await context.appendMessage(frame, response.message);
    await context.hook(frame, AgentEvents.ModelEnd, {
      attemptId: attempt.id,
      response,
    });
    return true;
  } catch (error) {
    if (attempt.status === "succeeded") throw error;
    attempt.status = frame.sink.controller.signal.aborted
      ? "cancelled"
      : "failed";
    attempt.error = errorInfo(error);
    attempt.endedAt = context.clock.now();
    await context.commit(frame, "ExecutionTransition");
    await context.hook(frame, AgentEvents.ModelError, {
      attemptId: attempt.id,
      error: attempt.error,
    });
    const recovery = await context.hook(frame, AgentEvents.ModelRecover, {
      attemptId: attempt.id,
      error: attempt.error,
    });
    if (
      recovery?.decision === "retry" &&
      !frame.sink.controller.signal.aborted
    ) {
      frame.cp.execution!.phase = "BeforeModel";
      await context.commit(frame, "ExecutionTransition");
      return true;
    }
    throw error;
  }
}
async function callTool(
  frame: ExecutionFrame,
  context: LoopContext,
): Promise<void> {
  const position = frame.cp.execution!,
    id = position.pendingToolExecutionIds[0];
  if (!id) {
    position.phase = "TurnBoundary";
    return;
  }
  const record = context
    .rows<ToolExecutionRecord>(frame, "tool_executions")
    .find((t) => t.id === id)!;
  if (position.budgets.toolCalls >= position.budgets.limits.maxToolCalls) {
    await context.finish(frame, "stopped", "MaxToolCalls");
    return;
  }
  const tool = frame.registry.find<Tool>("tool", record.toolName);
  let result;
  try {
    if (!tool) fail("UnknownTool", "No registered tool executor");
    const saved =
      position.handlerCursor?.eventId === AgentEvents.BeforeTool
        ? position.handlerCursor.payload
        : null;
    const prepared = (saved ??
      (record.policyDecision?.decision === "allowed"
        ? {
            tool: {
              name: tool.name,
              description: tool.description,
              inputSchema: tool.input.jsonSchema,
            },
            toolExecutionId: id,
            toolCallId: record.toolCallId,
            arguments: record.arguments,
          }
        : await context.hook(frame, AgentEvents.ToolPrepare, {
            tool: {
              name: tool.name,
              description: tool.description,
              inputSchema: tool.input.jsonSchema,
            },
            toolExecutionId: id,
            toolCallId: record.toolCallId,
            arguments: record.arguments,
          }))) as ToolPreparation;
    record.arguments = immutable(prepared.arguments);
    tool.input.parse(record.arguments);
    const decision =
      record.policyDecision?.decision === "allowed"
        ? { decision: "allow" as const }
        : await context.hook(
            frame,
            AgentEvents.BeforeTool,
            immutable(prepared),
          );
    if (decision?.decision === "stop") {
      await context.finish(
        frame,
        "stopped",
        decision.reason ?? "PolicyStopped",
      );
      return;
    }
    record.policyDecision = {
      decision: decision?.decision === "deny" ? "denied" : "allowed",
      ...(decision?.decision === "deny" && decision.reason
        ? { reason: decision.reason }
        : {}),
    };
    if (decision?.decision === "deny") {
      record.status = "denied";
      result = toolResult(decision.reason ?? "Tool denied");
    } else {
      record.status = "running";
      record.startedAt = context.clock.now();
      record.idempotencyKey =
        tool.recovery?.idempotencyKey(tool.input.parse(record.arguments), {
          toolExecutionId: record.id,
        }) ?? null;
      position.budgets.toolCalls++;
      position.phase = "ToolPending";
      await context.commit(frame, "ExecutionTransition");
      await context.hook(frame, AgentEvents.ToolStart, {
        toolExecutionId: id,
        toolCallId: record.toolCallId,
      });
      frame.currentToolExecutionId = id;
      result = await executeTool(tool, record.arguments, {
        ...context.services(frame, id),
        signal: frame.sink.controller.signal,
        threadId: frame.cp.threadId,
        streamId: frame.stream.id,
        turnId: record.turnId,
        toolExecutionId: id,
        emit: (progress) => {
          void context.hook(frame, AgentEvents.ToolUpdate, {
            toolExecutionId: id,
            progress,
          });
        },
      });
      frame.currentToolExecutionId = undefined;
      record.status = "succeeded";
    }
  } catch (error) {
    if (error instanceof Suspension) throw error;
    if (errorInfo(error).code === "RecoveryRequired") {
      record.status = "interrupted";
      frame.stream.status = "interrupted";
      await context.commit(frame, "ExecutionTransition");
      throw error;
    }
    if (
      [
        "StorageUnavailable",
        "CommitConflict",
        "OwnershipLost",
        "PluginError",
      ].includes(errorInfo(error).code) ||
      ["plugin", "storage", "provider"].includes(errorInfo(error).source)
    )
      throw error;
    record.status = "failed";
    record.error = errorInfo(error, { source: "tool", toolName: record.toolName });
    result = toolResult("Tool failed: " + record.error.message);
    await context.hook(frame, AgentEvents.ToolError, {
      toolExecutionId: id,
      error: record.error,
    });
  }
  result = await context.hook(frame, AgentEvents.ToolResult, result);
  record.result = result;
  record.endedAt = context.clock.now();
  const message = MessageCodec.encode(
    new ToolMessage({
      toolCallId: record.toolCallId,
      content: result.content,
      metadata: result.metadata,
    }),
  );
  record.resultMessageId = message.id;
  frame.cp.execution!.pendingToolExecutionIds =
    frame.cp.execution!.pendingToolExecutionIds.filter((value) => value !== id);
  frame.cp.execution!.phase = frame.cp.execution!.pendingToolExecutionIds.length
    ? "BeforeTool"
    : "TurnBoundary";
  await context.appendMessage(frame, message);
  await context.hook(frame, AgentEvents.ToolEnd, {
    toolExecutionId: id,
    toolCallId: record.toolCallId,
    result,
    status: record.status,
  });
}
