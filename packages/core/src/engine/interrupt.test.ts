import { expect,it } from "vitest";
import { EngineHarness } from "../testing/harness.js";
import { defineInterruption } from "./interrupt.js";
import { AgentEvents,ToolDecision } from "../events/catalog.js";
import { AssistantMessage,HumanMessage } from "../messages/message.js";
import { MessageCodec } from "../messages/codec.js";
import { createTool,toolResult } from "../tools/tool.js";
import { TesseractError } from "../errors.js";
const Approval=defineInterruption({id:"approval.request",version:1,response:{jsonSchema:{type:"object",properties:{approved:{type:"boolean"}}},parse(value:unknown){if(!value||typeof(value as {approved?:unknown}).approved!=="boolean")throw Error("Invalid approval");return value as {approved:boolean};}},resolve:response=>response.approved?ToolDecision.allow():ToolDecision.deny("declined")});
it("suspends durably, validates before consume, and resumes past previous handlers",async()=>{
 let executions=0,before=0,after=0;
 const harness=await EngineHarness.create({modelScripts:[{response:{message:MessageCodec.encode(new AssistantMessage([{type:"tool-call",toolCallId:"c",name:"write",arguments:{}}]))}},{text:"done"}],plugins:[
 {id:"tools",apiVersion:1,setup(api){api.tools.register(createTool({name:"write",description:"write",input:{jsonSchema:{},parse:()=>({})},execute:async()=>{executions++;return toolResult("wrote");}}));}},
 {id:"approval",apiVersion:1,setup(api){api.interruptions.register(Approval);api.on(AgentEvents.BeforeTool,()=>{before++;return ToolDecision.allow();});api.on(AgentEvents.BeforeTool,(_event,context)=>context.suspend(Approval,{question:"allow?"}));api.on(AgentEvents.BeforeTool,()=>{after++;return ToolDecision.allow();});}}
 ]});
 try{
  const thread=await harness.createThread(),first=harness.engine.start({kind:"input",threadId:thread.id,input:[MessageCodec.encode(new HumanMessage("write"))],model:{providerId:"scripted",modelId:"test"}});
  const events=await harness.collect(first),pending=events.find(e=>e.is(AgentEvents.StreamSuspended))!;
  expect(pending).toBeDefined();expect(executions).toBe(0);expect(before).toBe(1);
  const interruptId=pending.payload.interrupt.id;
  await expect(harness.collect(harness.engine.start({kind:"resume",threadId:thread.id,interruptId,value:{approved:"wrong"}}))).rejects.toMatchObject({code:"InvalidResumeResponse"});
  expect((await harness.queries.getInterrupt(thread.id,interruptId))!.status).toBe("pending");
  const resumed=harness.engine.start({kind:"resume",threadId:thread.id,interruptId,value:{approved:true},model:{providerId:"scripted",modelId:"alternate"}});
  const duplicate=harness.engine.start({kind:"resume",threadId:thread.id,interruptId,value:{approved:true}});
  const results=await Promise.allSettled([harness.collect(resumed),harness.collect(duplicate)]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  expect((results.find(r=>r.status==="rejected") as PromiseRejectedResult).reason.code).toBe("AlreadyResumed");
  expect(resumed.id).toBe(first.id);expect(resumed.handleId).not.toBe(first.handleId);
  expect(executions).toBe(1);expect(before).toBe(1);expect(after).toBe(1);
  expect((await harness.records(first.id!)).attempts.map(a=>a.modelId)).toEqual(["test","alternate"]);
  await expect(harness.collect(harness.engine.start({kind:"resume",threadId:thread.id,interruptId,value:{approved:true}}))).rejects.toMatchObject({code:"AlreadyResumed"});
 }finally{await harness.dispose();}
});
it.each([AgentEvents.BeforeStream,AgentEvents.ModelSelect,AgentEvents.TurnDecision,AgentEvents.ModelRecover])("resumes supported decision boundary $id",async boundary=>{
 const Resume=defineInterruption({id:"boundary.resume",version:1,response:Approval.response,resolve:()=>({decision:boundary.id===AgentEvents.ModelRecover.id?"retry" as const:"allow" as const})});
 let asks=0;
 const harness=await EngineHarness.create({modelScripts:boundary.id===AgentEvents.ModelRecover.id?[{error:new TesseractError("ProviderError","fixture failure")},{text:"done"}]:[{text:"done"}],plugins:[{id:"boundary",apiVersion:1,setup(api){api.interruptions.register(Resume);api.on(boundary,(_event,context)=>{asks++;return context.suspend(Resume,{});});}}]});
 try{
  const thread=await harness.createThread(),stream=harness.engine.start({kind:"input",threadId:thread.id,input:[MessageCodec.encode(new HumanMessage("ask"))],model:{providerId:"scripted",modelId:"test"}});
  const events=await harness.collect(stream),request=events.find(e=>e.is(AgentEvents.StreamSuspended))!.payload.interrupt;
  await harness.collect(harness.engine.start({kind:"resume",threadId:thread.id,interruptId:request.id,value:{approved:true}}));
  expect(asks).toBe(1);expect((await harness.records(stream.id!)).stream.status).toBe("completed");
 }finally{await harness.dispose();}
});
