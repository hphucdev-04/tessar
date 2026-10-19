import { expect, it } from "vitest";
import { z } from "zod";
import { Tool, createTool } from "@tessar/core/tool";
import { ToolMessage } from "../../src/messages/message.js";

it("infers Zod arguments and describes their input before transforms", async () => {
  const schema = z.object({ count: z.string().transform(Number) });
  const tool = createTool({
    name: "count", description: "Count", schema,
    execute: ({ count }) => ({ count: count + 1 }),
  });
  expect(tool).toBeInstanceOf(Tool);
  expect(tool.jsonSchema).toMatchObject({ properties: { count: { type: "string" } } });
  const message = await tool.execute(schema.parse({ count: "2" }), {} as never);
  expect(message).toBeInstanceOf(ToolMessage);
  expect(message.content).toEqual([{ type: "data", data: { count: 3 } }]);
  expect(() => schema.parse({ count: 2 })).toThrow();
  if (false) {
    // @ts-expect-error execute receives the parsed number, not the model's string
    tool.execute({ count: "2" }, {} as never);
  }
});

it.each(["done", 3, true, null, [1, 2], { sum: 3 }].map(value => ({ value })))("normalizes JSON output $value", async ({ value }) => {
  const tool = createTool({ name: "value", description: "Value", schema: z.object({}), execute: async () => value });
  expect(await tool.execute({}, {} as never)).toMatchObject({
    role: "tool",
    content: typeof value === "string" ? [{ type: "text", text: value }] : [{ type: "data", data: value }],
  });
});

it("preserves an explicit ToolMessage instead of wrapping it again", async () => {
  const message = new ToolMessage("cached", { id: "cached-result", metadata: { source: "cache" }, providerState: { marker: 1 } });
  const tool = createTool({ name: "cached", description: "Cached", schema: z.object({}), execute: () => message });
  expect(await tool.execute({}, {} as never)).toBe(message);
});

it.each([undefined, NaN, 1n, new Date()])("rejects missing or non-JSON output %s", async (value) => {
  const tool = createTool({ name: "bad", description: "Bad", schema: z.object({}), execute: () => value as never });
  await expect(tool.execute({}, {} as never)).rejects.toThrow();
});
