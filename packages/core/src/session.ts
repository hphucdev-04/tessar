import type { Controller } from "./controller.js";
import { Thread, type ThreadStreamOptions } from "./thread.js";
import { AgentEvents } from "./events/catalog.js";
import {
  EventEnvelope,
  type AnyEvent,
  type PayloadOf,
  type StreamEvent,
} from "./events/definition.js";
import {
  SessionEvents,
  type ExecutionReceipt,
  type QueuedInputReceipt,
} from "./session-events.js";
import { errorInfo, fail, TesseractError, type ErrorInfo } from "./errors.js";
import { immutable, randomIds, type JsonValue } from "./json.js";
import { inputMessages } from "./agent.js";
import type { Model } from "./models/profile.js";
import type { ModelRef } from "./models/contract.js";
import type { MessageData } from "./messages/message.js";
import type { Scope, PageOptions } from "./state/schema.js";
import { normalizeScope } from "./state/scope.js";
import type { CreateThreadOptions } from "./state/threads.js";
import type { ForkOptions } from "./state/fork.js";
import type { HistoryOptions } from "./state/queries.js";
import type { Stream } from "./engine/delivery.js";
export interface SessionOptions {
  scope?: Scope;
  model?: Model | ModelRef;
}
export type SessionThreadOptions = Omit<CreateThreadOptions, "scope">;
export interface ThreadTarget {
  threadId?: string;
}
type Observer = (event: StreamEvent) => unknown;
interface QueuedInput {
  receipt: QueuedInputReceipt;
  thread: Thread;
  model: ModelRef;
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
  readonly scope: Scope;
  private selection: Thread | null = null;
  private selectedModel: Model;
  private readonly observers = new Set<Observer>();
  private readonly queue: QueuedInput[] = [];
  private readonly blocked = new Set<string>();
  private foreground?: Foreground;
  private disposed = false;
  private sequence = 0;

