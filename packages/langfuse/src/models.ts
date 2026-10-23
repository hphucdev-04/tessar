import type { Span } from "@opentelemetry/api";
import {
  model,
  message,
  type ModelUsage,
  type PluginContext,
} from "@tessar/core";
import { time, update, type TraceRuntime } from "./trace.js";
import type { LangfuseOptions } from "./types.js";

// Langfuse flat usage details must contain exclusive, non-overlapping buckets.
function usageDetails(usage: ModelUsage): Record<string, number> | undefined {
  const details: Record<string, number> = {};
  const read = usage.cacheReadInputTokens,
    write = usage.cacheWriteInputTokens;
  if (usage.inputTokens !== null) {
    if ((read ?? 0) + (write ?? 0) <= usage.inputTokens) {
      details.input = usage.inputTokens - (read ?? 0) - (write ?? 0);
      if (read !== null) details.input_cached_tokens = read;
      if (write !== null) details.input_cache_write = write;
    } else details.input = usage.inputTokens;
  } else {
    if (read !== null) details.input_cached_tokens = read;
    if (write !== null) details.input_cache_write = write;
    if (usage.uncachedInputTokens !== null)
      details.input = usage.uncachedInputTokens;
  }
  if (usage.outputTokens !== null) {
    const reasoning = usage.reasoningOutputTokens;
    if (reasoning !== null && reasoning <= usage.outputTokens) {
      details.output = usage.outputTokens - reasoning;
      details.output_reasoning_tokens = reasoning;
    } else details.output = usage.outputTokens;
  } else if (usage.reasoningOutputTokens !== null) {
    details.output_reasoning_tokens = usage.reasoningOutputTokens;
  }
  if (usage.totalTokens !== null) details.total = usage.totalTokens;
  return Object.keys(details).length ? details : undefined;
}

/** Records model requests, retries, usage and time to first output. */
export function registerModelHooks(
  tessar: PluginContext,
  tracing: TraceRuntime,
  options: LangfuseOptions,
): void {
  const { current, parentTurn, start, failure } = tracing;
  tessar.hook(model.start, (event) => {
    const state = current(event);
    if (!state || state.models.has(event.payload.attemptId)) return;
    const { attemptId, request, purpose, parentToolExecutionId, turnId } =
      event.payload;
    if (turnId) state.currentTurn = turnId;
    if (purpose !== "auxiliary" && request) {
      update(parentTurn(state, event, turnId), "span", {
        input: request,
        metadata: { inputSource: "model.request" },
      });
    }
    const parent = parentToolExecutionId
      ? state.tools.get(parentToolExecutionId)
      : undefined;
    const span = start(
      event.payload.model.modelId,
      "generation",
      event,
      {
        ...state.identity,
        attemptId,
        purpose,
        parentToolExecutionId,
        turnId,
        providerId: event.payload.model.providerId,
        options: request?.options,
      },
      parent ?? parentTurn(state, event, turnId),
      {
        model: event.payload.model.modelId,
        input: request,
        ...(purpose !== "auxiliary" && options.prompt
          ? { prompt: { ...options.prompt, isFallback: false } }
          : {}),
        modelParameters: Object.fromEntries(
          Object.entries(request?.options ?? {}).filter(
            ([, value]) =>
              typeof value === "string" || typeof value === "number",
          ),
        ) as Record<string, string | number>,
      },
    );
    state.models.set(attemptId, span);
  });
  tessar.hook(message.delta, (event) => {
    const state = current(event),
      span = state?.models.get(event.payload.attemptId);
    if (!span || state!.firstOutputs.has(event.payload.attemptId)) return;
    state!.firstOutputs.add(event.payload.attemptId);
    update(span, "generation", {
      completionStartTime: time(event) ?? new Date(),
    });
  });
  const recordUsage = (span: Span, usage: ModelUsage) =>
    update(span, "generation", {
      usageDetails: usageDetails(usage),
      metadata: { usage },
    });
  tessar.hook(model.usage, (event) => {
    const span = current(event)?.models.get(event.payload.attemptId);
    if (span) recordUsage(span, event.payload.usage);
  });
  tessar.hook(model.end, (event) => {
    const state = current(event),
      span = state?.models.get(event.payload.attemptId);
    if (!span) return;
    const { response } = event.payload;
    if (response.usage) recordUsage(span, response.usage);
    update(span, "generation", {
      output: response.message,
      metadata: {
        finishReason: response.finishReason,
        providerRequestId: response.providerRequestId,
      },
    });
    if (event.payload.purpose !== "auxiliary")
      for (const part of response.message.content)
        if (part.type === "tool-call")
          state!.calls.set(part.toolCallId, {
            name: part.name,
            arguments: part.arguments,
          });
    span.end(time(event));
    state!.models.delete(event.payload.attemptId);
    state!.firstOutputs.delete(event.payload.attemptId);
  });
  tessar.hook(model.error, (event) => {
    const state = current(event),
      span = state?.models.get(event.payload.attemptId);
    if (!span) return;
    failure(span, "generation", event.payload.error);
    span.end(time(event));
    state!.models.delete(event.payload.attemptId);
    state!.firstOutputs.delete(event.payload.attemptId);
  });
}
