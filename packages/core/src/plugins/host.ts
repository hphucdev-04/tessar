import { TesseractError, fail, requireId, type ErrorInfo } from "../errors.js";
import { dispatch } from "../events/dispatcher.js";
import { AgentEvents } from "../events/catalog.js";
import type { AnyEvent, EventContext, PayloadOf, ResultOf } from "../events/definition.js";
import type { HookContext, Plugin, PluginContext } from "./context.js";
import { RegistryLease, type PluginSlot, type ValueRegistration } from "./registry.js";
import { definePluginState } from "../state/plugin-state.js";
export class PluginHost {
  private slots: PluginSlot[] = [];
  private generation = 0;
  private definitions = new Map<string, AnyEvent>(Object.values(AgentEvents).map(d => [d.id, d]));
  private mutation: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly diagnostics: (error: ErrorInfo) => void;
  constructor(options: { diagnostics?: (error: ErrorInfo) => void } = {}) { this.diagnostics = options.diagnostics ?? (() => {}); }
  async initialize(plugins: readonly Plugin[]): Promise<void> {
    try { for (const plugin of plugins) await this.attach(plugin); } catch (error) { await this.dispose(); throw error; }
  }
  private serialize(action: () => Promise<void>): Promise<void> { const next = this.mutation.then(action); this.mutation = next.catch(() => {}); return next; }
  attach(plugin: Plugin): Promise<void> { return this.serialize(async () => {
    if (this.closed) fail("Disposed", "Plugin host is closed");
    requireId(plugin.id, "plugin id");
    if (plugin.apiVersion !== 1) fail("PluginIncompatible", "Unsupported plugin API");
    if (this.slots.some(s => !s.detached && s.plugin.id === plugin.id)) fail("RegistrationConflict", "Plugin ID already attached");
    const slot: PluginSlot = { plugin, handlers: [], values: [], disposers: [], references: 0, detached: false, disposed: false };
    const definitions = new Map(this.definitions);
    const register = (kind: string, id: string, value: unknown, version = 1) => {
      requireId(id);
      if ([...this.slots.filter(s => !s.detached).flatMap(s => s.values), ...slot.values].some(v => v.kind === kind && v.id === id)) fail("RegistrationConflict", "Capability already registered");
      slot.values.push({ kind, id, value, version, pluginId: plugin.id });
    };
    const api: PluginContext = {
      registry: { register },
      interruptions: { register: definition => register("interruption",definition.id,{definition,pluginId:plugin.id},definition.version) },
      state: { define: definition => { const state=definePluginState({...definition,pluginId:plugin.id}); register("state",plugin.id+":"+state.namespace,state,state.schemaVersion); return state; } },
      tools: { register: tool => register("tool", tool.name, tool) },
      models: { registerProvider: provider => register("provider", provider.id, provider) },
      storage: { registerBackend: backend => { register("storage", "primary", backend); api.defer(() => backend.close()); } },
      defer: disposer => { slot.disposers.push(disposer); },
      on: (definition, handler) => {
        const prior = definitions.get(definition.id);
        if (prior && (prior.owner !== definition.owner || prior.kind !== definition.kind || prior.version !== definition.version))
          fail("RegistrationConflict", "Event definition conflict");
        if (!prior && (definition.owner === "core" || definition.owner !== plugin.id)) fail("RegistrationConflict", "Invalid event owner");
        definitions.set(definition.id, definition);
        const registration = { definition, handler, pluginId: plugin.id, id: plugin.id + ":" + definition.id + ":" + slot.handlers.length };
        slot.handlers.push(registration);
        return () => { const index = slot.handlers.indexOf(registration); if (index >= 0) slot.handlers.splice(index, 1); };
      },
      emit: (definition, payload) => this.dispatch(definition, payload),
    };
    this.extendContext(api, register);
    try {
      const disposer = await plugin.setup(api);
      if (disposer) slot.disposers.push(disposer);
      this.slots.push(slot); this.definitions = definitions; this.generation++;
    } catch (error) { slot.detached = true; await this.releaseSlot(slot); throw error; }
  }); }
  protected extendContext(_api: PluginContext, _register: (kind: string, id: string, value: unknown, version?: number) => void): void {}
  detach(id: string): Promise<void> { return this.serialize(async () => { const slot = this.slots.find(s => s.plugin.id === id && !s.detached); if (!slot) return; slot.detached = true; this.generation++; await this.releaseSlot(slot); }); }
  private async releaseSlot(slot: PluginSlot): Promise<void> {
    if (!slot.detached || slot.references || slot.disposed) return;
    slot.disposed = true;
    for (const dispose of slot.disposers.slice().reverse()) { try { await dispose(); } catch { this.diagnostics({ code: "PluginDisposeError", message: "Plugin cleanup failed", retryable: false }); } }
  }
  capture(): RegistryLease { return new RegistryLease(this.generation, this.slots.filter(s => !s.detached), slot => this.releaseSlot(slot)); }
  async dispatch<D extends AnyEvent>(definition: D, payload: PayloadOf<D>, context: HookContext & EventContext = {}, captured?: RegistryLease): Promise<ResultOf<D>> {
    const lease = captured ?? this.capture();
    try { return await dispatch(lease, definition, payload, context, this.diagnostics); } finally { if (!captured) await lease.release(); }
  }
  registrations(): readonly ValueRegistration[] { return this.slots.filter(s => !s.detached).flatMap(s => s.values); }
  async dispose(): Promise<void> { this.closed = true; for (const slot of this.slots.slice().reverse()) { slot.detached = true; await this.releaseSlot(slot); } }
}
