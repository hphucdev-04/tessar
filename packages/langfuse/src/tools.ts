import { tool, type PluginContext } from "@tessar/core";
import { time, update, type TraceRuntime } from "./trace.js";

/** Records tool arguments, results, errors and parent Turn relationships. */
export function registerToolHooks(
  tessar: PluginContext,
  tracing: TraceRuntime,
): void {
  const { current, parentTurn, start, failure } = tracing;
  tessar.hook(tool.start, (event) => {
    const state = current(event);
    if (!state || state.tools.has(event.payload.toolExecutionId)) return;
    const call = state.calls.get(event.payload.toolCallId);
    const span = start(
      event.payload.name ?? call?.name ?? "tool",
      "tool",
      event,
      {
        ...state.identity,
        toolExecutionId: event.payload.toolExecutionId,
        toolCallId: event.payload.toolCallId,
      },
      parentTurn(state, event, event.payload.turnId),
      { input: event.payload.arguments ?? call?.arguments },
    );
    state.tools.set(event.payload.toolExecutionId, span);
  });
  tessar.hook(tool.error, (event) => {
    const span = current(event)?.tools.get(event.payload.toolExecutionId);
    if (span) failure(span, "tool", event.payload.error);
  });
  tessar.hook(tool.end, (event) => {
    const state = current(event);
    if (!state) return;
    const call = state.calls.get(event.payload.toolCallId);
    const span =
      state.tools.get(event.payload.toolExecutionId) ??
      start(
        call?.name ?? "tool",
        "tool",
        event,
        {
          ...state.identity,
          toolExecutionId: event.payload.toolExecutionId,
          toolCallId: event.payload.toolCallId,
        },
        parentTurn(state, event),
        { input: call?.arguments },
      );
    update(span, "tool", {
      output: event.payload.result,
      metadata: { status: event.payload.status },
    });
    span.end(time(event));
    state.tools.delete(event.payload.toolExecutionId);
    state.calls.delete(event.payload.toolCallId);
  });
}
