import { errorInfo, TesseractError } from "../errors.js";
import type { ModelAdapter, ModelCallContext, ModelRef, ModelRequest } from "./contract.js";

function record(error: unknown, ref: ModelRef): void {
  if (!(error instanceof TesseractError))
    errorInfo(error, { source: "provider", providerId: ref.providerId, modelId: ref.modelId });
}
export function providerCall<T>(ref: ModelRef, operation: () => T): T {
  try { return operation(); }
  catch (error) { record(error, ref); throw error; }
}
export async function* streamModel(adapter: ModelAdapter, request: ModelRequest, context: ModelCallContext) {
  try { yield* adapter.stream(request, context); }
  catch (error) { record(error, request.model); throw error; }
}
