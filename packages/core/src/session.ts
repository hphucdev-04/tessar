import { notifyObserver } from "./events/observer.js";
import {
  session as sessionHooks,
  stream as streamHooks,
} from "./events/type.js";
import type { Controller } from "./controller.js";
import { Thread, type ThreadStreamOptions } from "./thread.js";

import {
  EventEnvelope,
  type AnyEvent,
  type PayloadOf,
  type StreamEvent,
} from "./events/definition.js";
import {
  type ExecutionReceipt,
  type QueuedInputReceipt,
} from "./events/type.js";
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
  type JsonValue,
  type JsonObject,
} from "./json.js";
import { inputMessages } from "./messages/codec.js";
import type { Model, ModelProfile } from "./models/profile.js";
import type { ModelRegistry } from "./models/registry.js";
import { snapshotModelOptions } from "./models/options.js";
import type { ModelRef } from "./models/contract.js";
import type { MessageData } from "./messages/message.js";
import type { Scope, PageOptions, SessionRecord } from "./state/schema.js";
import { canonicalJson } from "./state/commit.js";
import type { CreateThreadOptions } from "./state/threads.js";
import type { ForkOptions } from "./state/fork.js";
import type { HistoryOptions } from "./state/queries.js";
import type { Stream } from "./engine/delivery.js";
import {
  createThread,
  getThread,
  listThreads,
  renameThread,
  forkThread,
  deleteThread,
  purgeThread,
} from "./state/thread-operations.js";
export interface SessionOptions {
  scope?: Scope;
  model?: Model | ModelRef;
  metadata?: JsonObject;
}
export type SessionThreadOptions = Pick<
  CreateThreadOptions,
  "title" | "messages" | "metadata"
>;
export interface SessionModelInfo {
  readonly id: string;
  readonly name: string;
  readonly profile: Readonly<ModelProfile>;
}
export interface ThreadTarget {
  threadId?: string;
}
type Observer = (event: StreamEvent) => unknown;
interface QueuedInput {
  receipt: QueuedInputReceipt;
  thread: Thread;
  model: ModelRef;
  modelOptions?: JsonObject;
  messages: readonly MessageData[];
}
interface Foreground {
  thread: Thread;
  stream?: Stream;
  streamId?: string;
  status: string;
  done: Promise<void>;
  close: () => void;
  admitted: boolean;
  closed: boolean;
}

export class Session {
  readonly agent;
  private readonly sessionScope: Scope;
  readonly id: string;
  metadata(): JsonObject {
    return this.record.metadata;
  }
  scope(): Scope {
    return this.sessionScope;
  }
  private selection: Thread | null = null;
  private selectedModel: Model;
  private readonly observers = new Set<Observer>();
  private readonly queue: QueuedInput[] = [];
  private readonly blocked = new Set<string>();
  private foreground?: Foreground;
  private disposed = false;
  private closing = false;
  private disposal?: Promise<void>;
  private sequence = 0;
  private controlPending = false;

  private async control<T>(action: () => Promise<T>): Promise<T> {
    this.check();
    if (this.controlPending)
      fail("SessionBusy", "Session control operation is pending");
    this.controlPending = true;
    try {
      await this.assertCurrent();
      return await action();
    } finally {
      this.controlPending = false;
    }
  }

