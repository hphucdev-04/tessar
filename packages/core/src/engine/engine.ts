import { createDelivery, type Stream, type DeliveryTarget, type Attachment } from "./delivery.js";
export type { Stream, DeliveryTarget } from "./delivery.js";
import { TesseractError,errorInfo,fail,type ErrorInfo } from "../errors.js";
import { immutable,randomIds,systemClock,type Clock,type IdGenerator,type JsonObject,type JsonValue } from "../json.js";
import { normalizeInstruction,type Instruction } from "../instructions/instruction.js";
import { AgentEvents,type ControlDecision,type StreamOutcome,type ToolPreparation } from "../events/catalog.js";
import { EventEnvelope,type AnyEvent,type EventContext,type PayloadOf,type ResultOf } from "../events/definition.js";
import { MessageCodec } from "../messages/codec.js";
import { ToolMessage,type MessageData } from "../messages/message.js";
import type { ModelProviderRegistration,ModelRef,ModelResponse,ToolDescription } from "../models/contract.js";
import { PluginHost } from "../plugins/host.js";
import type { RegistryLease } from "../plugins/registry.js";
import { CommitCoordinator } from "../state/commit.js";
import { PluginStateAccess,type PluginStateDefinition } from "../state/plugin-state.js";
import type { StorageBackend,Lease } from "../state/storage-ports.js";
import type { Checkpoint,CheckpointCause,RecordEntry,StreamLimits,ExecutionPosition } from "../state/schema.js";
import { aggregateUsage,normalizeUsage } from "../trace/usage.js";
import type { StreamRecord,TurnRecord,ModelAttemptRecord,ToolExecutionRecord } from "../trace/records.js";
import { toolResult,type Tool } from "../tools/tool.js";
import { ContextAssembler } from "./context.js";
import { executeTool } from "./tool-executor.js";
import { Suspension,type InterruptionDefinition } from "./interrupt.js";
import { phaseForEvent,validateManifest,validateResume } from "./resume.js";
import { canonicalJson } from "../state/commit.js";
import { RecoveryService } from "./recovery.js";

