import { fail } from "../errors.js";
import { canonicalJson } from "./commit.js";
import { MessageCodec } from "../messages/codec.js";
import type { Message } from "../messages/message.js";
import type { StorageBackend } from "./storage-ports.js";
import type { Checkpoint,Page,PageOptions,StateQuery,ThreadInfo,RecordKind,RecordTypes } from "./schema.js";
import { matchesScope } from "./scope.js";
export interface HistoryOptions extends PageOptions {atCheckpointId?:string}
export interface HistoryPage extends Page<Message>{checkpointId:string;revision:number}
export interface CheckpointInfo {id:string;threadId:string;revision:number;createdAt:string;cause:string;forkable:boolean;unsafeReason:string|null}
export function checkpointSafety(cp:Checkpoint):{forkable:boolean;unsafeReason:string|null} {
  const pending=new Set<string>();
  for(const message of cp.state.messages){for(const part of message.content)if(part.type==="tool-call")pending.add(part.toolCallId);if(message.role==="tool")pending.delete(message.toolCallId!);}
  return pending.size?{forkable:false,unsafeReason:"UnresolvedToolCalls"}:{forkable:true,unsafeReason:null};
}
function limitOf(limit=50):number {if(!Number.isInteger(limit)||limit<1||limit>200)fail("InvalidConfiguration","Page limit must be 1..200");return limit;}
export function encodeCursor(value:unknown):string{return encodeURIComponent(JSON.stringify(value));}
export function decodeCursor(value:string):any {try{return JSON.parse(decodeURIComponent(value));}catch{fail("InvalidCursor","Malformed cursor");}}
export function pageRows<T extends {id:string}>(rows:readonly T[],options:PageOptions={},binding=""):Page<T> {
  const key=(row:T)=>{const dated=row as T&{createdAt?:string;startedAt?:string};return (dated.createdAt??dated.startedAt??"")+"\u0000"+row.id;};
  const limit=limitOf(options.limit),sorted=rows.slice().sort((a,b)=>key(a).localeCompare(key(b)));
  let index=0;
  if(options.cursor){const cursor=decodeCursor(options.cursor);if(cursor.binding!==binding||cursor.v!==1)fail("InvalidCursor","Cursor belongs to another query");index=sorted.findIndex(r=>key(r)>cursor.after);if(index<0)index=sorted.length;}
  const items=sorted.slice(index,index+limit);return {items,nextCursor:index+limit<sorted.length?encodeCursor({v:1,binding,after:key(items.at(-1)!)}):null};
}
export class StateQueries {
  constructor(readonly backend:StorageBackend) {}
  async getThread(id:string,query:StateQuery={}):Promise<ThreadInfo|null>{const info=await this.backend.threads.get(id);return info&&matchesScope(info.scope,query.scope)?info:null;}
  async requireThread(id:string,query:StateQuery={}):Promise<ThreadInfo>{const info=await this.getThread(id,query);if(!info)fail("ThreadNotFound","Thread does not match query");return info;}
  async listThreads(query:StateQuery&PageOptions={}):Promise<Page<ThreadInfo>>{const rows=(await this.backend.threads.list()).filter(r=>matchesScope(r.scope,query.scope));return pageRows(rows,query,canonicalJson(query.scope??{}));}
  async snapshot(id:string,query:StateQuery={}):Promise<Checkpoint>{const info=await this.requireThread(id,query);return (await this.backend.checkpoints.get(info.currentCheckpointId))!;}
  async getHistory(id:string,options:HistoryOptions={},query:StateQuery={}):Promise<HistoryPage>{
    const head=await this.requireThread(id,query),limit=limitOf(options.limit),binding=canonicalJson({threadId:id,scope:query.scope??{}});
    const cursor=options.cursor?decodeCursor(options.cursor):null;
    if(cursor&&(cursor.v!==1||cursor.binding!==binding||(options.atCheckpointId&&options.atCheckpointId!==cursor.checkpointId)))fail("InvalidCursor","History cursor mismatch");
    const cp=await this.backend.checkpoints.get(cursor?.checkpointId??options.atCheckpointId??head.currentCheckpointId);
    if(!cp||cp.threadId!==id)fail("CheckpointNotFound","No checkpoint for history");
    const end=cursor?.end??cp.state.messages.length;
    if(!Number.isInteger(end)||end<0||end>cp.state.messages.length)fail("InvalidCursor","Invalid history position");
    const begin=Math.max(0,end-limit),items=Object.freeze(cp.state.messages.slice(begin,end).map(m=>MessageCodec.decode(m)));
    return {items,checkpointId:cp.id,revision:cp.revision,nextCursor:begin>0?encodeCursor({v:1,binding,checkpointId:cp.id,end:begin}):null};
  }
  async getCheckpoint(threadId:string,id:string,query:StateQuery={}):Promise<Checkpoint|null>{await this.requireThread(threadId,query);const cp=await this.backend.checkpoints.get(id);return cp?.threadId===threadId?cp:null;}
  async listCheckpoints(threadId:string,options:PageOptions={},query:StateQuery={}):Promise<Page<CheckpointInfo>>{await this.requireThread(threadId,query);return pageRows((await this.backend.checkpoints.list(threadId)).map(cp=>({id:cp.id,threadId,revision:cp.revision,createdAt:cp.createdAt,cause:cp.cause,...checkpointSafety(cp)})),options,"checkpoints:"+threadId);}
  async getRecord<K extends RecordKind>(kind:K,threadId:string,id:string,query:StateQuery={}):Promise<RecordTypes[K]|null>{await this.requireThread(threadId,query);return this.backend.executions.get(kind,id,{threadId});}
  async listRecords<K extends RecordKind>(kind:K,threadId:string,options:PageOptions={},query:StateQuery={}):Promise<Page<RecordTypes[K]>>{await this.requireThread(threadId,query);const rows=await this.backend.executions.listRecords(kind,threadId);return pageRows(rows as (RecordTypes[K]&{id:string})[],options,kind+":"+threadId);}
  getStream=(threadId:string,id:string,query?:StateQuery)=>this.getRecord("streams",threadId,id,query);
  getInterrupt=(threadId:string,id:string,query?:StateQuery)=>this.getRecord("interrupts",threadId,id,query);
  listStreams=(threadId:string,options?:PageOptions,query?:StateQuery)=>this.listRecords("streams",threadId,options,query);
  async listTurns(threadId:string,streamId:string,options:PageOptions={},query:StateQuery={}){await this.requireThread(threadId,query);return pageRows((await this.backend.executions.listRecords("turns",threadId)).filter(r=>r.streamId===streamId),options,"turns:"+streamId);}
  async listModelAttempts(threadId:string,turnId:string,options:PageOptions={},query:StateQuery={}){await this.requireThread(threadId,query);return pageRows((await this.backend.executions.listRecords("model_attempts",threadId)).filter(r=>r.turnId===turnId),options,"attempts:"+turnId);}
  async listToolExecutions(threadId:string,turnId:string,options:PageOptions={},query:StateQuery={}){await this.requireThread(threadId,query);return pageRows((await this.backend.executions.listRecords("tool_executions",threadId)).filter(r=>r.turnId===turnId),options,"tools:"+turnId);}
  async listInterrupts(threadId:string,options:PageOptions&{status?:string}={},query:StateQuery={}){await this.requireThread(threadId,query);return pageRows((await this.backend.executions.listRecords("interrupts",threadId)).filter(r=>!options.status||r.status===options.status),options,"interrupts:"+threadId+":"+options.status);}
}
