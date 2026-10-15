import { expect, it } from "vitest";
import { defineEvent } from "./definition.js";
import { PluginHost } from "../plugins/host.js";
it("infers event payloads and rejects handlers with incompatible results", async () => {
  const event = defineEvent<{count:number},number,"transformation">({id:"typed.value",owner:"typed",version:1,kind:"transformation"});
  const host = new PluginHost();
  await host.initialize([{id:"typed",apiVersion:1,setup(api){
    api.on(event, e => e.payload.count + 1);
    if (false) {
      // @ts-expect-error result must be a number
      api.on(event, () => "wrong");
      // @ts-expect-error payload is inferred from definition
      api.emit(event, {count:"wrong"});
    }
  }}]);
  expect(await host.dispatch(event,{count:2})).toBe(3);
  await host.dispose();
});
