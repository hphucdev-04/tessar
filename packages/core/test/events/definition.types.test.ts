import { tool as toolHooks, stream as streamHooks } from "../../src/events/type.js";
import {expect,it} from "vitest";
import type {HookSpec} from "../../src/events/definition.js";
import {PluginHost} from "../../src/plugins/host.js";

declare module "../../src/events/definition.js" {interface EventMap {"typed.value":HookSpec<{count:number},number>;}}
it("infers hook payload and result from the string type map",async()=>{
 const host=new PluginHost();await host.initialize([{id:"typed",setup(tessar){
  tessar.hook("typed.value",e=>e.payload.count+1,{kind:"transformation"});
  tessar.hook(toolHooks.before,event=>event.payload.tool.name==="write"?{decision:"deny",reason:"blocked"}:undefined);
  if(false){
   // @ts-expect-error wrong hook result
   tessar.hook("typed.value",()=>"wrong");
   // @ts-expect-error payload inferred from event map
   tessar.emit("typed.value",{count:"wrong"});
   // @ts-expect-error no legacy registration alias
   tessar.on(streamHooks.started,()=>{});
   // @ts-expect-error typo is not a registered event name
   tessar.hook("tool.befor",()=>{});
  }
 }}]);expect(await host.dispatch("typed.value",{count:2})).toBe(3);await host.dispose();
});
