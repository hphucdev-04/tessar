import { fail } from "../errors.js";
import { immutable, systemClock, type Clock } from "../json.js";
import { canonicalJson, validateBatch } from "./commit.js";
import type { Checkpoint, ThreadInfo, RecordEntry, RecordKind, RecordTypes, PluginStateSnapshot } from "./schema.js";
import { matchesScope } from "./scope.js";
import type { CommitBatch, CommitReceipt, Lease, StorageBackend } from "./storage-ports.js";
export function createMemoryBackend(options:{clock?:Clock}={}):StorageBackend {
  const clock=options.clock??systemClock;
  const heads=new Map<string,ThreadInfo>(),snapshots=new Map<string,Checkpoint>(),records=new Map<string,readonly RecordEntry[]>();
  const staged=new Map<string,CommitBatch>(),receipts=new Map<string,CommitReceipt>(),leases=new Map<string,Lease>(),fences=new Map<string,number>();
  let closed=false;
  const ownedStates=new Map<string,PluginStateSnapshot>();
  const ownerKey=(key:Pick<PluginStateSnapshot,"ownerType"|"ownerId"|"pluginId"|"namespace">)=>canonicalJson([key.ownerType,key.ownerId,key.pluginId,key.namespace]);
  const guard=()=>{if(closed)fail("Disposed","Backend closed");};
  const assertLease=(lease:Lease)=>{guard();const active=leases.get(lease.threadId);if(!active||active.ownerToken!==lease.ownerToken||active.fencingToken!==lease.fencingToken||Date.parse(active.expiresAt)<=Date.parse(clock.now()))fail("OwnershipLost","Lease no longer owns thread");};
  const currentRecords=(threadId:string,checkpointId?:string):readonly RecordEntry[]=>records.get(checkpointId??heads.get(threadId)?.currentCheckpointId??"")??[];
  const allRecords=(checkpointId?:string)=>checkpointId?(records.get(checkpointId)??[]):[...heads.values()].flatMap(h=>currentRecords(h.id));
  const backend:StorageBackend={
    ownedState:{
      get:async key=>{guard();return ownedStates.get(ownerKey(key))??null;},
      compareAndSet:async(state,expectedRevision)=>{guard();if(!["agent","session"].includes(state.ownerType))fail("InvalidConfiguration","Thread/stream/turn state must use checkpoint commits");const key=ownerKey(state);if((ownedStates.get(key)?.revision??0)!==expectedRevision||state.revision!==expectedRevision+1)fail("CommitConflict","Owned state revision changed");ownedStates.set(key,immutable(state));}
    },
    id:"memory",capabilities:{durable:false,atomicPublish:true,coordination:"single-process"},
    threads:{
      get:async id=>{guard();const head=heads.get(id);return head&&!head.deleted?head:null;},
      list:async query=>{guard();return [...heads.values()].filter(h=>!h.deleted&&matchesScope(h.scope,query?.scope));}
    },
    checkpoints:{get:async id=>{guard();return snapshots.get(id)??null;},list:async id=>{guard();return [...snapshots.values()].filter(cp=>cp.threadId===id);}},
    executions:{
      get:async<K extends RecordKind>(kind:K,id:string,query?:{threadId?:string;atCheckpointId?:string})=>{guard();const entries=query?.threadId?currentRecords(query.threadId,query.atCheckpointId):allRecords(query?.atCheckpointId);return (entries.find(e=>e.kind===kind&&e.id===id)?.data??null) as RecordTypes[K]|null;},
      listRecords:async<K extends RecordKind>(kind:K,threadId:string,query?:{atCheckpointId?:string})=>{guard();return currentRecords(threadId,query?.atCheckpointId).filter(e=>e.kind===kind).map(e=>e.data) as RecordTypes[K][];}
    },
    commits:{
      stage:async batch=>{guard();validateBatch(batch);const prior=staged.get(batch.commitId);if(prior&&canonicalJson(prior)!==canonicalJson(batch))fail("CommitConflict","commitId reused with different payload");if(!prior)staged.set(batch.commitId,immutable(batch));},
      lookupCommit:async id=>{guard();return receipts.get(id)??null;},
      publish:async request=>{
        guard();const prior=receipts.get(request.commitId);if(prior)return prior;
        assertLease(request.lease);
        const batch=staged.get(request.commitId);if(!batch||batch.threadId!==request.threadId||batch.expectedRevision!==request.expectedRevision)fail("CommitConflict","Missing staged batch");
        const head=heads.get(batch.threadId);if((head?.revision??0)!==batch.expectedRevision||head?.deleted)fail("CommitConflict","Head revision changed");
        if(batch.checkpoint.parentCheckpointId!==(head?.currentCheckpointId??null))fail("CommitConflict","Checkpoint parent mismatch");
        if(snapshots.has(batch.checkpoint.id))fail("CommitConflict","Checkpoint ID already published");
        const merged=new Map(currentRecords(batch.threadId).map(r=>[r.kind+":"+r.id,r]));
        for(const record of batch.records)merged.set(record.kind+":"+record.id,record);
        const execution=batch.checkpoint.execution;
        if(execution&&!merged.has("streams:"+execution.streamId))fail("CommitConflict","Execution references missing stream");
        if(execution?.pendingInterruptId&&!merged.has("interrupts:"+execution.pendingInterruptId))fail("CommitConflict","Execution references missing interrupt");
        const cp=immutable(batch.checkpoint);
        const stream=execution?merged.get("streams:"+execution.streamId)?.data as RecordTypes["streams"]:null;
        const info:ThreadInfo=immutable({id:batch.threadId,scope:cp.state.scope,metadata:cp.state.metadata,revision:cp.revision,currentCheckpointId:cp.id,activeStreamId:stream&&!["completed","failed","stopped","cancelled"].includes(stream.status)?stream.id:null,createdAt:head?.createdAt??cp.createdAt,updatedAt:cp.createdAt,parentThreadId:batch.lineage?.parentThreadId??head?.parentThreadId??null,sourceCheckpointId:batch.lineage?.sourceCheckpointId??head?.sourceCheckpointId??null,deleted:batch.deleteThread??false});
        const receipt=immutable({commitId:batch.commitId,threadId:batch.threadId,revision:cp.revision,checkpointId:cp.id});
        snapshots.set(cp.id,cp);records.set(cp.id,immutable([...merged.values()]));heads.set(batch.threadId,info);receipts.set(batch.commitId,receipt);return receipt;
      }
    },
    ownership:{
      acquire:async request=>{guard();const now=Date.parse(clock.now()),active=leases.get(request.threadId);if(!Number.isFinite(request.ttlMs)||request.ttlMs<=0)fail("InvalidConfiguration","Invalid lease duration");if(active&&Date.parse(active.expiresAt)>now)fail("OwnerActive","Thread has active owner");const fencingToken=(fences.get(request.threadId)??0)+1;fences.set(request.threadId,fencingToken);const lease=immutable({...request,fencingToken,expiresAt:new Date(now+request.ttlMs).toISOString()});leases.set(request.threadId,lease);return lease;},
      renew:async(lease,ttlMs)=>{assertLease(lease);if(!Number.isFinite(ttlMs)||ttlMs<=0)fail("InvalidConfiguration","Invalid lease duration");const renewed=immutable({...lease,expiresAt:new Date(Date.parse(clock.now())+ttlMs).toISOString()});leases.set(lease.threadId,renewed);return renewed;},
      release:async lease=>{guard();const active=leases.get(lease.threadId);if(active?.fencingToken===lease.fencingToken&&active.ownerToken===lease.ownerToken)leases.delete(lease.threadId);}
    },
    close:async()=>{closed=true;heads.clear();snapshots.clear();records.clear();staged.clear();receipts.clear();leases.clear();}
  };return backend;
}
