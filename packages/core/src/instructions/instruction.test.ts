import { expect, it } from "vitest";
import { buildInstruction } from "./instruction.js";
it("keeps ordered immutable instruction sections and rejects duplicate ids", () => {
  const input = [{ id: "a", content: "first" }, { id: "b", content: "second" }];
  const value = buildInstruction(input);
  input[0]!.content = "changed";
  expect(value.sections).toEqual([{ id: "a", content: "first" }, { id: "b", content: "second" }]);
  expect(Object.isFrozen(value.sections[0])).toBe(true);
  expect(() => buildInstruction([{ id: "a", content: "1" }, { id: "a", content: "2" }]))
    .toThrowError(expect.objectContaining({ code: "InvalidConfiguration" }));
  expect(() => buildInstruction([{ id: "", content: "x" }])).toThrow();
});

