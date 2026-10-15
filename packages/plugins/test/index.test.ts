import {expect,it} from "vitest";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
const execute=promisify(execFile);
const managerUrl=pathToFileURL(resolve("packages/plugins/dist/index.js")).href;
const hostUrl=pathToFileURL(resolve("package.json")).href;
async function file(root:string,path:string,text:string){const target=join(root,path);await mkdir(join(target,".."),{recursive:true});await writeFile(target,text);}
async function run(root:string,body:string){return execute(process.execPath,["--input-type=module","-e",`
 import assert from 'node:assert/strict';
 import {pathToFileURL} from 'node:url';
 import {join} from 'node:path';
 const directory=process.argv[1],hostUrl=process.argv[3];
 const {PluginManager}=await import(process.argv[2]);
 const manager=new PluginManager({directory,hostUrl});
 try {${body}} finally {manager.dispose();}
`,root,managerUrl,hostUrl],{timeout:25000,env:{...process.env,npm_config_offline:"true",npm_config_cache:join(root,".npm-cache")}});}
it("discovers local JS/TS and folders, preserves the host SDK for lazy imports and releases its resolver",async()=>{
 const root=await mkdtemp(join(tmpdir(),"tesseract plugins "));
 try{
  await file(root,"plugins/a.mts",`import {Tool,AgentEvents} from '@tesseract/core';
   const id: string = 'a'; export default {id, sdkClass:Tool, event:AgentEvents.BeforeTool, setup(){}, async lazy(){return (await import('./lazy.mjs')).Tool;}, async after(){return (await import('./after.mjs')).Tool;}};`);
  await file(root,"plugins/lazy.mjs",`export {Tool} from '@tesseract/core'; export default {id:'helper',setup(){}};`);
  await file(root,"plugins/folder/index.cjs",`const {Tool}=require('@tesseract/core');module.exports={id:'folder',sdkClass:Tool,setup(){}};`);
  await file(root,"plugins/types.d.ts","export type Ignore = string;");
  await file(root,"node_modules/@tesseract/core/package.json",JSON.stringify({type:"module",exports:"./index.mjs"}));
  await file(root,"node_modules/@tesseract/core/index.mjs","export class Tool {};");
  await file(root,"outside.mjs",`export {Tool} from '@tesseract/core';`);
  await run(root,`
   const {Tool}=await import(${JSON.stringify(pathToFileURL(resolve("packages/core/dist/index.js")).href)});
   const sources=await manager.discover();assert.equal(sources.length,3);
   const plugins=await manager.load();assert.deepEqual(plugins.map(p=>p.id),['a','folder','helper']);
   assert.equal(plugins[0].sdkClass,Tool);assert.equal(plugins[0].event,'tool.before');assert.equal(await plugins[0].lazy(),Tool);
   assert.equal(plugins[1].sdkClass,Tool);
   const outside=await import(pathToFileURL(join(directory,'outside.mjs')));assert.notEqual(outside.Tool,Tool);
   const {writeFile}=await import('node:fs/promises');await writeFile(join(directory,'plugins/after.mjs'),"export {Tool} from '@tesseract/core';");
   manager.dispose();assert.notEqual(await plugins[0].after(),Tool);await assert.rejects(manager.load(),/disposed/i);
  `);
 }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
it("resolves import-only package exports and their own dependencies from the plugin environment",async()=>{
 const root=await mkdtemp(join(tmpdir(),"tesseract package "));
 try{
  await file(root,"package.json",JSON.stringify({private:true,tesseract:{plugins:["example-plugin"]}}));
  await file(root,"node_modules/example-plugin/package.json",JSON.stringify({type:"module",exports:{import:"./index.mjs"}}));
  await file(root,"node_modules/example-plugin/index.mjs",`import {value} from 'helper'; export default {id:value,setup(){}};`);
  await file(root,"node_modules/example-plugin/node_modules/helper/package.json",JSON.stringify({type:"module",exports:"./index.mjs"}));
  await file(root,"node_modules/example-plugin/node_modules/helper/index.mjs",`export const value='package-helper';`);
  await run(root,`assert.deepEqual(await manager.discover(),['example-plugin']);assert.equal((await manager.load())[0].id,'package-helper');`);
 }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
it("rejects invalid manifests, invalid exports, duplicate IDs and module failures with source context",async()=>{
 const root=await mkdtemp(join(tmpdir(),"tesseract invalid "));
 try{
  await run(root,`assert.deepEqual(await manager.load(),[]);`);
  await file(root,"package.json",JSON.stringify({tesseract:{plugins:"bad"}}));
  await run(root,`await assert.rejects(manager.discover(),/tesseract.plugins/);`);
  await file(root,"package.json",JSON.stringify({private:true}));
  await file(root,"invalid.mjs","export default {}; ");
  await file(root,"first.mjs","export default {id:'same',setup(){}};");
  await file(root,"second.mjs","export default {id:'same',setup(){}};");
  await file(root,"throws.mjs","throw Error('module exploded');");
  await run(root,`
   await assert.rejects(manager.load(['./invalid.mjs']),/invalid.mjs/);
   await assert.rejects(manager.load(['./first.mjs','./second.mjs']),/same/);
   await assert.rejects(manager.load(['./throws.mjs']),/throws.mjs.*module exploded/s);
  `);
 }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
it("installs, updates and removes a real local npm plugin without activating helper dependencies",async()=>{
 const root=await mkdtemp(join(tmpdir(),"tesseract npm & "));
 try{
  await file(root,"fixtures/helper/package.json",JSON.stringify({name:"fixture-helper",version:"1.0.0",type:"module",exports:"./index.mjs"}));
  await file(root,"fixtures/helper/index.mjs","export const value='installed-plugin';");
  await file(root,"fixtures/plugin/package.json",JSON.stringify({name:"fixture-plugin",version:"1.0.0",type:"module",exports:{import:"./index.mjs"},dependencies:{"fixture-helper":"file:"+join(root,"fixtures/helper")}}));
  await file(root,"fixtures/plugin/index.mjs",`import {value} from 'fixture-helper';export default {id:value,setup(){}};`);
  await file(root,"package.json",JSON.stringify({private:true,description:"preserved",dependencies:{"fixture-helper":"file:"+join(root,"fixtures/helper")},tesseract:{other:true,plugins:[]}}));
  await run(root,`
   const {readFile}=await import('node:fs/promises');
   await assert.rejects(manager.install('./fixtures/plugin',{name:'fixture-helper'}),/source package/);
   assert.deepEqual(await manager.discover(),[]);
   await manager.install('./fixtures/plugin');
   assert.deepEqual(await manager.discover(),['fixture-plugin']);assert.equal((await manager.load())[0].id,'installed-plugin');
   await manager.update('fixture-plugin');
   let manifest=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));
   assert.equal(manifest.description,'preserved');assert.equal(manifest.tesseract.other,true);
   assert.ok(manifest.dependencies['fixture-helper']);assert.ok(manifest.dependencies['fixture-plugin']);
   await assert.rejects(manager.install('./missing; unexpected-command',{name:'missing-plugin'}));
   assert.deepEqual(await manager.discover(),['fixture-plugin']);
   await assert.rejects(manager.install('git+https://example.invalid/repo.git'),/name/i);
   await manager.remove('fixture-plugin');
   assert.deepEqual(await manager.discover(),[]);
   manifest=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));assert.ok(manifest.dependencies['fixture-helper']);assert.equal(manifest.dependencies['fixture-plugin'],undefined);
   await assert.rejects(manager.update('fixture-helper'),/not.*plugin/i);
   await assert.rejects(manager.remove('--unsafe'),/name/i);
  `);
 }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
},30000);
