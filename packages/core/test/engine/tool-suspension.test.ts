import { expect, it } from "vitest";
import { z } from "zod";
import { AgentHarness } from "../../src/testing/harness.js";
import { AssistantMessage, HumanMessage } from "../../src/messages/message.js";
import { MessageCodec } from "../../src/messages/codec.js";
import { createTool } from "../../src/tools/tool.js";
import { stream as events } from "../../src/events/type.js";
import { TessarError } from "../../src/errors.js";

function calls(names: string[]) {
  return {
    response: {
      message: MessageCodec.encode(
        new AssistantMessage(
          names.map((name, i) => ({
            type: "tool-call" as const,
            name,
            toolCallId: `call-${i}`,
            arguments: {},
          })),
        ),
      ),
    },
  };
}

it("does not count continuation as another tool call and can suspend again from resume", async () => {
  let executions = 0,
    resumes = 0;
  const ask = createTool({
    name: "ask",
    description: "Ask",
    schema: z.object({}),
    execute: (_input, context) => {
      executions++;
      return context.suspend("first");
    },
    resume: (value, _input, context) => {
      resumes++;
      return value === "again" ? context.suspend("second") : value;
    },
  });
  const h = await AgentHarness.create({
    tools: { ask },
    limits: { maxToolCalls: 1 },
    modelScripts: [calls(["ask"]), { text: "done" }],
  });
  try {
    const thread = await h.createThread();
    const first = h.admit({
      kind: "input",
      threadId: thread.id,
      input: [MessageCodec.encode(new HumanMessage("ask"))],
      model: h.provider.ref,
    });
    const one = (await h.collect(first)).find((e) => e.is(events.suspended))!
      .payload.interrupt;
    const second = h.admit({
      kind: "resume",
      threadId: thread.id,
      interruptId: one.id,
      value: "again",
    });
    const two = (await h.collect(second)).find((e) => e.is(events.suspended))!
      .payload.interrupt;
    const end = await h.collect(
      h.admit({
        kind: "resume",
        threadId: thread.id,
        interruptId: two.id,
        value: "done",
      }),
    );
    expect(end.find((e) => e.is(events.end))!.payload.status).toBe("completed");
    expect({ executions, resumes }).toEqual({ executions: 1, resumes: 2 });
  } finally {
    await h.dispose();
  }
});

it("suspends a tool, rejects invalid answers without consuming, and resumes its result once", async () => {
  let executions = 0;
  const ask = createTool({
    name: "ask",
    description: "Ask",
    schema: z.object({}),
    resumeSchema: z.string().min(1),
    execute: (_input, context) => {
      executions++;
      return context.suspend({ question: "Database?" });
    },
  });
  const h = await AgentHarness.create({
    tools: { ask },
    modelScripts: [calls(["ask"]), { text: "done" }],
  });
  try {
    const thread = await h.createThread();
    const first = h.admit({
      kind: "input",
      threadId: thread.id,
      input: [MessageCodec.encode(new HumanMessage("ask"))],
      model: h.provider.ref,
    });
    const pending = (await h.collect(first)).find((e) =>
      e.is(events.suspended),
    )!.payload.interrupt;
    expect(pending).toMatchObject({
      kind: "tool-result",
      payload: { question: "Database?" },
    });
    await expect(
      h.collect(
        h.admit({
          kind: "resume",
          threadId: thread.id,
          interruptId: pending.id,
          value: false,
        }),
      ),
    ).rejects.toMatchObject({ code: "InvalidResumeResponse" });
    expect((await h.queries.getInterrupt(thread.id, pending.id))!.status).toBe(
      "pending",
    );
    const next = h.admit({
      kind: "resume",
      threadId: thread.id,
      interruptId: pending.id,
      value: "PostgreSQL",
    });
    await h.collect(next);
    expect(next.id).toBe(first.id);
    expect(executions).toBe(1);
    expect(
      h.provider.calls[1]!.messages.find((m) => m.role === "tool"),
    ).toMatchObject({
      toolCallId: "call-0",
      content: [{ type: "text", text: "PostgreSQL" }],
    });
    await expect(
      h.collect(
        h.admit({
          kind: "resume",
          threadId: thread.id,
          interruptId: pending.id,
          value: "again",
        }),
      ),
    ).rejects.toMatchObject({ code: "AlreadyResumed" });
  } finally {
    await h.dispose();
  }
});

