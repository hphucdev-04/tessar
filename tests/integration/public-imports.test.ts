import {expect,it} from "vitest";
import {spawnSync} from "node:child_process";
it("loads built core without product startup I/O and runs the public APIs",()=>{
 const result=spawnSync(process.execPath,["--input-type=module","-e",`
  import assert from 'node:assert/strict';
  globalThis.fetch=()=>{throw Error('Unexpected startup network');};
  const {Agent,Controller,Session,HumanMessage,AgentEvents}=await import('@tesseract/core');
  assert.equal(AgentEvents.BeforeTool,'tool.before');assert.equal(typeof Session,'function');
  const {ScriptedProvider}=await import('@tesseract/core/testing');
  const provider=new ScriptedProvider([{text:'built answer'}]);
  const agent=new Agent({id:'consumer',model:{providerId:'scripted',modelId:'test'},plugins:[{id:'fixture',setup(tesseract){tesseract.models.registerProvider({id:'scripted',create:()=>provider});}}]});
  const controller=new Controller({id:'consumer-runtime',agent});
  await controller.initialize();
  try{const result=await agent.generate({input:new HumanMessage('hello')});assert.equal(result.status,'completed');assert.equal(result.output[0].content[0].text,'built answer');}finally{await controller.dispose();}
 `],{encoding:"utf8"});
 expect(result.error).toBeUndefined();expect(result.status,result.stderr).toBe(0);expect(result.stdout).toBe("");
});
