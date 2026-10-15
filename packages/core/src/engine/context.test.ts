import { expect,it } from "vitest";
import { AgentHarness } from "../testing/harness.js";
import { HumanMessage } from "../messages/message.js";
import { MessageCodec } from "../messages/codec.js";
it("assembles the complete canonical history and ordered instruction sources",async()=>{
 const harness=await AgentHarness.create({instructions:"agent rules",modelScripts:[{text:"ok"}]});
 try{
  const thread=await harness.createThread({instructions:"thread rules",messages:Array.from({length:60},(_,i)=>MessageCodec.encode(new HumanMessage(String(i))))});
  await harness.collect(harness.admit({kind:"input",threadId:thread.id,input:[MessageCodec.encode(new HumanMessage("next"))],model:{providerId:"scripted",modelId:"test"}}));
  expect(harness.provider.calls[0]!.messages).toHaveLength(61);
  expect(harness.provider.calls[0]!.instructions.sections.map(s=>s.content)).toEqual(["agent rules","thread rules"]);
 }finally{await harness.dispose();}
});
