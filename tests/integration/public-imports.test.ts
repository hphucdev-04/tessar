import {expect,it} from "vitest";
import {spawnSync} from "node:child_process";
it("loads built core without product startup I/O and runs the public APIs",()=>{
 const result=spawnSync(process.execPath,["--input-type=module","-e",`
  import assert from 'node:assert/strict';
  globalThis.fetch=()=>{throw Error('Unexpected startup network');};
  const {Agent,Controller,Session,HumanMessage,AgentEvents}=await import('@tesseract/core');
  assert.equal(AgentEvents.BeforeTool,'tool.before');assert.equal(typeof Session,'function');
  const {createTool,toolResult,Tool}=await import('@tesseract/core/tool');
  const core=await import('@tesseract/core');
  assert.equal(createTool,core.createTool);assert.equal(Tool,core.Tool);
  const tool=createTool({name:'echo',description:'Echo input',input:{jsonSchema:{type:'string'},parse:value=>String(value)},execute:async value=>toolResult(value)});
  assert.ok(tool instanceof core.Tool);
  assert.deepEqual(await tool.execute('subpath works',{}),{content:[{type:'text',text:'subpath works'}]});
  const {ScriptedProvider}=await import('@tesseract/core/testing');
  const provider=new ScriptedProvider([{text:'built answer'}]);
  const {PluginManager}=await import('@tesseract/plugins');
  const manager=new PluginManager({directory:process.cwd(),hostUrl:import.meta.url});
  try{const [logger]=await manager.load(['@tesseract/plugins/logger']);assert.equal(logger.id,'logger');assert.equal(typeof logger.setup,'function');}finally{manager.dispose();}
  const {LoggerPlugin}=await import('@tesseract/plugins/logger');const logs=[];
  const logger=new LoggerPlugin({write:entry=>{logs.push(entry);}});assert.ok(logger instanceof LoggerPlugin);
  const agent=new Agent({id:'consumer',model:{providerId:'scripted',modelId:'test'},plugins:[logger,{id:'fixture',setup(tesseract){tesseract.models.registerProvider({id:'scripted',create:()=>provider});}}]});
  const controller=new Controller({id:'consumer-runtime',agent});
  await controller.initialize();
  try{const result=await agent.generate({input:new HumanMessage('hello')});assert.equal(result.status,'completed');assert.equal(result.output[0].content[0].text,'built answer');assert.ok(logs.some(entry=>entry.type===AgentEvents.StreamEnd));}finally{await controller.dispose();}
 `],{encoding:"utf8"});
 expect(result.error).toBeUndefined();expect(result.status,result.stderr).toBe(0);expect(result.stdout).toBe("");
});
