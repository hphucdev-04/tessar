import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  Agent,
  Controller,
  AssistantMessage,
  MessageCodec,
  createTool,
  turn,
  type Plugin,
} from "../../src/index.js";
import { ScriptedProvider } from "../../src/testing/scripted-provider.js";

it("waits for the complete parallel tool batch and retains transient message position", async () => {
  let release!: () => void;
  const slow = {
    promise: new Promise<void>((done) => {
      release = done;
    }),
    resolve: () => release(),
  };
  let fastFinished = false;
  const fast = createTool({
    name: "fast",
    description: "fast",
    schema: z.object({}),
    execute: () => {
      fastFinished = true;
      return "fast-result";
    },
  });
  const wait = createTool({
    name: "wait",
    description: "wait",
    schema: z.object({}),
    execute: async () => {
      await slow.promise;
      return "wait-result";
    },
  });
  const calls = (id: string) => ({
    response: {
      message: MessageCodec.encode(
        new AssistantMessage([
          {
            type: "tool-call",
            name: "fast",
            toolCallId: id + "1",
            arguments: {},
          },
          {
            type: "tool-call",
            name: "wait",
            toolCallId: id + "2",
            arguments: {},
          },
        ]),
      ),
    },
  });
  const provider = new ScriptedProvider([
    calls("a"),
    calls("b"),
    { text: "done" },
  ]);
  const agent = new Agent({
    id: "signal-tools",
    model: provider,
    tools: { fast, wait },
  });
  try {
    const stream = agent.stream("start");
    const done = (async () => {
      for await (const event of stream)
        expect(event.type).not.toBe("stream.error");
    })();
    await vi.waitFor(() => expect(fastFinished).toBe(true));
    await agent.sendSignal({
      streamId: stream.id!,
      content: "transient",
      persist: false,
    });
    expect(provider.calls).toHaveLength(1);
    slow.resolve();
    await done;
    const second = provider.calls[1]!.messages;
    expect(second.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "user",
    ]);
    const third = provider.calls[2]!.messages;
    expect(
      third.findIndex((m) =>
        m.content.some((p) => p.type === "text" && p.text === "transient"),
      ),
    ).toBe(4);
    expect(third.slice(5).map((m) => m.role)).toEqual([
      "assistant",
      "tool",
      "tool",
    ]);
  } finally {
    slow.resolve();
    await agent.shutdown();
  }
});

it("processes a signal from turn.decision in the same stream and honors limits", async () => {
  const provider = new ScriptedProvider([
    { text: "first" },
    { text: "second" },
  ]);
  const agent = new Agent({ id: "signal-decision", model: provider });
  let sent = false;
  const plugin: Plugin = {
    id: "inject",
    setup(tessar) {
      tessar.hook(turn.decision, async (_payload, context) => {
        if (!sent) {
          sent = true;
          await agent.sendSignal({
            streamId: context.streamId!,
            content: "continue",
          });
        }
      });
    },
  };
  const controller = new Controller({
    id: "signal-decision",
    agent,
    plugins: [plugin],
  });
  await controller.initialize();
  try {
    const result = await agent.generate("start", { limits: { maxTurns: 1 } });
    expect(result.status).toBe("stopped");
    expect(provider.calls).toHaveLength(1);
  } finally {
    await controller.dispose();
  }
});

it.each(["policy", "attempt-limit"] as const)(
  "does not override %s with pending signals",
  async (mode) => {
    const provider = new ScriptedProvider([{ text: "first" }]);
    const agent = new Agent({ id: "signal-stop-" + mode, model: provider });
    const controller = new Controller({
      id: "signal-stop-" + mode,
      agent,
      plugins: [
        {
          id: "stop",
          setup(tessar) {
            tessar.hook(turn.decision, async (_event, context) => {
              await agent.sendSignal({
                streamId: context.streamId!,
                content: "pending",
              });
              if (mode === "policy")
                return { decision: "stop", reason: "explicit" };
            });
          },
        },
      ],
    });
    await controller.initialize();
    try {
      const result = await agent.generate("start", {
        limits: { maxModelAttempts: 1 },
      });
      expect(result.status).toBe("stopped");
      expect(provider.calls).toHaveLength(1);
    } finally {
      await controller.dispose();
    }
  },
);

it("honors cancellation without sending pending input to another model request", async () => {
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const provider = new ScriptedProvider([{ gate, text: "first" }]);
  const agent = new Agent({ id: "signal-cancel", model: provider });
  try {
    const stream = agent.stream("start");
    const result = (async () => {
      const events = [];
      for await (const event of stream) events.push(event);
      return events;
    })();
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    await agent.sendSignal({ streamId: stream.id!, content: "pending" });
    stream.abort("cancelled by app");
    const events = await result;
    expect(
      events.find((event) => event.type === "stream.end")!.payload.status,
    ).toBe("cancelled");
    expect(provider.calls).toHaveLength(1);
    await expect(
      agent.sendSignal({ streamId: stream.id!, content: "late" }),
    ).rejects.toThrow();
  } finally {
    release();
    await agent.shutdown();
  }
});
