import { fail, requireId } from "../errors.js";
import {
  assertJson,
  immutable,
  randomIds,
  type JsonObject,
  type JsonValue,
} from "../json.js";
import type { ContentPart } from "./parts.js";
export type MessageRole = "system" | "user" | "assistant" | "tool";
export interface MessageOptions {
  id?: string;
  metadata?: JsonObject;
  providerState?: JsonValue;
}
export interface MessageData {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly role: MessageRole;
  readonly content: readonly ContentPart[];
  readonly metadata?: JsonObject;
  readonly providerState?: JsonValue;
  readonly toolCallId?: string;
}
export function normalizeContent(
  content: string | readonly ContentPart[],
): readonly ContentPart[] {
  const parts =
    typeof content === "string"
      ? [{ type: "text" as const, text: content }]
      : content;
  assertJson(parts);
  if (!Array.isArray(parts))
    fail("InvalidMessage", "Message content must be text or parts");
  for (const part of parts) {
    if (!part || typeof part !== "object")
      fail("InvalidMessage", "Invalid message part");
    switch (part.type) {
      case "text":
      case "reasoning":
        if (typeof part.text !== "string")
          fail("InvalidMessage", "Text is required");
        break;
      case "tool-call":
        requireId(part.toolCallId, "toolCallId");
        requireId(part.name, "tool name");
        if (
          !part.arguments ||
          typeof part.arguments !== "object" ||
          Array.isArray(part.arguments)
        )
          fail("InvalidMessage", "Arguments must be an object");
        break;
      case "image":
      case "audio":
      case "file":
        requireId(part.mediaType, "mediaType");
        if (typeof part.data !== "string")
          fail("InvalidMessage", "Media data required");
        break;
      case "data":
        if (!Object.hasOwn(part, "data"))
          fail("InvalidMessage", "Data is required");
        break;
      default:
        fail("InvalidMessage", "Unknown content part");
    }
  }
  return immutable(parts);
}
export abstract class Message implements MessageData {
  readonly schemaVersion = 1 as const;
  readonly id: string;
  readonly content: readonly ContentPart[];
  readonly metadata?: JsonObject;
  readonly providerState?: JsonValue;
  readonly toolCallId?: string;
  protected constructor(
    readonly role: MessageRole,
    content: string | readonly ContentPart[],
    options: MessageOptions = {},
    toolCallId?: string,
  ) {
    this.id = requireId(options.id ?? randomIds.next("message"));
    this.content = normalizeContent(content);
    if (options.metadata !== undefined)
      this.metadata = immutable(options.metadata);
    if (options.providerState !== undefined)
      this.providerState = immutable(options.providerState);
    if (role === "tool") this.toolCallId = requireId(toolCallId!, "toolCallId");
    Object.freeze(this);
  }
}
export class HumanMessage extends Message {
  constructor(
    content: string | readonly ContentPart[],
    options?: MessageOptions,
  ) {
    super("user", content, options);
  }
}
export class SystemMessage extends Message {
  constructor(
    content: string | readonly ContentPart[],
    options?: MessageOptions,
  ) {
    super("system", content, options);
  }
}
export class AssistantMessage extends Message {
  constructor(
    content: string | readonly ContentPart[],
    options?: MessageOptions,
  ) {
    super("assistant", content, options);
  }
}
export class ToolMessage extends Message {
  constructor(
    options: MessageOptions & {
      toolCallId: string;
      content: string | readonly ContentPart[];
    },
  ) {
    super("tool", options.content, options, options.toolCallId);
  }
}
