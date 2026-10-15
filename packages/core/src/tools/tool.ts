import { requireId } from "../errors.js";
import { immutable, type JsonObject, type JsonValue } from "../json.js";
import { normalizeContent } from "../messages/message.js";
import type { ContentPart } from "../messages/parts.js";
import type { InputDefinition } from "./input-definition.js";
export interface ToolResult { readonly content:readonly ContentPart[]; readonly metadata?:JsonObject }
export interface ToolExecutionContext { readonly signal:AbortSignal; readonly threadId:string; readonly streamId:string; readonly turnId:string; readonly toolExecutionId:string; emit(progress:JsonValue):void }
export type ReconcileResult = {status:"completed";result:ToolResult}|{status:"safeToRetry"}|{status:"unknown"};
export interface ToolRecovery<I> { idempotencyKey(input:I,identity:{toolExecutionId:string}):string; reconcile(operation:{id:string;input:I;key:string}):Promise<ReconcileResult> }
export interface ToolDefinition<I> { name:string; description:string; input:InputDefinition<I>; execute(input:I,context:ToolExecutionContext):Promise<ToolResult>; recovery?:ToolRecovery<I> }
export class Tool<I = any> {
  readonly name:string; readonly description:string; readonly input:InputDefinition<I>;
  readonly execute:ToolDefinition<I>["execute"]; readonly recovery?:ToolRecovery<I>;
  constructor(definition:ToolDefinition<I>) {
    this.name=requireId(definition.name,"tool name");this.description=definition.description;
    this.input=definition.input;this.execute=definition.execute;this.recovery=definition.recovery;
  }
}
export function createTool<I>(definition:ToolDefinition<I>):Tool<I> { return new Tool(definition); }
export function toolResult(content:string|readonly ContentPart[],metadata?:JsonObject):ToolResult {
  return immutable({content:normalizeContent(content),...(metadata?{metadata}:{})});
}
