import type { Instruction } from "../instructions/instruction.js";
import type { MessageData } from "../messages/message.js";
import type { JsonObject } from "../json.js";
import type { ModelUsage } from "../trace/usage.js";
import type { MetadataResolver } from "./profile.js";
export interface ModelRef {
  providerId: string;
  modelId: string;
  /** Non-secret identity of a concrete connection, when supplied by an adapter. */
  connectionId?: string;
}
export interface ModelConnectionDescriptor {
  providerId: string;
  connectionId: string;
  protocol: string;
  endpoint: string;
}
export interface ToolDescription {
  name: string;
  description: string;
  inputSchema: JsonObject;
}
export interface ModelRequest {
  model: ModelRef;
  instructions: Instruction;
  messages: readonly MessageData[];
  tools: readonly ToolDescription[];
  options?: JsonObject;
}
export interface ModelCallContext {
  signal: AbortSignal;
}
export interface ModelResponse {
  message: MessageData;
  usage?: ModelUsage;
  finishReason?: string;
  providerRequestId?: string;
}
export type ModelChunk =
  | {
      type: "message-delta";
      messageId: string;
      partId: string;
      partKind: "text" | "reasoning";
      delta: string;
    }
  | { type: "usage"; usage: ModelUsage }
  | { type: "response"; response: ModelResponse };
export interface ModelAdapter {
  readonly ref: ModelRef;
  readonly connection?: ModelConnectionDescriptor;
  readonly options?: object;
  /** Select another model without changing credentials, endpoint or client. */
  withModel?(modelId: string): ModelAdapter;
  validate(request: ModelRequest): void;
  stream(
    request: ModelRequest,
    context: ModelCallContext,
  ): AsyncIterable<ModelChunk>;
}
export type ModelOptions<M> = M extends { readonly options: infer O }
  ? Partial<O>
  : JsonObject;
export interface ModelProviderRegistration {
  id: string;
  create(modelId: string): ModelAdapter;
  metadata?: MetadataResolver;
  endpoint?: string;
  metadataPartition?: string;
  catalogModelRef?: (ref: ModelRef) => ModelRef | null;
  catalogMappingVersion?: number;
}
