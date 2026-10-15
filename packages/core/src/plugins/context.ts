import type { AnyEvent, EventEnvelope, PayloadOf, ResultOf } from "../events/definition.js";
import type { Tool } from "../tools/tool.js";
import type { ModelProviderRegistration } from "../models/contract.js";
export type Disposer = () => void | Promise<void>;
export interface HookContext { readonly signal?: AbortSignal; readonly [key: string]: unknown }
export type EventHandler<D extends AnyEvent> = (event: EventEnvelope<PayloadOf<D>>, context: HookContext) => ResultOf<D> | Promise<ResultOf<D>>;
export interface PluginContext {
  readonly tools: { register(tool: Tool): void };
  readonly models: { registerProvider(provider: ModelProviderRegistration): void };
  on<D extends AnyEvent>(definition: D, handler: EventHandler<D>): Disposer;
  emit<D extends AnyEvent>(definition: D, payload: PayloadOf<D>): Promise<ResultOf<D>>;
  defer(disposer: Disposer): void;
  readonly registry: { register(kind: string, id: string, value: unknown, version?: number): void };
}
export interface Plugin { readonly id: string; readonly apiVersion: number; setup(api: PluginContext): void | Disposer | Promise<void | Disposer> }
