import { expect,it } from "vitest";
import { AgentHarness } from "../testing/harness.js";
import { defineEffect } from "./tracked-effects.js";
import { AssistantMessage,HumanMessage } from "../messages/message.js";
import { MessageCodec } from "../messages/codec.js";
import { createTool,toolResult } from "../tools/tool.js";
import { normalizeInstruction } from "../instructions/instruction.js";
import { TesseractError } from "../errors.js";
const call=()=>({response:{message:MessageCodec.encode(new AssistantMessage([{type:"tool-call",toolCallId:"c",name:"work",arguments:{}}])),usage:undefined}});
const model={providerId:"scripted",modelId:"test"};
it("tracks auxiliary model attempts under their originating tool",async()=>{
 const harness=await AgentHarness.create({modelScripts:[call(),{text:"aux",usage:{inputTokens:20,outputTokens:2}},{text:"done",usage:{inputTokens:10,outputTokens:1}}],plugins:[{id:"work",setup(tesseract){tesseract.tools.register(createTool({name:"work",description:"work",input:{jsonSchema:{},parse:()=>({})},execute:async(_input,context)=>{
  for await(const _chunk of context.models.stream({model,purpose:"auxiliary",request:{model,instructions:normalizeInstruction("aux"),messages:[],tools:[]}})){}
  return toolResult("aux completed");
 }}));}}]});
 try{
  const thread=await harness.createThread(),stream=harness.admit({kind:"input",threadId:thread.id,input:[MessageCodec.encode(new HumanMessage("ask"))],model});
  await harness.collect(stream);const records=await harness.records(stream.id!);
  expect(records.attempts.map(a=>a.purpose)).toEqual(["primary","auxiliary","primary"]);
  expect(records.attempts[1]!.parentToolExecutionId).toBe(records.tools[0]!.id);
  expect(records.stream.directUsage.metrics.inputTokens.knownTotal).toBe(30);expect(records.tools[0]!.status).toBe("succeeded");
 }finally{await harness.dispose();}
});
it("requires reconciliation for unknown effects and does not invoke the executor again",async()=>{
 let calls=0;const errors:string[]=[];
 const Effect=defineEffect({id:"effect.unknown",version:1,input:{jsonSchema:{},parse:()=>({})},output:{jsonSchema:{},parse:()=>({})},execute:async()=>{calls++;throw new TesseractError("StorageUnavailable","external ack lost");}});
 const harness=await AgentHarness.create({modelScripts:[call(),{text:"done"}],plugins:[{id:"work",setup(tesseract){tesseract.effects.register(Effect);tesseract.tools.register(createTool({name:"work",description:"work",input:{jsonSchema:{},parse:()=>({})},execute:async(_input,context)=>{
  for(let n=0;n<2;n++)try{await context.effects.execute(Effect,{},{key:"once"});}catch(error){errors.push((error as TesseractError).code);}
  return toolResult("unknown outcome was reported to host");
 }}));}}]});
 try{const thread=await harness.createThread();await harness.collect(harness.admit({kind:"input",threadId:thread.id,input:[MessageCodec.encode(new HumanMessage("ask"))],model}));expect(calls).toBe(1);expect(errors).toEqual(["RecoveryRequired","RecoveryRequired"]);}finally{await harness.dispose();}
});
it("commits typed effect outcomes and reuses completed results by stable key",async()=>{
 let writes=0;
 const Effect=defineEffect({id:"effect.write",version:1,input:{jsonSchema:{},parse:(value:unknown)=>value as {value:number}},output:{jsonSchema:{},parse:(value:unknown)=>value as {value:number}},execute:async(input)=>{writes++;return {value:input.value+1};}});
 const harness=await AgentHarness.create({modelScripts:[call(),{text:"done"}],plugins:[{id:"work",setup(tesseract){tesseract.effects.register(Effect);tesseract.tools.register(createTool({name:"work",description:"work",input:{jsonSchema:{},parse:()=>({})},execute:async(_input,context)=>{
  expect(await context.effects.execute(Effect,{value:1},{key:"once"})).toEqual({value:2});
  expect(await context.effects.execute(Effect,{value:1},{key:"once"})).toEqual({value:2});
  await expect(context.effects.execute(Effect,{value:9},{key:"once"})).rejects.toMatchObject({code:"CommitConflict"});
  return toolResult("done");
 }}));}}]});
 try{const thread=await harness.createThread();const stream=harness.admit({kind:"input",threadId:thread.id,input:[MessageCodec.encode(new HumanMessage("ask"))],model});await harness.collect(stream);expect(writes).toBe(1);expect((await harness.records(stream.id!)).tools[0]!.status).toBe("succeeded");}finally{await harness.dispose();}
});
it("reserves a child identity once and separates direct from inclusive usage",async()=>{
 let harness!:AgentHarness;
 harness=await AgentHarness.create({modelScripts:[{...call(),usage:{inputTokens:10,outputTokens:0}},{text:"child",usage:{inputTokens:20,outputTokens:0}},{text:"standalone",usage:{inputTokens:0,outputTokens:0}},{text:"parent",usage:{inputTokens:0,outputTokens:0}}],plugins:[{id:"work",setup(tesseract){tesseract.tools.register(createTool({name:"work",description:"work",input:{jsonSchema:{},parse:()=>({})},execute:async(_input,context)=>{
  const child=await harness.createThread(),reserved=await context.executions.reserveChild({threadId:child.id,dispatchKey:"child"});
  expect(await context.executions.reserveChild({threadId:child.id,dispatchKey:"child"})).toEqual(reserved);
  await harness.collect(harness.admit({kind:"input",threadId:child.id,input:[MessageCodec.encode(new HumanMessage("child"))],model,origin:reserved.origin}));
  await expect(harness.collect(harness.admit({kind:"input",threadId:child.id,input:[MessageCodec.encode(new HumanMessage("duplicate"))],model,origin:reserved.origin}))).rejects.toMatchObject({code:"AlreadyAdmitted"});
  await harness.collect(harness.admit({kind:"input",threadId:child.id,input:[MessageCodec.encode(new HumanMessage("independent"))],model}));
  return toolResult("child completed");
 }}));}}]});
 try{
  const thread=await harness.createThread(),stream=harness.admit({kind:"input",threadId:thread.id,input:[MessageCodec.encode(new HumanMessage("parent"))],model});
  await harness.collect(stream);const records=await harness.records(stream.id!);
  expect(records.stream.directUsage.metrics.inputTokens.knownTotal).toBe(10);
  expect(records.stream.inclusiveUsage.metrics.inputTokens.knownTotal).toBe(30);
  expect(records.tools[0]!.status).toBe("succeeded");
 }finally{await harness.dispose();}
});
