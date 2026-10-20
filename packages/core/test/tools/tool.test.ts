import { expect, it } from "vitest";
import { z } from "zod";
import { Tool, createTool, ToolSuspension } from "@tessar/core/tool";
import { ToolMessage } from "../../src/messages/message.js";

it("infers Zod arguments and describes their input before transforms", async () => {
  const schema = z.object({ count: z.string().transform(Number) });
  const tool = createTool({
    name: "count",
    description: "Count",
    schema,
    execute: ({ count }) => ({ count: count + 1 }),
  });
  expect(tool).toBeInstanceOf(Tool);
  expect(tool.jsonSchema).toMatchObject({
    properties: { count: { type: "string" } },
  });
  const message = await tool.execute(schema.parse({ count: "2" }), {} as never);
  expect(message).toBeInstanceOf(ToolMessage);
  expect(message.content).toEqual([{ type: "data", data: { count: 3 } }]);
  expect(() => schema.parse({ count: 2 })).toThrow();
  if (false) {
    // @ts-expect-error execute receives the parsed number, not the model's string
    tool.execute({ count: "2" }, {} as never);
  }
});

it.each(
  ["done", 3, true, null, [1, 2], { sum: 3 }].map((value) => ({ value })),
)("normalizes JSON output $value", async ({ value }) => {
  const tool = createTool({
    name: "value",
    description: "Value",
    schema: z.object({}),
    execute: async () => value,
  });
  expect(await tool.execute({}, {} as never)).toMatchObject({
    role: "tool",
    content:
      typeof value === "string"
        ? [{ type: "text", text: value }]
        : [{ type: "data", data: value }],
  });
});

it("preserves an explicit ToolMessage instead of wrapping it again", async () => {
  const message = new ToolMessage("cached", {
    id: "cached-result",
    metadata: { source: "cache" },
    providerState: { marker: 1 },
  });
  const tool = createTool({
    name: "cached",
    description: "Cached",
    schema: z.object({}),
    execute: () => message,
  });
  expect(await tool.execute({}, {} as never)).toBe(message);
});

it.each([undefined, NaN, 1n, new Date()])(
  "rejects missing or non-JSON output %s",
  async (value) => {
    const tool = createTool({
      name: "bad",
      description: "Bad",
      schema: z.object({}),
      execute: () => value as never,
    });
    await expect(tool.execute({}, {} as never)).rejects.toThrow();
  },
);

it("preserves suspension control values while ordinary JSON stays tool data", async () => {
  const waiting = new ToolSuspension({ question: "Choose" });
  const ask = createTool({
    name: "ask",
    description: "Ask",
    schema: z.object({}),
    execute: () => waiting,
  });
  expect(await ask.execute({}, {} as never)).toBe(waiting);
  const data = createTool({
    name: "data",
    description: "Data",
    schema: z.object({}),
    execute: () => ({ payload: { question: "Choose" } }),
  });
  expect(await data.execute({}, {} as never)).toBeInstanceOf(ToolMessage);
  expect(() => new ToolSuspension(new Date() as never)).toThrow();
});

it("infers parsed resume responses and original tool arguments", () => {
  const ask = createTool({
    name: "ask",
    description: "Ask",
    schema: z.object({ count: z.number() }),
    resumeSchema: z.string().transform(Number),
    execute: (_input, context) => context.suspend("Choose"),
    resume: (response, input) => {
      const sum: number = response + input.count;
      if (false) {
        // @ts-expect-error Parsed resume response is a number
        const text: string = response;
        void text;
      }
      return sum;
    },
  });
  expect(ask.resumeSchema!.parse("2")).toBe(2);
});

it("accepts a conditional suspension alongside an asynchronous result", async () => {
  const ask = createTool({
    name: "ask",
    description: "Ask",
    schema: z.object({ approval: z.boolean() }),
    execute: (input, context) =>
      input.approval ? context.suspend("Approve?") : Promise.resolve("saved"),
  });
  expect(await ask.execute({ approval: false }, {} as never)).toBeInstanceOf(
    ToolMessage,
  );
  const context = { suspend: (payload: string) => new ToolSuspension(payload) };
  expect(
    await ask.execute({ approval: true }, context as never),
  ).toBeInstanceOf(ToolSuspension);
});
