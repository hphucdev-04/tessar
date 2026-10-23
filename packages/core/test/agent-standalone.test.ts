import { getThread } from "../src/state/thread-operations.js";
import { randomUUID } from "node:crypto";
import { stream as streamHooks, model as modelHooks } from "../src/index.js";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  Agent,
  Controller,
  AssistantMessage,
  HumanMessage,
  MessageCodec,
  createTool,
  defineInterruption,
  type Plugin,
  type ModelAdapter,
  type ModelRequest,
  type ModelChunk,
  type ModelRef,
} from "../src/index.js";

class EchoModel implements ModelAdapter {
  readonly calls: ModelRequest[];
  constructor(
    readonly ref: ModelRef = { providerId: "echo", modelId: "first" },
    readonly options = {
      reasoning: { effort: "high", summary: "auto" },
      max_output_tokens: 8192,
    },
    calls: ModelRequest[] = [],
  ) {
    this.calls = calls;
  }
  withModel(modelId: string) {
    return new EchoModel({ ...this.ref, modelId }, this.options, this.calls);
  }
  validate() {}
  async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
    this.calls.push(structuredClone(request));
    await Promise.resolve();
    yield {
      type: "response",
      response: {
        message: MessageCodec.encode(
          new AssistantMessage(request.model.modelId),
        ),
      },
    };
  }
}

it("requires a default model at construction", () => {
  expect(() => new Agent({ id: "missing" } as any)).toThrowError(
    expect.objectContaining({ code: "MissingModel" }),
  );
});

it("generates and streams standalone with fresh message context each time", async () => {
  const model = new EchoModel(),
    agent = new Agent({ id: randomUUID(), model });
  const result = await agent.generate("hello");
  expect(result.output[0]!.content[0]).toMatchObject({ text: "first" });
  const events = [];
  for await (const event of agent.stream(new HumanMessage("again")))
    events.push(event);
  expect(events.filter((event) => event.type === streamHooks.end)).toHaveLength(
    1,
  );
  expect(model.calls.map((call) => call.messages.length)).toEqual([1, 1]);
  expect(events.every((event) => event.controllerId === undefined)).toBe(true);
});

it("isolates concurrent shallow overrides and keeps the default model and options", async () => {
  const model = new EchoModel(),
    agent = new Agent({ id: randomUUID(), model });
  await Promise.all([
    agent.generate("a", {
      model: "second",
      modelOptions: { reasoning: { effort: "low" } },
    }),
    agent.generate([new HumanMessage("b")], {
      model: "third",
      modelOptions: { max_output_tokens: 1024 },
    }),
  ]);
  await agent.generate("default");
  expect(model.calls.map((call) => call.model.modelId).sort()).toEqual([
    "first",
    "second",
    "third",
  ]);
  expect(
    model.calls.find((call) => call.model.modelId === "second")!.options,
  ).toEqual({ reasoning: { effort: "low" }, max_output_tokens: 8192 });
  expect(
    model.calls.find((call) => call.model.modelId === "third")!.options,
  ).toEqual({
    reasoning: { effort: "high", summary: "auto" },
    max_output_tokens: 1024,
  });
  expect(model.options.reasoning.effort).toBe("high");
});

it("runs tools and the next model step through the existing standalone loop", async () => {
  const calls: ModelRequest[] = [];
  const model: ModelAdapter = {
    ref: { providerId: "tools", modelId: "fixture" },
    validate() {},
    async *stream(request) {
      calls.push(request);
      yield {
        type: "response",
        response: {
          message: MessageCodec.encode(
            new AssistantMessage(
              calls.length === 1
                ? [
                    {
                      type: "tool-call",
                      toolCallId: "call-1",
                      name: "add",
                      arguments: { a: 1, b: 2 },
                    },
                  ]
                : "done",
            ),
          ),
        },
      };
    },
  };
  const add = createTool({
    name: "add",
    description: "add",
    schema: z.object({ a: z.number(), b: z.number() }),
    execute: ({ a, b }) => ({ sum: a + b }),
  });
  const result = await new Agent({
    id: randomUUID(),
    model,
    tools: { add },
  }).generate("add");
  expect(result.status).toBe("completed");
  expect(calls).toHaveLength(2);
  expect(
    calls[1]!.messages.find((message) => message.role === "tool"),
  ).toMatchObject({
    toolCallId: "call-1",
    content: [{ type: "data", data: { sum: 3 } }],
  });
});

it("preserves native model errors and can be reused after a failed call", async () => {
  const failure = new Error("provider down");
  let calls = 0;
  const model: ModelAdapter = {
    ref: { providerId: "test", modelId: "fixture" },
    validate() {},
    async *stream() {
      if (++calls === 1) throw failure;
      yield {
        type: "response",
        response: { message: MessageCodec.encode(new AssistantMessage("ok")) },
      };
    },
  };
  const agent = new Agent({ id: randomUUID(), model });
  await expect(agent.generate("one")).rejects.toBe(failure);
  expect((await agent.generate("two")).status).toBe("completed");
});

it("uses default executable-model options through Controller and queued Session turns", async () => {
  const model = new EchoModel({
    providerId: "echo",
    modelId: "first",
    connectionId: "one",
  });
  const agent = new Agent({ id: randomUUID(), model }),
    controller = new Controller({ id: "host", agent });
  try {
    await controller.initialize();
    const session = await controller.createSession();
    await session.thread.create();
    const done = new Promise<void>((resolve) => {
      let count = 0;
      session.subscribe(streamHooks.end, () => {
        if (++count === 2) resolve();
      });
    });
    await session.followUp(new HumanMessage("one"));
    await session.model.switch(model.ref.providerId + "/second");
    await session.followUp(new HumanMessage("two"));
    await done;
    expect(model.calls.map((call) => call.model.modelId)).toEqual([
      "first",
      "second",
    ]);
    expect(model.calls.map((call) => call.options)).toEqual([
      model.options,
      model.options,
    ]);
    expect(
      model.calls[1]!.messages.filter((message) => message.role === "user"),
    ).toHaveLength(2);
  } finally {
    await controller.dispose();
  }
});

