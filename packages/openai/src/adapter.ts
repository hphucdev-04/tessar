import OpenAI from "openai";
import type {ResponseUsage} from "openai/resources/responses/responses";
import {TesseractError,fail,normalizeUsage,type ModelAdapter,type ModelChunk,type ModelRef,type ModelRequest} from "@tesseract/core";
import {decodeOutput,encodeInput} from "./codec.js";
export interface OpenAIOptions {apiKey:string;baseURL?:string;providerId?:string;fetch?:typeof fetch;metadataPartition?:string}
export function createClient(options:OpenAIOptions):OpenAI{return new OpenAI({apiKey:options.apiKey,baseURL:options.baseURL,fetch:options.fetch,maxRetries:0});}
function usage(value:ResponseUsage|null|undefined){return normalizeUsage({inputTokens:value?.input_tokens,outputTokens:value?.output_tokens,totalTokens:value?.total_tokens,cacheReadInputTokens:value?.input_tokens_details?.cached_tokens,cacheWriteInputTokens:value?.input_tokens_details?.cache_write_tokens,reasoningOutputTokens:value?.output_tokens_details?.reasoning_tokens,uncachedInputTokens:value?.input_tokens!==undefined&&value?.input_tokens_details?.cached_tokens!==undefined?Math.max(0,value.input_tokens-value.input_tokens_details.cached_tokens):null},value?JSON.parse(JSON.stringify(value)):null);}
export class OpenAIAdapter implements ModelAdapter {
 private readonly client:OpenAI;
 constructor(options:OpenAIOptions,readonly ref:ModelRef,client?:OpenAI){this.client=client??createClient(options);}
 validate(request:ModelRequest):void{if(request.model.providerId!==this.ref.providerId||request.model.modelId!==this.ref.modelId)fail("UnsupportedContext","Model identity mismatch");encodeInput(request);}
 async *stream(request:ModelRequest,context:{signal:AbortSignal}):AsyncIterable<ModelChunk>{
  this.validate(request);context.signal.throwIfAborted();
  try{
   const stream=await this.client.responses.create({model:this.ref.modelId,instructions:request.instructions.sections.map(s=>s.content).join("\n\n"),input:encodeInput(request),tools:request.tools.map(t=>({type:"function" as const,name:t.name,description:t.description,parameters:t.inputSchema,strict:false})),include:["reasoning.encrypted_content"],store:false,stream:true}, {signal:context.signal});
   let terminal=false;
   for await(const event of stream){context.signal.throwIfAborted();switch(event.type){
    case "response.output_text.delta":yield{type:"message-delta",messageId:event.item_id,partId:event.item_id+":"+event.content_index,partKind:"text",delta:event.delta};break;
    case "response.reasoning_summary_text.delta":yield{type:"message-delta",messageId:event.item_id,partId:event.item_id+":summary:"+event.summary_index,partKind:"reasoning",delta:event.delta};break;
    case "response.completed":{
     terminal=true;const normalized=usage(event.response.usage);yield{type:"usage",usage:normalized};
     yield{type:"response",response:{message:decodeOutput(event.response.output,this.ref,event.response.id),usage:normalized,finishReason:"completed",providerRequestId:event.response.id}};break;
    }
    case "response.incomplete":case "response.failed":yield{type:"usage",usage:usage(event.response.usage)};throw new TesseractError("ProviderIncomplete","OpenAI response did not complete");
    case "error":throw new TesseractError("ProviderError","OpenAI stream failed");
   }}
   if(!terminal)fail("ProviderIncomplete","OpenAI stream ended before completion");
  }catch(error){if(context.signal.aborted)throw context.signal.reason;if(error instanceof TesseractError)throw error;throw new TesseractError("ProviderError","OpenAI request failed",{status:error instanceof OpenAI.APIError?error.status??null:null});}
 }
}
