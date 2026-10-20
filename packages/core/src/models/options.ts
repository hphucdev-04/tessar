import { fail } from "../errors.js";
import { immutable, type JsonObject } from "../json.js";

/** Snapshot JSON request options using SDK-compatible omission of undefined. */
export function snapshotModelOptions(value: object): JsonObject {
  const json = JSON.stringify(value, (_key, item) => {
    if (
      ["function", "symbol", "bigint"].includes(typeof item) ||
      (typeof item === "number" && !Number.isFinite(item))
    )
      fail("InvalidConfiguration", "Model options must be JSON data");
    return item;
  });
  return immutable(JSON.parse(json)) as JsonObject;
}
