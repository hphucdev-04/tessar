import { it } from "vitest";
import { AgentEvents } from "../../src/events/catalog.js";
import type { PluginContext } from "../../src/plugins/context.js";
it("does not offer suspend on notification hooks",()=>{
 const check=(tessar:PluginContext)=>{
  tessar.hook(AgentEvents.MessageDelta,(_event,context)=>{
   // @ts-expect-error notifications cannot suspend the engine
   context.suspend({}, {});
  });
 };
 void check;
});
