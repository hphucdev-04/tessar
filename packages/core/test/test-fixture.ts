import {Agent,Controller, type Plugin} from "../src/index.js";
import {ScriptedProvider,type ModelScript} from "@tesseract/core/testing";
export const fixtureRef={providerId:"scripted",modelId:"test"};
export async function fixture(scripts:readonly ModelScript[]=[{text:"answer"}],plugins:readonly Plugin[]=[]){
 const provider=new ScriptedProvider(scripts);const agent=new Agent({id:"agent",model:fixtureRef,plugins:[{id:"provider",setup(tesseract){tesseract.models.registerProvider({id:"scripted",create:()=>provider});}},...plugins]});
 const controller=new Controller({id:"runtime",agent});await controller.initialize();return {provider,agent,controller};
}
