import OpenAI, { OpenAIError, type ClientOptions } from "openai";
import type {
  ResponseUsage,
  ResponseCreateParamsStreaming,
} from "openai/resources/responses/responses";
import {
  errorInfo,
  MessageCodec,
  fail,
  normalizeUsage,
  type ModelAdapter,
  type ModelChunk,
  type ModelRef,
  type ModelRequest,
  type ModelConnectionDescriptor,
} from "@tessar/core";
import { decodeOutput, encodeInput } from "./codec.js";
export interface OpenAIOptions extends ClientOptions {
  providerId?: string;
  metadataPartition?: string;
}
// Connection settings must never enter either protocol's request body.
export const clientKeys = [
  "apiKey",
  "adminAPIKey",
  "organization",
  "project",
  "webhookSecret",
  "baseURL",
  "dataResidency",
  "timeout",
  "fetchOptions",
  "fetch",
  "maxRetries",
  "defaultHeaders",
  "defaultQuery",
  "dangerouslyAllowBrowser",
  "logLevel",
  "logger",
  "workloadIdentity",
  "credential",
  "provider",
  "x509Transport",
] as const satisfies readonly (keyof ClientOptions)[];
export function createClient(options: OpenAIOptions): OpenAI {
  const { providerId, metadataPartition, ...clientOptions } = options;
  return new OpenAI(clientOptions);
}
function usage(value: ResponseUsage | null | undefined) {
  return normalizeUsage(
    {
      inputTokens: value?.input_tokens,
      outputTokens: value?.output_tokens,
      totalTokens: value?.total_tokens,
      cacheReadInputTokens: value?.input_tokens_details?.cached_tokens,
      cacheWriteInputTokens: value?.input_tokens_details?.cache_write_tokens,
      reasoningOutputTokens: value?.output_tokens_details?.reasoning_tokens,
      uncachedInputTokens:
        value?.input_tokens !== undefined &&
        value?.input_tokens_details?.cached_tokens !== undefined
          ? Math.max(
              0,
              value.input_tokens - value.input_tokens_details.cached_tokens,
            )
          : null,
    },
    value ? JSON.parse(JSON.stringify(value)) : null,
  );
}
export class OpenAIAdapter implements ModelAdapter {
  protected readonly client: OpenAI;
  constructor(
    options: OpenAIOptions,
    readonly ref: ModelRef,
    client?: OpenAI,
    readonly connection?: ModelConnectionDescriptor,
  ) {
    this.client = client ?? createClient(options);
  }
  validate(request: ModelRequest): void {
    try {
      if (
        request.model.providerId !== this.ref.providerId ||
        request.model.modelId !== this.ref.modelId
      )
        fail("UnsupportedContext", "Model identity mismatch");
      if (request.model.connectionId !== this.ref.connectionId)
        fail("UnsupportedContext", "Model connection mismatch");
      for (const key of [
        "connectionId",
        "api",
        "model",
        "input",
        "messages",
        "instructions",
        "tools",
        "stream",
        ...clientKeys,
      ])
        if (request.options && key in request.options)
          fail(
            "UnsupportedOption",
            key + " is owned by the model connection or Agent runtime",
          );
      if (
        request.options?.background === true ||
        request.options?.conversation != null ||
        request.options?.previous_response_id != null ||
        request.options?.context_management != null
      )
        fail(
          "UnsupportedOption",
          "Background, provider-managed conversations and compaction are not supported by the Agent loop",
        );
      encodeInput(request, this.connection);
    } catch (error) {
      errorInfo(error, { source: "tessar", ...this.ref });
      throw error;
    }
  }
  async *stream(
    request: ModelRequest,
    context: { signal: AbortSignal },
  ): AsyncIterable<ModelChunk> {
    this.validate(request);
    context.signal.throwIfAborted();
    const failure = (message: string, code: string) => {
      const error = Object.assign(new Error(message), { code });
      errorInfo(error, { source: "provider", ...this.ref });
      return error;
    };
    try {
      const stream = await this.client.responses.create(
        {
          ...request.options,
          model: this.ref.modelId,
          ...(request.instructions.sections.some(
            (section) => section.content.length > 0,
          )
            ? {
                instructions: request.instructions.sections
                  .map((s) => s.content)
                  .join("\n\n"),
              }
            : {}),
          input: encodeInput(request, this.connection),
          ...(request.tools.length
            ? {
                tools: request.tools.map((t) => ({
                  type: "function" as const,
                  name: t.name,
                  description: t.description,
                  parameters: t.inputSchema,
                  strict: false,
                })),
              }
            : {}),
          stream: true,
        } as ResponseCreateParamsStreaming,
        { signal: context.signal },
      );
      let terminal = false;
      for await (const event of stream) {
        context.signal.throwIfAborted();
        switch (event.type) {
          case "response.output_text.delta":
            yield {
              type: "message-delta",
              messageId: event.item_id,
              partId: event.item_id + ":" + event.content_index,
              partKind: "text",
              delta: event.delta,
            };
            break;
          case "response.reasoning_summary_text.delta":
            yield {
              type: "message-delta",
              messageId: event.item_id,
              partId: event.item_id + ":summary:" + event.summary_index,
              partKind: "reasoning",
              delta: event.delta,
            };
            break;
          case "response.completed": {
            terminal = true;
            const normalized = usage(event.response.usage);
            yield { type: "usage", usage: normalized };
            yield {
              type: "response",
              response: {
                message: MessageCodec.encode(
                  decodeOutput(
                    event.response.output,
                    this.ref,
                    event.response.id,
                    this.connection,
                  ),
                ),
                usage: normalized,
                finishReason: "completed",
                providerRequestId: event.response.id,
              },
            };
            break;
          }
          case "response.incomplete":
          case "response.failed":
            yield { type: "usage", usage: usage(event.response.usage) };
            throw failure(
              event.response.error?.message ??
                "OpenAI response did not complete",
              event.response.error?.code ?? "ProviderIncomplete",
            );
          case "error":
            throw failure(event.message, event.code ?? "ProviderError");
        }
      }
      if (!terminal)
        throw failure(
          "OpenAI stream ended before completion",
          "ProviderIncomplete",
        );
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason;
      errorInfo(error, {
        source: error instanceof OpenAIError ? "provider" : "tessar",
        ...this.ref,
      });
      throw error;
    }
  }
}
