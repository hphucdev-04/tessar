import { normalizeContent } from "../messages/message.js";
import { immutable } from "../json.js";
import type { Tool,ToolExecutionContext,ToolResult } from "../tools/tool.js";
export async function executeTool(tool:Tool,input:unknown,context:ToolExecutionContext):Promise<ToolResult> {
 const parsed=tool.input.parse(input),result=await tool.execute(parsed,context);
 return immutable({...result,content:normalizeContent(result.content)});
}
