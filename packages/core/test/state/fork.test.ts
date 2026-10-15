import { expect,it } from "vitest";
import { createMemoryBackend } from "../../src/state/memory-backend.js";
import { ThreadService } from "../../src/state/threads.js";
import { StateQueries } from "../../src/state/queries.js";
import { ForkService } from "../../src/state/fork.js";
import { AssistantMessage,HumanMessage } from "../../src/messages/message.js";
import { MessageCodec } from "../../src/messages/codec.js";
it("copies a safe prefix with independent membership, scope and lineage",async()=>{
 const backend=createMemoryBackend(),threads=new ThreadService(backend),queries=new StateQueries(backend),forks=new ForkService(backend);
 const source=await threads.create({scope:{userId:"u"},messages:[MessageCodec.encode(new HumanMessage("hello",{id:"m1"}))]});
 const fork=await forks.fork(source.id,{});
 expect(fork).toMatchObject({parentThreadId:source.id,sourceCheckpointId:source.currentCheckpointId,scope:{userId:"u"},activeStreamId:null});
 await threads.delete(source.id);
 expect((await queries.getHistory(fork.id)).items[0]!.id).toBe("m1");
 expect((await backend.checkpoints.get(fork.currentCheckpointId))!.parentCheckpointId).toBeNull();
 await backend.close();
});
it("rejects unsafe current checkpoints and conflicting or non-boundary selectors",async()=>{
 const backend=createMemoryBackend(),threads=new ThreadService(backend),forks=new ForkService(backend);
 const source=await threads.create({messages:[MessageCodec.encode(new AssistantMessage([{type:"tool-call",toolCallId:"c",name:"write",arguments:{}}]))]});
 await expect(forks.fork(source.id,{})).rejects.toMatchObject({code:"UnsafeForkPoint"});
 await expect(forks.fork(source.id,{atCheckpointId:source.currentCheckpointId,atMessageId:"m"})).rejects.toThrow();
 await backend.close();
});
