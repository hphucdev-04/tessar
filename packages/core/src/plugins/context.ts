import type { AnyEvent, EventEnvelope, PayloadOf, ResultOf, ContextOf } from "../events/definition.js";
import type { InterruptionDefinition } from "../engine/interrupt.js";
import type { EffectDefinition } from "../engine/tracked-effects.js";
import type { Tool } from "../tools/tool.js";
import type { ModelProviderRegistration } from "../models/contract.js";
import type { StorageBackend } from "../state/storage-ports.js";
import type { PluginStateDefinition } from "../state/plugin-state.js";
import type { JsonValue } from "../json.js";
export type Disposer = () => void | Promise<void>;
export interface HookContext { readonly signal?: AbortSignal; readonly [key: string]: unknown }
export type EventHandler<D extends AnyEvent> = (event: EventEnvelope<PayloadOf<D>>, context: ContextOf<D>) => ResultOf<D> | Promise<ResultOf<D>>;
export interface PluginContext {
  readonly effects:{register(definition:EffectDefinition):void};
  readonly interruptions: {register(definition:InterruptionDefinition):void};
  readonly state: { define<T extends JsonValue>(definition: Omit<PluginStateDefinition<T>, "pluginId">): PluginStateDefinition<T> };
  readonly storage: { registerBackend(backend: StorageBackend): void };
  readonly tools: { register(tool: Tool): void };
  readonly models: { registerProvider(provider: ModelProviderRegistration): void };
  on<D extends AnyEvent>(definition: D, handler: EventHandler<D>): Disposer;
  emit<D extends AnyEvent>(definition: D, payload: PayloadOf<D>): Promise<ResultOf<D>>;
  defer(disposer: Disposer): void;
  readonly registry: { register(kind: string, id: string, value: unknown, version?: number): void };
}
export interface Plugin { readonly id: string; readonly apiVersion: number; readonly version?:number; readonly configurationId?:string; setup(api: PluginContext): void | Disposer | Promise<void | Disposer> }
