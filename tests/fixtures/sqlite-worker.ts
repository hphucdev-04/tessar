import { createSqliteBackend } from "@tesseract/storage-sqlite";
import { DatabaseSync } from "node:sqlite";
import { existsSync,writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
const filename=process.argv[2]!,participant=process.argv[3]!;
const backend=await createSqliteBackend({filename});
writeFileSync(filename+"."+participant+".ready","ready");
const deadline=Date.now()+10000;
while(!existsSync(filename+".a.ready")||!existsSync(filename+".b.ready")) {
  if(Date.now()>deadline)throw Error("Other process did not become ready");
  await setTimeout(10);
}
let result:unknown;
try {
  const lease=await backend.ownership.acquire({threadId:"race-thread",ownerToken:"same-controller/"+participant,ttlMs:60000});
  result={ok:true,lease};
}catch(error){result={ok:false,code:(error as {code?:string}).code};}
writeFileSync(filename+"."+participant+".result",JSON.stringify(result));
await backend.close();
