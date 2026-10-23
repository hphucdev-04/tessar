import { getThread } from "../src/state/thread-operations.js";
import { stream as streamHooks } from "../src/index.js";
import { expect, it } from "vitest";
import {
  Agent,
  Controller,
  HumanMessage,
  defineInterruption,
  ToolDecision,
} from "../src/index.js";
import { fixture, fixtureRef } from "./test-fixture.js";
it("delegates stream and generate to canonical execution and preserves default selection", async () => {
  const { agent, controller, provider } = await fixture([
    { text: "first", usage: { inputTokens: 5, outputTokens: 3 } },
    { text: "second" },
  ]);
  try {
    const outcome = await agent.generate(new HumanMessage("ask"), {
      model: { ...fixtureRef, modelId: "alternate" },
      scope: { user: "u" },
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.output[0]!.content[0]).toMatchObject({ text: "first" });
    expect(outcome.usage.metrics.outputTokens.knownTotal).toBe(3);
    const stream = agent.stream(new HumanMessage("next"));
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events.some((e) => e.type === streamHooks.end)).toBe(true);
    expect(provider.calls.map((c) => c.model.modelId)).toEqual([
      "alternate",
      "test",
    ]);
    expect((await getThread(controller, outcome.threadId))!.scope()).toEqual({
      user: "u",
    });
  } finally {
    await controller.dispose();
  }
});
it("returns suspended generate with durable interrupt and does not wait for a response", async () => {
  const approval = defineInterruption({
    id: "ask",
    version: 1,
    response: { jsonSchema: { type: "boolean" }, parse: (v) => Boolean(v) },
    resolve: () => ToolDecision.allow(),
  });
  const { agent, controller } = await fixture(
    [],
    [
      {
        id: "approval",
        setup(tessar) {
          tessar.interruptions.register(approval);
          tessar.hook(streamHooks.before, (_e, context) =>
            context.suspend(approval, {}),
          );
        },
      },
    ],
  );
  try {
    const result = await agent.generate(new HumanMessage("ask"));
    expect(result.status).toBe("suspended");
    expect(result.interrupt!.streamId).toBe(result.streamId);
    expect(
      (await (await getThread(controller, result.threadId))!.snapshot())
        .activeStreamId,
    ).toBe(result.streamId);
  } finally {
    await controller.dispose();
  }
});
it("keeps legacy model references dependent on an explicitly registered provider", async () => {
  const agent = new Agent({
    id: "a",
    model: { providerId: "test", modelId: "test" },
  });
  expect(() => agent.stream(new HumanMessage("ask"))).toThrow();
  const controller = new Controller({ id: "r", agent });
  expect(() => agent.stream(new HumanMessage("ask"))).toThrow();
  await controller.initialize();
  expect(() => agent.stream(new HumanMessage("ask"))).toThrowError(
    expect.objectContaining({ code: "MissingProvider" }),
  );
  await controller.dispose();
});
