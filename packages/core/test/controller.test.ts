import {expect,it} from "vitest";
import {Agent,Controller,createMemoryBackend,type Plugin} from "../src/index.js";
it("requires explicit IDs and binds an Agent to exactly one Controller",()=>{
 expect(()=>new Agent({id:""})).toThrow();const agent=new Agent({id:"a"});expect(()=>new Controller({id:"",agent})).toThrow();
 new Controller({id:"r",agent});expect(()=>new Controller({id:"other",agent})).toThrow();
});
it("initializes once and rolls back failed setup in reverse order",async()=>{
 const log:string[]=[];const plugin=(id:string):Plugin=>({id,setup(tesseract){log.push(id);tesseract.defer(()=>{log.push("close:"+id);});}});
 const plugins=[plugin("a"),plugin("b")];
 const controller=new Controller({id:"r",agent:new Agent({id:"a"}),plugins});
 plugins.push(plugin("not-initial"));
 const one=controller.initialize(),two=controller.initialize();expect(one).toBe(two);await Promise.all([one,two]);expect(log).toEqual(["a","b"]);await controller.dispose();await controller.dispose();expect(log).toEqual(["a","b","close:b","close:a"]);
 const broken=new Controller({id:"r",agent:new Agent({id:"a"}),plugins:[plugin("c"),{id:"bad",setup(){throw Error("setup");}}]});
 await expect(broken.initialize()).rejects.toThrow("setup");expect(log.at(-1)).toBe("close:c");await expect(broken.initialize()).rejects.toThrow();await broken.dispose();
});
it("rejects conflicting backends and backend attachment after initialization",async()=>{
 const storage=(id:string):Plugin=>({id,setup(tesseract){tesseract.storage.registerBackend(createMemoryBackend());}});
 const broken=new Controller({id:"r",agent:new Agent({id:"a"}),plugins:[storage("one"),storage("two")]});await expect(broken.initialize()).rejects.toMatchObject({code:"RegistrationConflict"});await broken.dispose();
 const ready=new Controller({id:"r",agent:new Agent({id:"a"})});await ready.initialize();await expect(ready.plugins.attach(storage("late"))).rejects.toMatchObject({code:"InvalidTransition"});await ready.dispose();
});
it("rejects initialization once disposal has started, including before first initialize",async()=>{
 const ready=new Controller({id:"r",agent:new Agent({id:"a"})});await ready.initialize();
 const closing=ready.dispose();await expect(ready.initialize()).rejects.toMatchObject({code:"Disposed"});expect(()=>ready.createSession()).toThrowError(expect.objectContaining({code:"Disposed"}));await closing;
 await expect(ready.initialize()).rejects.toMatchObject({code:"Disposed"});
 const unused=new Controller({id:"unused",agent:new Agent({id:"unused"})});await unused.dispose();
 await expect(unused.initialize()).rejects.toMatchObject({code:"Disposed"});
});
