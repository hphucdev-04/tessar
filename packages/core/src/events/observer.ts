import { errorInfo, type ErrorInfo } from "../errors.js";
import type { EventContext, EventEnvelope } from "./definition.js";

export function notifyObserver<E extends EventEnvelope>(
  observer: (event: E) => unknown,
  event: E,
  report: (error: ErrorInfo, context?: EventContext) => void,
): void {
  const failed = (error: unknown) =>
    report(
      errorInfo(error, { source: "application", eventId: event.type }),
      event,
    );
  try {
    const result = observer(event);
    if (result && typeof (result as PromiseLike<unknown>).then === "function")
      void Promise.resolve(result).catch(failed);
  } catch (error) {
    failed(error);
  }
}
