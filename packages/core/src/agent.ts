import { loop } from "./loop.js";
import { providerCall, streamModel } from "./models/stream.js";
import type { Controller } from "./controller.js";
import type { Model } from "./models/profile.js";
import type { Scope, InterruptRecord } from "./state/schema.js";
import {
  createDelivery,
  type Stream,
  type DeliveryTarget,
  type Attachment,
} from "./engine/delivery.js";
export type { Stream, DeliveryTarget } from "./engine/delivery.js";
import {
  TesseractError,
  errorInfo,
  errorFromInfo,
  fail,
  requireId,
  type ErrorInfo,
} from "./errors.js";
import {
  immutable,
  randomIds,
  systemClock,
  type Clock,
  type IdGenerator,
  type JsonObject,
  type JsonValue,
} from "./json.js";
import {
  normalizeInstruction,
  type Instruction,
} from "./instructions/instruction.js";
import {
  AgentEvents,
  type ControlDecision,
  type StreamOutcome,
} from "./events/catalog.js";
import {
  type AnyEvent,
  type EventContext,
  type PayloadOf,
  type ResultOf,
} from "./events/definition.js";
import { MessageCodec } from "./messages/codec.js";
import { ToolMessage, type MessageData } from "./messages/message.js";
import type { ModelProviderRegistration, ModelRef } from "./models/contract.js";
import { PluginHost } from "./plugins/host.js";
import type { RegistryLease } from "./plugins/registry.js";
import { CommitCoordinator } from "./state/commit.js";
import {
  PluginStateAccess,
  type PluginStateDefinition,
} from "./state/plugin-state.js";
import type { StorageBackend, Lease } from "./state/storage-ports.js";
import type {
  Checkpoint,
  CheckpointCause,
  RecordEntry,
  StreamLimits,
  ExecutionPosition,
} from "./state/schema.js";
import { aggregateUsage, normalizeUsage } from "./trace/usage.js";
import type {
  StreamRecord,
  TurnRecord,
  ModelAttemptRecord,
  ToolExecutionRecord,
} from "./trace/records.js";
import type { Tool } from "./tools/tool.js";
import { Suspension, type InterruptionDefinition } from "./engine/interrupt.js";
import {
  phaseForEvent,
  validateManifest,
  validateResume,
} from "./engine/resume.js";
import { canonicalJson } from "./state/commit.js";
import { RecoveryService } from "./engine/recovery.js";
import {
  EffectService,
  childStateDefinition,
  type EffectBinding,
  type TrackedServices,
  type ChildReservation,
} from "./engine/tracked-effects.js";
import {
  resolveChildAdmission,
  summarizeStreamUsage,
} from "./engine/lineage.js";
import type { ModelChunk, ModelRequest } from "./models/contract.js";

