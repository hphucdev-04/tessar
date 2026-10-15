import { expect,it } from "vitest";
import { createDelivery } from "../../src/engine/delivery.js";
import { AgentEvents } from "../../src/events/catalog.js";
import { randomIds } from "../../src/json.js";
import { AgentHarness } from "../../src/testing/harness.js";
import { defineInterruption } from "../../src/engine/interrupt.js";
import { ToolDecision } from "../../src/events/catalog.js";
import { AssistantMessage,HumanMessage } from "../../src/messages/message.js";
import { MessageCodec } from "../../src/messages/codec.js";
import { createTool,toolResult } from "../../src/tools/tool.js";
it("detaches overflowing consumers at 512 events without cancelling execution",async()=>{
 const delivery=createDelivery("t",randomIds,{kind:"iterator"});delivery.setId("s");
 for(let i=0;i<513;i++)delivery.emit(AgentEvents.MessageDelta,{messageId:"m",partId:"p",partKind:"text",delta:"x",attemptId:"a"},{});
 const events=[];for await(const event of delivery.stream)events.push(event);
 expect(events).toHaveLength(1);expect(events[0]!.payload.error.code).toBe("ConsumerTooSlow");
 expect(delivery.controller.signal.aborted).toBe(false);
});
it("cancels a suspended execution and its pending interrupt durably",async()=>{
 const Question=defineInterruption({id:"pause.question",version:1,response:{jsonSchema:{},parse:()=>({})},resolve:()=>ToolDecision.allow()});
 const harness=await AgentHarness.create({plugins:[{id:"pause",setup(tesseract){tesseract.interruptions.register(Question);tesseract.hook(AgentEvents.BeforeStream,(_event,ctx)=>ctx.suspend(Question,{}));}}]});
 try{
  const thread=await harness.createThread(),stream=harness.admit({kind:"input",threadId:thread.id,input:[MessageCodec.encode(new HumanMessage("ask"))],model:{providerId:"scripted",modelId:"test"}});
  const events=await harness.collect(stream),interrupt=events.find(e=>e.is(AgentEvents.StreamSuspended))!.payload.interrupt;
  await harness.agent.cancel(thread.id,stream.id!);
  expect((await harness.records(stream.id!)).stream.status).toBe("cancelled");
  expect((await harness.queries.getInterrupt(thread.id,interrupt.id))!.status).toBe("cancelled");
 }finally{await harness.dispose();}
});
it("keeps an abort-ignoring in-flight tool interrupted instead of unlocking the thread",async()=>{
 let started!:()=>void,release!:()=>void,errored!:()=>void;
 const start=new Promise<void>(resolve=>started=resolve),done=new Promise<void>(resolve=>errored=resolve),gate=new Promise<void>(resolve=>release=resolve);
 const harness=await AgentHarness.create({plugins:[{id:"tools",setup(tesseract){tesseract.tools.register(createTool({name:"write",description:"write",input:{jsonSchema:{},parse:()=>({})},execute:async()=>{started();await gate;return toolResult("late");}}));}}],modelScripts:[{response:{message:MessageCodec.encode(new AssistantMessage([{type:"tool-call",toolCallId:"c",name:"write",arguments:{}}]))}}]});
 try{
  const thread=await harness.createThread(),stream=harness.admit({kind:"input",threadId:thread.id,input:[MessageCodec.encode(new HumanMessage("ask"))],model:{providerId:"scripted",modelId:"test"}},{kind:"observer",observe:event=>{if(event.is(AgentEvents.StreamError))errored();}});
  await start;await harness.agent.cancel(thread.id,stream.id!);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([done,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error("Tool cancellation did not detach")),1000);})]);}finally{if(timer)clearTimeout(timer);}
  expect((await harness.records(stream.id!)).stream.status).toBe("interrupted");
 }finally{release();await harness.dispose();}
});
it("enforces the byte limit and detaches return without abortion",async()=>{
 const delivery=createDelivery("t",randomIds,{kind:"iterator"});
 delivery.emit(AgentEvents.MessageDelta,{messageId:"m",partId:"p",partKind:"text",delta:"x".repeat(4*1024*1024),attemptId:"a"},{});
 expect((await delivery.stream[Symbol.asyncIterator]().next()).value.payload.error.code).toBe("ConsumerTooSlow");
 expect(delivery.controller.signal.aborted).toBe(false);
 const other=createDelivery("t",randomIds,{kind:"iterator"}),iterator=other.stream[Symbol.asyncIterator]();
 await iterator.return!();expect(other.controller.signal.aborted).toBe(false);other.close();
});
it("does not allocate iterator queues for observers and ignores late emissions after close",()=>{
 let events=0;
 const delivery=createDelivery("t",randomIds,{kind:"observer",observe:()=>{events++;}});
 for(let i=0;i<1000;i++)delivery.emit(AgentEvents.TurnStart,{turnId:"t",index:i},{});
 expect(events).toBe(1000);delivery.close();delivery.emit(AgentEvents.TurnStart,{turnId:"t",index:1001},{});
 expect(events).toBe(1000);delivery.stream.abort();expect(delivery.controller.signal.aborted).toBe(false);
});
