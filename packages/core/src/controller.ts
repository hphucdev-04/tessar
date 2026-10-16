import {
  requireId,
  fail,
  errorInfo,
  TessarError,
  type ErrorInfo,
} from "./errors.js";
import { immutable, randomIds } from "./json.js";
import { AgentEvents } from "./events/catalog.js";
import { EventEnvelope, type EventContext } from "./events/definition.js";
import { PluginHost } from "./plugins/host.js";
import type { Plugin } from "./plugins/context.js";
import type { Agent } from "./agent.js";
import type { Model } from "./models/profile.js";
import type { ModelProviderRegistration, ModelRef } from "./models/contract.js";
import { ModelRegistry } from "./models/registry.js";
import { createMemoryBackend } from "./state/memory-backend.js";
import type { StorageBackend } from "./state/storage-ports.js";
import { StateQueries } from "./state/queries.js";
import { ThreadService, type CreateThreadOptions } from "./state/threads.js";
import { ForkService, type ForkOptions } from "./state/fork.js";
import type { PageOptions, StateQuery, ThreadInfo } from "./state/schema.js";
import type { PluginStateDefinition } from "./state/plugin-state.js";
import { canonicalJson } from "./state/commit.js";
import { Thread } from "./thread.js";
import { Session, type SessionOptions } from "./session.js";

