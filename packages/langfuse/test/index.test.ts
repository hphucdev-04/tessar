import { expect, it, vi, onTestFinished } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { AgentHarness } from "@tessar/core/testing";
import { AssistantMessage, MessageCodec, createTool } from "@tessar/core";
import { createSqliteBackend } from "@tessar/sqlite";
import { z } from "zod";
import { LangfusePlugin } from "../src/index.js";

const captured = vi.hoisted(() => ({ spans: [] as ReadableSpan[][], closed: [] as boolean[] }));
vi.mock("@langfuse/otel", async () => {
  const { SimpleSpanProcessor } = await import("@opentelemetry/sdk-trace-base");
  return { LangfuseSpanProcessor: class extends SimpleSpanProcessor {
    constructor() {
      const index = captured.spans.length;
      const spans: ReadableSpan[] = [];
      captured.spans.push(spans); captured.closed.push(false);
      super({
        export(batch, done) { spans.push(...batch); done({ code: 0 }); },
        async shutdown() { captured.closed[index] = true; },
      });
    }
  } };
});

const decode = (span: ReadableSpan, key: string) => {
  const value = span.attributes[key];
  return typeof value === "string" ? JSON.parse(value) : value;
};
const type = (span: ReadableSpan) => span.attributes["langfuse.observation.type"];
const metadata = (span: ReadableSpan, key: string) => decode(span, "langfuse.observation.metadata." + key);
const response = (name: string) => ({ response: { message: MessageCodec.encode(new AssistantMessage([
  { type: "tool-call" as const, toolCallId: "call", name, arguments: {} },
])) } });

