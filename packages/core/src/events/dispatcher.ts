import { TesseractError, errorInfo } from "../errors.js";
import {
  EventEnvelope,
  type AnyEvent,
  type EventContext,
  type PayloadOf,
  type ResultOf,
} from "./definition.js";
import type { HookContext } from "../plugins/context.js";
import type { RegistryLease } from "../plugins/registry.js";
export async function dispatch<D extends AnyEvent>(
  lease: RegistryLease,
  definition: D,
  payload: PayloadOf<D>,
  context: HookContext & EventContext,
  diagnostics: (error: ReturnType<typeof errorInfo>) => void,
): Promise<ResultOf<D>> {
  let current: unknown =
    definition.kind === "transformation" ? payload : context.initialDecision;
  let handlerIndex=-1;
  for (const registration of lease.handlers.filter(
    (h) => h.definition.id === definition.id,
  )) {
    handlerIndex++;
    if(handlerIndex<((context.startIndex as number|undefined)??0))continue;
    if(context.allowedHandlerIds && !(context.allowedHandlerIds as readonly string[]).includes(registration.id))continue;
    if (context.signal?.aborted && definition.kind !== "notification" && definition.kind !== "barrier")
      throw new TesseractError("Cancelled", "Execution cancelled");
    try {
      const event = new EventEnvelope(
        definition,
        definition.kind === "transformation" ? current : payload,
        context,
      );
      const result = await registration.handler(event, context);
      if (definition.kind === "transformation" && result !== undefined)
        current = result;
      if (definition.kind === "decision" && result !== undefined) {
        const previous = current as { decision?: string } | undefined;
        if (
          !previous ||
          !["deny", "stop", "reject", "handled"].includes(
            previous.decision ?? "",
          )
        )
          current = result;
        if(context.onDecision)await (context.onDecision as (entry:{handlerId:string;index:number;decision:unknown})=>Promise<void>)({handlerId:registration.id,index:handlerIndex,decision:current});
        if ((result as { decision?: string }).decision === "suspend") break;
      }
    } catch (cause) {
      if(cause instanceof TesseractError && ["StorageUnavailable","CommitConflict","OwnershipLost"].includes(cause.code))throw cause;
      const error = new TesseractError("PluginError", "Plugin handler failed", {
        pluginId: registration.pluginId,
        eventId: definition.id,
        cause: errorInfo(cause),
      });
      if (definition.kind !== "notification") throw error;
      try {
        diagnostics(error.toJSON());
      } catch {
        /* diagnostics cannot control execution */
      }
    }
  }
  return current as ResultOf<D>;
}