  /** @internal */
  static create(
    controller: Controller,
    record: SessionRecord,
    model: Model,
    modelCatalog: ModelRegistry,
    thread: Thread | null = null,
  ): Session {
    return new Session(controller, record, model, modelCatalog, thread);
  }
  private constructor(
    readonly controller: Controller,
    private record: SessionRecord,
    model: Model,
    private readonly modelCatalog: ModelRegistry,
    thread: Thread | null = null,
  ) {
    controller.requireReady();
    this.agent = controller.agent;
    this.sessionScope = record.scope;
    this.id = record.id;
    this.selection = thread;
    this.selectedModel = model;
  }
  /** @internal Called only after durable creation, never on restoration. */
  created(): void {
    this.notify(sessionHooks.created, { model: this.selectedModel.ref });
  }
  private async persist(
    patch: Partial<Pick<SessionRecord, "selectedThreadId" | "selectedModel">>,
  ): Promise<void> {
    const previous = this.record;
    const next = immutable({
      ...previous,
      ...patch,
      revision: previous.revision + 1,
      updatedAt: this.agent.clock.now(),
    });
    await this.controller.backend.sessions.compareAndSet(
      next,
      previous.revision,
    );
    this.record = next;
  }
  private async assertCurrent(): Promise<void> {
    const expected = this.record;
    const stored = await this.controller.backend.sessions.get(this.id, {
      scope: this.scope(),
    });
    this.check();
    if (
      !stored ||
      stored.revision !== expected.revision ||
      this.record !== expected
    )
      fail("CommitConflict", "Session changed; restore a current handle");
  }
  readonly model = Object.freeze({
    get: (): string => this.modelId(this.selectedModel.ref),
    name: (): string => this.selectedModel.ref.modelId,
    list: (): readonly SessionModelInfo[] => {
      this.check();
      const models = new Map(
        this.modelCatalog
          .list()
          .map((model) => [this.modelId(model.ref), model]),
      );
      models.set(this.model.get(), this.selectedModel);
      return immutable(
        [...models].map(([id, model]) => ({
          id,
          name: model.ref.modelId,
          profile: model.profile(),
        })),
      );
    },
    switch: (modelId: string, options?: JsonObject): Promise<void> =>
      this.switchModel(modelId, options),
  });
  private modelId(ref: ModelRef): string {
    return ref.providerId + "/" + ref.modelId;
  }
  private check(): void {
    this.controller.requireReady();
    if (this.disposed || this.closing)
      fail("Disposed", "Session is closing or disposed");
  }
  private get busy(): boolean {
    return this.foreground?.status === "running";
  }
  private checkSelectionChange(): void {
    this.check();
    if (this.busy) fail("SessionBusy", "Session has active work");
  }
  private checkThreadSelectionChange(): void {
    this.checkSelectionChange();
    if (this.queue.length) fail("SessionBusy", "Session has queued input");
  }
  private selected(id?: string): string {
    const value = id ?? this.selection?.id;
    if (!value) fail("ThreadNotSelected", "Select or create a Thread first");
    return value;
  }
  private async target(id?: string): Promise<Thread> {
    const thread = await getThread(this.controller, this.selected(id), {
      scope: this.scope(),
    });
    if (!thread) fail("ThreadNotFound", "Thread does not match Session scope");
    return thread;
  }
  private switchModel(modelId: string, options?: JsonObject): Promise<void> {
    return this.control(async () => {
      requireId(modelId, "model id");
      if (
        options !== undefined &&
        (!options || typeof options !== "object" || Array.isArray(options))
      )
        fail("InvalidConfiguration", "Model options must be an object");
      for (const key of [
        "api",
        "model",
        "input",
        "messages",
        "instructions",
        "tools",
        "stream",
        "apiKey",
        "baseURL",
        "defaultHeaders",
        "maxRetries",
        "timeout",
        "connectionId",
      ])
        if (options && key in options)
          fail("UnsupportedOption", key + " is not a model option");
      const previous = this.selectedModel.ref;
      const slash = modelId.indexOf("/");
      const ref =
        slash < 0
          ? { ...previous, modelId }
          : modelId.slice(0, slash) === previous.providerId
            ? { ...previous, modelId: modelId.slice(slash + 1) }
            : {
                providerId: modelId.slice(0, slash),
                modelId: modelId.slice(slash + 1),
              };
      const selected = this.controller.sessionModel(ref),
        next = selected.model;
      const effective =
        options === undefined
          ? selected.stored.options
          : snapshotModelOptions({ ...selected.stored.options, ...options });
      const payload = immutable({
        previous,
        model: next.ref,
        ...(this.record.selectedModel.options !== undefined
          ? { previousOptions: this.record.selectedModel.options }
          : {}),
        ...(effective !== undefined ? { options: effective } : {}),
      });
      await this.controller.hooks.authorize(
        sessionHooks.model.beforeChange,
        payload,
        this.context(),
      );
      this.check();
      await this.persist({
        selectedModel: {
          ...selected.stored,
          ...(effective !== undefined ? { options: effective } : {}),
        },
      });
      this.selectedModel = next;
      this.notify(sessionHooks.modelChanged, payload);
    });
  }
  subscribe(observer: Observer): () => void;
  subscribe<N extends AnyEvent>(
    name: N,
    observer: (event: EventEnvelope<PayloadOf<N>, N>) => unknown,
  ): () => void;
  subscribe(
    nameOrObserver: AnyEvent | Observer,
    observer?: (event: any) => unknown,
  ): () => void {
    this.check();
    const handler: Observer =
      typeof nameOrObserver === "function"
        ? nameOrObserver
        : (event) => {
            if (event.type === nameOrObserver) return observer!(event);
          };
    this.observers.add(handler);
    return () => {
      this.observers.delete(handler);
    };
  }
  private emit(event: EventEnvelope): void {
    for (const observer of [...this.observers])
      notifyObserver(observer, event as StreamEvent, this.controller.report);
  }
  private context() {
    return {
      session: this,
      sessionId: this.id,
      controllerId: this.controller.id,
      agentId: this.agent.id,
      scope: this.scope(),
      threadId: this.selection?.id,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
    };
  }
  private notify<N extends AnyEvent>(name: N, payload: PayloadOf<N>): void {
    const context = this.context();
    this.emit(new EventEnvelope(name, payload, context));
    void this.controller.hooks
      .dispatch(name, payload, context)
      .catch((error) => this.controller.report(errorInfo(error)));
  }
  readonly thread = {
    create: (options: SessionThreadOptions = {}): Promise<Thread> =>
      this.control(async () => {
        this.checkThreadSelectionChange();
        if (
          Object.keys(options).some(
            (key) => !["title", "messages", "metadata"].includes(key),
          )
        )
          fail(
            "InvalidConfiguration",
            "Thread creation accepts title, messages and metadata only",
          );
        const thread = await createThread(
          this.controller,
          {
            ...options,
            scope: this.scope(),
          },
          this,
        );
        this.checkThreadSelectionChange();
        await this.persist({ selectedThreadId: thread.id });
        this.selection = thread;
        this.notify(sessionHooks.threadCreated, { threadId: thread.id });
        return thread;
      }),
    switch: (id: string): Promise<Thread> =>
      this.control(async () => {
        this.checkThreadSelectionChange();
        const thread = await this.target(id);
        this.checkThreadSelectionChange();
        const previousThreadId = this.selection?.id ?? null;
        await this.controller.hooks.authorize(
          sessionHooks.thread.beforeSwitch,
          immutable({ previousThreadId, threadId: id }),
          this.context(),
        );
        this.checkThreadSelectionChange();
        const snapshot = await thread.snapshot();
        this.checkThreadSelectionChange();
        await this.persist({ selectedThreadId: thread.id });
        this.selection = thread;
        if (snapshot.activeStreamId) this.blocked.add(id);
        else this.blocked.delete(id);
        this.notify(sessionHooks.threadSwitched, {
          previousThreadId,
          threadId: id,
        });
        return thread;
      }),
    get: (id: string): Promise<Thread | null> => {
      this.check();
      return getThread(this.controller, id, { scope: this.scope() });
    },
    getId: (): string | null => this.selection?.id ?? null,
    list: (options: PageOptions = {}) => {
      this.check();
      return listThreads(this.controller, { ...options, scope: this.scope() });
    },
    rename: (title: string, target: ThreadTarget = {}): Promise<void> =>
      this.control(async () => {
        this.check();
        const id = this.selected(target.threadId);
        await renameThread(
          this.controller,
          id,
          title,
          { scope: this.scope() },
          this,
        );
        this.notify(sessionHooks.threadRenamed, { threadId: id, title });
      }),
    fork: (options: ForkOptions & ThreadTarget = {}): Promise<Thread> =>
      this.control(async () => {
        this.check();
        const sourceThreadId = this.selected(options.threadId),
          thread = await forkThread(
            this.controller,
            sourceThreadId,
            {
              ...options,
              scope: this.scope(),
            },
            this,
          );
        this.notify(sessionHooks.threadForked, {
          sourceThreadId,
          threadId: thread.id,
        });
        return thread;
      }),
    delete: (target: ThreadTarget = {}): Promise<void> =>
      this.removeThread(target, false),
    purge: (target: ThreadTarget = {}): Promise<void> =>
      this.removeThread(target, true),
    getHistory: async (options: HistoryOptions & ThreadTarget = {}) => {
      this.check();
      return (await this.target(options.threadId)).getHistory(options);
    },
  };
  private removeThread(
    target: ThreadTarget,
    permanent: boolean,
  ): Promise<void> {
    return this.control(async () => {
      this.check();
      const id = this.selected(target.threadId);
      await (permanent ? purgeThread : deleteThread)(
        this.controller,
        id,
        { scope: this.scope() },
        this,
      );
      const stored = await this.controller.backend.sessions.get(this.id, {
        scope: this.scope(),
      });
      const expected = {
        ...this.record,
        selectedThreadId:
          this.record.selectedThreadId === id
            ? null
            : this.record.selectedThreadId,
        revision:
          this.record.revision + (this.record.selectedThreadId === id ? 1 : 0),
        updatedAt: stored?.updatedAt,
      };
      if (!stored || canonicalJson(stored) !== canonicalJson(expected))
        fail(
          "CommitConflict",
          "Session changed during thread deletion; restore a current handle",
        );
      this.record = stored;
      if (this.selection?.id === id) this.selection = null;
      this.notify(sessionHooks.threadDeleted, { threadId: id });
    });
  }
  async followUp(
    input: MessageData | readonly MessageData[],
  ): Promise<QueuedInputReceipt> {
    this.check();
    if (!this.selection)
      fail("ThreadNotSelected", "Select or create a Thread first");
    await this.assertCurrent();
    const receipt = immutable({
      id: randomIds.next("input"),
      threadId: this.selection.id,
    });
    this.queue.push({
      receipt,
      thread: this.selection,
      model: immutable(this.record.selectedModel.ref),
      modelOptions: this.record.selectedModel.options,
      messages: inputMessages(input),
    });
    this.notify(sessionHooks.inputQueued, { receipt });
    queueMicrotask(() => this.pump());
    return receipt;
  }
  private discard(cause: string): void {
    for (const entry of this.queue.splice(0))
      this.notify(sessionHooks.inputDiscarded, {
        receipt: entry.receipt,
        cause,
      });
  }
  private pump(): void {
    if (
      this.disposed ||
      this.closing ||
      this.busy ||
      (this.foreground && !this.foreground.closed) ||
      !this.queue.length ||
      this.blocked.has(this.queue[0]!.thread.id)
    )
      return;
    const entry = this.queue.shift()!;
    void this.attach(
      entry.thread,
      {
        input: entry.messages,
        model: entry.model,
        modelOptions: entry.modelOptions,
      },
      true,
    ).catch(() => {});
  }
  private attach(
    thread: Thread,
    options: ThreadStreamOptions,
    input: boolean,
  ): Promise<ExecutionReceipt> {
    const previous = this.foreground;
    let resolveDone!: () => void;
    const foreground: Foreground = {
      thread,
      status: "running",
      done: new Promise((resolve) => (resolveDone = resolve)),
      close: () => resolveDone(),
      admitted: false,
      closed: false,
    };
    this.foreground = foreground;
    return new Promise((resolve, reject) => {
      const rejected = (error: ErrorInfo) => {
        reject(errorFromInfo(error));
      };
      const closed = () => {
        foreground.closed = true;
        foreground.close();
        if (!foreground.admitted && !input) {
          this.foreground = previous;
          return;
        }
        if (this.foreground === foreground) {
          if (
            foreground.status === "suspended" ||
            foreground.status === "interrupted"
          )
            this.blocked.add(thread.id);
          else {
            this.foreground = undefined;
            if (foreground.status !== "completed")
              this.discard(foreground.status);
          }
        }
        queueMicrotask(() => this.pump());
      };
      try {
        foreground.stream = thread.admit(
          options,
          {
            kind: "observer",
            admitted: (receipt) => {
              foreground.admitted = true;
              foreground.streamId = receipt.streamId;
              this.blocked.delete(thread.id);
              resolve(receipt);
            },
            rejected,
            observe: (event) => {
              if (event.type === streamHooks.end)
                foreground.status = event.payload.status;
              if (event.type === streamHooks.suspended)
                foreground.status = "suspended";
              if (event.type === streamHooks.error)
                foreground.status = event.payload.persistedStatus ?? "failed";
              this.emit(event);
            },
            closed,
          },
          this,
        );
      } catch (error) {
        foreground.status = "failed";
        rejected(errorInfo(error));
        closed();
      }
    });
  }
  private async continue(
    options: ThreadStreamOptions,
  ): Promise<ExecutionReceipt> {
    this.check();
    if (this.busy) fail("SessionBusy", "Session has active work");
    await this.assertCurrent();
    const thread = await this.target();
    if (this.busy) fail("SessionBusy", "Session has active work");
    await this.foreground?.done;
    this.check();
    if (this.busy) fail("SessionBusy", "Session has active work");
    return this.attach(thread, options, false);
  }
  resume(options: {
    interruptId: string;
    value: JsonValue;
    model?: Model | ModelRef;
  }): Promise<ExecutionReceipt> {
    return this.continue({
      resume: { interruptId: options.interruptId, value: options.value },
      model: options.model,
    });
  }
  recover(options: {
    streamId: string;
    model?: Model | ModelRef;
  }): Promise<ExecutionReceipt> {
    return this.continue({
      recover: { streamId: options.streamId },
      model: options.model,
    });
  }
  async abort(reason = "Cancelled"): Promise<void> {
    this.check();
    const foreground = this.foreground;
    if (foreground?.status === "running") {
      foreground.stream?.abort(reason);
      await foreground.done;
      return;
    }
    const thread = await this.target(),
      snapshot = await thread.snapshot();
    if (!snapshot.activeStreamId) return;
    await foreground?.done;
    await this.agent.cancel(
      thread.id,
      snapshot.activeStreamId,
      reason,
      {
        kind: "observer",
        observe: (event) => this.emit(event),
      },
      { session: this, thread },
    );
    this.blocked.delete(thread.id);
    this.foreground = undefined;
    this.discard("cancelled");
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.disposal) return this.disposal;
    if (this.controlPending)
      fail("SessionBusy", "Session control operation is pending");
    this.checkSelectionChange();
    this.closing = true;
    this.disposal = (async () => {
      try {
        await this.controller.hooks.dispatch(
          sessionHooks.beforeClose,
          {},
          this.context(),
        );
        await this.foreground?.done;
        this.discard("Closed");
        this.disposed = true;
        this.notify(sessionHooks.closed, {});
        this.observers.clear();
      } catch (error) {
        this.closing = false;
        this.disposal = undefined;
        queueMicrotask(() => this.pump());
        throw error;
      }
    })();
    return this.disposal;
  }
}
