import { it } from "vitest";
import { AgentEvents } from "../events/catalog.js";
import type { PluginContext } from "../plugins/context.js";
it("does not offer suspend on notification hooks",()=>{
 const check=(tesseract:PluginContext)=>{
  tesseract.hook(AgentEvents.MessageDelta,(_event,context)=>{
   // @ts-expect-error notifications cannot suspend the engine
   context.suspend({}, {});
  });
 };
 void check;
});