it("continues approval through the tool resume callback without re-executing its entry", async () => {
  let executions = 0,
    writes = 0;
  const write = createTool({
    name: "write",
    description: "Write",
    schema: z.object({}),
    resumeSchema: z.boolean(),
    execute: (_input, context) => {
      executions++;
      return context.suspend({ question: "Allow?" });
    },
    resume: async (approved) => {
      if (!approved) return "declined";
      writes++;
      return "saved";
    },
  });
  const h = await AgentHarness.create({
    tools: { write },
    modelScripts: [calls(["write"]), { text: "done" }],
  });
  try {
    const thread = await h.createThread();
    const first = h.admit({
      kind: "input",
      threadId: thread.id,
      input: [MessageCodec.encode(new HumanMessage("write"))],
      model: h.provider.ref,
    });
    const pending = (await h.collect(first)).find((e) =>
      e.is(events.suspended),
    )!.payload.interrupt;
    await h.collect(
      h.admit({
        kind: "resume",
        threadId: thread.id,
        interruptId: pending.id,
        value: true,
      }),
    );
    expect({ executions, writes }).toEqual({ executions: 1, writes: 1 });
    expect((await h.records(first.id!)).tools[0]).toMatchObject({
      status: "succeeded",
      result: { content: [{ type: "text", text: "saved" }] },
    });
  } finally {
    await h.dispose();
  }
});

it("preserves completed siblings and two independently waiting tool requests in call order", async () => {
  let executions = 0,
    finished = 0;
  const ask = createTool({
    name: "ask",
    description: "Ask",
    schema: z.object({}),
    execute: (_input, context) => {
      executions++;
      return context.suspend({ question: "Choose" });
    },
  });
  const work = createTool({
    name: "work",
    description: "Work",
    schema: z.object({}),
    execute: () => {
      finished++;
      return "worked";
    },
  });
  const h = await AgentHarness.create({
    tools: { ask, work },
    modelScripts: [calls(["work", "ask", "ask"]), { text: "done" }],
  });
  try {
    const thread = await h.createThread();
    const first = h.admit({
      kind: "input",
      threadId: thread.id,
      input: [MessageCodec.encode(new HumanMessage("ask twice"))],
      model: h.provider.ref,
    });
    const one = (await h.collect(first)).find((e) => e.is(events.suspended))!
      .payload.interrupt;
    const next = h.admit({
      kind: "resume",
      threadId: thread.id,
      interruptId: one.id,
      value: "one",
    });
    const two = (await h.collect(next)).find((e) => e.is(events.suspended))!
      .payload.interrupt;
    expect(two.id).not.toBe(one.id);
    await h.collect(
      h.admit({
        kind: "resume",
        threadId: thread.id,
        interruptId: two.id,
        value: "two",
      }),
    );
    expect({ executions, finished }).toEqual({ executions: 2, finished: 1 });
    expect(
      h.provider.calls[1]!.messages.filter((m) => m.role === "tool").map(
        (m) => m.content,
      ),
    ).toEqual([
      [{ type: "text", text: "worked" }],
      [{ type: "text", text: "one" }],
      [{ type: "text", text: "two" }],
    ]);
  } finally {
    await h.dispose();
  }
});

it("keeps queued siblings undispatched until the waiting call is answered", async () => {
  let work = 0;
  const ask = createTool({
    name: "ask",
    description: "Ask",
    schema: z.object({}),
    execute: (_input, context) => context.suspend("Choose"),
  });
  const later = createTool({
    name: "later",
    description: "Later",
    schema: z.object({}),
    execute: () => {
      work++;
      return "worked";
    },
  });
  const h = await AgentHarness.create({
    tools: { concurrency: 1, ask, later },
    modelScripts: [calls(["ask", "later"]), { text: "done" }],
  });
  try {
    const thread = await h.createThread();
    const first = h.admit({
      kind: "input",
      threadId: thread.id,
      input: [MessageCodec.encode(new HumanMessage("ask"))],
      model: h.provider.ref,
    });
    const question = (await h.collect(first)).find((e) =>
      e.is(events.suspended),
    )!.payload.interrupt;
    expect(work).toBe(0);
    await h.collect(
      h.admit({
        kind: "resume",
        threadId: thread.id,
        interruptId: question.id,
        value: "answer",
      }),
    );
    expect(work).toBe(1);
  } finally {
    await h.dispose();
  }
});

it("rejects changed plugin resume contracts without consuming the waiting request", async () => {
  const plugin = (
    numeric: boolean,
  ): import("../../src/plugins/context.js").Plugin => ({
    id: "questions",
    setup(tessar) {
      const resumeSchema: z.ZodType<string | number> = numeric
        ? z.number()
        : z.string();
      tessar.tools.register(
        createTool({
          name: "ask",
          description: "Ask",
          schema: z.object({}),
          resumeSchema,
          execute: (_input, context) => context.suspend("Choose"),
        }),
      );
    },
  });
  const h = await AgentHarness.create({
    plugins: [plugin(false)],
    modelScripts: [calls(["ask"]), { text: "done" }],
  });
  try {
    const thread = await h.createThread();
    const first = h.admit({
      kind: "input",
      threadId: thread.id,
      input: [MessageCodec.encode(new HumanMessage("ask"))],
      model: h.provider.ref,
    });
    const question = (await h.collect(first)).find((e) =>
      e.is(events.suspended),
    )!.payload.interrupt;
    await h.registry.detach("questions");
    await h.registry.attach(plugin(true));
    await expect(
      h.collect(
        h.admit({
          kind: "resume",
          threadId: thread.id,
          interruptId: question.id,
          value: 2,
        }),
      ),
    ).rejects.toMatchObject({ code: "ResumeIncompatible" });
    expect((await h.queries.getInterrupt(thread.id, question.id))!.status).toBe(
      "pending",
    );
    await h.registry.detach("questions");
    await h.registry.attach(plugin(false));
    await h.collect(
      h.admit({
        kind: "resume",
        threadId: thread.id,
        interruptId: question.id,
        value: "answer",
      }),
    );
  } finally {
    await h.dispose();
  }
});

