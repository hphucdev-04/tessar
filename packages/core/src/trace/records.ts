import type { ErrorInfo } from "../errors.js";
import type { JsonObject } from "../json.js";
import type { MessageData } from "../messages/message.js";
import type { ModelUsage, UsageSummary } from "./usage.js";
export type StreamStatus =
  | "pending"
  | "running"
  | "suspended"
  | "interrupted"
  | "completed"
  | "stopped"
  | "failed"
  | "cancelled";
export interface StreamRecord {
  outputMessageIds: readonly string[];
  id: string;
  threadId: string;
  scope: JsonObject;
  parentStreamId: string | null;
  parentToolExecutionId: string | null;
  triggerMessageId: string | null;
  status: StreamStatus;
  stopReason: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  error: ErrorInfo | null;
  directUsage: UsageSummary;
  inclusiveUsage: UsageSummary;
}
export interface TurnRecord {
  id: string;
  streamId: string;
  scope: JsonObject;
  index: number;
  contextRevision: number;
  assistantMessageId: string | null;
  status: string;
  stopReason: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  error: ErrorInfo | null;
  usage: UsageSummary;
}
export interface ModelAttemptRecord {
  id: string;
  turnId: string;
  streamId: string;
  scope: JsonObject;
  callId: string;
  attemptIndex: number;
  purpose: "primary" | "auxiliary";
  parentToolExecutionId: string | null;
  providerId: string;
  modelId: string;
  providerRequestId: string | null;
  responseMessageId: string | null;
  contextRevision: number;
  requestSnapshotRef: string | null;
  startedAt: string;
  firstOutputAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  timeToFirstOutputMs: number | null;
  status: string;
  finishReason: string | null;
  error: ErrorInfo | null;
  usage: ModelUsage;
}
export interface ToolExecutionRecord {
  id: string;
  turnId: string;
  streamId: string;
  scope: JsonObject;
  toolCallId: string;
  parentToolExecutionId: string | null;
  toolName: string;
  arguments: JsonObject;
  policyDecision: { decision: "allowed" | "denied"; reason?: string } | null;
  status:
    | "pending"
    | "running"
    | "succeeded"
    | "failed"
    | "denied"
    | "cancelled"
    | "interrupted";
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  resultMessageId: string | null;
  resultRef: string | null;
  result: MessageData | null;
  error: ErrorInfo | null;
  idempotencyKey: string | null;
}
