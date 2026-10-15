import { TesseractError, errorInfo } from "../errors.js";
import {
  EventEnvelope,
  type AnyEvent,
  type EventContext,
  type PayloadOf,
  type ResultOf,
  type EventKind,
} from "./definition.js";
import type { HookContext } from "../plugins/context.js";
import type { RegistryLease } from "../plugins/registry.js";
export async function dispatch<D extends AnyEvent>(
  lease: RegistryLease,
  definition: D,
  payload: PayloadOf<D>,
  context: HookContext & EventContext,
  diagnostics: (error: ReturnType<typeof errorInfo>) => void,
  kind: EventKind = "notification",
): Promise<ResultOf<D>> {
  let current: unknown =
    kind === "transformation" ? payload : context.initialDecision;
  let handlerIndex = -1;
  const allowed = context.allowedHandlerIds as readonly string[] | undefined;
  const handlers = lease.handlers.filter(
    (h) => h.name === definition && (!allowed || allowed.includes(h.id)),
  );
  if (allowed)
    handlers.sort((a, b) => allowed.indexOf(a.id) - allowed.indexOf(b.id));
  for (const registration of handlers) {
    handlerIndex++;
    if (handlerIndex < ((context.startIndex as number | undefined) ?? 0))
      continue;
    if (
      context.signal?.aborted &&
      kind !== "notification" &&
      kind !== "barrier"
    )
      throw new TesseractError("Cancelled", "Execution cancelled");
    try {
      const event = new EventEnvelope(
        definition,
        kind === "transformation" ? current : payload,
        context,
      );
      const result = await registration.handler(event, context);
      if (kind === "transformation" && result !== undefined) current = result;
      if (kind === "decision" && result !== undefined) {
        const previous = current as { decision?: string } | undefined;
        if (
          !previous ||
          !["deny", "stop", "reject", "handled"].includes(
            previous.decision ?? "",
          )
        )
          current = result;
        if (context.onDecision)
          await (
            context.onDecision as (entry: {
              handlerId: string;
              index: number;
              decision: unknown;
            }) => Promise<void>
          )({
            handlerId: registration.id,
            index: handlerIndex,
            decision: current,
          });
        if ((result as { decision?: string }).decision === "suspend") break;
      }
    } catch (cause) {
      if (
        cause instanceof TesseractError &&
        ["StorageUnavailable", "CommitConflict", "OwnershipLost"].includes(
          cause.code,
        )
      )
        throw cause;
      const error = new TesseractError("PluginError", "Plugin handler failed", {
        pluginId: registration.pluginId,
        eventId: definition,
        cause: errorInfo(cause),
      });
      if (kind !== "notification") throw error;
      try {
        diagnostics(error.toJSON());
      } catch {
        /* diagnostics cannot control execution */
      }
    }
  }
  return current as ResultOf<D>;
}
