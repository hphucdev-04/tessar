import type { Checkpoint, ThreadInfo, RecordEntry, RecordKind, RecordTypes, StateQuery, PluginStateSnapshot } from "./schema.js";
export interface Lease {threadId:string;ownerToken:string;fencingToken:number;expiresAt:string}
export interface CommitBatch {commitId:string;threadId:string;expectedRevision:number;checkpoint:Checkpoint;records:readonly RecordEntry[];lineage?:{parentThreadId:string;sourceCheckpointId:string};deleteThread?:boolean}
export interface CommitReceipt {commitId:string;threadId:string;revision:number;checkpointId:string}
export interface PublishRequest {commitId:string;threadId:string;expectedRevision:number;lease:Lease}
export interface ThreadStore {get(id:string):Promise<ThreadInfo|null>;list(query?:StateQuery):Promise<readonly ThreadInfo[]>}
export interface ExecutionStore {
  get<K extends RecordKind>(kind:K,id:string,options?:{threadId?:string;atCheckpointId?:string}):Promise<RecordTypes[K]|null>;
  listRecords<K extends RecordKind>(kind:K,threadId:string,options?:{atCheckpointId?:string}):Promise<readonly RecordTypes[K][]>;
}
export interface CheckpointStore {get(id:string):Promise<Checkpoint|null>;list(threadId:string):Promise<readonly Checkpoint[]>}
export interface CommitPort {stage(batch:CommitBatch):Promise<void>;publish(request:PublishRequest):Promise<CommitReceipt>;lookupCommit(id:string):Promise<CommitReceipt|null>}
export interface OwnershipPort {acquire(request:{threadId:string;ownerToken:string;ttlMs:number}):Promise<Lease>;renew(lease:Lease,ttlMs:number):Promise<Lease>;release(lease:Lease):Promise<void>}
export interface StorageBackend {
  readonly ownedState: {
    get(key: Pick<PluginStateSnapshot,"ownerType"|"ownerId"|"pluginId"|"namespace">):Promise<PluginStateSnapshot|null>;
    compareAndSet(state:PluginStateSnapshot,expectedRevision:number):Promise<void>;
  };
  readonly id:string;readonly capabilities:{durable:boolean;atomicPublish:true;coordination:"single-process"|"multi-process"};
  readonly threads:ThreadStore;readonly executions:ExecutionStore;readonly checkpoints:CheckpointStore;readonly commits:CommitPort;readonly ownership:OwnershipPort;
  close():Promise<void>;
}
