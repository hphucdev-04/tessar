import { normalizeContent } from "../messages/message.js";
import { immutable } from "../json.js";
import type { Tool, ToolExecutionContext, ToolResult } from "../tools/tool.js";
import { TessarError, errorInfo } from "../errors.js";
import { abortable } from "./abort.js";
export async function executeTool(
  tool: Tool,
  input: unknown,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  if (context.signal.aborted)
    throw new TessarError("Cancelled", "Tool cancelled before dispatch");
  try {
    const parsed = tool.input.parse(input),
      result = await abortable(
        tool.execute(parsed, context),
        context.signal,
        () =>
          new TessarError(
            "RecoveryRequired",
            "In-flight tool cancellation has unknown external outcome",
          ),
      );
    return immutable({ ...result, content: normalizeContent(result.content) });
  } catch (error) {
    if (!(error instanceof TessarError))
      errorInfo(error, { source: "tool", toolName: tool.name });
    throw error;
  }
}