it("reconciles an uncertain sibling before revealing a saved tool question", async () => {
  let asks = 0,
    writes = 0,
    known = false;
  const ask = createTool({
    name: "ask",
    description: "Ask",
    schema: z.object({}),
    execute: (_input, context) => {
      asks++;
      return context.suspend("Choose");
    },
  });
  const write = createTool({
    name: "write",
    description: "Write",
    schema: z.object({}),
    execute: () => {
      writes++;
      throw new TessarError("RecoveryRequired", "Unknown write outcome");
    },
    recovery: {
      idempotencyKey: () => "write-once",
      reconcile: async () =>
        known
          ? { status: "completed", result: "saved" }
          : { status: "unknown" },
    },
  });
  const h = await AgentHarness.create({
    tools: { ask, write },
    modelScripts: [calls(["ask", "write"]), { text: "done" }],
  });
  try {
    const thread = await h.createThread();
    const first = h.admit({
      kind: "input",
      threadId: thread.id,
      input: [MessageCodec.encode(new HumanMessage("ask"))],
      model: h.provider.ref,
    });
    await expect(h.collect(first)).rejects.toMatchObject({
      code: "RecoveryRequired",
    });
    known = true;
    const recovered = h.admit({
      kind: "recover",
      threadId: thread.id,
      streamId: first.id!,
    });
    const question = (await h.collect(recovered)).find((e) =>
      e.is(events.suspended),
    )!.payload.interrupt;
    await h.collect(
      h.admit({
        kind: "resume",
        threadId: thread.id,
        interruptId: question.id,
        value: "answer",
      }),
    );
    expect({ asks, writes }).toEqual({ asks: 1, writes: 1 });
    expect(
      h.provider.calls[1]!.messages.filter((m) => m.role === "tool").map(
        (m) => m.toolCallId,
      ),
    ).toEqual(["call-0", "call-1"]);
  } finally {
    await h.dispose();
  }
});

it("resumes tool questions through separate Sessions without mixing their state", async () => {
  const ask = createTool({
    name: "ask",
    description: "Ask",
    schema: z.object({}),
    resumeSchema: z.string(),
    execute: (_input, context) => context.suspend("Choose"),
  });
  const h = await AgentHarness.create({
    tools: { ask },
    modelScripts: [
      calls(["ask"]),
      calls(["ask"]),
      { text: "one" },
      { text: "two" },
    ],
  });
  try {
    const a = await h.controller.createSession(),
      b = await h.controller.createSession();
    await a.thread.create();
    await b.thread.create();
    const wait = (session: typeof a) =>
      new Promise<import("../../src/state/schema.js").InterruptRecord>(
        (resolve) => {
          const off = session.subscribe(events.suspended, (event) => {
            off();
            resolve(event.payload.interrupt);
          });
        },
      );
    const pendingA = wait(a),
      pendingB = wait(b);
    await Promise.all([
      a.followUp(new HumanMessage("one")),
      b.followUp(new HumanMessage("two")),
    ]);
    const [one, two] = await Promise.all([pendingA, pendingB]);
    expect(one.threadId).not.toBe(two.threadId);
    await expect(
      a.resume({ interruptId: one.id, value: false }),
    ).rejects.toMatchObject({ code: "InvalidResumeResponse" });
    const finished = (session: typeof a) =>
      new Promise<void>((resolve) => {
        const off = session.subscribe(events.end, () => {
          off();
          resolve();
        });
      });
    const doneA = finished(a),
      doneB = finished(b);
    await Promise.all([
      a.resume({ interruptId: one.id, value: "first answer" }),
      b.resume({ interruptId: two.id, value: "second answer" }),
    ]);
    await Promise.all([doneA, doneB]);
    expect(
      (await h.queries.getHistory(one.threadId)).items.filter(
        (m) => m.role === "tool",
      )[0]!.content,
    ).toEqual([{ type: "text", text: "first answer" }]);
    expect(
      (await h.queries.getHistory(two.threadId)).items.filter(
        (m) => m.role === "tool",
      )[0]!.content,
    ).toEqual([{ type: "text", text: "second answer" }]);
  } finally {
    await h.dispose();
  }
});
