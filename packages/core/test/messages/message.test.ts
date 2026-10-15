import { describe, expect, it } from "vitest";
import { AssistantMessage, HumanMessage, SystemMessage, ToolMessage } from "../../src/messages/message.js";
import { MessageCodec } from "../../src/messages/codec.js";
describe("message primitives", () => {
  it("round trips ordered reasoning, tool calls and opaque provider state", () => {
    const message = new AssistantMessage([
      { type: "reasoning", text: "consider", providerState: { signature: "sig" } },
      { type: "text", text: "answer" },
      { type: "tool-call", toolCallId: "c1", name: "lookup", arguments: { id: 1 } },
    ], { id: "m1", providerState: { encrypted: "opaque" } });
    const decoded = MessageCodec.decode(MessageCodec.encode(message));
    expect(decoded).toBeInstanceOf(AssistantMessage);
    expect(decoded.id).toBe("m1");
    expect(decoded.content).toEqual([
      { type: "reasoning", text: "consider", providerState: { signature: "sig" } },
      { type: "text", text: "answer" },
      { type: "tool-call", toolCallId: "c1", name: "lookup", arguments: { id: 1 } },
    ]);
    expect(decoded.providerState).toEqual({ encrypted: "opaque" });
  });
  it("normalizes strings and allocates distinct immutable messages", () => {
    const message = new HumanMessage("hello");
    expect(message.role).toBe("user");
    expect(message.content).toEqual([{ type: "text", text: "hello" }]);
    expect(new HumanMessage("hello").id).not.toBe(message.id);
    expect(new SystemMessage("rules").role).toBe("system");
    expect(Object.isFrozen(message.content)).toBe(true);
    expect(() => { (message.content as unknown as unknown[]).push({}); }).toThrow();
  });
  it("preserves tool correlation and rejects invalid wire input", () => {
    const message = new ToolMessage({ toolCallId: "c1", content: "found" });
    expect(MessageCodec.decode(MessageCodec.encode(message))).toMatchObject({ role: "tool", toolCallId: "c1" });
    for (const bad of [NaN, undefined, () => 1, 1n, new Date()]) {
      expect(() => new HumanMessage("x", { metadata: { bad } as never })).toThrow();
    }
    expect(() => MessageCodec.decode({ schemaVersion: 1, id: "x", role: "alien", content: [] })).toThrow();
    expect(() => new ToolMessage({ toolCallId: "", content: "x" })).toThrow();
    expect(() => MessageCodec.decode({ ...MessageCodec.encode(message), schemaVersion: 99 })).toThrow();
    expect(() => MessageCodec.decode({ schemaVersion: 1, role: "user", content: [] })).toThrow();
  });
  it("copies caller-owned data instead of freezing it in place", () => {
    const state = { signature: "before" };
    const message = new AssistantMessage("x", { providerState: state });
    state.signature = "after";
    expect(message.providerState).toEqual({ signature: "before" });
  });
});

