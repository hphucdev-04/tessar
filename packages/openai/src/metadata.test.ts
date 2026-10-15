import {expect,it} from "vitest";
import {OpenAIPlugin} from "./plugin.js";
import {PluginHost} from "@tesseract/core";
it("registers an explicit provider and retrieves only metadata actually supplied by the API",async()=>{
 const host=new PluginHost();await host.attach(OpenAIPlugin({apiKey:"fixture",fetch:async()=>Response.json({id:"x",object:"model",created:1,owned_by:"fixture"})}));
 const provider:any=host.registrations().find(r=>r.kind==="provider")!.value;
 expect(provider.id).toBe("openai");expect(await provider.metadata.resolve({providerId:"openai",modelId:"x"},{})).toEqual({});
 expect(provider.catalogModelRef({providerId:"openai",modelId:"x"})).toEqual({providerId:"openai",modelId:"x"});await host.dispose();
 const custom=new PluginHost();await custom.attach(OpenAIPlugin({apiKey:"fixture",baseURL:"https://custom.invalid/v1"}));
 const other:any=custom.registrations().find(r=>r.kind==="provider")!.value;expect(other.catalogModelRef({providerId:"openai",modelId:"x"})).toBeNull();await custom.dispose();
});
