import { message as messageHooks } from "../../src/events/type.js";
import { it } from "vitest";

import type { PluginContext } from "../../src/plugins/context.js";
it("does not offer suspend on notification hooks",()=>{
 const check=(tessar:PluginContext)=>{
  tessar.hook(messageHooks.delta,(_event,context)=>{
   // @ts-expect-error notifications cannot suspend the engine
   context.suspend({}, {});
  });
 };
 void check;
});
