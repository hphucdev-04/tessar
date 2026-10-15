import { AgentEngine,type Stream } from "../engine/engine.js";
import { PluginHost } from "../plugins/host.js";
import type { Plugin } from "../plugins/context.js";
import { createMemoryBackend } from "../state/memory-backend.js";
import type { StorageBackend } from "../state/storage-ports.js";
import { StateQueries } from "../state/queries.js";
import { ThreadService,type CreateThreadOptions } from "../state/threads.js";
import type { StreamLimits } from "../state/schema.js";
import { normalizeInstruction } from "../instructions/instruction.js";
import { ScriptedProvider,type ModelScript } from "./scripted-provider.js";
import { AgentEvents } from "../events/catalog.js";
import { TesseractError } from "../errors.js";
export class EngineHarness {
 private constructor(readonly engine:AgentEngine,readonly provider:ScriptedProvider,readonly backend:StorageBackend,readonly registry:PluginHost,readonly queries:StateQueries){}
 static async create(options:{modelScripts?:readonly ModelScript[];plugins?:readonly Plugin[];backend?:StorageBackend;instructions?:string;limits?:Partial<StreamLimits>}={}):Promise<EngineHarness>{
  const backend=options.backend??createMemoryBackend(),registry=new PluginHost(),provider=new ScriptedProvider(options.modelScripts??[]);
  await registry.initialize([{id:"scripted",apiVersion:1,setup(api){api.models.registerProvider({id:"scripted",create:()=>provider});}},...options.plugins??[]]);
  return new EngineHarness(new AgentEngine({backend,registry,instructions:normalizeInstruction(options.instructions),limits:options.limits}),provider,backend,registry,new StateQueries(backend));
 }
 createThread(options?:CreateThreadOptions){return new ThreadService(this.backend).create(options);}
 async collect(stream:Stream){const events=[];for await(const event of stream){events.push(event);if(event.is(AgentEvents.StreamError))throw new TesseractError(event.payload.error.code,event.payload.error.message);}return events;}
 async records(streamId:string){const stream=await this.backend.executions.get("streams",streamId);if(!stream)throw Error("No stream record");return {stream,turns:(await this.backend.executions.listRecords("turns",stream.threadId)).filter(t=>t.streamId===streamId),attempts:(await this.backend.executions.listRecords("model_attempts",stream.threadId)).filter(a=>a.streamId===streamId),tools:(await this.backend.executions.listRecords("tool_executions",stream.threadId)).filter(t=>t.streamId===streamId),messages:(await this.queries.snapshot(stream.threadId)).state.messages};}
 checkpoint(threadId:string){return this.queries.snapshot(threadId);}
 async dispose(){await this.engine.shutdown();await this.registry.dispose();await this.backend.close();}
}