export class Controller {
  readonly id: string;
  readonly agent: Agent;
  readonly models = new ModelRegistry();
  readonly diagnostics: ErrorInfo[] = [];
  readonly report = (error: ErrorInfo, context: EventContext = {}): void => {
    this.diagnostics.push(error);
    // Copy only event identity, never execution services from the failing hook.
    const event = new EventEnvelope(
      AgentEvents.Diagnostic,
      { error },
      {
        ...context,
        controllerId: this.id,
        agentId: this.agent.id,
      },
    );
    void this.hooks
      .dispatch(AgentEvents.Diagnostic, event.payload, { ...event })
      .catch(() => {});
  };
  /** @internal */ readonly hooks = new PluginHost({
    diagnostics: this.report,
  });
  /** @internal */ backend!: StorageBackend;
  /** @internal */ queries!: StateQueries;
  private phase:
    | "new"
    | "initializing"
    | "ready"
    | "failed"
    | "closing"
    | "closed" = "new";
  private initialization?: Promise<void>;
  private readonly initialPlugins: readonly Plugin[];
  private disposal?: Promise<void>;
  private defaultBackend = false;
  private readonly providers = new Map<ModelProviderRegistration, () => void>();
  readonly plugins = {
    attach: async (plugin: Plugin): Promise<void> => {
      this.requireReady();
      await this.hooks.attach(plugin);
      this.syncProviders();
    },
    detach: async (id: string): Promise<void> => {
      this.requireReady();
      if (
        this.hooks
          .registrations()
          .some((r) => r.kind === "storage" && r.pluginId === id)
      )
        fail(
          "InvalidTransition",
          "Storage backend cannot be detached while ready",
        );
      await this.hooks.detach(id);
      this.syncProviders();
    },
  };
  constructor(options: {
    id: string;
    agent: Agent;
    plugins?: readonly Plugin[];
  }) {
    this.id = requireId(options.id, "controller id");
    this.agent = options.agent;
    this.initialPlugins = Object.freeze([...(options.plugins ?? [])]);
    this.agent.attachController(this);
  }
  initialize(): Promise<void> {
    if (this.disposal)
      return Promise.reject(
        new TessarError("Disposed", "Controller is disposed"),
      );
    if (this.initialization) return this.initialization;
    if (this.phase !== "new")
      return Promise.reject(new Error("Controller is disposed"));
    this.phase = "initializing";
    this.initialization = (async () => {
      try {
        await this.hooks.initialize(this.initialPlugins);
        const selected = this.hooks
          .registrations()
          .find((r) => r.kind === "storage");
        this.backend =
          (selected?.value as StorageBackend) ?? createMemoryBackend();
        this.defaultBackend = !selected;
        this.queries = new StateQueries(this.backend);
        this.syncProviders();
        this.hooks.sealStorage();
        this.phase = "ready";
        await this.hooks.dispatch(
          AgentEvents.Ready,
          { agentId: this.agent.id },
          { controllerId: this.id, agentId: this.agent.id },
        );
        if ([...this.providers.keys()].some((p) => p.metadata))
          void this.models.refreshCatalog();
      } catch (error) {
        this.report(errorInfo(error));
        this.phase = "failed";
        this.models.dispose();
        await this.hooks.dispose();
        if (this.defaultBackend) await this.backend?.close();
        throw error;
      }
    })();
    return this.initialization;
  }
  /** @internal */ requireReady(): void {
    if (this.disposal || this.phase !== "ready")
      fail(
        this.disposal || this.phase === "closed" || this.phase === "closing"
          ? "Disposed"
          : "ControllerNotReady",
        "Controller must be initialized and ready",
      );
  }
  private syncProviders(): void {
    const current = this.hooks
      .registrations()
      .filter((r) => r.kind === "provider")
      .map((r) => r.value as ModelProviderRegistration);
    for (const [provider, remove] of this.providers)
      if (!current.includes(provider)) {
        remove();
        this.providers.delete(provider);
      }
    for (const provider of current)
      if (!this.providers.has(provider))
        this.providers.set(provider, this.models.registerProvider(provider));
  }
  /** @internal */ resolveModel(value: Model | ModelRef | undefined): Model {
    this.requireReady();
    if (!value)
      fail(
        "MissingModel",
        "Select a model explicitly or configure an Agent default",
      );
    const ref = "ref" in value ? value.ref : value;
    requireId(ref.providerId, "provider id");
    requireId(ref.modelId, "model id");
    return this.models.get(ref);
  }
  /** @internal */ async prepareThread(
    options: CreateThreadOptions = {},
    reservedId?: string,
  ): Promise<ThreadInfo> {
    this.requireReady();
    const prepared = await this.hooks.dispatch(
      AgentEvents.ThreadPrepare,
      options,
      { controllerId: this.id, agentId: this.agent.id, scope: options.scope },
    );
    if (
      canonicalJson(prepared.scope ?? {}) !== canonicalJson(options.scope ?? {})
    )
      fail("ThreadScopeMismatch", "Thread preparation cannot change scope");
    const ids = reservedId
      ? {
          next: (kind: string) =>
            kind === "thread" ? reservedId : randomIds.next(kind),
        }
      : randomIds;
    const info = await new ThreadService(this.backend, ids).create(prepared);
    await this.hooks.dispatch(AgentEvents.ThreadStarted, info, {
      controllerId: this.id,
      agentId: this.agent.id,
      threadId: info.id,
      scope: info.scope,
    });
    return info;
  }
  async createThread(options: CreateThreadOptions = {}): Promise<Thread> {
    return new Thread(this, await this.prepareThread(options));
  }
  createSession(options: SessionOptions = {}): Session {
    this.requireReady();
    return new Session(this, options);
  }
  async getThread(id: string, query: StateQuery = {}): Promise<Thread | null> {
    this.requireReady();
    const info = await this.queries.getThread(id, query);
    return info ? new Thread(this, info) : null;
  }
  listThreads(query: StateQuery & PageOptions = {}) {
    this.requireReady();
    return this.queries.listThreads(query);
  }
  async deleteThread(id: string, query: StateQuery = {}): Promise<void> {
    this.requireReady();
    await new ThreadService(this.backend).delete(id, query);
  }
  async renameThread(
    id: string,
    title: string,
    query: StateQuery = {},
  ): Promise<void> {
    this.requireReady();
    await new ThreadService(this.backend).rename(id, title, query);
  }
  async forkThread(
    id: string,
    options: ForkOptions & StateQuery = {},
  ): Promise<Thread> {
    this.requireReady();
    const defs = this.hooks
      .registrations()
      .filter((r) => r.kind === "state")
      .map((r) => r.value as PluginStateDefinition<any>);
    return new Thread(
      this,
      await new ForkService(this.backend, defs).fork(id, options),
    );
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposal = (async () => {
      if (this.initialization) await this.initialization.catch(() => {});
      this.phase = "closing";
      try {
        await this.agent.shutdown();
        await this.hooks.dispatch(
          AgentEvents.Shutdown,
          {},
          { controllerId: this.id, agentId: this.agent.id },
        );
      } catch (error) {
        this.report(errorInfo(error));
      } finally {
        this.models.dispose();
        await this.hooks.dispose();
        if (this.defaultBackend) await this.backend?.close();
        this.phase = "closed";
      }
    })();
    return this.disposal;
  }
}
