import type { JsonObject } from "../json.js";
export interface InputDefinition<T> {
  readonly jsonSchema: JsonObject;
  parse(value: unknown): T;
}
