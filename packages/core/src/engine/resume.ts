import { TessarError, fail } from "../errors.js";
import { immutable, type JsonValue } from "../json.js";
import { canonicalJson } from "../state/commit.js";
import type { StorageBackend } from "../state/storage-ports.js";
import type { RegistryLease } from "../plugins/registry.js";
import type { InterruptionDefinition } from "./interrupt.js";
import type { ControlDecision } from "../events/catalog.js";
import type { ExecutionPhase, InterruptRecord } from "../state/schema.js";
export function phaseForEvent(id: string): ExecutionPhase {
  const phases: Record<string, ExecutionPhase> = {
    "stream.before": "BeforeTurn",
    "tool.before": "BeforeTool",
    "model.select": "BeforeModel",
    "model.recover": "ModelPending",
    "turn.decision": "TurnBoundary",
  };
  return (
    phases[id] ??
    fail("ResumeIncompatible", "Unsupported interruption boundary")
  );
}
export function validateManifest(
  manifest: readonly {
    kind: string;
    id: string;
    version: number;
    requiredForContinuation: boolean;
    pluginVersion?: number;
    configurationId?: string | null;
  }[],
  registry: RegistryLease,
  modelOverride?: { providerId: string },
): void {
  for (const requirement of manifest) {
    if (!requirement.requiredForContinuation) continue;
    if (requirement.kind === "provider" && modelOverride) continue;
    const present =
      requirement.kind === "handler"
        ? registry.handlers.find(
            (r) => r.id === requirement.id && r.version === requirement.version,
          )
        : registry.values.find(
            (r) =>
              r.kind === requirement.kind &&
              r.id === requirement.id &&
              r.version === requirement.version,
          );
    if (!present)
      fail(
        "ResumeIncompatible",
        "Required contract is missing: " + requirement.id,
      );
    if (
      (requirement.pluginVersion !== undefined &&
        present.pluginVersion !== requirement.pluginVersion) ||
      (requirement.configurationId !== undefined &&
        present.configurationId !== requirement.configurationId)
    )
      fail("ResumeIncompatible", "Plugin configuration/version changed");
  }
}
export async function validateResume(
  backend: StorageBackend,
  registry: RegistryLease,
  threadId: string,
  interruptId: string,
  value: JsonValue,
): Promise<{ interrupt: InterruptRecord; decision: ControlDecision }> {
  const interrupt = await backend.executions.get("interrupts", interruptId, {
    threadId,
  });
  if (!interrupt)
    fail("InterruptNotFound", "Interrupt does not belong to thread");
  if (interrupt.status !== "pending")
    fail("AlreadyResumed", "Interrupt already consumed");
  const binding = registry.find<{
    definition: InterruptionDefinition;
    pluginId: string;
  }>("interruption", interrupt.definitionId);
  if (
    !binding ||
    binding.pluginId !== interrupt.pluginId ||
    binding.definition.version !== interrupt.definitionVersion
  )
    fail(
      "ResumeIncompatible",
      "Interruption definition is missing or incompatible",
    );
  let decision: ControlDecision;
  try {
    const parsed = binding.definition.response.parse(value);
    decision = binding.definition.resolve(parsed, interrupt.payload);
    immutable(decision);
  } catch (error) {
    throw new TessarError(
      "InvalidResumeResponse",
      "Response does not satisfy interruption contract",
    );
  }
  if (decision.decision === "suspend")
    fail("InvalidResumeResponse", "Resolver must return a resolved decision");
  return { interrupt, decision: immutable(decision) };
}
