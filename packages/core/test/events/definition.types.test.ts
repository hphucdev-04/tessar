import {expect,it} from "vitest";
import type {HookSpec} from "../../src/events/definition.js";
import {PluginHost} from "../../src/plugins/host.js";
import {AgentEvents} from "../../src/events/catalog.js";
declare module "../../src/events/definition.js" {interface EventMap {"typed.value":HookSpec<{count:number},number>;}}
it("infers hook payload and result from the string type map",async()=>{
 const host=new PluginHost();await host.initialize([{id:"typed",setup(tesseract){
  tesseract.hook("typed.value",e=>e.payload.count+1,{kind:"transformation"});
  tesseract.hook(AgentEvents.BeforeTool,event=>event.payload.tool.name==="write"?{decision:"deny",reason:"blocked"}:undefined);
  if(false){
   // @ts-expect-error wrong hook result
   tesseract.hook("typed.value",()=>"wrong");
   // @ts-expect-error payload inferred from event map
   tesseract.emit("typed.value",{count:"wrong"});
   // @ts-expect-error no legacy registration alias
   tesseract.on(AgentEvents.StreamStarted,()=>{});
   // @ts-expect-error typo is not a registered event name
   tesseract.hook("tool.befor",()=>{});
  }
 }}]);expect(await host.dispatch("typed.value",{count:2})).toBe(3);await host.dispose();
});
