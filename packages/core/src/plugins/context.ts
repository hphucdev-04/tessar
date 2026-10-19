import type {
  AnyEvent,
  EventEnvelope,
  PayloadOf,
  ResultOf,
  ContextOf,
  HookOptions,
} from "../events/definition.js";
import type { InterruptionDefinition } from "../engine/interrupt.js";
import type { EffectDefinition } from "../engine/tracked-effects.js";
import type { Tool } from "../tools/tool.js";
import type { ModelProviderRegistration } from "../models/contract.js";
import type { StorageBackend } from "../state/storage-ports.js";
import type { PluginStateDefinition } from "../state/plugin-state.js";
import type { JsonValue } from "../json.js";
import type { Session } from "../session.js";
import type { Thread } from "../thread.js";
import type { Agent } from "../agent.js";
export type Disposer = () => void | Promise<void>;
/** Controls that do not wait for completion of the active execution. */
export type SessionHookHandle = Pick<Session, "id" | "scope" | "model" | "thread" | "setModel" | "followUp">;
export type ThreadHookHandle = Pick<Thread, "id" | "scope" | "snapshot" | "getHistory" | "getCheckpoint" | "listCheckpoints">;
export interface HookContext {
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
  readonly session?: SessionHookHandle;
  readonly thread?: ThreadHookHandle;
  readonly [key: string]: unknown;
}
export interface SessionHookContext extends HookContext {
  readonly session: SessionHookHandle;
}
export interface ThreadHookContext extends HookContext {
  readonly thread: ThreadHookHandle;
}
export type EventHandler<D extends AnyEvent> = (
  event: EventEnvelope<PayloadOf<D>, D>,
  context: ContextOf<D>,
) => ResultOf<D> | void | Promise<ResultOf<D> | void>;
export interface PluginContext {
  /** Registers an Agent owned by this plugin; shutdown follows plugin disposal. */
  readonly agent: { register(agent: Agent): void };
  readonly effects: { register(definition: EffectDefinition): void };
  readonly interruptions: {
    register(definition: InterruptionDefinition): void;
  };
  readonly state: {
    define<T extends JsonValue>(
      definition: Omit<PluginStateDefinition<T>, "pluginId">,
    ): PluginStateDefinition<T>;
  };
  readonly storage: { registerBackend(backend: StorageBackend): void };
  readonly tools: { register(tool: Tool): void };
  readonly models: {
    registerProvider(provider: ModelProviderRegistration): void;
  };
  hook<D extends AnyEvent>(
    name: D,
    handler: EventHandler<D>,
    options?: HookOptions,
  ): Disposer;
  emit<D extends AnyEvent>(
    definition: D,
    payload: PayloadOf<D>,
  ): Promise<ResultOf<D>>;
  defer(disposer: Disposer): void;
  readonly registry: {
    register(kind: string, id: string, value: unknown, version?: number): void;
  };
}
/** Instance contract implemented by built-in and user-defined plugin classes. */
export interface Plugin {
  readonly id: string;
  readonly version?: number;
  readonly configurationId?: string;
  setup(tessar: PluginContext): void | Disposer | Promise<void | Disposer>;
}
