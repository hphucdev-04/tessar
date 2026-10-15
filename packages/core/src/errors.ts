export interface ErrorInfo { code: string; message: string; retryable: boolean; details?: Record<string, unknown> }
export class TesseractError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) { super(message); this.name = "TesseractError"; }
  toJSON(): ErrorInfo { return { code: this.code, message: this.message, retryable: false, ...(this.details ? { details: this.details } : {}) }; }
}
export function fail(code: string, message: string): never { throw new TesseractError(code, message); }
export function requireId(id: string, name = "id"): string {
  if (typeof id !== "string" || !id.trim()) fail("InvalidConfiguration", name + " must be a nonempty string");
  return id;
}
export function errorInfo(error: unknown): ErrorInfo {
  return error instanceof TesseractError ? error.toJSON() : { code: "InternalError", message: error instanceof Error ? error.message : String(error), retryable: false };
}