it("cleans up an aborted execution and leaves the Agent reusable", async () => {
  let started!: () => void;
  const entered = new Promise<void>((resolve) => (started = resolve));
  let calls = 0;
  const model: ModelAdapter = {
    ref: { providerId: "abort", modelId: "test" },
    validate() {},
    async *stream(_request, context) {
      if (++calls === 1) {
        started();
        await new Promise<void>((_resolve, reject) => {
          if (context.signal.aborted) reject(context.signal.reason);
          else
            context.signal.addEventListener(
              "abort",
              () => reject(context.signal.reason),
              { once: true },
            );
        });
      }
      yield {
        type: "response",
        response: { message: MessageCodec.encode(new AssistantMessage("ok")) },
      };
    },
  };
  const agent = new Agent({ id: randomUUID(), model });
  const stream = agent.stream("one");
  const collect = (async () => {
    const events = [];
    for await (const event of stream) events.push(event);
    return events;
  })();
  await entered;
  stream.abort("user cancelled");
  const events = await collect;
  expect(
    events.find((event) => event.type === streamHooks.end)?.payload.status,
  ).toBe("cancelled");
  expect((await agent.generate("two")).status).toBe("completed");
});

it("uses the selected provider defaults when a hook changes connection", async () => {
  const calls: ModelRequest[] = [];
  const other: ModelAdapter = {
    ref: { providerId: "other", modelId: "test" },
    options: { temperature: 0.3 },
    validate() {},
    async *stream(request) {
      calls.push(request);
      yield {
        type: "response",
        response: { message: MessageCodec.encode(new AssistantMessage("ok")) },
      };
    },
  };
  const agent = new Agent({ id: randomUUID(), model: new EchoModel() });
  const controller = new Controller({
    id: "host",
    agent,
    plugins: [
      {
        id: "other",
        setup(tessar) {
          tessar.models.register({ id: "other", create: () => other });
          tessar.hook(modelHooks.select, () => ({
            decision: "select",
            model: other.ref,
          }));
        },
      },
    ],
  });
  try {
    await controller.initialize();
    await agent.generate("hello");
    expect(calls[0]!.options).toEqual({ temperature: 0.3 });
  } finally {
    await controller.dispose();
  }
});

function pausePlugin(): Plugin {
  const question = defineInterruption({
    id: "pause",
    version: 1,
    response: { jsonSchema: {}, parse: () => ({}) },
    resolve: () => ({ decision: "allow" }),
  });
  return {
    id: "pause",
    setup(tessar) {
      tessar.interruptions.register(question);
      tessar.hook(streamHooks.before, (_event, context) =>
        context.suspend(question, {}),
      );
    },
  };
}

it.each(["echo", "another"])(
  "retains a per-call %s connection across suspension and recovery",
  async (providerId) => {
    const first = new EchoModel({
      providerId: "echo",
      modelId: "first",
      connectionId: "one",
    });
    const second = new EchoModel({
      providerId,
      modelId: "second",
      connectionId: "two",
    });
    const agent = new Agent({ id: randomUUID(), model: first });
    const controller = new Controller({
      id: "host",
      agent,
      plugins: [pausePlugin()],
    });
    try {
      await controller.initialize();
      const result = await agent.generate("hello", { model: second });
      expect(result.status).toBe("suspended");
      const thread = (await getThread(controller, result.threadId))!;
      for await (const _event of thread.stream({
        recover: { streamId: result.streamId },
      })) {
      }
      for await (const _event of thread.stream({
        resume: { interruptId: result.interrupt!.id, value: {} },
      })) {
      }
      expect((await thread.getStream(result.streamId))!.status).toBe(
        "completed",
      );
      expect(second.calls).toHaveLength(1);
      expect(first.calls).toHaveLength(0);
    } finally {
      await controller.dispose();
    }
  },
);

it.each(["resume", "recover"])(
  "discards old connection options on a %s model override",
  async (command) => {
    const first = new EchoModel();
    const calls: ModelRequest[] = [];
    const other: ModelAdapter = {
      ref: { providerId: "other", modelId: "test" },
      options: { max_tokens: 100 },
      validate() {},
      async *stream(request) {
        calls.push(request);
        yield {
          type: "response",
          response: {
            message: MessageCodec.encode(new AssistantMessage("ok")),
          },
        };
      },
    };
    const agent = new Agent({ id: randomUUID(), model: first });
    const controller = new Controller({
      id: "host",
      agent,
      plugins: [
        pausePlugin(),
        {
          id: "other",
          setup(tessar) {
            tessar.models.register({ id: "other", create: () => other });
          },
        },
      ],
    });
    try {
      await controller.initialize();
      const result = await agent.generate("hello");
      const thread = (await getThread(controller, result.threadId))!;
      if (command === "recover")
        for await (const _event of thread.stream({
          recover: { streamId: result.streamId },
          model: other.ref,
        })) {
        }
      for await (const _event of thread.stream({
        resume: { interruptId: result.interrupt!.id, value: {} },
        ...(command === "resume" ? { model: other.ref } : {}),
      })) {
      }
      expect((await thread.getStream(result.streamId))!.status).toBe(
        "completed",
      );
      expect(calls[0]!.options).toEqual({ max_tokens: 100 });
    } finally {
      await controller.dispose();
    }
  },
);
