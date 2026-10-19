import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initialBatch } from "@tessar/core/testing/storage-conformance";
import { canonicalJson, HumanMessage, MessageCodec } from "@tessar/core";
import { initializeSchema } from "../src/schema.js";
import { hydrateCheckpoint, readVersions } from "../src/versions.js";

function legacy(customState = false, filename = ":memory:") {
  const db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE checkpoints(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,UNIQUE(thread_id,revision));
    CREATE TABLE staging(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE commits(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE leases(thread_id TEXT PRIMARY KEY,owner_token TEXT NOT NULL,fencing_token INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE owned_states(owner_key TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE TABLE messages(thread_id TEXT,checkpoint_id TEXT,id TEXT,position INTEGER,body TEXT);
    PRAGMA user_version=1;`);
  for (const table of ["streams", "turns", "model_attempts", "tool_executions", "interrupts", "plugin_states"])
    db.exec(`CREATE TABLE ${table}(thread_id TEXT,checkpoint_id TEXT,id TEXT,body TEXT,PRIMARY KEY(checkpoint_id,id))`);
  const batch = initialBatch();
  batch.checkpoint.state.messages = [MessageCodec.encode(new HumanMessage("persisted", { providerState: { opaque: "preserve" } }))];
  batch.checkpoint.state.pluginStates = [{ pluginId: "summary", namespace: "compact", ownerType: "thread", ownerId: "t1", schemaVersion: 1, revision: 1, data: { summary: "hello", cursor: "m1" } }];
  const head = { id: "t1", revision: 1, currentCheckpointId: "cp-t1", activeStreamId: null, scope: { userId: "u" }, metadata: {}, createdAt: batch.checkpoint.createdAt, updatedAt: batch.checkpoint.createdAt, parentThreadId: null, sourceCheckpointId: null, deleted: false };
  db.prepare("INSERT INTO threads VALUES(?,?)").run(head.id, canonicalJson(head));
  db.prepare("INSERT INTO checkpoints VALUES(?,?,?,?)").run("cp-t1", "t1", 1, canonicalJson(batch.checkpoint));
  db.prepare("INSERT INTO staging VALUES(?,?)").run(batch.commitId, canonicalJson(batch));
  db.prepare("INSERT INTO commits VALUES(?,?)").run(batch.commitId, canonicalJson({ commitId: batch.commitId, threadId: "t1", revision: 1, checkpointId: "cp-t1" }));
  if (customState) db.prepare("INSERT INTO plugin_states VALUES(?,?,?,?)").run("t1", "cp-t1", "custom", "{}");
  return { db, batch };
}

it("migrates legacy snapshots and receipts without changing IDs or plugin data", async () => {
  const { db, batch } = legacy();
  try {
    await initializeSchema(db);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
    expect(hydrateCheckpoint(db, String(db.prepare("SELECT body FROM checkpoints WHERE id='cp-t1'").get()!.body))).toEqual(batch.checkpoint);
    expect(db.prepare("SELECT count(*) n FROM staging").get()?.n).toBe(0);
    expect(String(db.prepare("SELECT fingerprint FROM commits").get()?.fingerprint)).toHaveLength(64);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});

it.each(["plugin-state", "missing-batch", "invalid-json"])("rolls migration back on %s", async mode => {
  const { db } = legacy(mode === "plugin-state");
  try {
    if (mode === "missing-batch") db.exec("DELETE FROM staging");
    if (mode === "invalid-json") db.exec("UPDATE checkpoints SET body='invalid'");
    await expect(initializeSchema(db)).rejects.toThrow();
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    expect(db.prepare("SELECT count(*) n FROM checkpoints").get()?.n).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '_v1_%'").all()).toEqual([]);
  } finally { db.close(); }
});

it("retains historical versions, fork lineage, unfinished staging and plugin-owned tables", async () => {
  const { db, batch } = legacy();
  try {
    const next = structuredClone(batch);
    next.commitId = "second"; next.expectedRevision = 1;
    Object.assign(next.checkpoint, { id: "cp-second", parentCheckpointId: batch.checkpoint.id, revision: 2 });
    next.checkpoint.state.messages = [...next.checkpoint.state.messages, MessageCodec.encode(new HumanMessage("next"))];
    const trace = { id: "stream", threadId: "t1", status: "running", startedAt: batch.checkpoint.createdAt };
    for (const [cp, status] of [[batch.checkpoint.id, "running"], [next.checkpoint.id, "completed"]])
      db.prepare("INSERT INTO streams VALUES(?,?,?,?)").run("t1", cp!, trace.id, canonicalJson({ ...trace, status }));
    db.prepare("INSERT INTO checkpoints VALUES(?,?,?,?)").run(next.checkpoint.id, "t1", 2, canonicalJson(next.checkpoint));
    db.prepare("INSERT INTO staging VALUES(?,?)").run(next.commitId, canonicalJson(next));
    db.prepare("INSERT INTO commits VALUES(?,?)").run(next.commitId, canonicalJson({ commitId: next.commitId, threadId: "t1", revision: 2, checkpointId: next.checkpoint.id }));
    const head = JSON.parse(String(db.prepare("SELECT body FROM threads WHERE id='t1'").get()!.body));
    db.prepare("UPDATE threads SET body=? WHERE id='t1'").run(canonicalJson({ ...head, revision: 2, currentCheckpointId: next.checkpoint.id }));
    const fork = initialBatch("fork"); fork.lineage = { parentThreadId: "t1", sourceCheckpointId: batch.checkpoint.id };
    db.prepare("INSERT INTO threads VALUES(?,?)").run("fork", canonicalJson({ ...head, id: "fork", currentCheckpointId: fork.checkpoint.id, parentThreadId: "t1", sourceCheckpointId: batch.checkpoint.id, deleted: true }));
    db.prepare("INSERT INTO checkpoints VALUES(?,?,?,?)").run(fork.checkpoint.id, "fork", 1, canonicalJson(fork.checkpoint));
    const unfinished = initialBatch("unpublished");
    db.prepare("INSERT INTO staging VALUES(?,?)").run(unfinished.commitId, canonicalJson(unfinished));
    db.exec("INSERT INTO leases VALUES('t1','owner',7,0); CREATE TABLE custom_jobs(id TEXT); INSERT INTO custom_jobs VALUES('job');");
    await initializeSchema(db);
    await initializeSchema(db);
    expect(readVersions<any>(db,"streams","t1",1)[0].status).toBe("running");
    expect(readVersions<any>(db,"streams","t1",2)[0].status).toBe("completed");
    expect(db.prepare("SELECT count(*) n FROM messages").get()?.n).toBe(2);
    expect(hydrateCheckpoint(db,String(db.prepare("SELECT body FROM checkpoints WHERE id=?").get(batch.checkpoint.id)!.body))).toEqual(batch.checkpoint);
    expect(hydrateCheckpoint(db,String(db.prepare("SELECT body FROM checkpoints WHERE id=?").get(next.checkpoint.id)!.body))).toEqual(next.checkpoint);
    expect(JSON.parse(String(db.prepare("SELECT body FROM staging").get()!.body))).toEqual(unfinished);
    expect(JSON.parse(String(db.prepare("SELECT body FROM threads WHERE id='fork'").get()!.body))).toMatchObject({ parentThreadId:"t1", sourceCheckpointId:batch.checkpoint.id, deleted:true });
    expect(db.prepare("SELECT fencing_token FROM leases").get()?.fencing_token).toBe(7);
    expect(db.prepare("SELECT * FROM custom_jobs").get()?.id).toBe("job");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});
it("rolls back an injected SQL failure after creating replacement tables", async () => {
  const { db } = legacy();
  const original = db.prepare.bind(db);
  const injected = vi.spyOn(db,"prepare").mockImplementation(sql => { if (sql.startsWith("INSERT INTO commits")) throw Error("injected SQL failure"); return original(sql); });
  try {
    await expect(initializeSchema(db)).rejects.toThrow("injected SQL failure");
    injected.mockRestore();
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    expect(db.prepare("SELECT count(*) n FROM staging").get()?.n).toBe(1);
    await initializeSchema(db);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
  } finally { injected.mockRestore(); db.close(); }
});

it("lets independently opened connections observe one migrated version and preserves owned state", async () => {
 const dir=await mkdtemp(join(tmpdir(),"tessar-migrate-")), filename=join(dir,"state.db");
 const {db:a,batch}=legacy(false,filename), b=new DatabaseSync(filename);
 try {
  const owned={ownerType:"session",ownerId:"legacy-owner",pluginId:"memory",namespace:"notes",schemaVersion:1,revision:2,data:{note:"keep"}};
  a.prepare("INSERT INTO owned_states VALUES(?,?,?)").run("key",2,canonicalJson(owned));
  await Promise.all([initializeSchema(a),initializeSchema(b)]);
  expect(b.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
  expect(JSON.parse(String(b.prepare("SELECT body FROM owned_states").get()!.body))).toEqual(owned);
  expect(hydrateCheckpoint(b,String(b.prepare("SELECT body FROM checkpoints WHERE id=?").get(batch.checkpoint.id)!.body))).toEqual(batch.checkpoint);
 } finally {a.close();b.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
