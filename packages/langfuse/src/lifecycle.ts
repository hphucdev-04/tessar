import {
  input,
  model,
  stream,
  turn,
  message,
  type PluginContext,
} from "@tessar/core";
import { time, update, type TraceRuntime } from "./trace.js";
import type { ThreadTraceState } from "./types.js";

/** Persists Thread links and observes input, turn, stream and resume lifecycles. */
export function registerLifecycleHooks(
  tessar: PluginContext,
  tracing: TraceRuntime,
): void {
  const { executions, links, begin, current, parentTurn, finish } = tracing;
  const savedTrace = tessar.state.define<ThreadTraceState>({
    namespace: "trace",
    schemaVersion: 1,
    initial: {
      rootCreated: false,
      turnCount: 0,
      turnId: "",
      turnCreated: false,
    },
    fork: "reset",
  });
  tessar.hook(input.prepare, (event, context) => {
    if (!event.sessionId || !event.streamId) return;
    const saved = context.state.get(savedTrace);
    links.set(event.streamId, {
      ...saved,
      rootNew: !saved.rootCreated,
      turnNew: false,
    });
    if (!saved.rootCreated)
      context.state.update(savedTrace, { ...saved, rootCreated: true });
  });
  tessar.hook(model.select, (event, context) => {
    if (!event.sessionId || typeof context.turnId !== "string") return;
    const link = links.get(context.streamId);
    if (!link) return;
    const saved = context.state.get(savedTrace),
      fresh = saved.turnId !== context.turnId;
    const value = {
      ...saved,
      rootCreated: true,
      turnId: context.turnId,
      turnCount: saved.turnCount + (fresh ? 1 : 0),
      turnCreated: true,
    };
    context.state.update(savedTrace, value);
    Object.assign(link, value, { turnNew: fresh || !saved.turnCreated });
  });
  tessar.defer(async () => {
    for (const streamId of [...executions.keys()])
      finish({ streamId }, "interrupted");
    links.clear();
    await tracing.shutdown();
  });
  tessar.hook(stream.started, (event) => {
    begin(event);
  });
  tessar.hook(stream.resumed, async (event, context) => {
    // A continued Turn does not emit turn.start again. Restore its identity
    // from the existing checkpoint, without reconstructing an unrecorded request.
    const checkpoint = await context.thread?.getCheckpoint(
      event.payload.checkpointId,
    );
    const snapshot = checkpoint?.state.pluginStates.find(
      (value) =>
        value.pluginId === "langfuse" &&
        value.namespace === "trace" &&
        value.ownerType === "thread",
    );
    if (event.sessionId && event.streamId && snapshot) {
      const saved = snapshot.data as unknown as ThreadTraceState;
      links.set(event.streamId, {
        ...saved,
        rootNew: !saved.rootCreated,
        turnNew: !saved.turnCreated,
      });
    }
    const state = begin(event);
    if (!state) return;
    update(state.root, "agent", {
      input: event.payload,
      metadata: { inputSource: "resume" },
    });
    if (!checkpoint) return;
    const execution = checkpoint.execution;
    if (!execution?.turnId || execution.phase === "BeforeTurn") return;
    state.currentTurn = execution.turnId;
    const span = parentTurn(
      state,
      event,
      execution.turnId,
      execution.budgets.turns - 1,
    );
    update(span, "span", {
      input: { messages: checkpoint.state.messages },
      metadata: { inputSource: "checkpoint" },
    });
    for (const message of checkpoint.state.messages)
      for (const part of message.content)
        if (part.type === "tool-call")
          state.calls.set(part.toolCallId, {
            name: part.name,
            arguments: part.arguments,
          });
  });
  tessar.hook(input.received, (event) => {
    const state = current(event);
    if (!state) return;
    update(state.root, "agent", { input: event.payload.messages });
  });
  tessar.hook(turn.start, (event) => {
    const state = current(event);
    if (!state) return;
    state.currentTurn = event.payload.turnId;
    // Thread numbering is checkpointed by model.select before model.start.
    if (!state.link)
      parentTurn(state, event, event.payload.turnId, event.payload.index);
  });
  tessar.hook(turn.end, (event) => {
    const state = current(event),
      turn = state?.turns.get(event.payload.turnId);
    if (!turn) return;
    update(turn.span, "span", {
      metadata: { usage: event.payload.usage, status: "ended" },
    });
    turn.span.end(time(event));
    state!.turns.delete(event.payload.turnId);
  });
  tessar.hook(message.committed, (event) => {
    const state = current(event),
      value = event.payload.message;
    if (!state || (value.role !== "assistant" && value.role !== "tool")) return;
    state.output.push(value);
    const turn = state.currentTurn
      ? state.turns.get(state.currentTurn)
      : undefined;
    if (turn) {
      turn.output.push(value);
      update(turn.span, "span", { output: turn.output });
    }
  });
  tessar.hook(stream.suspended, (event) => {
    finish(event, "suspended");
  });
  tessar.hook(stream.end, (event) => {
    finish(
      event,
      event.payload.status,
      event.payload.error,
      event.payload.output,
    );
  });
  tessar.hook(stream.error, (event) => {
    begin(event);
    finish(
      event,
      event.payload.persistedStatus ?? "failed",
      event.payload.error,
    );
  });
}