export interface ExecutionOrigin {parentStreamId:string;parentToolExecutionId?:string;dispatchId:string}
export type ExecutionRequest=(
 |{kind:"input";threadId:string;input:readonly MessageData[];model:ModelRef;origin?:ExecutionOrigin;context?:JsonObject;limits?:Partial<StreamLimits>}
 |{kind:"resume";threadId:string;interruptId:string;value:JsonValue;model?:ModelRef}
 |{kind:"recover";threadId:string;streamId:string;model?:ModelRef}
)&{signal?:AbortSignal};
export interface EngineOptions {backend:StorageBackend;registry:PluginHost;instructions?:Instruction;limits?:Partial<StreamLimits>;clock?:Clock;ids?:IdGenerator;agentId?:string;controllerId?:string;diagnostics?:(error:ErrorInfo)=>void}
export interface ExecutionFrame {
 heartbeat?:ReturnType<typeof setInterval>;ownershipError?:ErrorInfo;
 request:ExecutionRequest;sink:Attachment;registry:RegistryLease;lease:Lease;cp:Checkpoint;stream:StreamRecord;
 records:Map<string,RecordEntry>;state:PluginStateAccess;admitted:boolean;sequence:number;
}
export class AgentEngine {
 readonly backend:StorageBackend;readonly registry:PluginHost;readonly ids:IdGenerator;readonly clock:Clock;readonly limits:StreamLimits;readonly instructions:Instruction;
 private readonly jobs=new Set<Promise<void>>();private readonly active=new Map<string,ExecutionFrame>();private closed=false;
 private readonly resumeAdmissions=new Map<string,Promise<ExecutionFrame>>();
 constructor(readonly options:EngineOptions){this.backend=options.backend;this.registry=options.registry;this.ids=options.ids??randomIds;this.clock=options.clock??systemClock;this.instructions=options.instructions??normalizeInstruction();this.limits={maxTurns:32,maxModelAttempts:64,maxToolCalls:128,...options.limits};for(const limit of Object.values(this.limits))if(!Number.isInteger(limit)||limit<1)fail("InvalidConfiguration","Limits must be positive integers");}
 start(request:ExecutionRequest,target:DeliveryTarget={kind:"iterator"}):Stream {
  if(this.closed)fail("Disposed","Engine closed");
  const sink=createDelivery(request.threadId,this.ids,target,request.signal,this.options.diagnostics),registry=this.registry.capture();
  const job=Promise.resolve().then(()=>this.execute(request,sink,registry)).catch(error=>{sink.emit(AgentEvents.StreamError,{error:errorInfo(error),lastKnownCheckpointId:null,persistedStatus:null},{});sink.rejected(errorInfo(error));sink.close();});
  this.jobs.add(job);void job.then(()=>this.jobs.delete(job));return sink.stream;
 }
 protected async execute(request:ExecutionRequest,sink:Attachment,registry:RegistryLease):Promise<void> {
  let frame:ExecutionFrame|undefined;
  try {
   if(sink.controller.signal.aborted)fail("Cancelled","Execution cancelled before admission");
   if(request.kind==="resume"){
    frame=await this.prepareResume(request,sink,registry);this.active.set(frame.stream.id,frame);this.watchLease(frame);sink.admitted();
    await this.hook(frame,AgentEvents.StreamResumed,{checkpointId:frame.cp.id,interruptId:request.interruptId,reason:"response"});
    const cursor=frame.cp.execution!.handlerCursor;
    if(cursor?.eventId===AgentEvents.BeforeStream.id){const result=await this.hook(frame,AgentEvents.BeforeStream,cursor.payload as any);if(result?.decision==="deny"||result?.decision==="stop"){await this.finish(frame,"stopped",result.reason??"PolicyStopped");return;}}
    if(cursor?.eventId===AgentEvents.ModelRecover.id){const result=await this.hook(frame,AgentEvents.ModelRecover,cursor.payload as any);if(result?.decision!=="retry")fail("ProviderError","Recovery policy declined retry");frame.cp.execution!.phase="BeforeModel";await this.commit(frame,"ExecutionTransition");}
    await this.process(frame);return;
   }
   if(request.kind==="recover"){
    frame=await this.prepareRecovery(request,sink,registry);this.active.set(frame.stream.id,frame);this.watchLease(frame);sink.admitted();
    if(frame.cp.execution?.pendingInterruptId){const interrupt=await this.backend.executions.get("interrupts",frame.cp.execution.pendingInterruptId,{threadId:request.threadId});await this.hook(frame,AgentEvents.StreamSuspended,{checkpointId:frame.cp.id,interrupt:interrupt!});return;}
    await this.hook(frame,AgentEvents.StreamResumed,{checkpointId:frame.cp.id,interruptId:null,reason:"recovery"});await this.process(frame);return;
   }
   const head=await this.backend.threads.get(request.threadId);if(!head)fail("ThreadNotFound","Thread not found");if(head.activeStreamId)fail("ThreadBusy","Thread already has unfinished execution");
   const lease=await this.backend.ownership.acquire({threadId:request.threadId,ownerToken:this.ids.next("owner"),ttlMs:30000});
   const cp=structuredClone((await this.backend.checkpoints.get(head.currentCheckpointId))!);
   const streamId=this.ids.next("stream"),usage=aggregateUsage([]);
   const stream:StreamRecord={id:streamId,threadId:request.threadId,scope:head.scope,parentStreamId:request.origin?.parentStreamId??null,parentToolExecutionId:request.origin?.parentToolExecutionId??null,triggerMessageId:null,status:"running",stopReason:null,startedAt:this.clock.now(),endedAt:null,durationMs:null,error:null,directUsage:usage,inclusiveUsage:usage,outputMessageIds:[]};
   const records=new Map<string,RecordEntry>();for(const kind of ["streams","turns","model_attempts","tool_executions","interrupts","plugin_states"] as const)for(const row of await this.backend.executions.listRecords(kind,request.threadId))records.set(kind+":"+("id" in row?row.id:""),{kind,id:"id" in row?row.id:"",threadId:request.threadId,data:structuredClone(row)} as RecordEntry);
   const state=new PluginStateAccess(registry.list<PluginStateDefinition<any>>("state"),{type:"thread",id:request.threadId},cp.state.pluginStates,async()=>{await this.commit(frame!,"PluginStateCommitted");return frame!.cp.id;});
   frame={request,sink,registry,lease,cp,stream,records,state,admitted:false,sequence:0};this.put(frame,"streams",stream);
   sink.setId(streamId);this.active.set(streamId,frame);this.watchLease(frame);
   cp.execution={streamId,turnId:null,phase:"BeforeTurn",modelRef:request.model,baseInstructions:this.instructions,pendingToolExecutionIds:[],pendingInterruptId:null,handlerCursor:null,budgets:{turns:0,modelAttempts:0,toolCalls:0,limits:{...this.limits,...request.limits}},registryManifest:[...registry.values.map(r=>({pluginId:r.pluginId,kind:r.kind,id:r.id,version:r.version,requiredForContinuation:true})),...registry.handlers.map(r=>({pluginId:r.pluginId,kind:"handler",id:r.id,version:r.definition.version,requiredForContinuation:r.definition.kind!=="notification"}))],recordRevision:cp.revision};
   const input=await this.hook(frame,AgentEvents.InputPrepare,{messages:request.input});
   if(input.rejected)throw new TesseractError(input.rejected.code,input.rejected.message);
   for(const message of input.messages)cp.state={...cp.state,messages:[...cp.state.messages,await this.prepareMessage(frame,message)]};
   stream.triggerMessageId=input.messages[0]?.id??null;
   await this.commit(frame,"InputCommitted");frame.admitted=true;sink.admitted();
   await this.hook(frame,AgentEvents.StreamStarted,{modelRef:request.model,checkpointId:frame.cp.id});
   await this.hook(frame,AgentEvents.InputReceived,{messages:input.messages});
   if(input.handled){for(const message of input.handled.output)await this.appendMessage(frame,message);await this.finish(frame,"completed",null);return;}
   const before=await this.hook(frame,AgentEvents.BeforeStream,{input:input.messages});
   if(before?.decision==="deny"||before?.decision==="stop"){await this.finish(frame,"stopped",before.reason??"PolicyStopped");return;}
   await this.process(frame);
  }catch(error){
   if(error instanceof Suspension)return;
   if(frame?.ownershipError)error=new TesseractError("OwnershipLost","Execution ownership was lost");
   const info=errorInfo(error);
   if(frame?.admitted&&!["StorageUnavailable","CommitConflict","OwnershipLost","RecoveryRequired"].includes(info.code)){
    try{await this.finish(frame,sink.controller.signal.aborted?"cancelled":"failed",info.code,info);return;}catch(finalizeError){error=finalizeError;}
   }
   const finalError=errorInfo(error);sink.emit(AgentEvents.StreamError,{error:finalError,lastKnownCheckpointId:frame?.cp.id??null,persistedStatus:frame?.stream.status??null},this.eventContext(frame));sink.rejected(finalError);
  }finally{
   if(frame){if(frame.heartbeat)clearInterval(frame.heartbeat);this.active.delete(frame.stream.id);try{await this.backend.ownership.release(frame.lease);}catch{/* recovery uses lease expiry */}}
   await registry.release();sink.close();
  }
 }
 eventContext(frame?:ExecutionFrame):EventContext{return {agentId:this.options.agentId,controllerId:this.options.controllerId,...(frame?{scope:frame.cp.state.scope,streamId:frame.stream.id,threadId:frame.cp.threadId,sequence:++frame.sequence,timestamp:this.clock.now()}:{} )};}
 watchLease(frame:ExecutionFrame):void {
  if(frame.heartbeat)return;
  frame.heartbeat=setInterval(()=>{void this.backend.ownership.renew(frame.lease,30000).then(lease=>{frame.lease=lease;},error=>{frame.ownershipError=errorInfo(error);frame.sink.controller.abort("OwnershipLost");});},10000);
 }
 async hook<D extends AnyEvent>(frame:ExecutionFrame,definition:D,payload:PayloadOf<D>):Promise<ResultOf<D>> {
  const cursor=frame.cp.execution?.handlerCursor?.eventId===definition.id?frame.cp.execution.handlerCursor:null;
  const decisions:JsonValue[]=cursor?.decisions.slice()??[];
  const context={...this.eventContext(frame),signal:frame.sink.controller.signal,state:frame.state,context:frame.request.kind==="input"?frame.request.context:undefined,turnId:frame.cp.execution?.turnId,streamId:frame.stream.id,threadId:frame.cp.threadId,
   startIndex:cursor?.nextIndex??0,initialDecision:decisions.at(-1)??undefined,
   allowedHandlerIds:frame.cp.execution?.registryManifest.filter(r=>r.kind==="handler").map(r=>r.id),
   suspend:<R,P extends JsonValue>(def:InterruptionDefinition<R,ControlDecision,P>,data:P):ControlDecision=>{
    phaseForEvent(definition.id);
    const binding=frame.registry.find<{definition:InterruptionDefinition;pluginId:string}>("interruption",def.id);
    if(!binding||binding.definition.version!==def.version)fail("ResumeIncompatible","Interruption definition is not registered");
    return {decision:"suspend",definitionId:def.id,definitionVersion:def.version,pluginId:binding.pluginId,payload:immutable(def.payload?def.payload.parse(data):data) as JsonValue};
   },
   onDecision:definition.kind==="decision"?async(entry:{handlerId:string;index:number;decision:unknown})=>{
    const value=entry.decision as ControlDecision|undefined;decisions.push(value?immutable(value) as JsonValue:null);
    frame.cp.execution!.handlerCursor={eventId:definition.id,handlerId:entry.handlerId,nextIndex:entry.index+1,payload:immutable(cursor?.payload??payload) as JsonValue,decisions};
    if(value?.decision!=="suspend")await this.commit(frame,"ExecutionTransition");
   }:undefined
  };
  const value=await this.registry.dispatch(definition,payload,context,frame.registry);
  if(definition.kind==="decision"){
   if((value as ControlDecision|undefined)?.decision==="suspend")await this.suspend(frame,value as ControlDecision);
   if(frame.cp.execution?.handlerCursor?.eventId===definition.id)frame.cp.execution.handlerCursor=null;
  }
  if(definition.kind==="notification")frame.sink.emit(definition,payload,context);
  return value;
 }
 put(frame:ExecutionFrame,kind:RecordEntry["kind"],data:any):void{frame.records.set(kind+":"+data.id,{kind,id:data.id,threadId:frame.cp.threadId,data} as RecordEntry);}
 rows<T>(frame:ExecutionFrame,kind:RecordEntry["kind"]):T[]{return [...frame.records.values()].filter(r=>r.kind===kind).map(r=>r.data as T);}
 updateUsage(frame:ExecutionFrame):void {
  const attempts=this.rows<ModelAttemptRecord>(frame,"model_attempts");
  frame.stream.directUsage=aggregateUsage(attempts.filter(a=>a.streamId===frame.stream.id));frame.stream.inclusiveUsage=frame.stream.directUsage;
  for(const turn of this.rows<TurnRecord>(frame,"turns"))turn.usage=aggregateUsage(attempts.filter(a=>a.turnId===turn.id));
 }
 async commit(frame:ExecutionFrame,cause:CheckpointCause):Promise<void>{
  this.updateUsage(frame);
  const cp:Checkpoint={...frame.cp,id:this.ids.next("checkpoint"),parentCheckpointId:frame.cp.id,revision:frame.cp.revision+1,createdAt:this.clock.now(),cause,state:{...frame.cp.state,pluginStates:frame.state.snapshots()},execution:frame.cp.execution?{...frame.cp.execution,recordRevision:frame.cp.revision+1}:null};
  if(cause==="Suspended"&&cp.execution?.pendingInterruptId){const record=frame.records.get("interrupts:"+cp.execution.pendingInterruptId)!;if(record.kind==="interrupts"){record.data.checkpointId=cp.id;record.data.revision=cp.revision;}}
  try{await new CommitCoordinator(this.backend).commit({commitId:this.ids.next("commit"),threadId:cp.threadId,expectedRevision:frame.cp.revision,checkpoint:cp,records:[...frame.records.values()]},frame.lease);}
  catch(error){if(error instanceof TesseractError)throw error;throw new TesseractError("StorageUnavailable","Canonical state commit failed");}
  frame.cp={...structuredClone(cp),execution:frame.cp.execution};
  if(frame.cp.execution)frame.cp.execution.recordRevision=cp.revision;
  await this.hook(frame,AgentEvents.CheckpointCommitted,{checkpointId:cp.id,revision:cp.revision});
  await this.hook(frame,AgentEvents.ThreadUpdated,{checkpointId:cp.id,revision:cp.revision});
 }
 async prepareMessage(frame:ExecutionFrame,message:MessageData):Promise<MessageData>{
  const value=await this.hook(frame,AgentEvents.MessagePrepare,immutable(message));
  if(value.id!==message.id||value.role!==message.role||value.toolCallId!==message.toolCallId)fail("InvalidMessage","Message transform changed identity/role/correlation");
  const validated=MessageCodec.encode(MessageCodec.decode(value));
  await this.hook(frame,AgentEvents.MessageBeforeCommit,{message:validated});return validated;
 }
 async appendMessage(frame:ExecutionFrame,message:MessageData):Promise<void>{
  const value=await this.prepareMessage(frame,message);frame.cp.state={...frame.cp.state,messages:[...frame.cp.state.messages,value]};
  if(value.role==="assistant"||value.role==="tool")frame.stream.outputMessageIds=[...frame.stream.outputMessageIds,value.id];
  await this.commit(frame,"MessageCommitted");await this.hook(frame,AgentEvents.MessageCommitted,{message:value,checkpointId:frame.cp.id});
 }
 async process(frame:ExecutionFrame):Promise<void>{
  while(true){
   if(frame.sink.controller.signal.aborted)throw new TesseractError("Cancelled","Execution cancelled");
   const position=frame.cp.execution!;
   if(position.phase==="BeforeTurn"){
    if(position.budgets.turns>=position.budgets.limits.maxTurns){await this.finish(frame,"stopped","MaxTurns");return;}
    const turn:TurnRecord={id:this.ids.next("turn"),streamId:frame.stream.id,scope:frame.cp.state.scope,index:position.budgets.turns++,contextRevision:frame.cp.revision,assistantMessageId:null,status:"running",stopReason:null,startedAt:this.clock.now(),endedAt:null,durationMs:null,error:null,usage:aggregateUsage([])};
    this.put(frame,"turns",turn);position.turnId=turn.id;position.phase="BeforeModel";await this.commit(frame,"ExecutionTransition");await this.hook(frame,AgentEvents.TurnStart,{turnId:turn.id,index:turn.index});continue;
   }
   if(position.phase==="BeforeModel"){if(!await this.callModel(frame))return;continue;}
   if(position.phase==="BeforeTool"){await this.callTool(frame);if(frame.stream.endedAt)return;continue;}
   if(position.phase==="TurnBoundary"){
    const turn=this.rows<TurnRecord>(frame,"turns").find(t=>t.id===position.turnId)!;turn.status="completed";turn.endedAt=this.clock.now();this.updateUsage(frame);
    await this.hook(frame,AgentEvents.TurnEnd,{turnId:turn.id,usage:turn.usage});
    const hadTools=!!frame.cp.state.messages.find(m=>m.id===turn.assistantMessageId)?.content.some(p=>p.type==="tool-call");
    const decision=await this.hook(frame,AgentEvents.TurnDecision,{turnId:turn.id,hadTools});
    if(decision?.decision==="stop"||decision?.decision==="deny"){await this.finish(frame,"stopped",decision.reason??"PolicyStopped");return;}
    if(!hadTools&&decision?.decision!=="continue"){await this.finish(frame,"completed",null);return;}
    position.phase="BeforeTurn";await this.commit(frame,"ExecutionTransition");continue;
   }
   fail("RecoveryRequired","Execution is at a pending operation boundary");
  }
 }
 async callModel(frame:ExecutionFrame):Promise<boolean>{
  const position=frame.cp.execution!,budgets=position.budgets;
  if(budgets.modelAttempts>=budgets.limits.maxModelAttempts){await this.finish(frame,"stopped","MaxModelAttempts");return false;}
  const selection=await this.hook(frame,AgentEvents.ModelSelect,{model:position.modelRef});if(selection?.decision==="select")position.modelRef=selection.model;
  const provider=frame.registry.find<ModelProviderRegistration>("provider",position.modelRef.providerId);if(!provider)fail("MissingProvider","Model provider is not registered");
  const adapter=provider.create(position.modelRef.modelId);
  const tools=frame.registry.list<Tool>("tool"),descriptions:ToolDescription[]=tools.map(t=>({name:t.name,description:t.description,inputSchema:t.input.jsonSchema}));
  const selected=await this.hook(frame,AgentEvents.ToolsSelect,immutable(descriptions));
  if(selected.some(t=>!tools.some(tool=>tool.name===t.name)))fail("UnknownTool","Tool selection includes unregistered tool");
  let request=new ContextAssembler().build(frame.cp,position.baseInstructions,selected,position.modelRef);
  request=await this.hook(frame,AgentEvents.ContextPrepare,request);request=await this.hook(frame,AgentEvents.ModelRequest,immutable(request));
  if(request.model.providerId!==position.modelRef.providerId||request.model.modelId!==position.modelRef.modelId)fail("ModelContextIncompatible","Request transform must not bypass ModelSelect");
  adapter.validate(request);
  const attempt:ModelAttemptRecord={id:this.ids.next("attempt"),turnId:position.turnId!,streamId:frame.stream.id,scope:frame.cp.state.scope,callId:this.ids.next("call"),attemptIndex:0,purpose:"primary",parentToolExecutionId:null,providerId:position.modelRef.providerId,modelId:position.modelRef.modelId,providerRequestId:null,responseMessageId:null,contextRevision:frame.cp.revision,requestSnapshotRef:null,startedAt:this.clock.now(),firstOutputAt:null,endedAt:null,durationMs:null,timeToFirstOutputMs:null,status:"running",finishReason:null,error:null,usage:normalizeUsage({})};
  const priorAttempts=this.rows<ModelAttemptRecord>(frame,"model_attempts").filter(a=>a.turnId===position.turnId&&a.purpose==="primary");
  if(priorAttempts.length){attempt.callId=priorAttempts[0]!.callId;attempt.attemptIndex=priorAttempts.length;}
  this.put(frame,"model_attempts",attempt);budgets.modelAttempts++;position.phase="ModelPending";await this.commit(frame,"ExecutionTransition");await this.hook(frame,AgentEvents.ModelStart,{attemptId:attempt.id,model:position.modelRef});
  let response:ModelResponse|undefined;
  try{
   for await(const chunk of adapter.stream(immutable(request),{signal:frame.sink.controller.signal})){
    if(chunk.type==="message-delta"){if(!attempt.firstOutputAt)attempt.firstOutputAt=this.clock.now();await this.hook(frame,AgentEvents.MessageDelta,{...chunk,attemptId:attempt.id});}
    if(chunk.type==="usage"){attempt.usage=chunk.usage;await this.hook(frame,AgentEvents.ModelUsage,{attemptId:attempt.id,usage:chunk.usage});}
    if(chunk.type==="response")response=chunk.response;
   }
   if(!response)fail("ProviderError","Model stream ended without complete response");
   response=await this.hook(frame,AgentEvents.ModelResponse,response);
   if(response.message.role!=="assistant")fail("InvalidMessage","Model response must be assistant");
   attempt.usage=response.usage??attempt.usage;attempt.status="succeeded";attempt.endedAt=this.clock.now();attempt.finishReason=response.finishReason??null;attempt.providerRequestId=response.providerRequestId??null;attempt.responseMessageId=response.message.id;
   const turn=this.rows<TurnRecord>(frame,"turns").find(t=>t.id===position.turnId)!;turn.assistantMessageId=response.message.id;
   const pending:ToolExecutionRecord[]=[];
   for(const part of response.message.content)if(part.type==="tool-call")pending.push({id:this.ids.next("tool"),turnId:turn.id,streamId:frame.stream.id,scope:frame.cp.state.scope,toolCallId:part.toolCallId,parentToolExecutionId:null,toolName:part.name,arguments:part.arguments,policyDecision:null,status:"pending",startedAt:null,endedAt:null,durationMs:null,resultMessageId:null,resultRef:null,result:null,error:null,idempotencyKey:null});
   for(const record of pending)this.put(frame,"tool_executions",record);
   frame.cp.execution!.pendingToolExecutionIds=pending.map(t=>t.id);frame.cp.execution!.phase=pending.length?"BeforeTool":"TurnBoundary";
   await this.appendMessage(frame,response.message);await this.hook(frame,AgentEvents.ModelEnd,{attemptId:attempt.id,response});return true;
  }catch(error){
   if(attempt.status==="succeeded")throw error;
   attempt.status=frame.sink.controller.signal.aborted?"cancelled":"failed";attempt.error=errorInfo(error);attempt.endedAt=this.clock.now();await this.commit(frame,"ExecutionTransition");
   await this.hook(frame,AgentEvents.ModelError,{attemptId:attempt.id,error:attempt.error});
   const recovery=await this.hook(frame,AgentEvents.ModelRecover,{attemptId:attempt.id,error:attempt.error});
   if(recovery?.decision==="retry"&&!frame.sink.controller.signal.aborted){frame.cp.execution!.phase="BeforeModel";await this.commit(frame,"ExecutionTransition");return true;}throw error;
  }
 }
 async callTool(frame:ExecutionFrame):Promise<void>{
  const position=frame.cp.execution!,id=position.pendingToolExecutionIds[0];if(!id){position.phase="TurnBoundary";return;}
  const record=this.rows<ToolExecutionRecord>(frame,"tool_executions").find(t=>t.id===id)!;
  if(position.budgets.toolCalls>=position.budgets.limits.maxToolCalls){await this.finish(frame,"stopped","MaxToolCalls");return;}
  const tool=frame.registry.find<Tool>("tool",record.toolName);
  let result;
  try{
   if(!tool)fail("UnknownTool","No registered tool executor");
   const saved=position.handlerCursor?.eventId===AgentEvents.BeforeTool.id?position.handlerCursor.payload:null;
   const prepared=(saved??(record.policyDecision?.decision==="allowed"?{tool:{name:tool.name,description:tool.description,inputSchema:tool.input.jsonSchema},toolExecutionId:id,toolCallId:record.toolCallId,arguments:record.arguments}:await this.hook(frame,AgentEvents.ToolPrepare,{tool:{name:tool.name,description:tool.description,inputSchema:tool.input.jsonSchema},toolExecutionId:id,toolCallId:record.toolCallId,arguments:record.arguments}))) as ToolPreparation;
   record.arguments=immutable(prepared.arguments);tool.input.parse(record.arguments);
   const decision=record.policyDecision?.decision==="allowed"?{decision:"allow" as const}:await this.hook(frame,AgentEvents.BeforeTool,immutable(prepared));
   record.policyDecision={decision:decision?.decision==="deny"?"denied":"allowed",...(decision?.decision==="deny"&&decision.reason?{reason:decision.reason}:{})};
   if(decision?.decision==="deny"){record.status="denied";result=toolResult(decision.reason??"Tool denied");}
   else{
    record.status="running";record.startedAt=this.clock.now();record.idempotencyKey=tool.recovery?.idempotencyKey(tool.input.parse(record.arguments),{toolExecutionId:record.id})??null;position.budgets.toolCalls++;position.phase="ToolPending";await this.commit(frame,"ExecutionTransition");
    await this.hook(frame,AgentEvents.ToolStart,{toolExecutionId:id,toolCallId:record.toolCallId});
    result=await executeTool(tool,record.arguments,{signal:frame.sink.controller.signal,threadId:frame.cp.threadId,streamId:frame.stream.id,turnId:record.turnId,toolExecutionId:id,emit:progress=>{void this.hook(frame,AgentEvents.ToolUpdate,{toolExecutionId:id,progress});}});
    record.status="succeeded";
   }
  }catch(error){
   if(error instanceof Suspension)throw error;
   if(errorInfo(error).code==="RecoveryRequired"){record.status="interrupted";frame.stream.status="interrupted";await this.commit(frame,"ExecutionTransition");throw error;}
   if(["StorageUnavailable","CommitConflict","OwnershipLost"].includes(errorInfo(error).code))throw error;
   record.status="failed";record.error=errorInfo(error);result=toolResult("Tool failed: "+record.error.message);await this.hook(frame,AgentEvents.ToolError,{toolExecutionId:id,error:record.error});
  }
  result=await this.hook(frame,AgentEvents.ToolResult,result);
  record.result=result;record.endedAt=this.clock.now();
  const message=MessageCodec.encode(new ToolMessage({toolCallId:record.toolCallId,content:result.content,metadata:result.metadata}));record.resultMessageId=message.id;
  frame.cp.execution!.pendingToolExecutionIds=frame.cp.execution!.pendingToolExecutionIds.filter(value=>value!==id);frame.cp.execution!.phase=frame.cp.execution!.pendingToolExecutionIds.length?"BeforeTool":"TurnBoundary";
  await this.appendMessage(frame,message);await this.hook(frame,AgentEvents.ToolEnd,{toolExecutionId:id,toolCallId:record.toolCallId,result,status:record.status});
 }
 async restoreFrame(request:Extract<ExecutionRequest,{kind:"recover"}>,sink:Attachment,registry:RegistryLease,checkManifest=true):Promise<ExecutionFrame>{
  const head=await this.backend.threads.get(request.threadId);if(!head)fail("ThreadNotFound","Thread not found");
  const stored=await this.backend.executions.get("streams",request.streamId,{threadId:request.threadId});if(!stored)fail("StreamNotFound","Execution not found");
  if(["completed","failed","stopped","cancelled"].includes(stored.status))fail("AlreadyTerminal","Execution already ended");
  const cp=structuredClone((await this.backend.checkpoints.get(head.currentCheckpointId))!);
  if(cp.execution?.streamId!==request.streamId)fail("InvalidTransition","Execution is not current thread work");
  if(checkManifest)validateManifest(cp.execution.registryManifest,registry,request.model);
  const lease=await this.backend.ownership.acquire({threadId:request.threadId,ownerToken:this.ids.next("owner"),ttlMs:30000});
  try{
   const records=new Map<string,RecordEntry>();
   for(const kind of ["streams","turns","model_attempts","tool_executions","interrupts","plugin_states"] as const)for(const row of await this.backend.executions.listRecords(kind,request.threadId))records.set(kind+":"+("id" in row?row.id:""),{kind,id:"id" in row?row.id:"",threadId:request.threadId,data:structuredClone(row)} as RecordEntry);
   const stream=(records.get("streams:"+request.streamId) as {data:StreamRecord}).data;
   let frame!:ExecutionFrame;
   const state=new PluginStateAccess(registry.list<PluginStateDefinition<any>>("state"),{type:"thread",id:request.threadId},cp.state.pluginStates,async()=>{await this.commit(frame,"PluginStateCommitted");return frame.cp.id;});
   frame={request,sink,registry,lease,cp,stream,records,state,admitted:true,sequence:0};sink.setId(stream.id);
   if(request.model)cp.execution!.modelRef=request.model;
   return frame;
  }catch(error){await this.backend.ownership.release(lease);throw error;}
 }
 async prepareRecovery(request:Extract<ExecutionRequest,{kind:"recover"}>,sink:Attachment,registry:RegistryLease):Promise<ExecutionFrame>{
  const frame=await this.restoreFrame(request,sink,registry);
  try{
   const plan=new RecoveryService().plan(frame.cp,this.rows(frame,"model_attempts"),this.rows(frame,"tool_executions"));
   if(plan.kind==="pending-interrupt")return frame;
   frame.stream.status="interrupted";
   if(plan.kind==="incompatible")fail("ResumeIncompatible","Invalid recovery cursor");
   if(plan.kind==="model"){
    plan.attempt.status="interrupted";plan.attempt.endedAt=this.clock.now();plan.attempt.error={code:"InterruptedModelCall",message:"Provider outcome was not committed",retryable:true};
    await this.commit(frame,"ExecutionTransition");
    const decision=await this.hook(frame,AgentEvents.ModelRecover,{attemptId:plan.attempt.id,error:plan.attempt.error});
    if(decision?.decision!=="retry")fail("RecoveryRequired","Model retry requires an explicit recovery policy");
    frame.cp.execution!.phase="BeforeModel";
   }
   if(plan.kind==="tool"){
    const record=plan.tool;record.status="interrupted";await this.commit(frame,"ExecutionTransition");
    const tool=registry.find<Tool>("tool",record.toolName);
    const result=tool?.recovery&&record.idempotencyKey?await tool.recovery.reconcile({id:record.id,input:tool.input.parse(record.arguments),key:record.idempotencyKey}):{status:"unknown" as const};
    if(result.status==="unknown")fail("RecoveryRequired","Tool dispatch outcome is unknown");
    if(result.status==="safeToRetry"){record.status="pending";frame.cp.execution!.phase="BeforeTool";}
    if(result.status==="completed"){
     const transformed=await this.hook(frame,AgentEvents.ToolResult,result.result),message=MessageCodec.encode(new ToolMessage({toolCallId:record.toolCallId,content:transformed.content,metadata:transformed.metadata}));
     record.status="succeeded";record.result=transformed;record.resultMessageId=message.id;record.endedAt=this.clock.now();
     frame.cp.execution!.pendingToolExecutionIds=frame.cp.execution!.pendingToolExecutionIds.filter(id=>id!==record.id);
     frame.cp.execution!.phase=frame.cp.execution!.pendingToolExecutionIds.length?"BeforeTool":"TurnBoundary";
     await this.appendMessage(frame,message);
    }
   }
   frame.stream.status="running";await this.commit(frame,"Resumed");return frame;
  }catch(error){await this.backend.ownership.release(frame.lease);throw error;}
 }
 async suspend(frame:ExecutionFrame,decision:ControlDecision):Promise<never>{
  if(decision.decision!=="suspend")fail("InvalidTransition","Expected suspension decision");
  const binding=frame.registry.find<{definition:InterruptionDefinition;pluginId:string}>("interruption",decision.definitionId)!;
  const position=frame.cp.execution!,id=this.ids.next("interrupt");
  const tool=position.pendingToolExecutionIds[0]?this.rows<ToolExecutionRecord>(frame,"tool_executions").find(t=>t.id===position.pendingToolExecutionIds[0]):null;
  const interrupt={id,threadId:frame.cp.threadId,streamId:frame.stream.id,checkpointId:frame.cp.id,definitionId:decision.definitionId,definitionVersion:decision.definitionVersion,pluginId:decision.pluginId,payload:decision.payload,responseSchema:binding.definition.response.jsonSchema,actionRef:tool?{toolExecutionId:tool.id,toolName:tool.toolName,argumentsDigest:canonicalJson(tool.arguments)}:null,status:"pending" as const,response:null,resolvedDecision:null,createdAt:this.clock.now(),resolvedAt:null,revision:frame.cp.revision};
  this.put(frame,"interrupts",interrupt);position.pendingInterruptId=id;position.phase="Suspended";frame.stream.status="suspended";
  await this.commit(frame,"Suspended");
  await this.hook(frame,AgentEvents.StreamSuspended,{checkpointId:frame.cp.id,interrupt});
  throw new Suspension();
 }
 async prepareResume(request:Extract<ExecutionRequest,{kind:"resume"}>,sink:Attachment,registry:RegistryLease):Promise<ExecutionFrame>{
  const existing=this.resumeAdmissions.get(request.interruptId);
  if(existing){await existing;fail("AlreadyResumed","Another response was already committed");}
  const pending=this.prepareResumeFrame(request,sink,registry);this.resumeAdmissions.set(request.interruptId,pending);
  try{return await pending;}finally{this.resumeAdmissions.delete(request.interruptId);}
 }
 private async prepareResumeFrame(request:Extract<ExecutionRequest,{kind:"resume"}>,sink:Attachment,registry:RegistryLease):Promise<ExecutionFrame>{
  await validateResume(this.backend,registry,request.threadId,request.interruptId,request.value);
  const head=await this.backend.threads.get(request.threadId);if(!head)fail("ThreadNotFound","Thread not found");
  const stored=(await this.backend.checkpoints.get(head.currentCheckpointId))!;
  if(!stored.execution||stored.execution.pendingInterruptId!==request.interruptId)fail("InvalidTransition","Thread is not waiting for this interruption");
  validateManifest(stored.execution.registryManifest,registry,request.model);
  const lease=await this.backend.ownership.acquire({threadId:request.threadId,ownerToken:this.ids.next("owner"),ttlMs:30000});
  try{
   const {interrupt,decision}=await validateResume(this.backend,registry,request.threadId,request.interruptId,request.value);
   const cp=structuredClone(stored),records=new Map<string,RecordEntry>();
   for(const kind of ["streams","turns","model_attempts","tool_executions","interrupts","plugin_states"] as const)for(const row of await this.backend.executions.listRecords(kind,request.threadId))records.set(kind+":"+("id" in row?row.id:""),{kind,id:"id" in row?row.id:"",threadId:request.threadId,data:structuredClone(row)} as RecordEntry);
   const stream=(records.get("streams:"+interrupt.streamId) as {data:StreamRecord}).data;
   if(interrupt.actionRef?.toolExecutionId){const tool=this.rows<ToolExecutionRecord>({records} as ExecutionFrame,"tool_executions").find(t=>t.id===interrupt.actionRef!.toolExecutionId);if(!tool||canonicalJson(tool.arguments)!==interrupt.actionRef.argumentsDigest)fail("ResumeIncompatible","Pending operation payload changed");}
   let frame!:ExecutionFrame;
   const state=new PluginStateAccess(registry.list<PluginStateDefinition<any>>("state"),{type:"thread",id:request.threadId},cp.state.pluginStates,async()=>{await this.commit(frame,"PluginStateCommitted");return frame.cp.id;});
   frame={request,sink,registry,lease,cp,stream,records,state,admitted:true,sequence:0};
   const position=cp.execution!,cursor=position.handlerCursor;if(!cursor)fail("ResumeIncompatible","Missing continuation cursor");
   const previous=cursor.decisions.at(-2) as ControlDecision|undefined;
   const resolved=previous&&["deny","stop"].includes(previous.decision)?previous:decision;
   cursor.decisions=[...cursor.decisions.slice(0,-1),resolved as unknown as JsonValue];
   position.phase=phaseForEvent(cursor.eventId);position.pendingInterruptId=null;
   if(request.model){position.modelRef=request.model;position.registryManifest=position.registryManifest.filter(r=>r.kind!=="provider");const provider=registry.values.find(r=>r.kind==="provider"&&r.id===request.model!.providerId);if(!provider)fail("MissingProvider","Override model provider missing");position.registryManifest=[...position.registryManifest,{pluginId:provider.pluginId,kind:provider.kind,id:provider.id,version:provider.version,requiredForContinuation:true}];}
   stream.status="running";
   this.put(frame,"interrupts",{...interrupt,status:"resolved",response:request.value,resolvedDecision:resolved as unknown as JsonValue,resolvedAt:this.clock.now(),revision:cp.revision+1});
   sink.setId(stream.id);await this.commit(frame,"Resumed");return frame;
  }catch(error){await this.backend.ownership.release(lease);throw error;}
 }
 async finish(frame:ExecutionFrame,status:"completed"|"stopped"|"failed"|"cancelled",reason:string|null,error:ErrorInfo|null=null):Promise<void>{
  const pending=new Set<string>();for(const message of frame.cp.state.messages){for(const part of message.content)if(part.type==="tool-call")pending.add(part.toolCallId);if(message.role==="tool")pending.delete(message.toolCallId!);}
  for(const toolCallId of pending){const message=MessageCodec.encode(new ToolMessage({toolCallId,content:"Execution "+status}));frame.cp.state={...frame.cp.state,messages:[...frame.cp.state.messages,message]};frame.stream.outputMessageIds=[...frame.stream.outputMessageIds,message.id];const tool=this.rows<ToolExecutionRecord>(frame,"tool_executions").find(t=>t.toolCallId===toolCallId&&t.streamId===frame.stream.id);if(tool&&tool.status==="pending"){tool.status="cancelled";tool.resultMessageId=message.id;tool.endedAt=this.clock.now();}}
  frame.stream.status=status;frame.stream.stopReason=reason;frame.stream.error=error;frame.stream.endedAt=this.clock.now();this.updateUsage(frame);
  let outcome:StreamOutcome={status,reason,output:frame.cp.state.messages.filter(m=>frame.stream.outputMessageIds.includes(m.id)),usage:frame.stream.directUsage,error,interrupt:null};
  try{await this.hook(frame,AgentEvents.StreamBeforeEnd,immutable(outcome));}catch(finalizationError){
    if(!error&&status!=="cancelled"){status="failed";error=errorInfo(finalizationError);reason="FinalizationFailed";frame.stream.status=status;frame.stream.error=error;frame.stream.stopReason=reason;outcome={...outcome,status,error,reason};}
  }
  frame.cp.execution=null;await this.commit(frame,"Terminal");await this.hook(frame,AgentEvents.StreamEnd,immutable(outcome));
 }
 async cancel(threadId:string,streamId:string,reason="Cancelled",target:DeliveryTarget={kind:"observer",observe:()=>{}}):Promise<void>{
  const active=this.active.get(streamId);
  if(active){if(active.cp.threadId!==threadId)fail("InvalidTransition","Execution belongs to a different thread");await this.hook(active,AgentEvents.StreamCancel,{reason});active.sink.controller.abort(reason);return;}
  const registry=this.registry.capture(),sink=createDelivery(threadId,this.ids,target,undefined,this.options.diagnostics);
  let frame:ExecutionFrame|undefined;
  try{
   frame=await this.restoreFrame({kind:"recover",threadId,streamId},sink,registry,false);this.watchLease(frame);
   if(frame.cp.execution?.phase==="ToolPending"){
    const toolRecord=this.rows<ToolExecutionRecord>(frame,"tool_executions").find(t=>t.id===frame!.cp.execution!.pendingToolExecutionIds[0])!;
    const tool=registry.find<Tool>("tool",toolRecord.toolName);
    const outcome=tool?.recovery&&toolRecord.idempotencyKey?await tool.recovery.reconcile({id:toolRecord.id,input:tool.input.parse(toolRecord.arguments),key:toolRecord.idempotencyKey}):{status:"unknown" as const};
    if(outcome.status==="unknown"){frame.stream.status="interrupted";toolRecord.status="interrupted";await this.commit(frame,"ExecutionTransition");fail("RecoveryRequired","Cannot close unknown external tool outcome");}
    if(outcome.status==="completed"){toolRecord.status="succeeded";toolRecord.result=outcome.result;const message=MessageCodec.encode(new ToolMessage({toolCallId:toolRecord.toolCallId,content:outcome.result.content}));toolRecord.resultMessageId=message.id;await this.appendMessage(frame,message);}
    else toolRecord.status="pending";
   }
   for(const interrupt of this.rows<import("../state/schema.js").InterruptRecord>(frame,"interrupts"))if(interrupt.streamId===streamId&&interrupt.status==="pending"){interrupt.status="cancelled";interrupt.resolvedAt=this.clock.now();}
   for(const attempt of this.rows<ModelAttemptRecord>(frame,"model_attempts"))if(attempt.streamId===streamId&&attempt.status==="running"){attempt.status="cancelled";attempt.endedAt=this.clock.now();}
   await this.hook(frame,AgentEvents.StreamCancel,{reason});await this.finish(frame,"cancelled",reason);
  }finally{if(frame){if(frame.heartbeat)clearInterval(frame.heartbeat);await this.backend.ownership.release(frame.lease);}await registry.release();sink.close();}
 }
 async shutdown():Promise<void>{this.closed=true;for(const frame of this.active.values())frame.sink.controller.abort("Controller disposed");await Promise.allSettled([...this.jobs]);}
}
