import { createSqliteBackend } from "@tesseract/storage-sqlite";
import { DatabaseSync } from "node:sqlite";
import { existsSync,writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { AgentHarness } from "@tesseract/core/testing";
import { AgentEvents,AssistantMessage,HumanMessage,MessageCodec,createTool,toolResult } from "@tesseract/core";
import { appendFileSync } from "node:fs";
const filename=process.argv[2]!,participant=process.argv[3]!;
const backend=await createSqliteBackend({filename});
if(participant.startsWith("crash-")){
 const harness=await AgentHarness.create({backend,plugins:[
  {id:"tools",setup(tesseract){tesseract.tools.register(createTool({name:"write",description:"write",input:{jsonSchema:{},parse:()=>({})},execute:async()=>{appendFileSync(filename+".effects","write\n");if(participant==="crash-tool-dispatch")process.exit(0);return toolResult("done");}}));}},
  {id:"crash-observer",setup(tesseract){
   tesseract.hook(AgentEvents.StreamStarted,event=>{writeFileSync(filename+".execution",JSON.stringify({threadId:event.threadId,streamId:event.streamId}));});
   tesseract.hook(AgentEvents.MessageCommitted,event=>{if(participant==="crash-model-result"&&event.payload.message.role==="assistant")process.exit(0);});
  }}
 ],modelScripts:[{response:{message:MessageCodec.encode(new AssistantMessage([{type:"tool-call",toolCallId:"c",name:"write",arguments:{}}]))}}]});
 const thread=await harness.createThread();
 await harness.collect(harness.admit({kind:"input",threadId:thread.id,input:[MessageCodec.encode(new HumanMessage("write"))],model:{providerId:"scripted",modelId:"test"}}));
 throw Error("Expected crash boundary was not reached");
}
writeFileSync(filename+"."+participant+".ready","ready");
const deadline=Date.now()+10000;
while(!existsSync(filename+".a.ready")||!existsSync(filename+".b.ready")) {
  if(Date.now()>deadline)throw Error("Other process did not become ready");
  await setTimeout(10);
}
let result:unknown;
try {
  const lease=await backend.ownership.acquire({threadId:"race-thread",ownerToken:"same-controller/"+participant,ttlMs:60000});
  result={ok:true,lease};
}catch(error){result={ok:false,code:(error as {code?:string}).code};}
writeFileSync(filename+"."+participant+".result",JSON.stringify(result));
await backend.close();
