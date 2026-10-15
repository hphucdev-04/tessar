import { fail, requireId } from "../errors.js";
import { immutable } from "../json.js";
export interface InstructionSection {
  readonly id: string;
  readonly content: string;
}
export interface Instruction {
  readonly sections: readonly InstructionSection[];
}
export function buildInstruction(
  sections: readonly InstructionSection[],
): Instruction {
  const ids = new Set<string>();
  for (const section of sections) {
    requireId(section.id, "section id");
    if (typeof section.content !== "string" || ids.has(section.id))
      fail(
        "InvalidConfiguration",
        "Instruction sections need unique ids and string content",
      );
    ids.add(section.id);
  }
  return immutable({ sections });
}
export function normalizeInstruction(
  value: string | Instruction = "",
): Instruction {
  return buildInstruction(
    typeof value === "string"
      ? [{ id: "default", content: value }]
      : value.sections,
  );
}
