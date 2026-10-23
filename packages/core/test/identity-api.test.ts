import { expect, it } from "vitest";
import { Agent, Controller, HumanMessage } from "../src/index.js";
import { ScriptedProvider } from "../src/testing/scripted-provider.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

it("accepts explicit session, thread and fork IDs and rejects collisions", async () => {
  const agent = new Agent({
    id: "identity-agent",
    model: new ScriptedProvider([]),
  });
  const controller = new Controller({ id: "identity-controller", agent });
  await controller.initialize();
  try {
    const session = await controller.createSession({ id: "session-a" });
    expect(session.id).toBe("session-a");
    await expect(
      controller.createSession({ id: session.id }),
    ).rejects.toMatchObject({ code: "RegistrationConflict" });
    await expect(controller.createSession({ id: "" })).rejects.toThrow();
    const thread = await session.thread.create({ id: "thread-a" });
    expect(thread.id).toBe("thread-a");
    const fork = await session.thread.fork({ id: "thread-b" });
    expect(fork.id).toBe("thread-b");
    expect((await fork.snapshot()).state.messages).toEqual([]);
    await expect(
      session.thread.create({ id: thread.id }),
    ).rejects.toMatchObject({ code: "RegistrationConflict" });
    await expect(session.thread.fork({ id: fork.id })).rejects.toMatchObject({
      code: "RegistrationConflict",
    });
    const racingSessions = await Promise.allSettled([
      controller.createSession({ id: "racing-session" }),
      controller.createSession({ id: "racing-session" }),
    ]);
    expect(
      racingSessions.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const other = await controller.createSession();
    const racingThreads = await Promise.allSettled([
      session.thread.create({ id: "racing-thread" }),
      other.thread.create({ id: "racing-thread" }),
    ]);
    expect(
      racingThreads.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect((await session.thread.get(thread.id))!.id).toBe(thread.id);
    expect((await controller.createSession()).id).toMatch(uuid);
    expect((await session.thread.create()).id).toMatch(uuid);
  } finally {
    await controller.dispose();
  }
});

it("exposes Stream.id immediately and preserves existing result and event fields", async () => {
  const agent = new Agent({
    id: "run-identity-agent",
    model: new ScriptedProvider([
      { text: "first" },
      { text: "second" },
      { text: "auto" },
    ]),
  });
  try {
    const stream = agent.stream("hello", { id: "run-a" });
    expect(stream.id).toBe("run-a");
    for await (const event of stream) expect(event.streamId).toBe("run-a");
    const input = new HumanMessage("next");
    expect(input.id).toMatch(uuid);
    const result = await agent.generate(input);
    expect(result.streamId).toMatch(uuid);
    expect(result).not.toHaveProperty("runId");
    expect(result.status).toBe("completed");
    const automatic = agent.stream("auto");
    expect(automatic.id).toMatch(uuid);
    expect(automatic.id).not.toBe(result.streamId);
    for await (const _event of automatic) {
    }
    expect(stream).not.toHaveProperty("runId");
    expect(stream).not.toHaveProperty("signal");
    expect(() => agent.stream("bad", { id: "" })).toThrow();
  } finally {
    await agent.shutdown();
  }
});

it("rejects concurrent and stored run ID collisions before calling the model", async () => {
  let release!: () => void;
  const provider = new ScriptedProvider([
    {
      text: "done",
      gate: new Promise<void>((resolve) => {
        release = resolve;
      }),
    },
  ]);
  const agent = new Agent({ id: "run-conflict-agent", model: provider });
  const controller = new Controller({ id: "run-conflict-controller", agent });
  await controller.initialize();
  try {
    const stream = agent.stream("first", { id: "same-run" });
    expect(() => agent.stream("second", { id: "same-run" })).toThrowError(
      expect.objectContaining({ code: "RegistrationConflict" }),
    );
    release();
    for await (const _event of stream) {
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    const duplicate = agent.stream("third", { id: "same-run" });
    const errors = [];
    for await (const event of duplicate)
      if (event.type === "stream.error") errors.push(event.payload.error.code);
    expect(errors).toContain("RegistrationConflict");
    expect(provider.calls).toHaveLength(1);
  } finally {
    release();
    await controller.dispose();
  }
});