it("exports stream/turn/model/tool hierarchy including auxiliary calls and exclusive token buckets", async () => {
  const start = captured.spans.length;
  const model = { providerId: "scripted", modelId: "test" };
  const helper = createTool({ name: "helper", description: "Helper", schema: z.object({}),
    execute: async (_input, context) => {
      for await (const _ of context.models.stream({ model, purpose: "auxiliary",
        request: { model, instructions: { sections: [] }, messages: [], tools: [] } })) {}
      return "tool result";
    } });
  const harness = await AgentHarness.create({
    tools: { helper }, plugins: [new LangfusePlugin({
      publicKey: "pk-test", secretKey: "sk-test", baseUrl: "http://localhost:3000",
      traceName: "tool conversation", tags: ["demo", "tools"], prompt: { name: "agent-system", version: 2 },
    })],
    modelScripts: [response("helper"), { text: "auxiliary" }, { text: "answer", usage: {
      inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 40, cacheWriteInputTokens: 10, reasoningOutputTokens: 5,
    } }],
  });
  try { expect((await harness.agent.generate("hello", { model })).status).toBe("completed"); }
  finally { await harness.dispose(); }
  const spans = captured.spans[start]!;
  const agent = spans.find(span => type(span) === "agent")!;
  const turns = spans.filter(span => type(span) === "span");
  const generations = spans.filter(span => type(span) === "generation");
  const tool = spans.find(span => type(span) === "tool")!;
  expect(turns).toHaveLength(2); expect(generations).toHaveLength(3);
  const firstTurn = turns.find(span => span.name === "turn 1")!;
  const secondTurn = turns.find(span => span.name === "turn 2")!;
  expect(firstTurn).toBeDefined(); expect(secondTurn).toBeDefined();
  const firstGeneration = generations.find(span => span.parentSpanContext?.spanId === firstTurn.spanContext().spanId)!;
  expect(decode(firstTurn, "langfuse.observation.input")).toEqual(decode(firstGeneration, "langfuse.observation.input"));
  const firstOutput = decode(firstTurn, "langfuse.observation.output");
  expect(firstOutput.map((message: { role: string }) => message.role)).toEqual(["assistant", "tool"]);
  expect(firstOutput[0].content[0].type).toBe("tool-call");
  expect(firstOutput[1]).toEqual(decode(tool, "langfuse.observation.output"));
  expect(JSON.stringify(firstOutput)).not.toContain("auxiliary");
  expect(decode(secondTurn, "langfuse.observation.input").messages).toEqual(harness.provider.calls.at(-1)!.messages);
  expect(decode(secondTurn, "langfuse.observation.output")[0].content[0].text).toBe("answer");
  expect(turns.every(span => span.parentSpanContext?.spanId === agent.spanContext().spanId)).toBe(true);
  expect(generations.find(span => metadata(span, "purpose") === "auxiliary")?.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
  expect(decode(agent, "langfuse.observation.input")[0].role).toBe("user");
  expect(decode(agent, "langfuse.observation.output")).toEqual([
    ...firstOutput, ...decode(secondTurn, "langfuse.observation.output"),
  ]);
  const last = generations.find(span => decode(span, "langfuse.observation.output")?.content?.[0]?.text === "answer")!;
  expect(decode(last, "langfuse.observation.usage_details")).toEqual({ input: 50, input_cached_tokens: 40, input_cache_write: 10, output: 15, output_reasoning_tokens: 5, total: 120 });
  expect(decode(last, "langfuse.observation.input").messages).toBeDefined();
  expect(metadata(agent, "streamId")).toBeTruthy();
  expect(spans.every(span => span.attributes["langfuse.trace.name"] === "tool conversation")).toBe(true);
  expect(spans.every(span => JSON.stringify(span.attributes["langfuse.trace.tags"]) === JSON.stringify(["demo", "tools"]))).toBe(true);
  expect(last.attributes["langfuse.observation.model.name"]).toBe("test");
  expect(last.attributes["langfuse.observation.completion_start_time"]).toBeDefined();
  expect(last.attributes["langfuse.observation.prompt.name"]).toBe("agent-system");
  expect(last.attributes["langfuse.observation.prompt.version"]).toBe(2);
  expect(generations.find(span => metadata(span, "purpose") === "auxiliary")!.attributes["langfuse.observation.prompt.name"]).toBeUndefined();
  expect(captured.closed[start]).toBe(true);
});

it("isolates concurrent streams without registering or replacing the application's global tracer provider", async () => {
  const { trace } = await import("@opentelemetry/api");
  const global = trace.getTracerProvider();
  const start = captured.spans.length;
  const harness = await AgentHarness.create({ modelScripts: [{ text: "first" }, { text: "second" }], plugins: [new LangfusePlugin()] });
  try {
    const streams = [harness.agent.stream("one", { model: harness.provider.ref }), harness.agent.stream("two", { model: harness.provider.ref })];
    await Promise.all(streams.map(stream => harness.collect(stream)));
  } finally { await harness.dispose(); }
  const spans = captured.spans[start]!;
  const roots = spans.filter(span => type(span) === "agent");
  expect(roots).toHaveLength(2);
  expect(new Set(roots.map(span => span.spanContext().traceId)).size).toBe(2);
  for (const root of roots) {
    const children = spans.filter(span => span.spanContext().traceId === root.spanContext().traceId);
    expect(children).toHaveLength(3);
    expect(children.every(span => metadata(span, "streamId") === metadata(root, "streamId"))).toBe(true);
  }
  expect(trace.getTracerProvider()).toBe(global);
});

it("records each retry as a separate generation and omits unknown token counts", async () => {
  const start = captured.spans.length;
  const harness = await AgentHarness.create({
    modelScripts: [{ error: Error("busy") }, { text: "recovered" }],
    plugins: [new LangfusePlugin(), { id: "retry", setup(tessar) { tessar.hook("model.recover", () => ({ decision: "retry" })); } }],
  });
  try { expect((await harness.agent.generate("hello", { model: harness.provider.ref })).status).toBe("completed"); }
  finally { await harness.dispose(); }
  const generations = captured.spans[start]!.filter(span => type(span) === "generation");
  expect(generations).toHaveLength(2);
  expect(new Set(generations.map(span => metadata(span, "attemptId"))).size).toBe(2);
  expect(generations.find(span => span.status.code === 2)?.attributes["langfuse.observation.status_message"]).toBe("busy");
  const success = generations.find(span => span.status.code !== 2)!;
  expect(decode(success, "langfuse.observation.usage_details")).toBeUndefined();
  const turn = captured.spans[start]!.find(span => span.name === "turn 1")!;
  expect(turn).toBeDefined();
  expect(decode(turn, "langfuse.observation.input")).toEqual(decode(success, "langfuse.observation.input"));
  expect(decode(turn, "langfuse.observation.output")).toEqual([decode(success, "langfuse.observation.output")]);
});

it("links suspension and restart/resume to the same trace using existing logical IDs", async () => {
  const start = captured.spans.length;
  const directory = await mkdtemp(join(tmpdir(), "tessar-langfuse-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const filename = join(directory, "state.db");
  const ask = createTool({ name: "ask", description: "Wait", schema: z.object({}), execute: (_input, context) => context.suspend({ question: "Continue?" }) });
  const first = await AgentHarness.create({ backend: await createSqliteBackend({ filename }), tools: { ask }, modelScripts: [response("ask")], plugins: [new LangfusePlugin()] });
  let sessionId: string, interruptId: string, streamId: string;
  try {
    const session = await first.controller.createSession({ threadId: "conversation", scope: { userId: "user-one" }, model: first.provider.ref });
    sessionId = session.id;
    const pending = new Promise<void>(resolve => session.subscribe("stream.suspended", event => {
      interruptId = event.payload.interrupt.id; streamId = event.streamId!; resolve();
    }));
    await session.followUp("ask"); await pending;
  } finally { await first.dispose(); }
  const second = await AgentHarness.create({ backend: await createSqliteBackend({ filename }), tools: { ask }, modelScripts: [{ text: "resumed" }], plugins: [new LangfusePlugin()] });
  try {
    const session = (await second.controller.getSession(sessionId!))!;
    const done = new Promise<void>(resolve => session.subscribe("stream.end", () => resolve()));
    await session.resume({ interruptId: interruptId!, value: "yes" }); await done;
  } finally { await second.dispose(); }
  const roots = captured.spans.slice(start).flat().filter(span => type(span) === "agent");
  expect(roots).toHaveLength(1);
  expect(new Set(roots.map(span => span.spanContext().traceId)).size).toBe(1);
  const turns = captured.spans.slice(start).flat().filter(span => type(span) === "span");
  expect(turns.every(span => metadata(span, "streamId") === streamId! && metadata(span, "threadId") === "conversation")).toBe(true);
  expect(metadata(roots[0]!, "status")).toBe("suspended");
  expect(roots.every(span => span.attributes["session.id"] === sessionId!)).toBe(true);
  expect(decode(roots[0]!, "langfuse.observation.output")[0].content[0].type).toBe("tool-call");
  const resumedTurns = captured.spans.slice(start + 1).flat().filter(span => type(span) === "span");
  expect(resumedTurns.some(span => span.name === "turn 1")).toBe(false);
  const originalTurn = turns.find(span => span.name === "turn 1")!;
  const resumedTool = captured.spans.slice(start + 1).flat().find(span => type(span) === "tool")!;
  expect(resumedTool.parentSpanContext?.spanId).toBe(originalTurn.spanContext().spanId);
  expect(resumedTurns.some(span => span.name === "turn 2")).toBe(true);
});

it("retains the actual Turn input and an empty output when its model fails", async () => {
  const start = captured.spans.length;
  const harness = await AgentHarness.create({
    modelScripts: [{ error: Error("provider unavailable") }], plugins: [new LangfusePlugin()],
  });
  try { await expect(harness.agent.generate("hello", { model: harness.provider.ref })).rejects.toThrow("provider unavailable"); }
  finally { await harness.dispose(); }
  const spans = captured.spans[start]!;
  const turn = spans.find(span => span.name === "turn 1")!;
  expect(turn).toBeDefined();
  expect(decode(turn, "langfuse.observation.input")).toEqual(harness.provider.calls[0]);
  expect(decode(turn, "langfuse.observation.output")).toEqual([]);
  expect(decode(spans.find(span => type(span) === "agent")!, "langfuse.observation.output")).toEqual([]);
  expect(decode(spans.find(span => type(span) === "generation")!, "langfuse.observation.output")).toBeUndefined();
});

it("uses the effective request and committed messages after application transforms", async () => {
  const start = captured.spans.length;
  const harness = await AgentHarness.create({
    modelScripts: [{ text: "raw answer" }],
    plugins: [new LangfusePlugin(), { id: "transforms", setup(tessar) {
      tessar.hook("model.request", event => ({ ...event.payload, options: { temperature: 0.25 } }));
      tessar.hook("message.prepare", event => event.payload.role === "assistant"
        ? { ...event.payload, content: [{ type: "text", text: "committed answer" }] }
        : event.payload);
    } }],
  });
  try { await harness.agent.generate("hello", { model: harness.provider.ref }); }
  finally { await harness.dispose(); }
  const spans = captured.spans[start]!;
  const turn = spans.find(span => span.name === "turn 1")!;
  const generation = spans.find(span => type(span) === "generation")!;
  expect(decode(turn, "langfuse.observation.input")).toEqual(harness.provider.calls[0]);
  expect(decode(turn, "langfuse.observation.input").options).toEqual({ temperature: 0.25 });
  expect(decode(turn, "langfuse.observation.output")[0].content[0].text).toBe("committed answer");
  expect(decode(generation, "langfuse.observation.output").content[0].text).toBe("raw answer");
});

it("appends Session follow-ups to one Agent trace with continuous Turn numbers and the correct history", async () => {
  const start = captured.spans.length;
  const harness = await AgentHarness.create({
    modelScripts: [{ text: "first answer" }, { text: "second answer" }], plugins: [new LangfusePlugin()],
  });
  let sessionId: string;
  try {
    const session = await harness.controller.createSession({ threadId: "session-history", model: harness.provider.ref });
    sessionId = session.id;
    for (const input of ["first question", "second question"]) {
      let stop = () => {};
      const completed = new Promise<void>((resolve, reject) => {
        stop = session.subscribe(event => {
          if (event.type === "stream.end") resolve();
          if (event.type === "stream.error") reject(Error(event.payload.error.message));
        });
      });
      try { await session.followUp(input); await completed; }
      finally { stop(); }
    }
  } finally { await harness.dispose(); }
  const spans = captured.spans[start]!;
  const roots = spans.filter(span => type(span) === "agent");
  const turns = spans.filter(span => type(span) === "span");
  expect(roots).toHaveLength(1);
  expect(roots[0]!.attributes["session.id"]).toBe(sessionId!);
  expect(new Set(spans.map(span => span.spanContext().traceId)).size).toBe(1);
  expect(turns.every(span => span.parentSpanContext?.spanId === roots[0]!.spanContext().spanId)).toBe(true);
  expect(turns.map(span => span.name).sort()).toEqual(["turn 1", "turn 2"]);
  expect(turns.every(span => metadata(span, "threadId") === "session-history")).toBe(true);
  expect(new Set(turns.map(span => metadata(span, "streamId"))).size).toBe(2);
  // The root is exported once; later Turns append to its existing identity.
  expect(decode(roots[0]!, "langfuse.observation.input")).toHaveLength(1);
  expect(decode(roots[0]!, "langfuse.observation.output")).toHaveLength(1);
  expect(turns.map(span => decode(span, "langfuse.observation.input").messages.length).sort()).toEqual([1, 3]);
  expect(turns.map(span => decode(span, "langfuse.observation.output")[0].content[0].text).sort()).toEqual(["first answer", "second answer"]);
});

it("keeps Thread traces isolated and continues their numbers after switching back", async () => {
  const start = captured.spans.length;
  const harness = await AgentHarness.create({
    modelScripts: [{ text: "one" }, { text: "two" }, { text: "three" }, { text: "four" }], plugins: [new LangfusePlugin()],
  });
  let firstId: string, secondId: string;
  try {
    const first = await harness.controller.createSession({ threadId: "thread-a", model: harness.provider.ref });
    const second = await harness.controller.createSession({ threadId: "thread-c", model: harness.provider.ref });
    firstId = first.id; secondId = second.id;
    for (const [index, session] of [first, first, second, first].entries()) {
      if (index === 1) await session.thread.create({ id: "thread-b" });
      if (index === 3) await session.thread.switch("thread-a");
      let stop = () => {};
      const completed = new Promise<void>((resolve, reject) => {
        stop = session.subscribe(event => {
          if (event.type === "stream.end") resolve();
          if (event.type === "stream.error") reject(Error(event.payload.error.message));
        });
      });
      try { await session.followUp("hello"); await completed; }
      finally { stop(); }
    }
    await first.dispose();
    expect(captured.spans[start]!.filter(span => type(span) === "agent")).toHaveLength(3);
  } finally { await harness.dispose(); }
  const spans = captured.spans[start]!;
  const roots = spans.filter(span => type(span) === "agent");
  expect(roots).toHaveLength(3);
  expect(new Set(roots.map(span => span.spanContext().traceId)).size).toBe(3);
  const firstTurns = spans.filter(span => type(span) === "span" && span.attributes["session.id"] === firstId!);
  expect(firstTurns.filter(span => metadata(span, "threadId") === "thread-a").map(span => span.name).sort()).toEqual(["turn 1", "turn 2"]);
  expect(firstTurns.filter(span => metadata(span, "threadId") === "thread-b").map(span => span.name)).toEqual(["turn 1"]);
  const secondTurns = spans.filter(span => type(span) === "span" && span.attributes["session.id"] === secondId!);
  expect(secondTurns.map(span => span.name)).toEqual(["turn 1"]);
  for (const root of roots) {
    const children = spans.filter(span => span.spanContext().traceId === root.spanContext().traceId && span !== root);
    expect(children.every(span => span.attributes["session.id"] === root.attributes["session.id"])).toBe(true);
    expect(root.attributes["langfuse.trace.name"]).toContain(metadata(root, "threadId"));
  }
});

it("restores the same Thread trace, parent Agent and Turn counter after a completed execution and restart", async () => {
  const start = captured.spans.length;
  const directory = await mkdtemp(join(tmpdir(), "tessar-langfuse-counter-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const filename = join(directory, "state.db");
  let sessionId: string;
  for (const index of [0, 1]) {
    const harness = await AgentHarness.create({
      backend: await createSqliteBackend({ filename }), modelScripts: [{ text: `answer ${index}` }], plugins: [new LangfusePlugin()],
    });
    try {
      const session = index === 0
        ? await harness.controller.createSession({ threadId: "persisted-conversation", model: harness.provider.ref })
        : (await harness.controller.getSession(sessionId!))!;
      sessionId = session.id;
      const completed = new Promise<void>((resolve, reject) => session.subscribe(event => {
        if (event.type === "stream.end") resolve();
        if (event.type === "stream.error") reject(Error(event.payload.error.message));
      }));
      await session.followUp("hello"); await completed;
    } finally { await harness.dispose(); }
  }
  const spans = captured.spans.slice(start).flat();
  const roots = spans.filter(span => type(span) === "agent");
  const turns = spans.filter(span => type(span) === "span");
  expect(roots).toHaveLength(1);
  expect(new Set(spans.map(span => span.spanContext().traceId)).size).toBe(1);
  expect(turns.map(span => span.name)).toEqual(["turn 1", "turn 2"]);
  expect(turns.every(span => span.parentSpanContext?.spanId === roots[0]!.spanContext().spanId)).toBe(true);
});

