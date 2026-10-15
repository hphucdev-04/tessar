import { expect, it } from "vitest";
import { PluginHost } from "./host.js";
import { defineEvent } from "../events/definition.js";
const Value = defineEvent<string,string,"transformation">({id:"test.value",owner:"test",version:1,kind:"transformation"});
it("rolls back failed setup and retains resources until captured streams release them", async () => {
  const order: string[] = [];
  const host = new PluginHost();
  await host.initialize([{id:"test",apiVersion:1,setup(api) { api.on(Value, e=> e.payload+"A"); return () => {order.push("disposeA");}; }}]);
  const captured = host.capture();
  await expect(host.attach({id:"bad",apiVersion:1,setup(api) {api.on(Value,e=>e.payload+"BAD"); throw Error("setup");}})).rejects.toThrow();
  expect(await host.dispatch(Value,"")).toBe("A");
  await host.detach("test");
  expect(order).toEqual([]);
  expect(await host.dispatch(Value,"",{},captured)).toBe("A");
  expect(await host.dispatch(Value,"")).toBe("");
  await captured.release();
  expect(order).toEqual(["disposeA"]);
  await host.dispose();
});
it("rejects incompatible event ownership and plugin IDs, and awaits required barriers", async () => {
  const host = new PluginHost();
  await expect(host.attach({id:"",apiVersion:1,setup(){}})).rejects.toThrow();
  const Barrier = defineEvent<{},void,"barrier">({id:"test.barrier",owner:"test",version:1,kind:"barrier"});
  await host.initialize([{id:"test",apiVersion:1,setup(api){api.on(Barrier,async()=>{throw Error("required");});}}]);
  await expect(host.dispatch(Barrier,{})).rejects.toMatchObject({code:"PluginError"});
  await expect(host.attach({id:"foreign",apiVersion:1,setup(api){api.on(defineEvent({id:"test.barrier",owner:"foreign",version:2,kind:"barrier"}),()=>{});}})).rejects.toMatchObject({code:"RegistrationConflict"});
  await host.dispose();
});
