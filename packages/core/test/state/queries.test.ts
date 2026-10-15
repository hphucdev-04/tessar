import { expect,it } from "vitest";
import { createMemoryBackend } from "../../src/state/memory-backend.js";
import { StateQueries } from "../../src/state/queries.js";
import { ThreadService } from "../../src/state/threads.js";
import { matchesScope } from "../../src/state/scope.js";
import { HumanMessage } from "../../src/messages/message.js";
import { MessageCodec } from "../../src/messages/codec.js";
it("matches scalar own keys with AND and type-sensitive equality",()=>{
 expect(matchesScope({n:0,flag:false},{n:0,flag:false})).toBe(true);
 expect(matchesScope({n:"0"},{n:0})).toBe(false);
 expect(matchesScope({},{flag:false})).toBe(false);
 expect(matchesScope(JSON.parse('{"__proto__":"x"}'),JSON.parse('{"__proto__":"x"}'))).toBe(true);
});
it("orders thread pages by creation time then ID rather than random IDs",async()=>{
 const backend=createMemoryBackend();
 let n=0;
 const ids={next:(kind:string)=>kind==="thread"?["z-old","a-new"][n++]!:crypto.randomUUID()};
 let time=0;
 const threads=new ThreadService(backend,ids,{now:()=>new Date(++time*1000).toISOString()});
 await threads.create();await threads.create();
 const first=await new StateQueries(backend).listThreads({limit:1});
 expect(first.items[0]!.id).toBe("z-old");
 await backend.close();
});
it("pins history pages while new committed messages arrive and rejects cursor reuse elsewhere",async()=>{
 const backend=createMemoryBackend(),threads=new ThreadService(backend),queries=new StateQueries(backend);
 const t=await threads.create({scope:{userId:"u"},messages:["1","2","3","4"].map(text=>MessageCodec.encode(new HumanMessage(text)))});
 const first=await queries.getHistory(t.id,{limit:2},{scope:{userId:"u"}});
 await threads.mutate(t.id,cp=>({...cp,state:{...cp.state,messages:[...cp.state.messages,MessageCodec.encode(new HumanMessage("5"))]}}));
 const second=await queries.getHistory(t.id,{cursor:first.nextCursor!},{scope:{userId:"u"}});
 expect(second.checkpointId).toBe(first.checkpointId);
 expect([...second.items,...first.items].map(m=>m.content)).toEqual(["1","2","3","4"].map(text=>[{type:"text",text}]));
 const other=await threads.create();
 await expect(queries.getHistory(other.id,{cursor:first.nextCursor!})).rejects.toMatchObject({code:"InvalidCursor"});
 expect(await queries.getThread(t.id,{scope:{userId:"wrong"}})).toBeNull();
 await backend.close();
});
