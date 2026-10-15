import { expect,it } from "vitest";
import { PluginStateAccess,definePluginState } from "../../src/state/plugin-state.js";
import { createMemoryBackend } from "../../src/state/memory-backend.js";
it("stages immutable versioned plugin data and migrates without mutating old snapshot",async()=>{
 const definition=definePluginState({pluginId:"test",namespace:"counter",schemaVersion:2,initial:{count:0},migrate:(data)=>({count:(data as {count:number}).count+1})});
 const old={pluginId:"test",namespace:"counter",ownerType:"thread" as const,ownerId:"t",schemaVersion:1,revision:1,data:{count:2}};
 const access=new PluginStateAccess([definition],{type:"thread",id:"t"},[old]);
 expect(access.get(definition)).toEqual({count:3});
 access.update(definition,{count:4});
 expect(access.snapshots()[0]).toMatchObject({schemaVersion:2,data:{count:4}});
 expect(old.data).toEqual({count:2});
 expect(Object.isFrozen(access.get(definition))).toBe(true);
});
it("keeps agent-owned state outside thread checkpoints with compare-and-set",async()=>{
 const backend=createMemoryBackend();
 const state={pluginId:"test",namespace:"counter",ownerType:"agent" as const,ownerId:"assistant",schemaVersion:1,revision:1,data:{count:1}};
 await backend.ownedState.compareAndSet(state,0);
 await expect(backend.ownedState.compareAndSet({...state,data:{count:2}},0)).rejects.toMatchObject({code:"CommitConflict"});
 expect(await backend.ownedState.get(state)).toEqual(state);
 await backend.close();
});
it("offers explicit CAS access to agent-owned namespaces through the plugin state API",async()=>{
 const backend=createMemoryBackend(),definition=definePluginState({pluginId:"test",namespace:"owned",schemaVersion:1,initial:{count:0}});
 const access=new PluginStateAccess([definition],{type:"thread",id:"t"},[],undefined,undefined,backend.ownedState);
 const owned=access.owned({type:"agent",id:"assistant"});
 const first=await owned.read(definition);
 expect(first).toMatchObject({value:{count:0},revision:0});
 await owned.update(definition,first.revision,{count:1});
 expect(await owned.read(definition)).toMatchObject({value:{count:1},revision:1});
 expect(access.snapshots()).toEqual([]);
 await backend.close();
});
