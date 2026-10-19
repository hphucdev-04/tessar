import { fail, requireId } from "../errors.js";
import { immutable, type JsonValue } from "../json.js";
import type { InputDefinition } from "../tools/input-definition.js";
import type { ControlDecision } from "../events/type.js";
import type { HookContext } from "../plugins/context.js";
import type { PluginStateAccess } from "../state/plugin-state.js";
import type { ExecutionHookContext } from "./tracked-effects.js";
export interface InterruptionDefinition<
  R = any,
  D extends ControlDecision = ControlDecision,
  P extends JsonValue = JsonValue,
> {
  readonly id: string;
  readonly version: number;
  readonly response: InputDefinition<R>;
  readonly payload?: InputDefinition<P>;
  readonly resolve: (response: R, payload: P) => D;
}
export function defineInterruption<
  R,
  D extends ControlDecision,
  P extends JsonValue = JsonValue,
>(
  definition: InterruptionDefinition<R, D, P>,
): InterruptionDefinition<R, D, P> {
  requireId(definition.id);
  if (!Number.isInteger(definition.version) || definition.version < 1)
    fail("InvalidConfiguration", "Invalid interruption version");
  return Object.freeze({ ...definition });
}
export interface DecisionHookContext extends ExecutionHookContext {
  readonly state: PluginStateAccess;
  readonly signal: AbortSignal;
  readonly threadId: string;
  readonly streamId: string;
  suspend<R, D extends ControlDecision, P extends JsonValue>(
    definition: InterruptionDefinition<R, D, P>,
    payload: P,
  ): ControlDecision;
}
export class Suspension extends Error {
  constructor() {
    super("Execution suspended");
  }
}
