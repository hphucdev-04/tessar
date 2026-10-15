import type { Checkpoint } from "../state/schema.js";
import type {
  ModelAttemptRecord,
  ToolExecutionRecord,
} from "../trace/records.js";
export type RecoveryPlan =
  | { kind: "continue" }
  | { kind: "pending-interrupt" }
  | { kind: "model"; attempt: ModelAttemptRecord }
  | { kind: "tool"; tool: ToolExecutionRecord }
  | { kind: "incompatible" };
export class RecoveryService {
  plan(
    checkpoint: Checkpoint,
    attempts: readonly ModelAttemptRecord[],
    tools: readonly ToolExecutionRecord[],
  ): RecoveryPlan {
    const position = checkpoint.execution;
    if (!position) return { kind: "incompatible" };
    if (position.pendingInterruptId) return { kind: "pending-interrupt" };
    if (position.phase === "ModelPending") {
      const attempt = attempts
        .filter((a) => a.turnId === position.turnId && a.purpose === "primary")
        .at(-1);
      return attempt ? { kind: "model", attempt } : { kind: "incompatible" };
    }
    if (position.phase === "ToolPending") {
      const tool = tools.find(
        (t) => t.id === position.pendingToolExecutionIds[0],
      );
      return tool ? { kind: "tool", tool } : { kind: "incompatible" };
    }
    return { kind: "continue" };
  }
}
