import { z } from "zod";
import { fail, requireId } from "../errors.js";
import {
  assertJson,
  immutable,
  type JsonObject,
  type JsonValue,
} from "../json.js";
import { ToolMessage } from "../messages/message.js";
import type { TrackedServices } from "../engine/tracked-effects.js";
export type ToolOutput = JsonValue | ToolMessage;
export interface ToolExecutionContext extends TrackedServices {
  readonly signal: AbortSignal;
  readonly threadId: string;
  readonly streamId: string;
  readonly turnId: string;
  readonly toolExecutionId: string;
  emit(progress: JsonValue): void;
}
export type ReconcileResult =
  | { status: "completed"; result: ToolOutput }
  | { status: "safeToRetry" }
  | { status: "unknown" };
export interface ToolRecovery<I> {
  idempotencyKey(input: I, identity: { toolExecutionId: string }): string;
  reconcile(operation: {
    id: string;
    input: I;
    key: string;
  }): Promise<ReconcileResult>;
}
export interface ToolDefinition<I> {
  name: string;
  description: string;
  schema: z.ZodType<I>;
  execute(
    input: I,
    context: ToolExecutionContext,
  ): ToolOutput | Promise<ToolOutput>;
  recovery?: ToolRecovery<I>;
}
export class Tool<I = any> {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<I>;
  readonly jsonSchema: JsonObject;
  readonly execute: (
    input: I,
    context: ToolExecutionContext,
  ) => Promise<ToolMessage>;
  readonly recovery?: ToolRecovery<I>;
  constructor(definition: ToolDefinition<I>) {
    this.name = requireId(definition.name, "tool name");
    this.description = definition.description;
    this.schema = definition.schema;
    // Zod attaches a non-enumerable Standard Schema validator; keep only JSON.
    this.jsonSchema = immutable(
      JSON.parse(
        JSON.stringify(z.toJSONSchema(definition.schema, { io: "input" })),
      ),
    ) as JsonObject;
    this.execute = async (input, context) =>
      normalizeToolOutput(await definition.execute(input, context));
    this.recovery = definition.recovery;
  }
}
export function createTool<I>(definition: ToolDefinition<I>): Tool<I> {
  return new Tool(definition);
}
/** @internal Normalize developer results and bind runtime correlation. */
export function normalizeToolOutput(
  value: ToolOutput,
  toolCallId?: string,
): ToolMessage {
  if (!(value instanceof ToolMessage)) {
    if (value === undefined)
      fail("InvalidToolResult", "Tool execute must return a result");
    assertJson(value);
    value = new ToolMessage(
      typeof value === "string" ? value : [{ type: "data", data: value }],
    );
  }
  if (toolCallId === undefined || value.toolCallId === toolCallId) return value;
  if (value.toolCallId !== undefined)
    fail("InvalidMessage", "Tool result belongs to a different tool call");
  return new ToolMessage(value.content, {
    id: value.id,
    metadata: value.metadata,
    providerState: value.providerState,
    toolCallId,
  });
}
