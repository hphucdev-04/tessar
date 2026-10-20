import { stream as streamHooks } from "./events/type.js";
import type { Controller } from "./controller.js";
import type { Model } from "./models/profile.js";
import type {
  ModelAdapter,
  ModelOptions,
  ModelRef,
} from "./models/contract.js";
import type { Scope, InterruptRecord, StreamLimits } from "./state/schema.js";
import type { StreamRecord } from "./trace/records.js";
import type { StorageBackend } from "./state/storage-ports.js";
import type { PluginHost } from "./plugins/host.js";
import {
  createDelivery,
  type Stream,
  type DeliveryTarget,
} from "./engine/delivery.js";
export type { Stream, DeliveryTarget } from "./engine/delivery.js";
import {
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

import { MessageCodec } from "./messages/codec.js";
import type { MessageData } from "./messages/message.js";
import { Tool } from "./tools/tool.js";
import { execute, cancel } from "./engine/execution.js";
import type {
  ExecutionContext,
  ExecutionFrame,
  ExecutionRequest,
} from "./engine/frame.js";
export type {
  ExecutionFrame,
  ExecutionRequest,
  ExecutionOrigin,
} from "./engine/frame.js";
import { hook } from "./engine/hooks.js";
import {
  put,
  rows,
  commit,
  updateUsage,
  prepareMessage,
  appendMessage,
  finish,
} from "./engine/checkpoint.js";
import { services } from "./engine/services.js";
import { callAgent, modelRef, readOutcome } from "./engine/call.js";
import type { ExecutionRuntime } from "./engine/runtime.js";
import { isModelAdapter } from "./models/stream.js";
import { reserveId } from "./identity.js";
import {
  resumeAgent,
  cancelRetained,
  closeStandalone,
} from "./engine/continuation.js";

export type ModelSelection = ModelAdapter | Model | ModelRef;
export type AgentInput = string | MessageData | readonly MessageData[];
export interface AgentOptions<M extends ModelSelection = ModelSelection> {
  id: string;
  model: M;
  instructions?: string | Instruction;
  limits?: Partial<StreamLimits>;
  tools?: AgentTools;
}
export interface AgentTools {
  concurrency?: number;
  readonly [alias: string]: Tool | number | undefined;
}
export interface AgentExecutionOptions<M = ModelAdapter> {
  model?: M | Model | ModelRef | string;
  modelOptions?: ModelOptions<M>;
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
export interface AgentResumeOptions {
  threadId: string;
  interruptId: string;
  value: JsonValue;
  scope?: Scope;
  signal?: AbortSignal;
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
export class Agent<M extends ModelSelection = ModelSelection> {
  readonly id: string;
  readonly tools: readonly Tool[];
  /** @internal */ readonly toolConcurrency: number;
  readonly model: M;
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
  private readonly outcomes = new WeakMap<Stream, Promise<GenerateOutcome>>();
  private readonly active = new Map<string, ExecutionFrame>();
  private readonly pendingModels = new Map<string, ModelAdapter>();
  private closed = false;
  private readonly releaseId: () => void;
  private readonly resumeAdmissions = new Map<
    string,
    Promise<ExecutionFrame>
  >();
  constructor(options: AgentOptions<M>) {
    this.id = requireId(options.id, "agent id");
    if (!options.model) fail("MissingModel", "Agent requires a default model");
    const { concurrency, ...tools } = options.tools ?? {};
    if (
      concurrency !== undefined &&
      (!Number.isInteger(concurrency) || concurrency < 1)
    )
      fail(
        "InvalidConfiguration",
        "Tool concurrency must be a positive integer",
      );
    const values = Object.values(tools);
    if (values.some((tool) => !(tool instanceof Tool)))
      fail("InvalidConfiguration", "Agent tools must be Tool instances");
    this.tools = Object.freeze(values as Tool[]);
    if (new Set(this.tools.map((tool) => tool.name)).size !== this.tools.length)
      fail("RegistrationConflict", "Tool name already registered");
    this.toolConcurrency = concurrency ?? Infinity;
    this.model = (
      "ref" in options.model ? options.model : immutable(options.model)
    ) as M;
    const ref = modelRef(this.model);
    requireId(ref.providerId, "provider id");
    requireId(ref.modelId, "model id");
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
    this.releaseId = reserveId("Agent", this.id, this);
  }
  stream<T extends ModelAdapter = Extract<M, ModelAdapter>>(
    input: AgentInput,
    options: AgentExecutionOptions<T> = {},
  ): Stream {
    return callAgent(this, input, options, this.controller);
  }
  async generate<T extends ModelAdapter = Extract<M, ModelAdapter>>(
    input: AgentInput,
    options: AgentExecutionOptions<T> = {},
  ): Promise<GenerateOutcome> {
    const stream = this.stream(input, options);
    for await (const event of stream)
      if (event.is(streamHooks.error)) throw errorFromInfo(event.payload.error);
    return this.outcomes.get(stream)!;
  }
  resume(options: AgentResumeOptions): Stream {
    if (this.closed) fail("Disposed", "Agent closed");
    return resumeAgent(this, options, this.controller);
  }
  /** @internal Shared admission for Thread, Session and testing. */
  admit(
    request: ExecutionRequest,
    target: DeliveryTarget = { kind: "iterator" },
    prepare?: () => Promise<void>,
    runtime?: ExecutionRuntime,
    cleanup?: (outcome?: GenerateOutcome) => Promise<void>,
    admitted?: () => void,
  ): Stream {
    const environment = runtime ?? this.runtime();
    if (environment === this.controller) this.controller!.requireReady();
    if (this.closed) fail("Disposed", "Agent closed");
    if (request.kind === "input")
      validateLimits({ ...this.limits, ...request.limits });
    if (
      !request.adapter &&
      isModelAdapter(this.model) &&
      request.model?.providerId === this.model.ref.providerId &&
      request.model.connectionId === this.model.ref.connectionId
    ) {
      request = {
        ...request,
        adapter:
          request.model.modelId === this.model.ref.modelId
            ? this.model
            : this.model.withModel?.(request.model.modelId),
      };
    }
    const sink = createDelivery(
      request.threadId,
      this.ids,
      target,
      request.signal,
      environment.report,
    );
    const registry = environment.hooks.capture();
    if (admitted) {
      const notify = sink.admitted;
      sink.admitted = () => {
        admitted();
        notify();
      };
    }
    const outcome = (async () => {
      let entered = false;
      let result: GenerateOutcome | undefined;
      try {
        await prepare?.();
        if (this.closed) fail("Disposed", "Agent closed");
        entered = true;
        const failure = await execute(
          this.executionContext(environment),
          request,
          sink,
          registry,
        );
        if (failure !== undefined && errorInfo(failure).source === "provider")
          throw failure;
        result = await readOutcome(environment, sink.stream);
        return result;
      } catch (error) {
        if (!entered) await registry.release();
        environment.report(errorInfo(error));
        sink.emit(
          streamHooks.error,
          {
            error: errorInfo(error),
            lastKnownCheckpointId: null,
            persistedStatus: null,
          },
          {},
        );
        sink.rejected(errorInfo(error));
        sink.close();
        throw error;
      } finally {
        await cleanup?.(result);
      }
    })();
    this.outcomes.set(sink.stream, outcome);
    const job = outcome.then(
      () => {},
      () => {},
    );
    this.jobs.add(job);
    void job.then(() => this.jobs.delete(job));
    return sink.stream;
  }
  private executionContext(
    runtime: ExecutionRuntime = this.runtime(),
  ): ExecutionContext {
    const execution: ExecutionContext = {
      agent: this,
      runtime,
      active: this.active,
      pendingModels: this.pendingModels,
      resumeAdmissions: this.resumeAdmissions,
      ids: this.ids,
      clock: this.clock,
      toolConcurrency: this.toolConcurrency,
      hook: (frame, definition, payload, toolExecutionId) =>
        hook(execution, frame, definition, payload, toolExecutionId),
      put,
      rows,
      commit: (frame, cause) => commit(execution, frame, cause),
      updateUsage: (frame) => updateUsage(execution, frame),
      prepareMessage: (frame, message) =>
        prepareMessage(execution, frame, message),
      appendMessage: (frame, message) =>
        appendMessage(execution, frame, message),
      services: (frame, toolExecutionId) =>
        services(execution, frame, toolExecutionId),
      finish: (frame, status, reason, error) =>
        finish(execution, frame, status, reason, error),
    };
    return execution;
  }
  async cancel(
    threadId: string,
    streamId: string,
    reason = "Cancelled",
    target: DeliveryTarget = { kind: "observer", observe: () => {} },
    context: Pick<ExecutionRequest, "session" | "thread"> = {},
  ): Promise<void> {
    return cancelRetained(this, threadId, reason, (runtime) =>
      cancel(
        this.executionContext(runtime ?? this.runtime()),
        threadId,
        streamId,
        reason,
        target,
        context,
      ),
    );
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    for (const frame of this.active.values())
      frame.sink.controller.abort("Controller disposed");
    await Promise.allSettled([...this.jobs]);
    await closeStandalone(this);
    this.pendingModels.clear();
    this.releaseId();
  }
}
