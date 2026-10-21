import { expect, it } from "vitest";
import { buildInstruction } from "../../src/instructions/instruction.js";
it("keeps ordered immutable instruction sections and rejects duplicate ids", () => {
  const input = [
    { id: "a", content: "first" },
    { id: "b", content: "second" },
  ];
  const value = buildInstruction(input);
  input[0]!.content = "changed";
  expect(value.sections).toEqual([
    { id: "a", content: "first" },
    { id: "b", content: "second" },
  ]);
  expect(Object.isFrozen(value.sections[0])).toBe(true);
  expect(() =>
    buildInstruction([
      { id: "a", content: "1" },
      { id: "a", content: "2" },
    ]),
  ).toThrowError(expect.objectContaining({ code: "InvalidConfiguration" }));
  expect(() => buildInstruction([{ id: "", content: "x" }])).toThrow();
});

it("orders a copied array by optional order and ID so registration order cannot change the prefix", () => {
  const sections = [
    { id: "dynamic", order: 1000, content: "changes" },
    { id: "z-plugin", order: 100, content: "z" },
    { id: "base", content: "base" },
    { id: "a-plugin", order: 100, content: "a" },
  ];
  const ids = (value: typeof sections) =>
    buildInstruction(value).sections.map((section) => section.id);
  expect(ids(sections)).toEqual(["base", "a-plugin", "z-plugin", "dynamic"]);
  expect(ids(sections.toReversed())).toEqual([
    "base",
    "a-plugin",
    "z-plugin",
    "dynamic",
  ]);
  expect(sections[0]!.id).toBe("dynamic");
  expect(buildInstruction(sections).sections[0]).not.toHaveProperty("order");
});

it.each([NaN, Infinity, -Infinity, "last"])(
  "rejects a non-finite numeric instruction order: %s",
  (order) => {
    expect(() =>
      buildInstruction([{ id: "invalid", content: "x", order } as any]),
    ).toThrowError(expect.objectContaining({ code: "InvalidConfiguration" }));
  },
);

it("omits an explicitly undefined optional order", () => {
  expect(
    buildInstruction([{ id: "base", content: "text", order: undefined }])
      .sections,
  ).toEqual([{ id: "base", content: "text" }]);
});
