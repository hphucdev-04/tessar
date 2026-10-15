import {expect,it} from "vitest";
import {Agent,Controller,AgentEvents,HumanMessage,defineInterruption,ToolDecision} from "./index.js";
import {fixture,fixtureRef} from "./test-fixture.js";
it("delegates stream and generate to canonical execution and preserves default selection",async()=>{
 const {agent,controller,provider}=await fixture([{text:"first",usage:{inputTokens:5,outputTokens:3}},{text:"second"}]);
 try{const outcome=await agent.generate({input:new HumanMessage("ask"),model:{...fixtureRef,modelId:"alternate"},scope:{user:"u"}});expect(outcome.status).toBe("completed");expect(outcome.output[0]!.content[0]).toMatchObject({text:"first"});expect(outcome.usage.metrics.outputTokens.knownTotal).toBe(3);
 const stream=agent.stream({input:new HumanMessage("next")});const events=[];for await(const event of stream)events.push(event);expect(events.some(e=>e.is(AgentEvents.StreamEnd))).toBe(true);expect(provider.calls.map(c=>c.model.modelId)).toEqual(["alternate","test"]);expect((await controller.getThread(outcome.threadId))!.scope).toEqual({user:"u"});}finally{await controller.dispose();}
});
it("returns suspended generate with durable interrupt and does not wait for a response",async()=>{
 const approval=defineInterruption({id:"ask",version:1,response:{jsonSchema:{type:"boolean"},parse:v=>Boolean(v)},resolve:()=>ToolDecision.allow()});
 const {agent,controller}=await fixture([],[{id:"approval",setup(tesseract){tesseract.interruptions.register(approval);tesseract.hook(AgentEvents.BeforeStream,(_e,context)=>context.suspend(approval,{}));}}]);
 try{const result=await agent.generate({input:new HumanMessage("ask")});expect(result.status).toBe("suspended");expect(result.interrupt!.streamId).toBe(result.streamId);expect((await (await controller.getThread(result.threadId))!.snapshot()).activeStreamId).toBe(result.streamId);}finally{await controller.dispose();}
});
it("throws typed not-ready and missing-model without creating a hidden runtime",async()=>{
 const agent=new Agent({id:"a"});expect(()=>agent.stream({input:new HumanMessage("ask")})).toThrow();const controller=new Controller({id:"r",agent});expect(()=>agent.stream({input:new HumanMessage("ask")})).toThrow();await controller.initialize();expect(()=>agent.stream({input:new HumanMessage("ask")})).toThrowError(expect.objectContaining({code:"MissingModel"}));await controller.dispose();
});
