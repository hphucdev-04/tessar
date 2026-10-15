import type { HookSpec, EventKind } from "./definition.js";
import type { JsonObject, JsonValue } from "../json.js";
import type { MessageData } from "../messages/message.js";
import type {
  ModelRef,
  ModelRequest,
  ModelResponse,
  ToolDescription,
} from "../models/contract.js";
import type { ErrorInfo } from "../errors.js";
import type { ModelUsage, UsageSummary } from "../trace/usage.js";
import type { ToolResult as ToolResultData } from "../tools/tool.js";
import type { InterruptRecord, ThreadInfo } from "../state/schema.js";
import type { CreateThreadOptions } from "../state/threads.js";
import type { DecisionHookContext } from "../engine/interrupt.js";
import type { ExecutionHookContext } from "../engine/tracked-effects.js";
export type ControlDecision =
  | {
      decision: "allow" | "deny" | "continue" | "stop" | "retry" | "fail";
      reason?: string;
    }
  | { decision: "select"; model: ModelRef }
  | {
      decision: "suspend";
      definitionId: string;
      payload: JsonValue;
      pluginId: string;
      definitionVersion: number;
    };
export interface InputPreparation {
  messages: readonly MessageData[];
  handled?: { output: readonly MessageData[] };
  rejected?: ErrorInfo;
}
export interface ToolPreparation {
  tool: ToolDescription;
  toolCallId: string;
  toolExecutionId: string;
  arguments: JsonObject;
}
export interface StreamOutcome {
  status: string;
  reason: string | null;
  output: readonly MessageData[];
  usage: UsageSummary;
  error: ErrorInfo | null;
  interrupt: InterruptRecord | null;
}
export const AgentEvents = {
  Ready: "ready",
  Shutdown: "shutdown",
  ThreadPrepare: "thread.prepare",
  ThreadStarted: "thread.started",
  ThreadBeforeShutdown: "thread.before-shutdown",
  ThreadShutdown: "thread.shutdown",
  ThreadUpdated: "thread.updated",
  InputPrepare: "input.prepare",
  InputReceived: "input.received",
  BeforeStream: "stream.before",
  StreamStarted: "stream.started",
  StreamBeforeEnd: "stream.before-end",
  StreamEnd: "stream.end",
  StreamError: "stream.error",
  StreamSuspended: "stream.suspended",
  StreamResumed: "stream.resumed",
  TurnStart: "turn.start",
  TurnEnd: "turn.end",
  TurnDecision: "turn.decision",
  ContextPrepare: "context.prepare",
  ToolsSelect: "tools.select",
  ModelSelect: "model.select",
  ModelRequest: "model.request",
  ModelStart: "model.start",
  ModelEnd: "model.end",
  ModelResponse: "model.response",
  ModelUsage: "model.usage",
  ModelError: "model.error",
  ModelRecover: "model.recover",
  MessagePrepare: "message.prepare",
  MessageBeforeCommit: "message.before-commit",
  MessageDelta: "message.delta",
  MessageCommitted: "message.committed",
  ToolPrepare: "tool.prepare",
  BeforeTool: "tool.before",
  ToolStart: "tool.start",
  ToolUpdate: "tool.update",
  ToolEnd: "tool.end",
  ToolError: "tool.error",
  ToolResult: "tool.result",
  StreamCancel: "stream.cancel",
  CheckpointCommitted: "checkpoint.committed",
} as const;
type Transform<P> = HookSpec<P, P, ExecutionHookContext>;
type Decision<P> = HookSpec<P, ControlDecision, DecisionHookContext>;
declare module "./definition.js" {
  interface EventMap {
    ready: HookSpec<{ agentId: string }>;
    shutdown: HookSpec<{}>;
    "thread.prepare": HookSpec<CreateThreadOptions, CreateThreadOptions>;
    "thread.started": HookSpec<ThreadInfo>;
    "thread.before-shutdown": HookSpec<{ threadId: string }>;
    "thread.shutdown": HookSpec<{ threadId: string }>;
    "thread.updated": HookSpec<{ checkpointId: string; revision: number }>;
    "input.prepare": Transform<InputPreparation>;
    "input.received": HookSpec<{ messages: readonly MessageData[] }>;
    "stream.before": Decision<{ input: readonly MessageData[] }>;
    "stream.started": HookSpec<{ modelRef: ModelRef; checkpointId: string }>;
    "stream.before-end": HookSpec<StreamOutcome>;
    "stream.end": HookSpec<StreamOutcome>;
    "stream.error": HookSpec<{
      error: ErrorInfo;
      lastKnownCheckpointId: string | null;
      persistedStatus: string | null;
    }>;
    "stream.suspended": HookSpec<{
      checkpointId: string;
      interrupt: InterruptRecord;
    }>;
    "stream.resumed": HookSpec<{
      checkpointId: string;
      interruptId: string | null;
      reason: string;
    }>;
    "turn.start": HookSpec<{ turnId: string; index: number }>;
    "turn.end": HookSpec<{ turnId: string; usage: UsageSummary }>;
    "turn.decision": Decision<{ turnId: string; hadTools: boolean }>;
    "context.prepare": Transform<ModelRequest>;
    "tools.select": Transform<readonly ToolDescription[]>;
    "model.select": Decision<{ model: ModelRef }>;
    "model.request": Transform<ModelRequest>;
    "model.start": HookSpec<{ attemptId: string; model: ModelRef }>;
    "model.end": HookSpec<{ attemptId: string; response: ModelResponse }>;
    "model.response": Transform<ModelResponse>;
    "model.usage": HookSpec<{ attemptId: string; usage: ModelUsage }>;
    "model.error": HookSpec<{ attemptId: string; error: ErrorInfo }>;
    "model.recover": Decision<{ attemptId: string; error: ErrorInfo }>;
    "message.prepare": Transform<MessageData>;
    "message.before-commit": HookSpec<{ message: MessageData }>;
    "message.delta": HookSpec<{
      messageId: string;
      partId: string;
      partKind: "text" | "reasoning";
      delta: string;
      attemptId: string;
    }>;
    "message.committed": HookSpec<{
      message: MessageData;
      checkpointId: string;
    }>;
    "tool.prepare": Transform<ToolPreparation>;
    "tool.before": Decision<ToolPreparation>;
    "tool.start": HookSpec<{ toolExecutionId: string; toolCallId: string }>;
    "tool.update": HookSpec<{ toolExecutionId: string; progress: JsonValue }>;
    "tool.end": HookSpec<{
      toolExecutionId: string;
      toolCallId: string;
      result: ToolResultData;
      status: string;
    }>;
    "tool.error": HookSpec<{ toolExecutionId: string; error: ErrorInfo }>;
    "tool.result": Transform<ToolResultData>;
    "stream.cancel": HookSpec<{ reason: string }>;
    "checkpoint.committed": HookSpec<{
      checkpointId: string;
      revision: number;
    }>;
  }
}
/** Dispatch behavior is internal metadata; public event identifiers are strings. */
export const hookKinds: Readonly<Record<string, EventKind>> = Object.freeze({
  shutdown: "barrier",
  "thread.prepare": "transformation",
  "thread.before-shutdown": "barrier",
  "session.before-close": "barrier",
  "input.prepare": "transformation",
  "stream.before": "decision",
  "stream.before-end": "barrier",
  "turn.decision": "decision",
  "context.prepare": "transformation",
  "tools.select": "transformation",
  "model.select": "decision",
  "model.request": "transformation",
  "model.response": "transformation",
  "model.recover": "decision",
  "message.prepare": "transformation",
  "message.before-commit": "barrier",
  "tool.prepare": "transformation",
  "tool.before": "decision",
  "tool.result": "transformation",
});
export const ToolDecision = {
  allow: (): ControlDecision => ({ decision: "allow" }),
  deny: (reason: string): ControlDecision => ({ decision: "deny", reason }),
};
export const TurnDecision = {
  continue: (): ControlDecision => ({ decision: "continue" }),
  stop: (reason: string): ControlDecision => ({ decision: "stop", reason }),
};
export const InputDecision = {
  continue: (messages: readonly MessageData[]): InputPreparation => ({
    messages,
  }),
  handled: (outcome: { output: readonly MessageData[] }): InputPreparation => ({
    messages: [],
    handled: outcome,
  }),
  reject: (error: ErrorInfo): InputPreparation => ({
    messages: [],
    rejected: error,
  }),
};
