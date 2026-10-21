import { expect,it } from "vitest";
import { ModelRegistry } from "../../src/models/registry.js";
it("does not refresh old catalog pricing by retrieving only a provider name",async()=>{
 const registry=new ModelRegistry({clock:{now:()=>"2026-10-15T00:00:00Z"},catalog:{revision:"old",fetchedAt:"2026-10-01T00:00:00Z",entries:{p:{x:{contextWindow:100}}}}});
 registry.registerProvider({id:"p",create:()=>{throw Error("unused");},metadata:{resolve:async()=>({name:"updated"})}});
 const model=registry.get({providerId:"p",modelId:"x"});await model.refreshProfile();
 expect(model.profile().name).toBe("updated");expect(model.profile().metadata.freshness).toBe("stale");expect(model.profile().metadata.fetchedAt).toBe("2026-10-01T00:00:00Z");registry.dispose();
});
it("uses exact offline catalog identity and preserves unknown fields after metadata errors",async()=>{
 const registry=new ModelRegistry({catalog:{revision:"fixture",fetchedAt:"2026-10-15T00:00:00Z",entries:{openai:{"model-x":{name:"known",contextWindow:100,capabilities:{tools:true}}}}}});
 registry.registerProvider({id:"openai",create:()=>{throw Error("unused");},metadata:{resolve:async()=>{throw Error("offline");}}});
 registry.registerProvider({id:"gateway",create:()=>{throw Error("unused");}});
 const known=registry.get({providerId:"openai",modelId:"model-x"}),gateway=registry.get({providerId:"gateway",modelId:"model-x"});
 await known.refreshProfile();
 expect(known.profile().contextWindow).toBe(100);
 expect(known.profile().capabilities.tools).toBe(true);
 expect(known.profile().pricing).toBeNull();expect(gateway.profile().contextWindow).toBeNull();
 expect(known.profile().metadata.provenance.contextWindow).toContain("catalog");
 registry.dispose();
});
it("applies only explicit catalog aliases and retains tiered pricing conditions",async()=>{
 const registry=new ModelRegistry({catalog:{revision:"fixture",fetchedAt:"2026-10-15T00:00:00Z",entries:{official:{x:{contextWindow:42,pricing:{currency:"USD",basis:"million-tokens",type:"tiered",input:1,output:2,cacheRead:null,cacheWrite:null,reasoning:null,tiers:[{condition:{contextTokens:{gt:200000}},rates:{input:3,output:4}}]}}}}}});
 registry.registerProvider({id:"alias",catalogModelRef:()=>({providerId:"official",modelId:"x"}),catalogMappingVersion:1,create:()=>{throw Error("unused");}});
 const model=registry.get({providerId:"alias",modelId:"served-name"});
 expect(model.profile().providerId).toBe("alias");expect(model.profile().contextWindow).toBe(42);
 expect(model.profile().pricing!.type).toBe("tiered");expect(model.profile().pricing!.tiers![0]!.condition).toEqual({contextTokens:{gt:200000}});
 registry.dispose();
});
