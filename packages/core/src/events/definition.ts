import { immutable, type JsonObject } from "../json.js";
import { requireId } from "../errors.js";
import type { HookContext } from "../plugins/context.js";
export type EventKind = "notification" | "transformation" | "decision" | "barrier";
export interface EventDefinition<P, R, K extends EventKind = EventKind, C=HookContext> {
  readonly id: string; readonly owner: string; readonly version: number; readonly kind: K;
  readonly __payload?: P; readonly __result?: R; readonly __context?: C;
}
export type AnyEvent = EventDefinition<any, any, EventKind, any>;
export type PayloadOf<D> = D extends EventDefinition<infer P, any, any, any> ? P : never;
export type ResultOf<D> = D extends EventDefinition<any, infer R, any, any> ? R : never;
export type ContextOf<D> = D extends EventDefinition<any,any,any,infer C> ? C : never;
export function defineEvent<P, R, K extends EventKind,C=HookContext>(config: { id: string; owner: string; version: number; kind: K }): EventDefinition<P, R, K,C> {
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
  constructor(readonly definition: EventDefinition<P, any, any, any>, readonly payload: P, context: EventContext = {}) {
    for(const key of ["controllerId","agentId","scope","threadId","streamId","handleId","sequence","timestamp","checkpointRevision"] as const)
      if(context[key]!==undefined)Object.defineProperty(this,key,{value:key==="scope"?immutable(context[key]):context[key],enumerable:true});
    Object.freeze(this);
  }
  is<D extends AnyEvent>(definition: D): this is EventEnvelope<PayloadOf<D>> {
    return this.definition.id === definition.id && this.definition.owner === definition.owner && this.definition.version === definition.version;
  }
}