  constructor(
    readonly controller: Controller,
    options: SessionOptions = {},
  ) {
    controller.requireReady();
    this.agent = controller.agent;
    this.scope = normalizeScope(options.scope);
    this.selectedModel = controller.resolveModel(
      options.model ?? this.agent.model,
    );
    queueMicrotask(() => {
      if (!this.disposed)
        this.notify(SessionEvents.Created, { model: this.model.ref });
    });
  }
  get model(): Model {
    return this.selectedModel;
  }
  private check(): void {
    this.controller.requireReady();
    if (this.disposed) fail("Disposed", "Session is disposed");
  }
  private get busy(): boolean {
    return this.foreground?.status === "running";
  }
  private checkSelectionChange(): void {
    this.check();
    if (this.busy) fail("SessionBusy", "Session has active work");
  }
  private selected(id?: string): string {
    const value = id ?? this.selection?.id;
    if (!value) fail("ThreadNotSelected", "Select or create a Thread first");
    return value;
  }
  private async target(id?: string): Promise<Thread> {
    const thread = await this.controller.getThread(this.selected(id), {
      scope: this.scope,
    });
    if (!thread) fail("ThreadNotFound", "Thread does not match Session scope");
    return thread;
  }
  setModel(model: Model | ModelRef): void {
    this.check();
    const previous = this.model.ref;
    this.selectedModel = this.controller.resolveModel(model);
    this.notify(SessionEvents.ModelChanged, {
      previous,
      model: this.model.ref,
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
            if (event.type === nameOrObserver) observer!(event);
          };
    this.observers.add(handler);
    return () => {
      this.observers.delete(handler);
    };
  }
  private emit(event: EventEnvelope): void {
    for (const observer of [...this.observers]) {
      try {
        const result = observer(event as StreamEvent);
        if (
          result &&
          typeof (result as PromiseLike<unknown>).then === "function"
        )
          void Promise.resolve(result).catch((error) =>
            this.controller.report(errorInfo(error)),
          );
      } catch (error) {
        this.controller.report(errorInfo(error));
      }
    }
  }
  private context() {
    return {
      controllerId: this.controller.id,
      agentId: this.agent.id,
      scope: this.scope,
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
    create: async (options: SessionThreadOptions = {}): Promise<Thread> => {
      this.checkSelectionChange();
      const thread = await this.controller.createThread({
        ...options,
        scope: this.scope,
      });
      this.checkSelectionChange();
      this.selection = thread;
      this.notify(SessionEvents.ThreadCreated, { threadId: thread.id });
      return thread;
    },
    switch: async (id: string): Promise<Thread> => {
      this.checkSelectionChange();
      const thread = await this.target(id),
        snapshot = await thread.snapshot();
      this.checkSelectionChange();
      const previousThreadId = this.selection?.id ?? null;
      this.selection = thread;
      if (snapshot.activeStreamId) this.blocked.add(id);
      this.notify(SessionEvents.ThreadSwitched, {
        previousThreadId,
        threadId: id,
      });
      return thread;
    },
    get: (id: string): Promise<Thread | null> => {
      this.check();
      return this.controller.getThread(id, { scope: this.scope });
    },
    getId: (): string | null => this.selection?.id ?? null,
    list: (options: PageOptions = {}) => {
      this.check();
      return this.controller.listThreads({ ...options, scope: this.scope });
    },
    rename: async (title: string, target: ThreadTarget = {}): Promise<void> => {
      this.check();
      const id = this.selected(target.threadId);
      await this.controller.renameThread(id, title, { scope: this.scope });
      this.notify(SessionEvents.ThreadRenamed, { threadId: id, title });
    },
    fork: async (options: ForkOptions & ThreadTarget = {}): Promise<Thread> => {
      this.check();
      const sourceThreadId = this.selected(options.threadId),
        thread = await this.controller.forkThread(sourceThreadId, {
          ...options,
          scope: this.scope,
        });
      this.notify(SessionEvents.ThreadForked, {
        sourceThreadId,
        threadId: thread.id,
      });
      return thread;
    },
    delete: async (target: ThreadTarget = {}): Promise<void> => {
      this.check();
      const id = this.selected(target.threadId);
      await this.controller.deleteThread(id, { scope: this.scope });
      if (this.selection?.id === id) this.selection = null;
      this.notify(SessionEvents.ThreadDeleted, { threadId: id });
    },
    getHistory: async (options: HistoryOptions & ThreadTarget = {}) => {
      this.check();
      return (await this.target(options.threadId)).getHistory(options);
    },
  };
  async followUp(
    input: MessageData | readonly MessageData[],
  ): Promise<QueuedInputReceipt> {
    this.check();
    if (!this.selection)
      fail("ThreadNotSelected", "Select or create a Thread first");
    const receipt = immutable({
      id: randomIds.next("input"),
      threadId: this.selection.id,
    });
    this.queue.push({
      receipt,
      thread: this.selection,
      model: immutable(this.model.ref),
      messages: inputMessages(input),
    });
    this.notify(SessionEvents.InputQueued, { receipt });
    queueMicrotask(() => this.pump());
    return receipt;
  }
  private discard(cause: string): void {
    for (const entry of this.queue.splice(0))
      this.notify(SessionEvents.InputDiscarded, {
        receipt: entry.receipt,
        cause,
      });
  }
  private pump(): void {
    if (
      this.disposed ||
      this.busy ||
      (this.foreground && !this.foreground.closed) ||
      !this.queue.length ||
      this.blocked.has(this.queue[0]!.thread.id)
    )
      return;
    const entry = this.queue.shift()!;
    void this.attach(
      entry.thread,
      { input: entry.messages, model: entry.model },
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
        reject(new TesseractError(error.code, error.message));
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
        foreground.stream = thread.admit(options, {
          kind: "observer",
          admitted: (receipt) => {
            foreground.admitted = true;
            foreground.streamId = receipt.streamId;
            this.blocked.delete(thread.id);
            resolve(receipt);
          },
          rejected,
          observe: (event) => {
            if (event.is(AgentEvents.StreamEnd))
              foreground.status = event.payload.status;
            if (event.is(AgentEvents.StreamSuspended))
              foreground.status = "suspended";
            if (event.is(AgentEvents.StreamError))
              foreground.status = event.payload.persistedStatus ?? "failed";
            this.emit(event);
          },
          closed,
        });
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
    await this.agent.cancel(thread.id, snapshot.activeStreamId, reason, {
      kind: "observer",
      observe: (event) => this.emit(event),
    });
    this.blocked.delete(thread.id);
    this.foreground = undefined;
    this.discard("cancelled");
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.checkSelectionChange();
    await this.controller.hooks.dispatch(
      SessionEvents.BeforeClose,
      {},
      this.context(),
    );
    this.discard("Closed");
    this.disposed = true;
    this.notify(SessionEvents.Closed, {});
    this.observers.clear();
  }
}
