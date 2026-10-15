import { immutable, type JsonObject } from "../json.js";
import { requireId } from "../errors.js";
export type EventKind = "notification" | "transformation" | "decision" | "barrier";
export interface EventDefinition<P, R, K extends EventKind = EventKind> {
  readonly id: string; readonly owner: string; readonly version: number; readonly kind: K;
  readonly __payload?: P; readonly __result?: R;
}
export type AnyEvent = EventDefinition<any, any, EventKind>;
export type PayloadOf<D> = D extends EventDefinition<infer P, any, any> ? P : never;
export type ResultOf<D> = D extends EventDefinition<any, infer R, any> ? R : never;
export function defineEvent<P, R, K extends EventKind>(config: { id: string; owner: string; version: number; kind: K }): EventDefinition<P, R, K> {
  requireId(config.id); requireId(config.owner);
  if (!Number.isInteger(config.version) || config.version < 1) throw new TypeError("Invalid event version");
  return Object.freeze({ ...config });
}
export interface EventContext {
  controllerId?: string; agentId?: string; scope?: JsonObject; threadId?: string;
  streamId?: string | null; handleId?: string; sequence?: number; timestamp?: string;
  checkpointRevision?: number;
}
export class EventEnvelope<P = any> implements EventContext {
  readonly controllerId?: string; readonly agentId?: string; readonly scope?: JsonObject;
  readonly threadId?: string; readonly streamId?: string | null; readonly handleId?: string;
  readonly sequence?: number; readonly timestamp?: string; readonly checkpointRevision?: number;
  constructor(readonly definition: EventDefinition<P, any>, readonly payload: P, context: EventContext = {}) {
    Object.assign(this, context); Object.freeze(this);
  }
  is<D extends AnyEvent>(definition: D): this is EventEnvelope<PayloadOf<D>> {
    return this.definition.id === definition.id && this.definition.owner === definition.owner && this.definition.version === definition.version;
  }
}
