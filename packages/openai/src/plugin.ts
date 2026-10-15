import type {Plugin} from "@tesseract/core";
import {OpenAIAdapter,createClient,type OpenAIOptions} from "./adapter.js";
import {metadataResolver} from "./metadata.js";
export function OpenAIPlugin(options:OpenAIOptions):Plugin{
 const id=options.providerId??"openai";return{id:"provider."+id,setup(tesseract){
  const client=createClient(options);tesseract.models.registerProvider({id,endpoint:options.baseURL??"https://api.openai.com/v1",metadataPartition:options.metadataPartition,metadata:metadataResolver(client),catalogModelRef:ref=>!options.baseURL||options.baseURL.replace(/\/$/,"")==="https://api.openai.com/v1"?{providerId:"openai",modelId:ref.modelId}:null,catalogMappingVersion:1,create:modelId=>new OpenAIAdapter(options,{providerId:id,modelId},client)});
 }};
}
