import { expect, it } from "vitest";
import { ScriptedProvider } from "../../src/testing/scripted-provider.js";
import { HumanMessage } from "../../src/messages/message.js";
import { MessageCodec } from "../../src/messages/codec.js";
import { normalizeInstruction } from "../../src/instructions/instruction.js";
it("captures immutable normalized requests and forwards structured responses", async () => {
  const provider = new ScriptedProvider([
    { text: "answer", usage: { inputTokens: 2, outputTokens: 1 } },
  ]);
  const request = {
    model: { providerId: "scripted", modelId: "test" },
    instructions: normalizeInstruction("rules"),
    messages: [MessageCodec.encode(new HumanMessage("ask"))],
    tools: [],
  };
  const chunks = [];
  for await (const chunk of provider.stream(request, {
    signal: new AbortController().signal,
  }))
    chunks.push(chunk);
  expect(provider.calls).toHaveLength(1);
  expect(chunks.at(-1)).toMatchObject({
    type: "response",
    response: {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
      },
    },
  });
  expect(Object.isFrozen(provider.calls[0]!.messages)).toBe(true);
});
