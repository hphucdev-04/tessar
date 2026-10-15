import { defineEvent } from "./definition.js";
import type { JsonObject,JsonValue } from "../json.js";
import type { MessageData } from "../messages/message.js";
import type { ModelRef,ModelRequest,ModelResponse,ToolDescription } from "../models/contract.js";
import type { ErrorInfo } from "../errors.js";
import type { ModelUsage,UsageSummary } from "../trace/usage.js";
import type { ToolResult as ToolResultData } from "../tools/tool.js";
import type { InterruptRecord,ThreadInfo } from "../state/schema.js";
import type { CreateThreadOptions } from "../state/threads.js";
const notification=<P>(name:string)=>defineEvent<P,void,"notification">({id:"core."+name,owner:"core",version:1,kind:"notification"});
const transform=<P>(name:string)=>defineEvent<P,P,"transformation">({id:"core."+name,owner:"core",version:1,kind:"transformation"});
const decision=<P,R=ControlDecision>(name:string)=>defineEvent<P,R,"decision">({id:"core."+name,owner:"core",version:1,kind:"decision"});
const barrier=<P>(name:string)=>defineEvent<P,void,"barrier">({id:"core."+name,owner:"core",version:1,kind:"barrier"});
export type ControlDecision={decision:"allow"|"deny"|"continue"|"stop"|"retry"|"fail";reason?:string}|{decision:"select";model:ModelRef}|{decision:"suspend";definitionId:string;payload:JsonValue;pluginId:string;definitionVersion:number};
export interface InputPreparation {messages:readonly MessageData[];handled?:{output:readonly MessageData[]};rejected?:ErrorInfo}
export interface ToolPreparation {tool:ToolDescription;toolCallId:string;toolExecutionId:string;arguments:JsonObject}
export interface StreamOutcome {status:string;reason:string|null;output:readonly MessageData[];usage:UsageSummary;error:ErrorInfo|null;interrupt:InterruptRecord|null}
export const AgentEvents={
 Ready:notification<{agentId:string}>("ready"),Shutdown:barrier<{}>("shutdown"),
 ThreadPrepare:transform<CreateThreadOptions>("thread.prepare"),ThreadStarted:notification<ThreadInfo>("thread.started"),ThreadBeforeShutdown:barrier<{threadId:string}>("thread.before-shutdown"),ThreadShutdown:notification<{threadId:string}>("thread.shutdown"),
 ThreadUpdated:notification<{checkpointId:string;revision:number}>("thread.updated"),
 InputPrepare:transform<InputPreparation>("input.prepare"),InputReceived:notification<{messages:readonly MessageData[]}>("input.received"),
 BeforeStream:decision<{input:readonly MessageData[]}>("stream.before"),StreamStarted:notification<{modelRef:ModelRef;checkpointId:string}>("stream.started"),
 StreamBeforeEnd:barrier<StreamOutcome>("stream.before-end"),StreamEnd:notification<StreamOutcome>("stream.end"),
 StreamError:notification<{error:ErrorInfo;lastKnownCheckpointId:string|null;persistedStatus:string|null}>("stream.error"),
 StreamSuspended:notification<{checkpointId:string;interrupt:InterruptRecord}>("stream.suspended"),StreamResumed:notification<{checkpointId:string;interruptId:string|null;reason:string}>("stream.resumed"),
 TurnStart:notification<{turnId:string;index:number}>("turn.start"),TurnEnd:notification<{turnId:string;usage:UsageSummary}>("turn.end"),
 TurnDecision:decision<{turnId:string;hadTools:boolean}>("turn.decision"),
 ContextPrepare:transform<ModelRequest>("context.prepare"),ToolsSelect:transform<readonly ToolDescription[]>("tools.select"),ModelSelect:decision<{model:ModelRef}>("model.select"),
 ModelRequest:transform<ModelRequest>("model.request"),ModelStart:notification<{attemptId:string;model:ModelRef}>("model.start"),
 ModelEnd:notification<{attemptId:string;response:ModelResponse}>("model.end"),ModelResponse:transform<ModelResponse>("model.response"),
 ModelUsage:notification<{attemptId:string;usage:ModelUsage}>("model.usage"),ModelError:notification<{attemptId:string;error:ErrorInfo}>("model.error"),
 ModelRecover:decision<{attemptId:string;error:ErrorInfo}>("model.recover"),
 MessagePrepare:transform<MessageData>("message.prepare"),MessageBeforeCommit:barrier<{message:MessageData}>("message.before-commit"),
 MessageDelta:notification<{messageId:string;partId:string;partKind:"text"|"reasoning";delta:string;attemptId:string}>("message.delta"),
 MessageCommitted:notification<{message:MessageData;checkpointId:string}>("message.committed"),
 ToolPrepare:transform<ToolPreparation>("tool.prepare"),BeforeTool:decision<ToolPreparation>("tool.before"),
 ToolStart:notification<{toolExecutionId:string;toolCallId:string}>("tool.start"),ToolUpdate:notification<{toolExecutionId:string;progress:JsonValue}>("tool.update"),
 ToolEnd:notification<{toolExecutionId:string;toolCallId:string;result:ToolResultData;status:string}>("tool.end"),ToolError:notification<{toolExecutionId:string;error:ErrorInfo}>("tool.error"),
 ToolResult:transform<ToolResultData>("tool.result"),StreamCancel:notification<{reason:string}>("stream.cancel"),
 CheckpointCommitted:notification<{checkpointId:string;revision:number}>("checkpoint.committed"),
} as const;
export const ToolDecision={allow:():ControlDecision=>({decision:"allow"}),deny:(reason:string):ControlDecision=>({decision:"deny",reason})};
export const TurnDecision={continue:():ControlDecision=>({decision:"continue"}),stop:(reason:string):ControlDecision=>({decision:"stop",reason})};
export const InputDecision={continue:(messages:readonly MessageData[]):InputPreparation=>({messages}),handled:(outcome:{output:readonly MessageData[]}):InputPreparation=>({messages:[],handled:outcome}),reject:(error:ErrorInfo):InputPreparation=>({messages:[],rejected:error})};
