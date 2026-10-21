import assert from "node:assert/strict";
import {
  Agent,
  AssistantMessage,
  Controller,
  MessageCodec,
  createTool,
  normalizeUsage,
} from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { z } from "zod";

// Exercise built public contracts without harness admission or internal imports.
const worker = new Agent({
  id: "public-worker",
  model: new ScriptedProvider([
    { text: "worker answer", usage: { inputTokens: 20, outputTokens: 1 } },
    { text: "stream answer" },
  ]),
});
const parent = new Agent({
  id: "public-parent",
  model: new ScriptedProvider([
    {
      response: {
        message: MessageCodec.encode(new AssistantMessage([
          { type: "tool-call", toolCallId: "delegate-call", name: "delegate", arguments: {} },
        ])),
        usage: normalizeUsage({ inputTokens: 10, outputTokens: 0 }),
      },
    },
    { text: "parent answer", usage: { inputTokens: 5, outputTokens: 1 } },
  ]),
});
let delegated = false;
const controller = new Controller({
  id: "public-composition",
  agent: parent,
  plugins: [{
    id: "delegate-plugin",
    setup(tessar) {
      tessar.agent.register(worker);
      tessar.tools.register(createTool({
        name: "delegate",
        description: "Ask an independent agent",
        schema: z.object({}),
        async execute() {
          const result = await worker.generate("independent task");
          assert.equal(result.status, "completed");
          assert.equal(result.usage.metrics.inputTokens.knownTotal, 20);
          assert.deepEqual(result.output[0]!.content, [{ type: "text", text: "worker answer" }]);
          delegated = true;
          return "worker completed";
        },
      }));
    },
  }],
});
await controller.initialize();
try {
  const result = await parent.generate("ask worker");
  assert.ok(result.streamId);
  assert.equal(result.status, "completed");
  assert.equal(delegated, true);
  assert.equal(result.usage.metrics.inputTokens.knownTotal, 15);
  const events = worker.stream("stream identity", { id: "public-stream-run" });
  assert.equal(events.id, "public-stream-run");
  for await (const event of events) assert.equal(event.streamId, events.id);
  const session = await controller.createSession({ id: "composition-session" });
  assert.equal(session.id, "composition-session");
  const thread = await session.thread.create({ id: "composition-thread" });
  assert.equal(thread.id, "composition-thread");
  const fork = await session.thread.fork({ id: "composition-fork" });
  assert.equal(fork.id, "composition-fork");
} finally {
  await controller.dispose();
}
