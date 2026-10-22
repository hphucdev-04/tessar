import type { ErrorInfo } from "./errors.js";
import { immutable, type JsonValue } from "./json.js";
import type { MessageData } from "./messages/message.js";
import type { ContentPart } from "./messages/parts.js";
import type { InterruptRecord } from "./state/schema.js";
import type { StreamStatus, ToolExecutionRecord } from "./trace/records.js";
import type { StreamEvent } from "./events/definition.js";

export interface StateTool {
  readonly id: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly status: string;
  readonly progress: JsonValue | null;
  readonly result: MessageData | null;
  readonly error: ErrorInfo | null;
}

/** An immutable rendering snapshot, separate from durable checkpoint state. */
export interface RuntimeState {
  readonly status: StreamStatus | "idle" | "closed";
  /** Committed messages and the current draft, in conversation order. */
  readonly messages: readonly MessageData[];
  readonly currentMessage: MessageData | null;
  readonly tools: readonly StateTool[];
  readonly interrupt: InterruptRecord | null;
  readonly queuedInputs: number;
  readonly error: ErrorInfo | null;
}

/** @internal Restore renderable tool fields from committed records. */
export function stateTool(record: ToolExecutionRecord): StateTool {
  return {
    id: record.id,
    toolCallId: record.toolCallId,
    name: record.toolName,
    status: record.status,
    progress: null,
    result: record.result,
    error: record.error,
  };
}

/** @internal Shared projection for standalone streams and Session snapshots. */
export class StateView {
  private value: RuntimeState = immutable({
    status: "idle",
    messages: [],
    currentMessage: null,
    tools: [],
    interrupt: null,
    queuedInputs: 0,
    error: null,
  });
  private readonly parts = new Map<string, number>();
  get(): RuntimeState {
    return this.value;
  }
  update(patch: Partial<RuntimeState>): RuntimeState {
    return (this.value = immutable({ ...this.value, ...patch }));
  }
  private upsert(message: MessageData): readonly MessageData[] {
    return this.value.messages.some((value) => value.id === message.id)
      ? this.value.messages.map((value) =>
          value.id === message.id ? message : value,
        )
      : [...this.value.messages, message];
  }
  consume(event: StreamEvent): RuntimeState | null {
    switch (event.type) {
      case "stream.started":
      case "stream.resumed":
        return this.update({ status: "running", interrupt: null, error: null });
      case "input.received": {
        let messages = this.value.messages;
        for (const message of event.payload.messages)
          if (!messages.some((value) => value.id === message.id))
            messages = [...messages, message];
        return this.update({ messages });
      }
      case "model.start": {
        if (event.payload.purpose === "auxiliary") return null;
        const draft = this.value.currentMessage;
        this.parts.clear();
        return this.update({
          currentMessage: null,
          error: null,
          messages: this.value.messages.filter(
            (message) => message.id !== draft?.id,
          ),
        });
      }
      case "message.delta": {
        const { messageId, partId, partKind, delta } = event.payload;
        let draft = this.value.currentMessage;
        if (!draft || draft.id !== messageId) {
          this.parts.clear();
          draft = {
            schemaVersion: 1,
            id: messageId,
            role: "assistant",
            content: [],
          };
        }
        const content: ContentPart[] = [...draft.content];
        const index = this.parts.get(partId);
        if (index === undefined) {
          this.parts.set(partId, content.length);
          content.push({ type: partKind, text: delta });
        } else {
          const part = content[index] as {
            type: "text" | "reasoning";
            text: string;
          };
          content[index] = { ...part, text: part.text + delta };
        }
        draft = { ...draft, content };
        return this.update({
          currentMessage: draft,
          messages: this.upsert(draft),
        });
      }
      case "message.committed": {
        const message = event.payload.message;
        if (message.role === "assistant") {
          const draft = this.value.currentMessage;
          this.parts.clear();
          this.update({
            messages: this.value.messages.filter(
              (value) => value.id !== draft?.id,
            ),
            currentMessage: null,
          });
        }
        return this.update({ messages: this.upsert(message) });
      }
      case "tool.start": {
        const { toolExecutionId, toolCallId } = event.payload;
        const call = this.value.messages
          .flatMap((message) => message.content)
          .find(
            (part) =>
              part.type === "tool-call" && part.toolCallId === toolCallId,
          );
        const tool: StateTool = {
          id: toolExecutionId,
          toolCallId,
          name: call?.type === "tool-call" ? call.name : "",
          status: "running",
          progress: null,
          result: null,
          error: null,
        };
        return this.update({
          tools: [
            ...this.value.tools.filter((value) => value.id !== tool.id),
            tool,
          ],
        });
      }
      case "tool.update":
        return this.update({
          tools: this.value.tools.map((tool) =>
            tool.id === event.payload.toolExecutionId
              ? { ...tool, progress: event.payload.progress }
              : tool,
          ),
        });
      case "tool.end":
        return this.update({
          tools: this.value.tools.map((tool) =>
            tool.id === event.payload.toolExecutionId
              ? {
                  ...tool,
                  status: event.payload.status,
                  result: event.payload.result,
                }
              : tool,
          ),
        });
      case "tool.error":
        return this.update({
          tools: this.value.tools.map((tool) =>
            tool.id === event.payload.toolExecutionId
              ? { ...tool, status: "failed", error: event.payload.error }
              : tool,
          ),
        });
      case "model.error":
        if (event.payload.purpose === "auxiliary") return null;
        return this.update({ error: event.payload.error });
      case "stream.suspended":
        return this.update({
          status: "suspended",
          interrupt: event.payload.interrupt,
          tools: this.value.tools.map((tool) =>
            tool.id === event.payload.interrupt.actionRef?.toolExecutionId
              ? { ...tool, status: "suspended" }
              : tool,
          ),
        });
      case "stream.end": {
        let messages = this.value.messages;
        for (const message of event.payload.output)
          if (!messages.some((value) => value.id === message.id))
            messages = [...messages, message];
        return this.update({
          status: event.payload.status as StreamStatus,
          messages,
          interrupt: event.payload.interrupt,
          error: event.payload.error,
        });
      }
      case "stream.error":
        return this.update({
          status:
            (event.payload.persistedStatus as StreamStatus | null) ?? "failed",
          error: event.payload.error,
        });
      default:
        return null;
    }
  }
}
