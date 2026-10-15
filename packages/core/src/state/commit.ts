import { fail, errorInfo } from "../errors.js";
import { assertJson } from "../json.js";
import { MessageCodec } from "../messages/codec.js";
import type { CommitBatch, CommitReceipt, Lease, StorageBackend } from "./storage-ports.js";
export function canonicalJson(value:unknown):string {
  assertJson(value);
  const encode=(x:any):string=>Array.isArray(x)?"["+x.map(encode).join(",")+"]":x&&typeof x==="object"?"{"+Object.keys(x).sort().map(k=>JSON.stringify(k)+":"+encode(x[k])).join(",")+"}":JSON.stringify(x);
  return encode(value);
}
export function validateBatch(batch:CommitBatch):void {
  assertJson(batch);
  const cp=batch.checkpoint;
  if(cp.threadId!==batch.threadId || cp.revision!==batch.expectedRevision+1 || cp.schemaVersion!==1)fail("CommitConflict","Checkpoint identity/revision mismatch");
  const ids=new Set<string>(),pending=new Set<string>(),resolved=new Set<string>();
  for(const wire of cp.state.messages) {
    const message=MessageCodec.decode(wire);
    if(ids.has(message.id))fail("InvalidMessage","Duplicate message ID");ids.add(message.id);
    for(const part of message.content)if(part.type==="tool-call"){if(message.role!=="assistant"||pending.has(part.toolCallId)||resolved.has(part.toolCallId))fail("InvalidMessage","Invalid tool call");pending.add(part.toolCallId);}
    if(message.role==="tool"){if(!pending.has(message.toolCallId!))fail("InvalidMessage","Unmatched tool result");pending.delete(message.toolCallId!);resolved.add(message.toolCallId!);}
  }
  if(cp.cause==="Terminal"&&pending.size)fail("InvalidMessage","Terminal checkpoint contains unresolved tool calls");
  for(const entry of batch.records)if(entry.threadId!==batch.threadId || entry.id!==("id" in entry.data?entry.data.id:entry.id))fail("CommitConflict","Record membership mismatch");
}
export class CommitCoordinator {
  constructor(private readonly backend:StorageBackend) {}
  async commit(batch:CommitBatch,lease:Lease):Promise<CommitReceipt> {
    validateBatch(batch);
    try {
      await this.backend.commits.stage(batch);
      const existing=await this.backend.commits.lookupCommit(batch.commitId);if(existing)return existing;
      try {return await this.backend.commits.publish({commitId:batch.commitId,threadId:batch.threadId,expectedRevision:batch.expectedRevision,lease});}
      catch(error){const committed=await this.backend.commits.lookupCommit(batch.commitId);if(committed)return committed;throw error;}
    } catch(error) {
      errorInfo(error,{source:"storage",backendId:this.backend.id});
      throw error;
    }
  }
}
