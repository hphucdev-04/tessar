import {
  errorInfo, fail, MessageCodec, normalizeUsage, TessarError,
  type ModelCallContext, type ModelChunk, type ModelRequest,
} from "@tessar/core";
import type { CompletionUsage } from "openai/resources/completions";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions/completions";
import { OpenAIAdapter, clientKeys } from "./adapter.js";
import { chatResponseError, decodeChatMessage, encodeChatMessages, type ChatAssistant } from "./chat-codec.js";

function usage(value?: CompletionUsage | null) {
  const cached = value?.prompt_tokens_details?.cached_tokens;
  return normalizeUsage({
    inputTokens: value?.prompt_tokens, outputTokens: value?.completion_tokens, totalTokens: value?.total_tokens,
    cacheReadInputTokens: cached, cacheWriteInputTokens: value?.prompt_tokens_details?.cache_write_tokens,
    reasoningOutputTokens: value?.completion_tokens_details?.reasoning_tokens,
    uncachedInputTokens: value?.prompt_tokens !== undefined && cached !== undefined ? Math.max(0, value.prompt_tokens - cached) : null,
  }, value ? JSON.parse(JSON.stringify(value)) : null);
}

/** Native Chat Completions transport; the Agent consumes the shared ModelChunk contract. */
export class OpenAIChatAdapter extends OpenAIAdapter {
  override validate(request: ModelRequest): void {
    if (request.model.providerId !== this.ref.providerId || request.model.modelId !== this.ref.modelId ||
        request.model.connectionId !== this.ref.connectionId)
      fail("UnsupportedContext", "Chat model or connection identity mismatch");
    for (const key of ["connectionId", "api", "model", "input", "messages", "instructions", "tools", "stream", "functions", "function_call", ...clientKeys])
      if (request.options && key in request.options) fail("UnsupportedOption", key + " is owned by the connection or Agent runtime");
    if (request.options?.n != null && request.options.n !== 1)
      fail("UnsupportedOption", "An Agent consumes one Chat completion choice");
    encodeChatMessages(request, this.connection);
  }

  override async *stream(request: ModelRequest, context: ModelCallContext): AsyncIterable<ModelChunk> {
    this.validate(request);
    context.signal.throwIfAborted();
    try {
      const stream = await this.client.chat.completions.create({
        ...request.options, model: this.ref.modelId, messages: encodeChatMessages(request, this.connection),
        ...(request.tools.length ? { tools: request.tools.map(tool => ({ type: "function" as const,
          function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
        })) } : {}), stream: true,
      } as ChatCompletionCreateParamsStreaming, { signal: context.signal });
      let responseId = "", finishReason: string | null = null, text = "", refusal = "";
      let counts: CompletionUsage | null | undefined;
      const thinking: { reasoning_content?: string; reasoning?: string } = {};
      const calls = new Map<number, NonNullable<ChatAssistant["tool_calls"]>[number]>();
      for await (const chunk of stream) {
        context.signal.throwIfAborted();
        if (chunk.id) responseId = chunk.id;
        if (chunk.usage) counts = chunk.usage;
        for (const choice of chunk.choices) {
          if (choice.index !== 0) throw chatResponseError("Unexpected multiple Chat completion choices");
          const delta = choice.delta as typeof choice.delta & { reasoning_content?: string; reasoning?: string };
          if (delta.audio || delta.function_call) fail("UnsupportedResponse", "Unsupported Chat audio or deprecated function-call output");
          if (delta.content != null) {
            if (typeof delta.content !== "string") throw chatResponseError("Chat content must be text");
            text += delta.content;
            if (delta.content) yield { type: "message-delta", messageId: responseId, partId: "text-0", partKind: "text", delta: delta.content };
          }
          if (delta.refusal) { refusal += delta.refusal; yield { type: "message-delta", messageId: responseId, partId: "refusal", partKind: "text", delta: delta.refusal }; }
          for (const key of ["reasoning_content", "reasoning"] as const) {
            if (delta[key] === undefined || delta[key] === null) continue;
            if (typeof delta[key] !== "string") throw chatResponseError("Chat reasoning must be text");
            thinking[key] = (thinking[key] ?? "") + delta[key];
            if (delta[key]) yield { type: "message-delta", messageId: responseId, partId: key, partKind: "reasoning", delta: delta[key] };
          }
          for (const call of delta.tool_calls ?? []) {
            if (!Number.isInteger(call.index) || call.index < 0 || (call.type && call.type !== "function"))
              throw chatResponseError("Invalid Chat function-call chunk");
            const saved = calls.get(call.index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
            saved.id += call.id ?? "";
            saved.function.name += call.function?.name ?? "";
            saved.function.arguments += call.function?.arguments ?? "";
            calls.set(call.index, saved);
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
      }
      if (!responseId || !finishReason) throw chatResponseError("Chat stream ended before completion", "ProviderIncomplete");
      if (finishReason === "tool_calls" && !calls.size)
        throw chatResponseError("Chat completion ended with missing function calls");
      const message: ChatAssistant = { role: "assistant", content: text || null, ...thinking,
        ...(refusal ? { refusal } : {}),
        ...(calls.size ? { tool_calls: [...calls].sort(([a], [b]) => a - b).map(([, call]) => call) } : {}),
      };
      const normalized = usage(counts);
      const decoded = decodeChatMessage(message, this.ref, responseId, this.connection);
      yield { type: "usage", usage: normalized };
      yield { type: "response", response: { message: MessageCodec.encode(decoded), usage: normalized,
        finishReason, providerRequestId: responseId } };
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason;
      errorInfo(error, { source: error instanceof TessarError ? "tessar" : "provider", ...this.ref });
      throw error;
    }
  }
}
