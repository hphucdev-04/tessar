import { DatabaseSync } from "node:sqlite";
import { canonicalJson,validateBatch,fail,immutable,matchesScope,type CommitBatch,type CommitReceipt,type StorageBackend,type ThreadInfo,type Checkpoint,type RecordKind,type RecordTypes,type RecordEntry,type PluginStateSnapshot } from "@tesseract/core";
import { initializeSchema,recordTables } from "./schema.js";
import { assertOwnership,createOwnership,transaction } from "./ownership.js";
export async function createSqliteBackend(options:{filename:string}):Promise<StorageBackend> {
 const db=new DatabaseSync(options.filename);try{await initializeSchema(db);}catch(error){db.close();throw error;}
 let closed=false;
 const getJson=<T>(sql:string,...values:(string|number)[]):T|null=>{const row=db.prepare(sql).get(...values) as {body:string}|undefined;return row?immutable(JSON.parse(row.body)) as T:null;};
 const head=(id:string)=>getJson<ThreadInfo>("SELECT body FROM threads WHERE id=?",id);
 const records=(kind:RecordKind,threadId:string,cp?:string)=>{const checkpointId=cp??head(threadId)?.currentCheckpointId;if(!checkpointId)return [];return (db.prepare("SELECT body FROM "+kind+" WHERE thread_id=? AND checkpoint_id=?").all(threadId,checkpointId) as {body:string}[]).map(row=>immutable(JSON.parse(row.body)));};
 const ownerKey=(key:Pick<PluginStateSnapshot,"ownerType"|"ownerId"|"pluginId"|"namespace">)=>canonicalJson([key.ownerType,key.ownerId,key.pluginId,key.namespace]);
 return {
  id:"sqlite",capabilities:{durable:true,atomicPublish:true,coordination:"multi-process"},
  threads:{
   get:async id=>{const value=head(id);return value&&!value.deleted?value:null;},
   list:async query=>(db.prepare("SELECT body FROM threads").all() as {body:string}[]).map(r=>immutable(JSON.parse(r.body)) as ThreadInfo).filter(r=>!r.deleted&&matchesScope(r.scope,query?.scope))
  },
  checkpoints:{
   get:async id=>getJson<Checkpoint>("SELECT body FROM checkpoints WHERE id=?",id),
   list:async threadId=>(db.prepare("SELECT body FROM checkpoints WHERE thread_id=? ORDER BY revision").all(threadId) as {body:string}[]).map(r=>immutable(JSON.parse(r.body)) as Checkpoint)
  },
  executions:{
   get:async<K extends RecordKind>(kind:K,id:string,query?:{threadId?:string;atCheckpointId?:string})=>{
    if(!recordTables.includes(kind))fail("InvalidConfiguration","Unknown record kind");
    if(query?.threadId)return (records(kind,query.threadId,query.atCheckpointId).find((r:any)=>r.id===id)??null) as RecordTypes[K]|null;
    if(query?.atCheckpointId)return getJson<RecordTypes[K]>("SELECT body FROM "+kind+" WHERE checkpoint_id=? AND id=?",query.atCheckpointId,id);
    const rows=db.prepare("SELECT r.body FROM "+kind+" r JOIN threads t ON r.thread_id=t.id WHERE r.id=? AND r.checkpoint_id=json_extract(t.body,'$.currentCheckpointId')").get(id) as {body:string}|undefined;
    return rows?immutable(JSON.parse(rows.body)) as RecordTypes[K]:null;
   },
   listRecords:async<K extends RecordKind>(kind:K,threadId:string,query?:{atCheckpointId?:string})=>records(kind,threadId,query?.atCheckpointId) as RecordTypes[K][]
  },
  ownedState:{
   get:async key=>getJson<PluginStateSnapshot>("SELECT body FROM owned_states WHERE owner_key=?",ownerKey(key)),
   compareAndSet:async(state,expected)=>transaction(db,()=>{
    if(!["agent","session"].includes(state.ownerType))fail("InvalidConfiguration","Execution state must use checkpoints");
    const key=ownerKey(state),old=getJson<PluginStateSnapshot>("SELECT body FROM owned_states WHERE owner_key=?",key);
    if((old?.revision??0)!==expected||state.revision!==expected+1)fail("CommitConflict","Owned state revision changed");
    db.prepare("INSERT INTO owned_states VALUES(?,?,?) ON CONFLICT(owner_key) DO UPDATE SET revision=excluded.revision,body=excluded.body").run(key,state.revision,canonicalJson(state));
   })
  },
  ownership:createOwnership(db),
  commits:{
   stage:async batch=>{validateBatch(batch);transaction(db,()=>{const old=getJson<CommitBatch>("SELECT body FROM staging WHERE id=?",batch.commitId);if(old&&canonicalJson(old)!==canonicalJson(batch))fail("CommitConflict","commitId payload mismatch");if(!old)db.prepare("INSERT INTO staging VALUES(?,?)").run(batch.commitId,canonicalJson(batch));});},
   lookupCommit:async id=>getJson<CommitReceipt>("SELECT body FROM commits WHERE id=?",id),
   publish:async request=>transaction(db,()=>{
    const prior=getJson<CommitReceipt>("SELECT body FROM commits WHERE id=?",request.commitId);if(prior)return prior;
    assertOwnership(db,request.lease);
    const batch=getJson<CommitBatch>("SELECT body FROM staging WHERE id=?",request.commitId);
    if(!batch||batch.threadId!==request.threadId||batch.expectedRevision!==request.expectedRevision)fail("CommitConflict","Missing staged batch");
    const old=head(batch.threadId),cp=batch.checkpoint;
    if((old?.revision??0)!==batch.expectedRevision||old?.deleted||cp.parentCheckpointId!==(old?.currentCheckpointId??null))fail("CommitConflict","Head changed");
    const merged=new Map<string,RecordEntry>();
    for(const kind of recordTables)for(const data of records(kind,batch.threadId))merged.set(kind+":"+data.id,{kind,id:data.id,threadId:batch.threadId,data} as RecordEntry);
    for(const entry of batch.records)merged.set(entry.kind+":"+entry.id,entry);
    if(cp.execution&&!merged.has("streams:"+cp.execution.streamId))fail("CommitConflict","Missing stream reference");
    if(cp.execution?.pendingInterruptId&&!merged.has("interrupts:"+cp.execution.pendingInterruptId))fail("CommitConflict","Missing interrupt reference");
    db.prepare("INSERT INTO checkpoints VALUES(?,?,?,?)").run(cp.id,cp.threadId,cp.revision,canonicalJson(cp));
    for(const entry of merged.values())db.prepare("INSERT INTO "+entry.kind+" VALUES(?,?,?,?)").run(batch.threadId,cp.id,entry.id,canonicalJson(entry.data));
    cp.state.messages.forEach((message,position)=>db.prepare("INSERT INTO messages VALUES(?,?,?,?,?)").run(cp.threadId,cp.id,message.id,position,canonicalJson(message)));
    const stream=cp.execution?merged.get("streams:"+cp.execution.streamId)?.data as RecordTypes["streams"]:null;
    const info:ThreadInfo={id:batch.threadId,scope:cp.state.scope,metadata:cp.state.metadata,revision:cp.revision,currentCheckpointId:cp.id,activeStreamId:stream&&!["completed","failed","stopped","cancelled"].includes(stream.status)?stream.id:null,createdAt:old?.createdAt??cp.createdAt,updatedAt:cp.createdAt,parentThreadId:batch.lineage?.parentThreadId??old?.parentThreadId??null,sourceCheckpointId:batch.lineage?.sourceCheckpointId??old?.sourceCheckpointId??null,deleted:batch.deleteThread??false};
    db.prepare("INSERT INTO threads VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(info.id,canonicalJson(info));
    const receipt={commitId:batch.commitId,threadId:batch.threadId,revision:cp.revision,checkpointId:cp.id};
    db.prepare("INSERT INTO commits VALUES(?,?)").run(batch.commitId,canonicalJson(receipt));return receipt;
   })
  },
  close:async()=>{if(!closed){closed=true;db.close();}}
 };
}
