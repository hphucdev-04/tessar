import { expect,it } from "vitest";
import { spawn,spawnSync } from "node:child_process";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const supportsSpawn=!spawnSync(process.execPath,["--version"]).error;
it.skipIf(!supportsSpawn)("fences two real processes racing with the same logical controller ID",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"tesseract-process-")),filename=join(directory,"state.db");
  const run=(participant:string)=>new Promise<void>((resolve,reject)=>{
    const child=spawn(process.execPath,["tests/fixtures/sqlite-worker.ts",filename,participant],{stdio:["ignore","pipe","pipe"]});
    let stderr="";child.stderr.on("data",chunk=>stderr+=chunk);child.on("error",reject);child.on("exit",code=>code===0?resolve():reject(Error(stderr)));
  });
  try {
    await Promise.all([run("a"),run("b")]);
    const results=await Promise.all(["a","b"].map(async id=>JSON.parse(await readFile(filename+"."+id+".result","utf8"))));
    expect(results.filter(result=>result.ok)).toHaveLength(1);
    expect(results.find(result=>!result.ok).code).toBe("OwnerActive");
  }finally{await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
