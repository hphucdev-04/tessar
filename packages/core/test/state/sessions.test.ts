import { createThread, listThreads, getThread } from "../../src/state/thread-operations.js";
import { expect, it } from "vitest";
import { AgentHarness } from "../../src/testing/harness.js";

it("persists independent Sessions and restores a selection with stale-writer protection", async () => {
  const h = await AgentHarness.create();
  try {
    const a = await h.controller.createSession({ scope: { user: "one" }, metadata: { label: "work" } });
    const b = await h.controller.createSession({ scope: { user: "one" } });
    expect(a.id).not.toBe(b.id);
    const first = await a.thread.create({ title: "first" });
    const restored = (await h.controller.getSession(a.id, { scope: { user: "one" } }))!;
    expect(restored.thread.getId()).toBe(first.id);
    expect(restored.metadata).toEqual({ label: "work" });
    expect(await h.controller.getSession(a.id, { scope: { user: "other" } })).toBeNull();
    const other = await createThread(h.controller, { scope: { user: "one" } });
    await a.thread.switch(other.id);
    await expect(restored.thread.switch(first.id)).rejects.toMatchObject({ code: "CommitConflict" });
    expect(restored.thread.getId()).toBe(first.id);
    await a.thread.delete();
    expect((await h.controller.getSession(a.id))!.thread.getId()).toBeNull();
    await a.dispose();
    expect(await h.controller.getSession(a.id)).not.toBeNull();
    expect((await h.controller.listSessions({ scope: { user: "one" } })).items).toHaveLength(2);
  } finally { await h.dispose(); }
});

it("leaves selection unchanged and emits no success when persistence fails", async () => {
  const h = await AgentHarness.create();
  try {
    const session = await h.controller.createSession();
    const first = await session.thread.create();
    const events: string[] = [];
    session.subscribe(event => events.push(event.type));
    h.backend.sessions.compareAndSet = async () => { throw Error("disk unavailable"); };
    expect(await session.thread.create().then(() => null, error => error.message)).toBe("disk unavailable");
    expect(session.thread.getId()).toBe(first.id);
    expect(events).not.toContain("session.thread-created");
    expect((await listThreads(h.controller)).items).toHaveLength(2);
  } finally { await h.dispose(); }
});

it("does not let stale deletion adopt another handle revision while retaining the old selection", async () => {
  const h=await AgentHarness.create();
  try {
    const a=await h.controller.createSession();
    const old=await a.thread.create();
    const b=(await h.controller.getSession(a.id))!;
    await b.thread.create();
    const unrelated=await createThread(h.controller);
    expect(await a.thread.delete({threadId:unrelated.id}).then(()=>null,e=>e.code)).toBe("CommitConflict");
    expect(await getThread(h.controller, unrelated.id).then(t=>t?.id)).toBe(unrelated.id);
    expect(a.thread.getId()).toBe(old.id);
    expect(await a.followUp({schemaVersion:1,id:"input",role:"user",content:[{type:"text",text:"stale"}],metadata:{}}).then(()=>null,e=>e.code)).toBe("CommitConflict");
  } finally { await h.dispose(); }
});

it("does not absorb a concurrent selection write that occurs during deletion", async () => {
  const h=await AgentHarness.create();
  try {
    const a=await h.controller.createSession(); const old=await a.thread.create();
    const b=(await h.controller.getSession(a.id))!;
    await h.controller.plugins.attach({ id: "concurrent-selection", setup(tessar) {
      tessar.hook("thread.before-delete", async () => { await b.thread.create(); });
    } });
    expect(await a.thread.delete().then(()=>null,e=>e.code)).toBe("CommitConflict");
    expect(a.thread.getId()).toBe(old.id);
    expect((await h.controller.getSession(a.id))!.thread.getId()).toBe(b.thread.getId());
  } finally { await h.dispose(); }
});
