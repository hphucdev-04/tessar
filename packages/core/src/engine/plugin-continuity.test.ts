import { expect,it } from "vitest";
import { EngineHarness } from "../testing/harness.js";
import { AgentEvents,ToolDecision } from "../events/catalog.js";
import { defineInterruption } from "./interrupt.js";
import { HumanMessage } from "../messages/message.js";
import { MessageCodec } from "../messages/codec.js";
import { AssistantMessage } from "../messages/message.js";
import { createTool,toolResult } from "../tools/tool.js";
it("keeps suspended state when its required policy plugin is removed",async()=>{
 const Question=defineInterruption({id:"policy.question",version:1,response:{jsonSchema:{},parse:()=>({})},resolve:()=>ToolDecision.allow()});
 const harness=await EngineHarness.create({plugins:[{id:"policy",apiVersion:1,setup(api){api.interruptions.register(Question);api.on(AgentEvents.BeforeStream,(_event,context)=>context.suspend(Question,{}));}}]});
 try{
  const thread=await harness.createThread(),stream=harness.engine.start({kind:"input",threadId:thread.id,input:[MessageCodec.encode(new HumanMessage("ask"))],model:{providerId:"scripted",modelId:"test"}});
  const events=await harness.collect(stream),interrupt=events.find(e=>e.is(AgentEvents.StreamSuspended))!.payload.interrupt;
  await harness.registry.detach("policy");
  const errorCode=await harness.collect(harness.engine.start({kind:"resume",threadId:thread.id,interruptId:interrupt.id,value:{}})).then(()=>null,error=>error.code);
  expect(errorCode).toBe("ResumeIncompatible");
  expect((await harness.queries.getInterrupt(thread.id,interrupt.id))!.status).toBe("pending");
 }finally{await harness.dispose();}
});
it("keeps captured executors alive and applies newly attached policy only to new streams",async()=>{
 let release!:()=>void,started!:()=>void,calls=0,disposed=0,policyCalls=0;
 const gate=new Promise<void>(resolve=>release=resolve),entered=new Promise<void>(resolve=>started=resolve);
 const harness=await EngineHarness.create({modelScripts:[{gate,response:{message:MessageCodec.encode(new AssistantMessage([{type:"tool-call",toolCallId:"c",name:"work",arguments:{}}]))}},{text:"done"}],plugins:[{id:"work",apiVersion:1,setup(api){api.tools.register(createTool({name:"work",description:"work",input:{jsonSchema:{},parse:()=>({})},execute:async()=>{calls++;return toolResult("ok");}}));return ()=>{disposed++;};}}]});
 try{
  await harness.registry.attach({id:"signals",apiVersion:1,setup(api){api.on(AgentEvents.ModelStart,()=>started());}});
  const thread=await harness.createThread(),stream=harness.engine.start({kind:"input",threadId:thread.id,input:[MessageCodec.encode(new HumanMessage("ask"))],model:{providerId:"scripted",modelId:"test"}});
  const completion=harness.collect(stream);
  await entered;
  await harness.registry.attach({id:"new-policy",apiVersion:1,setup(api){api.on(AgentEvents.BeforeStream,()=>{policyCalls++;return ToolDecision.deny("blocked");});}});
  await harness.registry.detach("work");expect(disposed).toBe(0);release();
  await completion;expect(calls).toBe(1);expect(disposed).toBe(1);expect(policyCalls).toBe(0);
  const other=await harness.createThread(),blocked=harness.engine.start({kind:"input",threadId:other.id,input:[MessageCodec.encode(new HumanMessage("blocked"))],model:{providerId:"scripted",modelId:"test"}});
  await harness.collect(blocked);expect(policyCalls).toBe(1);expect((await harness.records(blocked.id!)).stream.status).toBe("stopped");
 }finally{release();await harness.dispose();}
});
it("rejects changed plugin configuration before consuming a pending response",async()=>{
 const Question=defineInterruption({id:"configured.question",version:1,response:{jsonSchema:{},parse:()=>({})},resolve:()=>ToolDecision.allow()});
 const plugin=(configurationId:string)=>({id:"configured",apiVersion:1,configurationId,setup(api:import("../plugins/context.js").PluginContext){api.interruptions.register(Question);api.on(AgentEvents.BeforeStream,(_event,context)=>context.suspend(Question,{}));}});
 const harness=await EngineHarness.create({modelScripts:[{text:"done"}],plugins:[plugin("original")]});
 try{
  const thread=await harness.createThread(),stream=harness.engine.start({kind:"input",threadId:thread.id,input:[MessageCodec.encode(new HumanMessage("ask"))],model:{providerId:"scripted",modelId:"test"}});
  const events=await harness.collect(stream),interrupt=events.find(e=>e.is(AgentEvents.StreamSuspended))!.payload.interrupt;
  await harness.registry.detach("configured");await harness.registry.attach(plugin("changed"));
  await expect(harness.collect(harness.engine.start({kind:"resume",threadId:thread.id,interruptId:interrupt.id,value:{}}))).rejects.toMatchObject({code:"ResumeIncompatible"});
  expect((await harness.queries.getInterrupt(thread.id,interrupt.id))!.status).toBe("pending");
 }finally{await harness.dispose();}
});
