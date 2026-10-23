import type { Span } from "@opentelemetry/api";
import type { JsonObject, MessageData } from "@tessar/core";

export interface LangfuseOptions {
  /** Defaults to LANGFUSE_PUBLIC_KEY through the Langfuse SDK. */
  publicKey?: string;
  /** Defaults to LANGFUSE_SECRET_KEY through the Langfuse SDK. */
  secretKey?: string;
  /** Cloud region or self-hosted URL; defaults to the Langfuse SDK's setting. */
  baseUrl?: string;
  /** Override the shared trace name; individual tool/model names are unchanged. */
  traceName?: string;
  /** Application-defined tags propagated to every observation. */
  tags?: readonly string[];
  /** Optional reference to an existing Langfuse prompt used by primary calls. */
  prompt?: { name: string; version: number };
}

interface TurnTrace {
  span: Span;
  output: MessageData[];
}
export type ThreadTraceState = {
  rootCreated: boolean;
  turnCount: number;
  turnId: string;
  turnCreated: boolean;
};
export interface TraceLink extends ThreadTraceState {
  rootNew: boolean;
  turnNew: boolean;
}
export interface ExecutionTrace {
  root: Span;
  link?: TraceLink;
  turns: Map<string, TurnTrace>;
  output: MessageData[];
  models: Map<string, Span>;
  tools: Map<string, Span>;
  calls: Map<string, { name: string; arguments: JsonObject }>;
  firstOutputs: Set<string>;
  currentTurn?: string;
  identity: Record<string, unknown>;
}
