import { expect, it } from "vitest";
import { createSignalMessage, type SendSignalOptions } from "../src/signal.js";

it("validates one target and always creates a user message", () => {
  const options = { streamId: "s", content: "hello" };
  expect(createSignalMessage(options)).toMatchObject({
    role: "user",
    content: [{ type: "text", text: "hello" }],
  });
  for (const invalid of [
    { content: "x" },
    { streamId: "", content: "x" },
    { streamId: "s", threadId: "t", content: "x" },
    { streamId: "s" },
    { ...options, role: "assistant" },
    { ...options, persist: "yes" },
  ])
    expect(() => createSignalMessage(invalid as SendSignalOptions)).toThrow();
});

it("wraps multipart content without changing its parts or application metadata", () => {
  const options: SendSignalOptions = {
    threadId: "t",
    tagName: "notification",
    attributes: { source: 'a&"b', pr: 123, ready: true },
    content: [{ type: "text", text: "<body/>", metadata: { hidden: true } }],
    metadata: { source: "app" },
  };
  const message = createSignalMessage(options);
  expect(message.content).toEqual([
    {
      type: "text",
      text: '<notification source="a&amp;&quot;b" pr="123" ready="true">\n',
    },
    { type: "text", text: "<body/>", metadata: { hidden: true } },
    { type: "text", text: "\n</notification>" },
  ]);
  expect(message.metadata).toEqual({ source: "app" });
  (options.metadata as { source: string }).source = "mutated";
  expect(message.metadata!.source).toBe("app");
  expect(Object.isFrozen(message.content)).toBe(true);
});

it("rejects invalid XML and nonobject metadata rather than silently dropping them", () => {
  for (const fields of [
    { attributes: { a: "b" } },
    { tagName: "bad>" },
    { tagName: "ok", attributes: { "bad key": "b" } },
    { tagName: "ok", attributes: { a: Infinity } },
    { tagName: "ok", attributes: { a: {} } },
    { metadata: [] },
  ])
    expect(() =>
      createSignalMessage({
        threadId: "t",
        content: "x",
        ...fields,
      } as SendSignalOptions),
    ).toThrow();
});
