import { fail, requireId } from "../errors.js";
import { assertJson, immutable } from "../json.js";
import {
  AssistantMessage,
  HumanMessage,
  Message,
  SystemMessage,
  ToolMessage,
  type MessageData,
} from "./message.js";
export const MessageCodec = {
  encode(message: Message): MessageData {
    const {
      schemaVersion,
      id,
      role,
      content,
      metadata,
      providerState,
      toolCallId,
    } = message;
    return immutable({
      schemaVersion,
      id,
      role,
      content,
      ...(metadata !== undefined ? { metadata } : {}),
      ...(providerState !== undefined ? { providerState } : {}),
      ...(toolCallId ? { toolCallId } : {}),
    });
  },
  decode(data: unknown): Message {
    assertJson(data);
    if (!data || typeof data !== "object" || Array.isArray(data))
      fail("InvalidMessage", "Expected message object");
    const value = data as unknown as MessageData;
    if (value.schemaVersion !== 1)
      fail("SchemaIncompatible", "Unsupported message schema");
    requireId(value.id, "message id");
    const options = {
      id: value.id,
      metadata: value.metadata,
      providerState: value.providerState,
    };
    switch (value.role) {
      case "user":
        return new HumanMessage(value.content, options);
      case "system":
        return new SystemMessage(value.content, options);
      case "assistant":
        return new AssistantMessage(value.content, options);
      case "tool":
        return new ToolMessage({
          ...options,
          content: value.content,
          toolCallId: value.toolCallId!,
        });
      default:
        return fail("InvalidMessage", "Unknown message role");
    }
  },
};
