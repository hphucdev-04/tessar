import { expect,it } from "vitest";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storageConformance,initialBatch } from "@tessar/core/testing/storage-conformance";
import { AgentHarness } from "@tessar/core/testing";
import { CommitCoordinator } from "@tessar/core";
import { createSqliteBackend } from "../src/backend.js";
storageConformance("sqlite",async()=>createSqliteBackend({filename:":memory:"}));
it("reopens committed state and fences independently connected owners",async()=>{
 const path=await mkdtemp(join(tmpdir(),"tessar-"));
 const filename=join(path,"state.db"),a=await createSqliteBackend({filename}),b=await createSqliteBackend({filename});
 try {
   const lease=await a.ownership.acquire({threadId:"t1",ownerToken:"a",ttlMs:60000});
   await expect(b.ownership.acquire({threadId:"t1",ownerToken:"b",ttlMs:60000})).rejects.toMatchObject({code:"OwnerActive"});
   await new CommitCoordinator(a).commit(initialBatch(),lease);
   expect(await b.threads.get("t1")).toMatchObject({revision:1});
   await a.ownership.release(lease);
   const next=await b.ownership.acquire({threadId:"t1",ownerToken:"b",ttlMs:60000});
   expect(next.fencingToken).toBeGreaterThan(lease.fencingToken);
 }finally {await a.close();await b.close();}
 const reopened=await createSqliteBackend({filename});
 try {expect(await reopened.checkpoints.get("cp-t1")).toMatchObject({revision:1});}finally{await reopened.close();await rm(path,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

it("persists Session CAS, validates scope/Agent identity, and clears all deleted selections", async () => {
 const backend=await createSqliteBackend({filename:":memory:"});
 const h=await AgentHarness.create({backend});
 try {
  const a=await h.controller.createSession({scope:{user:"a"}}), b=await h.controller.createSession({scope:{user:"a"}});
  const thread=await a.thread.create();await b.thread.switch(thread.id);
  const stale=(await h.controller.getSession(a.id))!;
  const other=await h.controller.createThread({scope:{user:"a"}});await a.thread.switch(other.id);
  expect(await stale.thread.switch(thread.id).then(()=>null,e=>e.code)).toBe("CommitConflict");
  expect(await h.controller.getSession(a.id,{scope:{user:"b"}})).toBeNull();
  const row=(await backend.sessions.get(a.id))!;
  await backend.sessions.compareAndSet({...row,id:"other-agent",agentId:"other",revision:1,selectedThreadId:null},0);
  expect(await h.controller.getSession("other-agent").then(()=>null,e=>e.code)).toBe("SessionAgentMismatch");
  await a.thread.switch(thread.id);
  await h.controller.deleteThread(thread.id);
  expect((await backend.sessions.get(a.id))?.selectedThreadId).toBeNull();
  expect((await backend.sessions.get(b.id))?.selectedThreadId).toBeNull();
 } finally {await h.dispose();}
});
