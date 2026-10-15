import {expect,it} from "vitest";
import {normalizeInstruction,HumanMessage,type ModelChunk} from "@tesseract/core";
import {OpenAIAdapter} from "./adapter.js";
const ref={providerId:"openai",modelId:"fixture"};
const request={model:ref,instructions:normalizeInstruction("system"),messages:[new HumanMessage("hello")],tools:[]};
export const output=[{type:"reasoning",id:"rs_1",summary:[{type:"summary_text",text:"summary"}],encrypted_content:"opaque"},{type:"message",id:"msg_1",status:"completed",role:"assistant",content:[{type:"output_text",text:"answer",annotations:[]}]}];
function fixture(events:unknown[]){return new Response(events.map(e=>`event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),{headers:{"content-type":"text/event-stream"}});}
it("streams official SDK SSE, retains reasoning state and counts cumulative usage once",async()=>{
 const bodies:any[]=[];const adapter=new OpenAIAdapter({apiKey:"fixture",fetch:async(_url,init)=>{bodies.push(JSON.parse(init!.body as string));return fixture([
  {type:"response.reasoning_summary_text.delta",item_id:"rs_1",summary_index:0,delta:"summary",sequence_number:1},
  {type:"response.output_text.delta",item_id:"msg_1",content_index:0,delta:"answer",sequence_number:2},
  {type:"response.completed",sequence_number:3,response:{id:"resp_1",status:"completed",output,usage:{input_tokens:100,output_tokens:30,total_tokens:130,input_tokens_details:{cached_tokens:40},output_tokens_details:{reasoning_tokens:10}}}}
 ]);}},ref);
 const chunks:ModelChunk[]=[];for await(const chunk of adapter.stream(request,{signal:new AbortController().signal}))chunks.push(chunk);
 expect(bodies).toHaveLength(1);expect(bodies[0].model).toBe("fixture");expect(bodies[0].instructions).toBe("system");expect(bodies[0].include).toContain("reasoning.encrypted_content");
 expect(chunks.filter(c=>c.type==="message-delta").map(c=>c.partKind)).toEqual(["reasoning","text"]);
 const response=chunks.find(c=>c.type==="response")!;expect(response.type==="response"&&response.response.usage).toMatchObject({inputTokens:100,cacheReadInputTokens:40,uncachedInputTokens:60,outputTokens:30,reasoningOutputTokens:10,totalTokens:130});
 expect(response.type==="response"&&response.response.message.providerState).toMatchObject({items:output});
});
it("does not retry HTTP429 implicitly and redacts raw error response",async()=>{
 let calls=0;const adapter=new OpenAIAdapter({apiKey:"secret",fetch:async()=>{calls++;return new Response(JSON.stringify({error:{message:"secret in body"}}),{status:429});}},ref);
 await expect(async()=>{for await(const _ of adapter.stream(request,{signal:new AbortController().signal})){} }).rejects.toMatchObject({code:"ProviderError",message:"OpenAI request failed"});expect(calls).toBe(1);
});
it("assembles fragmented function arguments using ordered authoritative completed items",async()=>{
 const calls=[{type:"function_call",id:"fc_1",call_id:"call_1",name:"lookup",arguments:'{"x":42}'},{type:"function_call",id:"fc_2",call_id:"call_2",name:"next",arguments:'{}'}];
 const adapter=new OpenAIAdapter({apiKey:"fixture",fetch:async()=>fixture([
  {type:"response.function_call_arguments.delta",item_id:"fc_1",delta:'{"x":'},
  {type:"response.function_call_arguments.delta",item_id:"fc_1",delta:'42}'},
  {type:"response.completed",response:{id:"r",status:"completed",output:calls}}
 ])},ref);
 for await(const chunk of adapter.stream(request,{signal:new AbortController().signal}))if(chunk.type==="response")expect(chunk.response.message.content).toEqual([{type:"tool-call",toolCallId:"call_1",name:"lookup",arguments:{x:42}},{type:"tool-call",toolCallId:"call_2",name:"next",arguments:{}}]);
});
it("rejects mismatched context before HTTP and propagates abort",async()=>{
 let calls=0;const adapter=new OpenAIAdapter({apiKey:"fixture",fetch:async()=>{calls++;return fixture([]);}},ref);
 expect(()=>adapter.validate({...request,model:{...ref,modelId:"other"}})).toThrow();expect(calls).toBe(0);
 const cancel=new AbortController();cancel.abort();await expect(async()=>{for await(const _ of adapter.stream(request,{signal:cancel.signal})){} }).rejects.toThrow();
});
it("reports incomplete streams and never fabricates missing usage",async()=>{
 for(const event of [null,{type:"response.incomplete",response:{id:"resp",status:"incomplete",output,usage:null}}]){
 const adapter=new OpenAIAdapter({apiKey:"fixture",fetch:async()=>fixture(event?[event]:[])},ref);
 await expect(async()=>{for await(const _ of adapter.stream(request,{signal:new AbortController().signal})){} }).rejects.toMatchObject({code:"ProviderIncomplete"});
 }
 const adapter=new OpenAIAdapter({apiKey:"fixture",fetch:async()=>fixture([{type:"response.completed",response:{id:"resp",status:"completed",output,usage:null}}])},ref);
 for await(const chunk of adapter.stream(request,{signal:new AbortController().signal}))if(chunk.type==="response")expect(chunk.response.usage!.totalTokens).toBeNull();
});

