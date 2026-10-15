import {it,expect} from "vitest";
import {Agent,Controller,AgentEvents,type Plugin,type HookSpec,type StreamEvent} from "../src/index.js";
declare module "../src/events/definition.js" {interface EventMap {"example.progress":HookSpec<{count:number}>;}}
it("infers the public plugin type map and discriminated event union",()=>{
 const plugin:Plugin={id:"typed-public",setup(tesseract){
  tesseract.hook(AgentEvents.BeforeTool,event=>{
   const name:string=event.payload.tool.name;
   if(name==="write")return {decision:"deny",reason:"blocked"};
  });
  tesseract.hook("example.progress",event=>{const count:number=event.payload.count;void count;});
 }};
 const inspect=(event:StreamEvent)=>{if(event.type===AgentEvents.MessageDelta){const kind:"text"|"reasoning"=event.payload.partKind;return kind;}return null;};
 void inspect;expect(plugin.id).toBe("typed-public");
 if(false){
  // @ts-expect-error Agent requires a developer ID
  new Agent({});
  // @ts-expect-error Controller requires a developer ID
  new Controller({agent:new Agent({id:"a"})});
  // @ts-expect-error Agent initialization is owned by Controller
  new Agent({id:"a"}).initialize();
 }
});
