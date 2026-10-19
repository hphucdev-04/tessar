import { session as sessionHooks } from "../../src/events/type.js";
import {expect,it} from "vitest";
import {PluginHost} from "../../src/plugins/host.js";
import type {HookSpec} from "../../src/events/definition.js";

declare module "../../src/events/definition.js"{interface EventMap {"test.value":HookSpec<string,string>;"test.barrier":HookSpec<{}>;}}
it("rolls back setup and retains captured resources until release",async()=>{
 const order:string[]=[];const host=new PluginHost();
 await host.initialize([{id:"test",setup(tessar){tessar.hook("test.value",e=>e.payload+"A",{kind:"transformation"});return ()=>{order.push("disposeA");};}}]);
 const captured=host.capture();await expect(host.attach({id:"bad",setup(tessar){tessar.hook("test.value",e=>e.payload+"BAD");throw Error("setup");}})).rejects.toThrow();
 expect(await host.dispatch("test.value","")).toBe("A");await host.detach("test");expect(order).toEqual([]);
 expect(await host.dispatch("test.value","",{},captured)).toBe("A");expect(await host.dispatch("test.value","")).toBe("");await captured.release();expect(order).toEqual(["disposeA"]);await host.dispose();
});
it("rejects incompatible hook contracts and plugin IDs and awaits barriers",async()=>{
 const host=new PluginHost();await expect(host.attach({id:"",setup(){}})).rejects.toThrow();
 await host.initialize([{id:"test",setup(tessar){tessar.hook("test.barrier",async()=>{throw Error("required");},{kind:"barrier"});}}]);
 await expect(host.dispatch("test.barrier",{})).rejects.toThrow("required");
 await expect(host.attach({id:"foreign",setup(tessar){tessar.hook("test.barrier",()=>{},{kind:"barrier",version:2});}})).rejects.toMatchObject({code:"RegistrationConflict"});await host.dispose();
});
it("disposes resources when shutdown races an asynchronous plugin setup",async()=>{
 let release!:()=>void,entered!:()=>void,closed=0;const gate=new Promise<void>(r=>release=r),start=new Promise<void>(r=>entered=r);
 const host=new PluginHost();const installing=host.attach({id:"late",async setup(tessar){tessar.defer(()=>{closed++;});entered();await gate;tessar.registry.register("capability","late",{});}});
 await start;const closing=host.dispose();release();await Promise.allSettled([installing,closing]);expect(closed).toBe(1);expect(host.registrations()).toHaveLength(0);
});
it("protects Session lifecycle barriers from notification overrides",async()=>{
 const host=new PluginHost();await expect(host.attach({id:"override",setup(tessar){tessar.hook(sessionHooks.beforeClose,()=>{},{kind:"notification"});}})).rejects.toMatchObject({code:"RegistrationConflict"});await host.dispose();
});
