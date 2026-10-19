import { tool as toolHooks, message as messageHooks } from "../src/index.js";
import {it,expect} from "vitest";
import { Agent, Controller, type Plugin, type HookSpec, type StreamEvent } from "../src/index.js";
declare module "../src/events/definition.js" {interface EventMap {"example.progress":HookSpec<{count:number}>;}}
it("infers the public plugin type map and discriminated event union",()=>{
 const plugin:Plugin={id:"typed-public",setup(tessar){
  tessar.hook(toolHooks.before,event=>{
   const name:string=event.payload.tool.name;
   if(name==="write")return {decision:"deny",reason:"blocked"};
  });
  tessar.hook("example.progress",event=>{const count:number=event.payload.count;void count;});
 }};
 const inspect=(event:StreamEvent)=>{if(event.type===messageHooks.delta){const kind:"text"|"reasoning"=event.payload.partKind;return kind;}return null;};
 void inspect;expect(plugin.id).toBe("typed-public");
 if(false){
  const agent = new Agent({id:"typed",model:{providerId:"test",modelId:"test"}});
  // @ts-expect-error Agent accepts messages first, not the legacy input wrapper
  agent.stream({input: []});
  // @ts-expect-error Agent accepts messages first, not the legacy input wrapper
  agent.generate({input: []});
  new Controller({id:"runtime",agent:new Agent({id:"a",model:{providerId:"test",modelId:"test"}}),plugins:[plugin]});
  // @ts-expect-error Plugins are configured on Controller
  new Agent({id:"a",plugins:[plugin]});
  // @ts-expect-error Agent does not own plugin configuration or management
  new Agent({id:"a",model:{providerId:"test",modelId:"test"}}).plugins;
  // @ts-expect-error Agent requires a developer ID
  new Agent({});
  // @ts-expect-error Controller requires a developer ID
  new Controller({agent:new Agent({id:"a",model:{providerId:"test",modelId:"test"}})});
  // @ts-expect-error Agent initialization is owned by Controller
  new Agent({id:"a",model:{providerId:"test",modelId:"test"}}).initialize();
 }
});
