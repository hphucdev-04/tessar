import {expect,it} from "vitest";
import {normalizeInstruction,HumanMessage,ToolMessage} from "@tessar/core";
import {decodeOutput,encodeInput} from "../src/codec.js";
const ref={providerId:"openai",modelId:"fixture"};
it("roundtrips ordered reasoning and two function calls with opaque IDs",()=>{
 const items=[{type:"reasoning",id:"r",summary:[],encrypted_content:"secret"},{type:"function_call",id:"f1",call_id:"c1",name:"one",arguments:'{"x":1}'},{type:"function_call",id:"f2",call_id:"c2",name:"two",arguments:'{}'}];
 const message=decodeOutput(items,ref,"response");expect(message.content.filter(p=>p.type==="tool-call").map(p=>p.toolCallId)).toEqual(["c1","c2"]);
 const input=encodeInput({model:ref,instructions:normalizeInstruction(""),messages:[new HumanMessage("ask"),message,new ToolMessage({toolCallId:"c1",content:"ok"})],tools:[]});
 expect(input.slice(1,4)).toEqual(items);expect(input[4]).toMatchObject({type:"function_call_output",call_id:"c1",output:"ok"});
 expect(()=>encodeInput({model:{providerId:"other",modelId:"x"},instructions:normalizeInstruction(""),messages:[message],tools:[]})).toThrow();
});
it("rejects malformed tool arguments and unsupported parts without losing content",()=>{
 expect(()=>decodeOutput([{type:"function_call",call_id:"x",name:"bad",arguments:'{broken'}],ref,"r")).toThrow();
 expect(()=>encodeInput({model:ref,instructions:normalizeInstruction(""),messages:[new HumanMessage([{type:"audio",data:"xx",mediaType:"audio/wav"}])],tools:[]})).toThrow();
});