export interface ExecutionOrigin {
  parentStreamId: string;
  parentToolExecutionId?: string;
  dispatchId: string;
}
export type ExecutionRequest = (
  | {
      kind: "input";
      threadId: string;
      input: readonly MessageData[];
      model: ModelRef;
      origin?: ExecutionOrigin;
      context?: JsonObject;
      limits?: Partial<StreamLimits>;
    }
  | {
      kind: "resume";
      threadId: string;
      interruptId: string;
      value: JsonValue;
      model?: ModelRef;
    }
  | { kind: "recover"; threadId: string; streamId: string; model?: ModelRef }
) & { signal?: AbortSignal };
export interface AgentOptions {
  id: string;
  model?: Model | ModelRef;
  instructions?: string | Instruction;
  limits?: Partial<StreamLimits>;
}
export interface AgentExecutionOptions {
  input: MessageData | readonly MessageData[];
  model?: Model | ModelRef;
  scope?: Scope;
  context?: JsonObject;
  signal?: AbortSignal;
  limits?: Partial<StreamLimits>;
}
export interface GenerateOutcome {
  threadId: string;
  streamId: string;
  status: StreamRecord["status"];
  output: readonly MessageData[];
  usage: import("./trace/usage.js").UsageSummary;
  interrupt: InterruptRecord | null;
  error: ErrorInfo | null;
}
export function inputMessages(
  input: MessageData | readonly MessageData[],
): readonly MessageData[] {
  const values = Array.isArray(input) ? input : [input];
  return values.map((value) =>
    MessageCodec.encode(MessageCodec.decode(MessageCodec.encode(value))),
  );
}
function validateLimits(limits: Partial<StreamLimits>): void {
  for (const value of Object.values(limits))
    if (!Number.isInteger(value) || value < 1)
      fail("InvalidConfiguration", "Limits must be positive integers");
}
export interface ExecutionFrame {
  effectLocks?: Map<string, Promise<unknown>>;
  commitQueue?: Promise<void>;
  currentToolExecutionId?: string;
  heartbeat?: ReturnType<typeof setInterval>;
  ownershipError?: ErrorInfo;
  request: ExecutionRequest;
  sink: Attachment;
  registry: RegistryLease;
  lease: Lease;
  cp: Checkpoint;
  stream: StreamRecord;
  records: Map<string, RecordEntry>;
  state: PluginStateAccess;
  admitted: boolean;
  sequence: number;
}
export class Agent {
  readonly id: string;
  readonly model: Readonly<ModelRef> | undefined;
  private controller?: Controller;
  /** @internal */ attachController(controller: Controller): void {
    if (this.controller)
      fail("AgentAlreadyBound", "Agent already belongs to a Controller");
    this.controller = controller;
  }
  private runtime(): Controller {
    if (!this.controller)
      fail("ControllerNotReady", "Initialize a Controller for this Agent");
    return this.controller;
  }
  get backend(): StorageBackend {
    return this.runtime().backend;
  }
  get registry(): PluginHost {
    return this.runtime().hooks;
  }
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly limits: StreamLimits;
  readonly instructions: Instruction;
  private readonly jobs = new Set<Promise<void>>();
  private readonly active = new Map<string, ExecutionFrame>();
  private closed = false;
  private readonly resumeAdmissions = new Map<
    string,
    Promise<ExecutionFrame>
  >();
  constructor(options: AgentOptions) {
    this.id = requireId(options.id, "agent id");
    this.model = options.model
      ? immutable("ref" in options.model ? options.model.ref : options.model)
      : undefined;
    this.ids = randomIds;
    this.clock = systemClock;
    this.instructions = normalizeInstruction(options.instructions);
    this.limits = immutable({
      maxTurns: 32,
      maxModelAttempts: 64,
      maxToolCalls: 128,
      ...options.limits,
    });
    validateLimits(this.limits);
  }
  stream(options: AgentExecutionOptions): Stream {
    const controller = this.runtime();
    controller.requireReady();
    const model = controller.resolveModel(options.model ?? this.model).ref;
    const threadId = this.ids.next("thread"),
      input = inputMessages(options.input);
    return this.admit(
      {
        kind: "input",
        threadId,
        input,
        model,
        context: options.context,
        limits: options.limits,
        signal: options.signal,
      },
      { kind: "iterator" },
      () =>
        controller
          .prepareThread({ scope: options.scope }, threadId)
          .then(() => {}),
    );
  }
  async generate(options: AgentExecutionOptions): Promise<GenerateOutcome> {
    const stream = this.stream(options);
    for await (const event of stream)
      if (event.is(AgentEvents.StreamError))
        throw errorFromInfo(event.payload.error);
    if (!stream.id) fail("AdmissionFailed", "Execution was not admitted");
    const record = await this.runtime().queries.getStream(
      stream.threadId,
      stream.id,
    );
    if (!record) fail("StorageUnavailable", "Committed execution missing");
    const cp = await this.runtime().queries.snapshot(stream.threadId),
      pending = cp.execution?.pendingInterruptId;
    return {
      threadId: stream.threadId,
      streamId: record.id,
      status: record.status,
      output: cp.state.messages.filter((m) =>
        record.outputMessageIds.includes(m.id),
      ),
      usage: record.directUsage,
      interrupt: pending
        ? await this.runtime().queries.getInterrupt(stream.threadId, pending)
        : null,
      error: record.error,
    };
  }
  /** @internal Shared admission for Thread, Session and testing. */
  admit(
    request: ExecutionRequest,
    target: DeliveryTarget = { kind: "iterator" },
    prepare?: () => Promise<void>,
  ): Stream {
    this.runtime().requireReady();
    if (this.closed) fail("Disposed", "Agent closed");
    if (request.kind === "input")
      validateLimits({ ...this.limits, ...request.limits });
    const sink = createDelivery(
        request.threadId,
        this.ids,
        target,
        request.signal,
        this.runtime().report,
      ),
      registry = this.registry.capture();
    const job = Promise.resolve()
      .then(async () => {
        try {
          await prepare?.();
          if (this.closed) fail("Disposed", "Agent closed");
        } catch (error) {
          await registry.release();
          throw error;
        }
        await this.execute(request, sink, registry);
      })
      .catch((error) => {
        this.runtime().report(errorInfo(error));
        sink.emit(
          AgentEvents.StreamError,
          {
            error: errorInfo(error),
            lastKnownCheckpointId: null,
            persistedStatus: null,
          },
          {},
        );
        sink.rejected(errorInfo(error));
        sink.close();
      });
    this.jobs.add(job);
    void job.then(() => this.jobs.delete(job));
    return sink.stream;
  }
  private async execute(
    request: ExecutionRequest,
    sink: Attachment,
    registry: RegistryLease,
  ): Promise<void> {
    let frame: ExecutionFrame | undefined;
    let pendingLease: Lease | undefined;
    try {
      if (sink.controller.signal.aborted)
        fail("Cancelled", "Execution cancelled before admission");
      if (request.kind === "resume") {
        frame = await this.prepareResume(request, sink, registry);
        this.active.set(frame.stream.id, frame);
        this.watchLease(frame);
        sink.admitted();
        await this.hook(frame, AgentEvents.StreamResumed, {
          checkpointId: frame.cp.id,
          interruptId: request.interruptId,
          reason: "response",
        });
        const cursor = frame.cp.execution!.handlerCursor;
        if (cursor?.eventId === AgentEvents.BeforeStream) {
          const result = await this.hook(
            frame,
            AgentEvents.BeforeStream,
            cursor.payload as any,
          );
          if (result?.decision === "deny" || result?.decision === "stop") {
            await this.finish(
              frame,
              "stopped",
              result.reason ?? "PolicyStopped",
            );
            return;
          }
        }
        if (cursor?.eventId === AgentEvents.ModelRecover) {
          const result = await this.hook(
            frame,
            AgentEvents.ModelRecover,
            cursor.payload as any,
          );
          if (result?.decision !== "retry")
            fail("ProviderError", "Recovery policy declined retry");
          frame.cp.execution!.phase = "BeforeModel";
          await this.commit(frame, "ExecutionTransition");
        }
        await this.loop(frame);
        return;
      }
      if (request.kind === "recover") {
        frame = await this.prepareRecovery(request, sink, registry);
        this.active.set(frame.stream.id, frame);
        this.watchLease(frame);
        sink.admitted();
        if (frame.cp.execution?.pendingInterruptId) {
          const interrupt = await this.backend.executions.get(
            "interrupts",
            frame.cp.execution.pendingInterruptId,
            { threadId: request.threadId },
          );
          await this.hook(frame, AgentEvents.StreamSuspended, {
            checkpointId: frame.cp.id,
            interrupt: interrupt!,
          });
          return;
        }
        await this.hook(frame, AgentEvents.StreamResumed, {
          checkpointId: frame.cp.id,
          interruptId: null,
          reason: "recovery",
        });
        await this.loop(frame);
        return;
      }
      const head = await this.backend.threads.get(request.threadId);
      if (!head) fail("ThreadNotFound", "Thread not found");
      if (head.activeStreamId)
        fail("ThreadBusy", "Thread already has unfinished execution");
      const lease = await this.backend.ownership.acquire({
        threadId: request.threadId,
        ownerToken: this.ids.next("owner"),
        ttlMs: 30000,
      });
      pendingLease = lease;
      const cp = structuredClone(
        (await this.backend.checkpoints.get(head.currentCheckpointId))!,
      );
      const streamId = request.origin
          ? await resolveChildAdmission(
              this.backend,
              request.origin,
              request.threadId,
            )
          : this.ids.next("stream"),
        usage = aggregateUsage([]);
      const stream: StreamRecord = {
        id: streamId,
        threadId: request.threadId,
        scope: head.scope,
        parentStreamId: request.origin?.parentStreamId ?? null,
        parentToolExecutionId: request.origin?.parentToolExecutionId ?? null,
        triggerMessageId: null,
        status: "running",
        stopReason: null,
        startedAt: this.clock.now(),
        endedAt: null,
        durationMs: null,
        error: null,
        directUsage: usage,
        inclusiveUsage: usage,
        outputMessageIds: [],
      };
      const records = new Map<string, RecordEntry>();
      for (const kind of [
        "streams",
        "turns",
        "model_attempts",
        "tool_executions",
        "interrupts",
        "plugin_states",
      ] as const)
        for (const row of await this.backend.executions.listRecords(
          kind,
          request.threadId,
        ))
          records.set(kind + ":" + ("id" in row ? row.id : ""), {
            kind,
            id: "id" in row ? row.id : "",
            threadId: request.threadId,
            data: structuredClone(row),
          } as RecordEntry);
      const state = new PluginStateAccess(
        [
          childStateDefinition,
          ...registry.list<PluginStateDefinition<any>>("state"),
        ],
        { type: "thread", id: request.threadId },
        cp.state.pluginStates,
        async () => {
          await this.commit(frame!, "PluginStateCommitted");
          return frame!.cp.id;
        },
        undefined,
        this.backend.ownedState,
      );
      frame = {
        request,
        sink,
        registry,
        lease,
        cp,
        stream,
        records,
        state,
        admitted: false,
        sequence: 0,
      };
      this.put(frame, "streams", stream);
      sink.setId(streamId);
      this.active.set(streamId, frame);
      this.watchLease(frame);
      cp.execution = {
        streamId,
        turnId: null,
        phase: "BeforeTurn",
        modelRef: request.model,
        baseInstructions: this.instructions,
        pendingToolExecutionIds: [],
        pendingInterruptId: null,
        handlerCursor: null,
        budgets: {
          turns: 0,
          modelAttempts: 0,
          toolCalls: 0,
          limits: { ...this.limits, ...request.limits },
        },
        registryManifest: [
          ...registry.values.map((r) => ({
            pluginId: r.pluginId,
            kind: r.kind,
            id: r.id,
            version: r.version,
            pluginVersion: r.pluginVersion,
            configurationId: r.configurationId,
            requiredForContinuation: true,
          })),
          ...registry.handlers.map((r) => ({
            pluginId: r.pluginId,
            kind: "handler",
            id: r.id,
            version: r.version,
            pluginVersion: r.pluginVersion,
            configurationId: r.configurationId,
            requiredForContinuation: r.kind !== "notification",
          })),
        ],
        recordRevision: cp.revision,
      };
      const input = await this.hook(frame, AgentEvents.InputPrepare, {
        messages: request.input,
      });
      if (input.rejected) throw errorFromInfo(input.rejected);
      for (const message of input.messages)
        cp.state = {
          ...cp.state,
          messages: [
            ...cp.state.messages,
            await this.prepareMessage(frame, message),
          ],
        };
      stream.triggerMessageId = input.messages[0]?.id ?? null;
      await this.commit(frame, "InputCommitted");
      frame.admitted = true;
      sink.admitted();
      await this.hook(frame, AgentEvents.StreamStarted, {
        modelRef: request.model,
        checkpointId: frame.cp.id,
      });
      await this.hook(frame, AgentEvents.InputReceived, {
        messages: input.messages,
      });
      if (input.handled) {
        for (const message of input.handled.output)
          await this.appendMessage(frame, message);
        await this.finish(frame, "completed", null);
        return;
      }
      const before = await this.hook(frame, AgentEvents.BeforeStream, {
        input: input.messages,
      });
      if (before?.decision === "deny" || before?.decision === "stop") {
        await this.finish(frame, "stopped", before.reason ?? "PolicyStopped");
        return;
      }
      await this.loop(frame);
    } catch (error) {
      if (error instanceof Suspension) return;
      if (frame?.ownershipError)
        error = new TesseractError(
          "OwnershipLost",
          "Execution ownership was lost",
        );
      const info = errorInfo(error);
      if (
        frame?.admitted &&
        info.source !== "storage" &&
        ![
          "StorageUnavailable",
          "CommitConflict",
          "OwnershipLost",
          "RecoveryRequired",
        ].includes(info.code)
      ) {
        try {
          await this.finish(
            frame,
            sink.controller.signal.aborted ? "cancelled" : "failed",
            info.code,
            info,
          );
          return;
        } catch (finalizeError) {
          error = finalizeError;
        }
      }
      const finalError = errorInfo(error);
      this.runtime().report(finalError, this.eventContext(frame));
      sink.emit(
        AgentEvents.StreamError,
        {
          error: finalError,
          lastKnownCheckpointId: frame?.cp.id ?? null,
          persistedStatus: frame?.stream.status ?? null,
        },
        this.eventContext(frame),
      );
      sink.rejected(finalError);
    } finally {
      if (frame) {
        if (frame.heartbeat) clearInterval(frame.heartbeat);
        this.active.delete(frame.stream.id);
        try {
          await this.backend.ownership.release(frame.lease);
        } catch {
          /* recovery uses lease expiry */
        }
      } else if (pendingLease) {
        try {
          await this.backend.ownership.release(pendingLease);
        } catch {
          /* lease expiry remains authoritative */
        }
      }
      await registry.release();
      sink.close();
    }
  }
  private eventContext(frame?: ExecutionFrame): EventContext {
    return {
      agentId: this.id,
      controllerId: this.runtime().id,
      ...(frame
        ? {
            scope: frame.cp.state.scope,
            streamId: frame.stream.id,
            threadId: frame.cp.threadId,
            sequence: ++frame.sequence,
            timestamp: this.clock.now(),
          }
        : {}),
    };
  }
  private watchLease(frame: ExecutionFrame): void {
    if (frame.heartbeat) return;
    frame.heartbeat = setInterval(() => {
      void this.backend.ownership.renew(frame.lease, 30000).then(
        (lease) => {
          frame.lease = lease;
        },
        (error) => {
          frame.ownershipError = errorInfo(error, {
            source: "storage",
            backendId: this.backend.id,
          });
          frame.sink.controller.abort("OwnershipLost");
        },
      );
    }, 10000);
  }
  private async hook<D extends AnyEvent>(
    frame: ExecutionFrame,
    definition: D,
    payload: PayloadOf<D>,
  ): Promise<ResultOf<D>> {
    const cursor =
      frame.cp.execution?.handlerCursor?.eventId === definition
        ? frame.cp.execution.handlerCursor
        : null;
    const decisions: JsonValue[] = cursor?.decisions.slice() ?? [];
    const kind = this.registry.kind(definition);
    const mutable = kind === "transformation" || kind === "decision";
    const context = {
      ...this.eventContext(frame),
      ...(mutable
        ? {
            ...this.services(frame, frame.currentToolExecutionId),
            state: frame.state,
          }
        : {}),
      signal: frame.sink.controller.signal,
      context:
        frame.request.kind === "input" ? frame.request.context : undefined,
      turnId: frame.cp.execution?.turnId,
      streamId: frame.stream.id,
      threadId: frame.cp.threadId,
      startIndex: cursor?.nextIndex ?? 0,
      initialDecision: decisions.at(-1) ?? undefined,
      allowedHandlerIds: frame.cp.execution?.registryManifest
        .filter((r) => r.kind === "handler")
        .map((r) => r.id),
      suspend:
        kind === "decision"
          ? <R, P extends JsonValue>(
              def: InterruptionDefinition<R, ControlDecision, P>,
              data: P,
            ): ControlDecision => {
              phaseForEvent(definition);
              const binding = frame.registry.find<{
                definition: InterruptionDefinition;
                pluginId: string;
              }>("interruption", def.id);
              if (!binding || binding.definition.version !== def.version)
                fail(
                  "ResumeIncompatible",
                  "Interruption definition is not registered",
                );
              return {
                decision: "suspend",
                definitionId: def.id,
                definitionVersion: def.version,
                pluginId: binding.pluginId,
                payload: immutable(
                  def.payload ? def.payload.parse(data) : data,
                ) as JsonValue,
              };
            }
          : undefined,
      onDecision:
        this.registry.kind(definition) === "decision"
          ? async (entry: {
              handlerId: string;
              index: number;
              decision: unknown;
            }) => {
              const value = entry.decision as ControlDecision | undefined;
              decisions.push(value ? (immutable(value) as JsonValue) : null);
              frame.cp.execution!.handlerCursor = {
                eventId: definition,
                handlerId: entry.handlerId,
                nextIndex: entry.index + 1,
                payload: immutable(cursor?.payload ?? payload) as JsonValue,
                decisions,
              };
              if (value?.decision !== "suspend")
                await this.commit(frame, "ExecutionTransition");
            }
          : undefined,
    };
    const value = await this.registry.dispatch(
      definition,
      payload,
      context,
      frame.registry,
    );
    if (this.registry.kind(definition) === "decision") {
      if ((value as ControlDecision | undefined)?.decision === "suspend")
        await this.suspend(frame, value as ControlDecision);
      if (frame.cp.execution?.handlerCursor?.eventId === definition)
        frame.cp.execution.handlerCursor = null;
    }
    if (this.registry.kind(definition) === "notification")
      frame.sink.emit(definition, payload, context);
    return value;
  }
  private put(
    frame: ExecutionFrame,
    kind: RecordEntry["kind"],
    data: any,
  ): void {
    frame.records.set(kind + ":" + data.id, {
      kind,
      id: data.id,
      threadId: frame.cp.threadId,
      data,
    } as RecordEntry);
  }
  private rows<T>(frame: ExecutionFrame, kind: RecordEntry["kind"]): T[] {
    return [...frame.records.values()]
      .filter((r) => r.kind === kind)
      .map((r) => r.data as T);
  }
  private services(
    frame: ExecutionFrame,
    toolExecutionId?: string,
  ): TrackedServices {
    const state = frame.state.withOwner({
      type: "stream",
      id: frame.stream.id,
    });
    frame.effectLocks ??= new Map();
    const effects = new EffectService(
      (id) => frame.registry.find<EffectBinding>("effect", id),
      state,
      () => this.commit(frame, "PluginStateCommitted"),
      {
        signal: frame.sink.controller.signal,
        threadId: frame.cp.threadId,
        streamId: frame.stream.id,
        turnId: frame.cp.execution?.turnId ?? null,
        ...(toolExecutionId ? { toolExecutionId } : {}),
      },
      () => this.ids.next("effect"),
      frame.effectLocks,
    );
    const guard = () => {
      if (!frame.admitted || !frame.cp.execution)
        fail(
          "UnsupportedBoundary",
          "Tracked execution requires admitted active work",
        );
    };
    return {
      models: {
        stream: (options) => {
          guard();
          return this.auxiliary(frame, toolExecutionId, options);
        },
      },
      effects: {
        execute: (definition, input, options) => {
          guard();
          return effects.execute(definition, input, options);
        },
      },
      executions: {
        reserveChild: async (options) => {
          guard();
          if (options.threadId === frame.cp.threadId)
            fail("InvalidLineage", "Child requires a separate Thread");
          if (!(await this.backend.threads.get(options.threadId)))
            fail("ThreadNotFound", "Child Thread not found");
          const previous = state.get(childStateDefinition),
            old = previous[options.dispatchKey] as unknown as
              | ChildReservation
              | undefined;
          if (old) {
            if (old.threadId !== options.threadId)
              fail("CommitConflict", "Dispatch key is bound to another Thread");
            await this.commit(frame, "PluginStateCommitted");
            return old;
          }
          const reservation: ChildReservation = {
            threadId: options.threadId,
            streamId: this.ids.next("stream"),
            origin: {
              parentStreamId: frame.stream.id,
              ...(toolExecutionId
                ? { parentToolExecutionId: toolExecutionId }
                : {}),
              dispatchId: this.ids.next("dispatch"),
            },
          };
          state.update(childStateDefinition, {
            ...previous,
            [options.dispatchKey]: reservation as unknown as JsonValue,
          });
          await this.commit(frame, "PluginStateCommitted");
          return immutable(reservation);
        },
      },
      events: {
        emit: async (definition, payload) => {
          if (this.registry.kind(definition) !== "notification")
            fail("InvalidEvent", "Custom progress must be notification events");
          await this.hook(frame, definition, payload);
        },
      },
    };
  }
  private async *auxiliary(
    frame: ExecutionFrame,
    toolExecutionId: string | undefined,
    options: { model: ModelRef; request: ModelRequest; purpose: "auxiliary" },
  ): AsyncIterable<ModelChunk> {
    const position = frame.cp.execution!;
    if (!position.turnId)
      fail("UnsupportedBoundary", "Auxiliary calls require an active turn");
    if (
      position.budgets.modelAttempts >= position.budgets.limits.maxModelAttempts
    )
      fail("StreamLimit", "Model attempt budget exhausted");
    const provider = frame.registry.find<ModelProviderRegistration>(
      "provider",
      options.model.providerId,
    );
    if (!provider) fail("MissingProvider", "Auxiliary provider is missing");
    const adapter = providerCall(options.model, () =>
        provider.create(options.model.modelId),
      ),
      request = await this.hook(
        frame,
        AgentEvents.ModelRequest,
        immutable(options.request),
      );
    providerCall(options.model, () => adapter.validate(request));
    const attempt: ModelAttemptRecord = {
      id: this.ids.next("attempt"),
      turnId: position.turnId,
      streamId: frame.stream.id,
      scope: frame.cp.state.scope,
      callId: this.ids.next("call"),
      attemptIndex: 0,
      purpose: "auxiliary",
      parentToolExecutionId: toolExecutionId ?? null,
      providerId: options.model.providerId,
      modelId: options.model.modelId,
      providerRequestId: null,
      responseMessageId: null,
      contextRevision: frame.cp.revision,
      requestSnapshotRef: null,
      startedAt: this.clock.now(),
      firstOutputAt: null,
      endedAt: null,
      durationMs: null,
      timeToFirstOutputMs: null,
      status: "running",
      finishReason: null,
      error: null,
      usage: normalizeUsage({}),
    };
    position.budgets.modelAttempts++;
    this.put(frame, "model_attempts", attempt);
    await this.commit(frame, "ExecutionTransition");
    try {
      for await (const chunk of streamModel(adapter, request, {
        signal: frame.sink.controller.signal,
      })) {
        if (chunk.type === "usage") attempt.usage = chunk.usage;
        if (chunk.type === "response") {
          attempt.usage = chunk.response.usage ?? attempt.usage;
          attempt.status = "succeeded";
          attempt.finishReason = chunk.response.finishReason ?? null;
          attempt.providerRequestId = chunk.response.providerRequestId ?? null;
        }
        yield chunk;
      }
    } catch (error) {
      attempt.status = "failed";
      attempt.error = errorInfo(error);
      throw error;
    } finally {
      if (attempt.status === "running") attempt.status = "interrupted";
      attempt.endedAt = this.clock.now();
      await this.commit(frame, "ExecutionTransition");
    }
  }
  private async updateUsage(frame: ExecutionFrame): Promise<void> {
    const attempts = this.rows<ModelAttemptRecord>(frame, "model_attempts");
    const summary = await summarizeStreamUsage(this.backend, frame.stream.id, {
      threadId: frame.cp.threadId,
      attempts,
      states: frame.state.snapshots(),
    });
    frame.stream.directUsage = summary.direct;
    frame.stream.inclusiveUsage = summary.inclusive;
    for (const turn of this.rows<TurnRecord>(frame, "turns"))
      turn.usage = aggregateUsage(attempts.filter((a) => a.turnId === turn.id));
  }
  private async commit(
    frame: ExecutionFrame,
    cause: CheckpointCause,
  ): Promise<void> {
    const queued = (frame.commitQueue ?? Promise.resolve()).then(() =>
      this.commitNow(frame, cause),
    );
    frame.commitQueue = queued.catch(() => {});
    return queued;
  }
  private async commitNow(
    frame: ExecutionFrame,
    cause: CheckpointCause,
  ): Promise<void> {
    await this.updateUsage(frame);
    const cp: Checkpoint = {
      ...frame.cp,
      id: this.ids.next("checkpoint"),
      parentCheckpointId: frame.cp.id,
      revision: frame.cp.revision + 1,
      createdAt: this.clock.now(),
      cause,
      state: { ...frame.cp.state, pluginStates: frame.state.snapshots() },
      execution: frame.cp.execution
        ? { ...frame.cp.execution, recordRevision: frame.cp.revision + 1 }
        : null,
    };
    if (cause === "Suspended" && cp.execution?.pendingInterruptId) {
      const record = frame.records.get(
        "interrupts:" + cp.execution.pendingInterruptId,
      )!;
      if (record.kind === "interrupts") {
        record.data.checkpointId = cp.id;
        record.data.revision = cp.revision;
      }
    }
    await new CommitCoordinator(this.backend).commit(
      {
        commitId: this.ids.next("commit"),
        threadId: cp.threadId,
        expectedRevision: frame.cp.revision,
        checkpoint: cp,
        records: [...frame.records.values()],
      },
      frame.lease,
    );
    frame.cp = { ...structuredClone(cp), execution: frame.cp.execution };
    if (frame.cp.execution) frame.cp.execution.recordRevision = cp.revision;
    await this.hook(frame, AgentEvents.CheckpointCommitted, {
      checkpointId: cp.id,
      revision: cp.revision,
    });
    await this.hook(frame, AgentEvents.ThreadUpdated, {
      checkpointId: cp.id,
      revision: cp.revision,
    });
  }
  private async prepareMessage(
    frame: ExecutionFrame,
    message: MessageData,
  ): Promise<MessageData> {
    const value = await this.hook(
      frame,
      AgentEvents.MessagePrepare,
      immutable(message),
    );
    if (
      value.id !== message.id ||
      value.role !== message.role ||
      value.toolCallId !== message.toolCallId
    )
      fail(
        "InvalidMessage",
        "Message transform changed identity/role/correlation",
      );
    const validated = MessageCodec.encode(MessageCodec.decode(value));
    await this.hook(frame, AgentEvents.MessageBeforeCommit, {
      message: validated,
    });
    return validated;
  }
  private async appendMessage(
    frame: ExecutionFrame,
    message: MessageData,
  ): Promise<void> {
    const value = await this.prepareMessage(frame, message);
    frame.cp.state = {
      ...frame.cp.state,
      messages: [...frame.cp.state.messages, value],
    };
    if (value.role === "assistant" || value.role === "tool")
      frame.stream.outputMessageIds = [
        ...frame.stream.outputMessageIds,
        value.id,
      ];
    await this.commit(frame, "MessageCommitted");
    await this.hook(frame, AgentEvents.MessageCommitted, {
      message: value,
      checkpointId: frame.cp.id,
    });
  }
  private loop(frame: ExecutionFrame): Promise<void> {
    return loop(frame, {
      ids: this.ids,
      clock: this.clock,
      hook: this.hook.bind(this),
      put: this.put.bind(this),
      rows: this.rows.bind(this),
      commit: this.commit.bind(this),
      updateUsage: this.updateUsage.bind(this),
      appendMessage: this.appendMessage.bind(this),
      services: this.services.bind(this),
      finish: this.finish.bind(this),
    });
  }
  private async restoreFrame(
    request: Extract<ExecutionRequest, { kind: "recover" }>,
    sink: Attachment,
    registry: RegistryLease,
    checkManifest = true,
  ): Promise<ExecutionFrame> {
    const head = await this.backend.threads.get(request.threadId);
    if (!head) fail("ThreadNotFound", "Thread not found");
    const stored = await this.backend.executions.get(
      "streams",
      request.streamId,
      { threadId: request.threadId },
    );
    if (!stored) fail("StreamNotFound", "Execution not found");
    if (["completed", "failed", "stopped", "cancelled"].includes(stored.status))
      fail("AlreadyTerminal", "Execution already ended");
    const cp = structuredClone(
      (await this.backend.checkpoints.get(head.currentCheckpointId))!,
    );
    if (cp.execution?.streamId !== request.streamId)
      fail("InvalidTransition", "Execution is not current thread work");
    if (checkManifest)
      validateManifest(cp.execution.registryManifest, registry, request.model);
    const lease = await this.backend.ownership.acquire({
      threadId: request.threadId,
      ownerToken: this.ids.next("owner"),
      ttlMs: 30000,
    });
    try {
      const records = new Map<string, RecordEntry>();
      for (const kind of [
        "streams",
        "turns",
        "model_attempts",
        "tool_executions",
        "interrupts",
        "plugin_states",
      ] as const)
        for (const row of await this.backend.executions.listRecords(
          kind,
          request.threadId,
        ))
          records.set(kind + ":" + ("id" in row ? row.id : ""), {
            kind,
            id: "id" in row ? row.id : "",
            threadId: request.threadId,
            data: structuredClone(row),
          } as RecordEntry);
      const stream = (
        records.get("streams:" + request.streamId) as { data: StreamRecord }
      ).data;
      let frame!: ExecutionFrame;
      const state = new PluginStateAccess(
        [
          childStateDefinition,
          ...registry.list<PluginStateDefinition<any>>("state"),
        ],
        { type: "thread", id: request.threadId },
        cp.state.pluginStates,
        async () => {
          await this.commit(frame, "PluginStateCommitted");
          return frame.cp.id;
        },
        undefined,
        this.backend.ownedState,
      );
      frame = {
        request,
        sink,
        registry,
        lease,
        cp,
        stream,
        records,
        state,
        admitted: true,
        sequence: 0,
      };
      sink.setId(stream.id);
      if (request.model) cp.execution!.modelRef = request.model;
      return frame;
    } catch (error) {
      await this.backend.ownership.release(lease);
      throw error;
    }
  }
  private async prepareRecovery(
    request: Extract<ExecutionRequest, { kind: "recover" }>,
    sink: Attachment,
    registry: RegistryLease,
  ): Promise<ExecutionFrame> {
    const frame = await this.restoreFrame(request, sink, registry);
    try {
      const plan = new RecoveryService().plan(
        frame.cp,
        this.rows(frame, "model_attempts"),
        this.rows(frame, "tool_executions"),
      );
      if (plan.kind === "pending-interrupt") return frame;
      frame.stream.status = "interrupted";
      if (plan.kind === "incompatible")
        fail("ResumeIncompatible", "Invalid recovery cursor");
      if (plan.kind === "model") {
        plan.attempt.status = "interrupted";
        plan.attempt.endedAt = this.clock.now();
        plan.attempt.error = {
          source: "tesseract",
          name: "TesseractError",
          code: "InterruptedModelCall",
          message: "Provider outcome was not committed",
          retryable: true,
        };
        await this.commit(frame, "ExecutionTransition");
        const decision = await this.hook(frame, AgentEvents.ModelRecover, {
          attemptId: plan.attempt.id,
          error: plan.attempt.error,
        });
        if (decision?.decision !== "retry")
          fail(
            "RecoveryRequired",
            "Model retry requires an explicit recovery policy",
          );
        frame.cp.execution!.phase = "BeforeModel";
      }
      if (plan.kind === "tool") {
        const record = plan.tool;
        record.status = "interrupted";
        await this.commit(frame, "ExecutionTransition");
        const tool = registry.find<Tool>("tool", record.toolName);
        const result =
          tool?.recovery && record.idempotencyKey
            ? await tool.recovery.reconcile({
                id: record.id,
                input: tool.input.parse(record.arguments),
                key: record.idempotencyKey,
              })
            : { status: "unknown" as const };
        if (result.status === "unknown")
          fail("RecoveryRequired", "Tool dispatch outcome is unknown");
        if (result.status === "safeToRetry") {
          record.status = "pending";
          frame.cp.execution!.phase = "BeforeTool";
        }
        if (result.status === "completed") {
          const transformed = await this.hook(
              frame,
              AgentEvents.ToolResult,
              result.result,
            ),
            message = MessageCodec.encode(
              new ToolMessage({
                toolCallId: record.toolCallId,
                content: transformed.content,
                metadata: transformed.metadata,
              }),
            );
          record.status = "succeeded";
          record.result = transformed;
          record.resultMessageId = message.id;
          record.endedAt = this.clock.now();
          frame.cp.execution!.pendingToolExecutionIds =
            frame.cp.execution!.pendingToolExecutionIds.filter(
              (id) => id !== record.id,
            );
          frame.cp.execution!.phase = frame.cp.execution!
            .pendingToolExecutionIds.length
            ? "BeforeTool"
            : "TurnBoundary";
          await this.appendMessage(frame, message);
        }
      }
      frame.stream.status = "running";
      await this.commit(frame, "Resumed");
      return frame;
    } catch (error) {
      await this.backend.ownership.release(frame.lease);
      throw error;
    }
  }
  private async suspend(
    frame: ExecutionFrame,
    decision: ControlDecision,
  ): Promise<never> {
    if (decision.decision !== "suspend")
      fail("InvalidTransition", "Expected suspension decision");
    const binding = frame.registry.find<{
      definition: InterruptionDefinition;
      pluginId: string;
    }>("interruption", decision.definitionId)!;
    const position = frame.cp.execution!,
      id = this.ids.next("interrupt");
    const tool = position.pendingToolExecutionIds[0]
      ? this.rows<ToolExecutionRecord>(frame, "tool_executions").find(
          (t) => t.id === position.pendingToolExecutionIds[0],
        )
      : null;
    const interrupt = {
      id,
      threadId: frame.cp.threadId,
      streamId: frame.stream.id,
      checkpointId: frame.cp.id,
      definitionId: decision.definitionId,
      definitionVersion: decision.definitionVersion,
      pluginId: decision.pluginId,
      payload: decision.payload,
      responseSchema: binding.definition.response.jsonSchema,
      actionRef: tool
        ? {
            toolExecutionId: tool.id,
            toolName: tool.toolName,
            argumentsDigest: canonicalJson(tool.arguments),
          }
        : null,
      status: "pending" as const,
      response: null,
      resolvedDecision: null,
      createdAt: this.clock.now(),
      resolvedAt: null,
      revision: frame.cp.revision,
    };
    this.put(frame, "interrupts", interrupt);
    position.pendingInterruptId = id;
    position.phase = "Suspended";
    frame.stream.status = "suspended";
    await this.commit(frame, "Suspended");
    await this.hook(frame, AgentEvents.StreamSuspended, {
      checkpointId: frame.cp.id,
      interrupt,
    });
    throw new Suspension();
  }
  private async prepareResume(
    request: Extract<ExecutionRequest, { kind: "resume" }>,
    sink: Attachment,
    registry: RegistryLease,
  ): Promise<ExecutionFrame> {
    const existing = this.resumeAdmissions.get(request.interruptId);
    if (existing) {
      await existing;
      fail("AlreadyResumed", "Another response was already committed");
    }
    const pending = this.prepareResumeFrame(request, sink, registry);
    this.resumeAdmissions.set(request.interruptId, pending);
    try {
      return await pending;
    } finally {
      this.resumeAdmissions.delete(request.interruptId);
    }
  }
  private async prepareResumeFrame(
    request: Extract<ExecutionRequest, { kind: "resume" }>,
    sink: Attachment,
    registry: RegistryLease,
  ): Promise<ExecutionFrame> {
    await validateResume(
      this.backend,
      registry,
      request.threadId,
      request.interruptId,
      request.value,
    );
    const head = await this.backend.threads.get(request.threadId);
    if (!head) fail("ThreadNotFound", "Thread not found");
    const stored = (await this.backend.checkpoints.get(
      head.currentCheckpointId,
    ))!;
    if (
      !stored.execution ||
      stored.execution.pendingInterruptId !== request.interruptId
    )
      fail("InvalidTransition", "Thread is not waiting for this interruption");
    validateManifest(
      stored.execution.registryManifest,
      registry,
      request.model,
    );
    const lease = await this.backend.ownership.acquire({
      threadId: request.threadId,
      ownerToken: this.ids.next("owner"),
      ttlMs: 30000,
    });
    try {
      const { interrupt, decision } = await validateResume(
        this.backend,
        registry,
        request.threadId,
        request.interruptId,
        request.value,
      );
      const cp = structuredClone(stored),
        records = new Map<string, RecordEntry>();
      for (const kind of [
        "streams",
        "turns",
        "model_attempts",
        "tool_executions",
        "interrupts",
        "plugin_states",
      ] as const)
        for (const row of await this.backend.executions.listRecords(
          kind,
          request.threadId,
        ))
          records.set(kind + ":" + ("id" in row ? row.id : ""), {
            kind,
            id: "id" in row ? row.id : "",
            threadId: request.threadId,
            data: structuredClone(row),
          } as RecordEntry);
      const stream = (
        records.get("streams:" + interrupt.streamId) as { data: StreamRecord }
      ).data;
      if (interrupt.actionRef?.toolExecutionId) {
        const tool = this.rows<ToolExecutionRecord>(
          { records } as ExecutionFrame,
          "tool_executions",
        ).find((t) => t.id === interrupt.actionRef!.toolExecutionId);
        if (
          !tool ||
          canonicalJson(tool.arguments) !== interrupt.actionRef.argumentsDigest
        )
          fail("ResumeIncompatible", "Pending operation payload changed");
      }
      let frame!: ExecutionFrame;
      const state = new PluginStateAccess(
        [
          childStateDefinition,
          ...registry.list<PluginStateDefinition<any>>("state"),
        ],
        { type: "thread", id: request.threadId },
        cp.state.pluginStates,
        async () => {
          await this.commit(frame, "PluginStateCommitted");
          return frame.cp.id;
        },
        undefined,
        this.backend.ownedState,
      );
      frame = {
        request,
        sink,
        registry,
        lease,
        cp,
        stream,
        records,
        state,
        admitted: true,
        sequence: 0,
      };
      const position = cp.execution!,
        cursor = position.handlerCursor;
      if (!cursor) fail("ResumeIncompatible", "Missing continuation cursor");
      const previous = cursor.decisions.at(-2) as ControlDecision | undefined;
      const resolved =
        previous && ["deny", "stop"].includes(previous.decision)
          ? previous
          : decision;
      cursor.decisions = [
        ...cursor.decisions.slice(0, -1),
        resolved as unknown as JsonValue,
      ];
      position.phase = phaseForEvent(cursor.eventId);
      position.pendingInterruptId = null;
      if (request.model) {
        position.modelRef = request.model;
        position.registryManifest = position.registryManifest.filter(
          (r) => r.kind !== "provider",
        );
        const provider = registry.values.find(
          (r) => r.kind === "provider" && r.id === request.model!.providerId,
        );
        if (!provider)
          fail("MissingProvider", "Override model provider missing");
        position.registryManifest = [
          ...position.registryManifest,
          {
            pluginId: provider.pluginId,
            kind: provider.kind,
            id: provider.id,
            version: provider.version,
            requiredForContinuation: true,
          },
        ];
      }
      stream.status = "running";
      this.put(frame, "interrupts", {
        ...interrupt,
        status: "resolved",
        response: request.value,
        resolvedDecision: resolved as unknown as JsonValue,
        resolvedAt: this.clock.now(),
        revision: cp.revision + 1,
      });
      sink.setId(stream.id);
      await this.commit(frame, "Resumed");
      return frame;
    } catch (error) {
      await this.backend.ownership.release(lease);
      throw error;
    }
  }
  private async finish(
    frame: ExecutionFrame,
    status: "completed" | "stopped" | "failed" | "cancelled",
    reason: string | null,
    error: ErrorInfo | null = null,
  ): Promise<void> {
    const pending = new Set<string>();
    for (const message of frame.cp.state.messages) {
      for (const part of message.content)
        if (part.type === "tool-call") pending.add(part.toolCallId);
      if (message.role === "tool") pending.delete(message.toolCallId!);
    }
    for (const toolCallId of pending) {
      const message = MessageCodec.encode(
        new ToolMessage({ toolCallId, content: "Execution " + status }),
      );
      frame.cp.state = {
        ...frame.cp.state,
        messages: [...frame.cp.state.messages, message],
      };
      frame.stream.outputMessageIds = [
        ...frame.stream.outputMessageIds,
        message.id,
      ];
      const tool = this.rows<ToolExecutionRecord>(
        frame,
        "tool_executions",
      ).find(
        (t) => t.toolCallId === toolCallId && t.streamId === frame.stream.id,
      );
      if (tool && tool.status === "pending") {
        tool.status = "cancelled";
        tool.resultMessageId = message.id;
        tool.endedAt = this.clock.now();
      }
    }
    frame.stream.status = status;
    frame.stream.stopReason = reason;
    frame.stream.error = error;
    frame.stream.endedAt = this.clock.now();
    await this.updateUsage(frame);
    let outcome: StreamOutcome = {
      status,
      reason,
      output: frame.cp.state.messages.filter((m) =>
        frame.stream.outputMessageIds.includes(m.id),
      ),
      usage: frame.stream.directUsage,
      error,
      interrupt: null,
    };
    try {
      await this.hook(frame, AgentEvents.StreamBeforeEnd, immutable(outcome));
    } catch (finalizationError) {
      if (!error && status !== "cancelled") {
        status = "failed";
        error = errorInfo(finalizationError);
        reason = "FinalizationFailed";
        frame.stream.status = status;
        frame.stream.error = error;
        frame.stream.stopReason = reason;
        outcome = { ...outcome, status, error, reason };
      }
    }
    const activeTurns = this.rows<TurnRecord>(frame, "turns").filter(
      (turn) => turn.status === "running",
    );
    for (const turn of activeTurns) {
      turn.status = status;
      turn.stopReason = reason;
      turn.error = error;
      turn.endedAt = this.clock.now();
      turn.durationMs = Date.parse(turn.endedAt) - Date.parse(turn.startedAt);
    }
    frame.cp.execution = null;
    await this.commit(frame, "Terminal");
    for (const turn of activeTurns)
      await this.hook(frame, AgentEvents.TurnEnd, {
        turnId: turn.id,
        usage: turn.usage,
      });
    await this.hook(frame, AgentEvents.StreamEnd, immutable(outcome));
  }
  async cancel(
    threadId: string,
    streamId: string,
    reason = "Cancelled",
    target: DeliveryTarget = { kind: "observer", observe: () => {} },
  ): Promise<void> {
    const active = this.active.get(streamId);
    if (active) {
      if (active.cp.threadId !== threadId)
        fail("InvalidTransition", "Execution belongs to a different thread");
      await this.hook(active, AgentEvents.StreamCancel, { reason });
      active.sink.controller.abort(reason);
      return;
    }
    const registry = this.registry.capture(),
      sink = createDelivery(
        threadId,
        this.ids,
        target,
        undefined,
        this.runtime().report,
      );
    let frame: ExecutionFrame | undefined;
    try {
      frame = await this.restoreFrame(
        { kind: "recover", threadId, streamId },
        sink,
        registry,
        false,
      );
      this.watchLease(frame);
      if (frame.cp.execution?.phase === "ToolPending") {
        const toolRecord = this.rows<ToolExecutionRecord>(
          frame,
          "tool_executions",
        ).find(
          (t) => t.id === frame!.cp.execution!.pendingToolExecutionIds[0],
        )!;
        const tool = registry.find<Tool>("tool", toolRecord.toolName);
        const outcome =
          tool?.recovery && toolRecord.idempotencyKey
            ? await tool.recovery.reconcile({
                id: toolRecord.id,
                input: tool.input.parse(toolRecord.arguments),
                key: toolRecord.idempotencyKey,
              })
            : { status: "unknown" as const };
        if (outcome.status === "unknown") {
          frame.stream.status = "interrupted";
          toolRecord.status = "interrupted";
          await this.commit(frame, "ExecutionTransition");
          fail(
            "RecoveryRequired",
            "Cannot close unknown external tool outcome",
          );
        }
        if (outcome.status === "completed") {
          toolRecord.status = "succeeded";
          toolRecord.result = outcome.result;
          const message = MessageCodec.encode(
            new ToolMessage({
              toolCallId: toolRecord.toolCallId,
              content: outcome.result.content,
            }),
          );
          toolRecord.resultMessageId = message.id;
          await this.appendMessage(frame, message);
        } else toolRecord.status = "pending";
      }
      for (const interrupt of this.rows<
        import("./state/schema.js").InterruptRecord
      >(frame, "interrupts"))
        if (interrupt.streamId === streamId && interrupt.status === "pending") {
          interrupt.status = "cancelled";
          interrupt.resolvedAt = this.clock.now();
        }
      for (const attempt of this.rows<ModelAttemptRecord>(
        frame,
        "model_attempts",
      ))
        if (attempt.streamId === streamId && attempt.status === "running") {
          attempt.status = "cancelled";
          attempt.endedAt = this.clock.now();
        }
      await this.hook(frame, AgentEvents.StreamCancel, { reason });
      await this.finish(frame, "cancelled", reason);
    } finally {
      if (frame) {
        if (frame.heartbeat) clearInterval(frame.heartbeat);
        await this.backend.ownership.release(frame.lease);
      }
      await registry.release();
      sink.close();
    }
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    for (const frame of this.active.values())
      frame.sink.controller.abort("Controller disposed");
    await Promise.allSettled([...this.jobs]);
  }
}
