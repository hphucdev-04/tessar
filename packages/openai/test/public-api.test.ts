import { expect, it } from "vitest";
import * as sdk from "../src/index.js";
import type {
  OpenAIAPI,
  OpenAIProviderOptions,
  OpenAIOptions,
} from "../src/index.js";
// @ts-expect-error The low-level adapter is an implementation detail.
import type { OpenAIAdapter } from "../src/index.js";

it("exports the provider and plugin with useful configuration types", () => {
  expect(Object.keys(sdk).sort()).toEqual(["OpenAIPlugin", "OpenAIProvider"]);
  const api: OpenAIAPI = "chat-completions";
  const connection: OpenAIOptions = { apiKey: "example" };
  const options: OpenAIProviderOptions<typeof api> = {
    ...connection,
    api,
    model: "test",
  };
  const model = new sdk.OpenAIProvider(options);
  expect(model.api).toBe(api);
});
