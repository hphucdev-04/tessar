import { describe, expect, it } from "vitest";
import {
  AssistantMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "../../src/messages/message.js";
import { MessageCodec } from "../../src/messages/codec.js";
import type { ContentPart } from "../../src/messages/parts.js";
describe("message primitives", () => {
  it("allows unbound tool results but requires correlation for serialization", () => {
    const message = new ToolMessage("found", { metadata: { source: "cache" } });
    expect(message).toMatchObject({
      role: "tool",
      content: [{ type: "text", text: "found" }],
    });
    expect(() => MessageCodec.encode(message)).toThrow();
    expect(() =>
      MessageCodec.decode({
        schemaVersion: 1,
        id: "missing-call",
        role: "tool",
        content: [],
      }),
    ).toThrow();
    const bound = new ToolMessage("found", {
      toolCallId: "c1",
      metadata: message.metadata,
      id: message.id,
    });
    expect(MessageCodec.decode(MessageCodec.encode(bound))).toMatchObject({
      id: message.id,
      toolCallId: "c1",
      metadata: { source: "cache" },
    });
  });
  it("round trips ordered reasoning, tool calls and opaque provider state", () => {
    const message = new AssistantMessage(
      [
        {
          type: "reasoning",
          text: "consider",
          providerState: { signature: "sig" },
        },
        { type: "text", text: "answer" },
        {
          type: "tool-call",
          toolCallId: "c1",
          name: "lookup",
          arguments: { id: 1 },
        },
      ],
      { id: "m1", providerState: { encrypted: "opaque" } },
    );
    const decoded = MessageCodec.decode(MessageCodec.encode(message));
    expect(decoded).toBeInstanceOf(AssistantMessage);
    expect(decoded.id).toBe("m1");
    expect(decoded.content).toEqual([
      {
        type: "reasoning",
        text: "consider",
        providerState: { signature: "sig" },
      },
      { type: "text", text: "answer" },
      {
        type: "tool-call",
        toolCallId: "c1",
        name: "lookup",
        arguments: { id: 1 },
      },
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
    expect(() => {
      (message.content as unknown as unknown[]).push({});
    }).toThrow();
  });
  it("preserves tool correlation and rejects invalid wire input", () => {
    const message = new ToolMessage("found", { toolCallId: "c1" });
    expect(MessageCodec.decode(MessageCodec.encode(message))).toMatchObject({
      role: "tool",
      toolCallId: "c1",
    });
    for (const bad of [NaN, undefined, () => 1, 1n, new Date()]) {
      expect(
        () => new HumanMessage("x", { metadata: { bad } as never }),
      ).toThrow();
    }
    expect(() =>
      MessageCodec.decode({
        schemaVersion: 1,
        id: "x",
        role: "alien",
        content: [],
      }),
    ).toThrow();
    expect(() => new ToolMessage("x", { toolCallId: "" })).toThrow();
    expect(() =>
      MessageCodec.decode({
        ...MessageCodec.encode(message),
        schemaVersion: 99,
      }),
    ).toThrow();
    expect(() =>
      MessageCodec.decode({ schemaVersion: 1, role: "user", content: [] }),
    ).toThrow();
  });
  it("copies caller-owned data instead of freezing it in place", () => {
    const state = { signature: "before" };
    const message = new AssistantMessage("x", { providerState: state });
    state.signature = "after";
    expect(message.providerState).toEqual({ signature: "before" });
  });
  it("preserves arbitrary part metadata independently from message metadata", () => {
    const metadata = {
      owner: "application",
      nested: { values: [null, false, 7] },
    };
    const parts: ContentPart[] = [
      { type: "text", text: "visible", metadata },
      {
        type: "text",
        text: "additional context",
        metadata: { custom: "anything" },
      },
    ];
    const original = new HumanMessage(parts, {
      metadata: { level: "message" },
    });
    const decoded = MessageCodec.decode(
      JSON.parse(JSON.stringify(MessageCodec.encode(original))),
    );
    expect(decoded.content).toEqual(parts);
    expect(decoded.metadata).toEqual({ level: "message" });
    expect(Object.isFrozen(decoded.content[0]!.metadata!.nested)).toBe(true);
    metadata.owner = "changed";
    expect(decoded.content[0]!.metadata!.owner).toBe("application");
  });
  it("rejects part metadata that is not a JSON object", () => {
    for (const metadata of [
      null,
      true,
      3,
      "text",
      [],
      { bad: NaN },
      { bad: () => 1 },
      new Date(),
    ]) {
      expect(
        () =>
          new HumanMessage([{ type: "text", text: "x", metadata }] as never),
      ).toThrow();
      expect(() =>
        MessageCodec.decode({
          schemaVersion: 1,
          id: "bad-meta",
          role: "user",
          content: [{ type: "text", text: "x", metadata }],
        }),
      ).toThrow();
    }
  });
});
