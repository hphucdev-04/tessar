import { expect,it } from "vitest";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storageConformance,initialBatch } from "@tesseract/core/testing/storage-conformance";
import { CommitCoordinator } from "@tesseract/core";
import { createSqliteBackend } from "./backend.js";
storageConformance("sqlite",async()=>createSqliteBackend({filename:":memory:"}));
it("reopens committed state and fences independently connected owners",async()=>{
 const path=await mkdtemp(join(tmpdir(),"tesseract-"));
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
