import { it, expect } from "vitest";
import { Agent, type ModelAdapter, type ModelChunk, type ModelRequest } from "@tessar/core";
import { OpenAIProvider, type OpenAIProviderOptions } from "../src/index.js";

class OtherModel implements ModelAdapter {
  readonly ref = { providerId: "other", modelId: "test" };
  readonly options: { max_tokens?: number; temperature?: number } = {};
  validate(_request: ModelRequest) {}
  async *stream(): AsyncIterable<ModelChunk> {}
}

it("infers native model options for defaults, model-ID overrides and other adapters", () => {
  const model = new OpenAIProvider({ apiKey: "test", model: "fixture" });
  const agent = new Agent({ id: "test", model });
  expect(agent.model).toBe(model);
  if (false) {
    const configuration: OpenAIProviderOptions = { api: "chat-completions", apiKey: "test", model: "fixture", reasoning_effort: "high" };
    new OpenAIProvider(configuration);
    const chat = new OpenAIProvider({ api: "chat-completions", apiKey: "test", model: "fixture", reasoning_effort: "high", max_tokens: 100 });
    const chatAgent = new Agent({ id: "chat", model: chat });
    chatAgent.stream("hi", { modelOptions: { reasoning_effort: "low", max_completion_tokens: 100 } });
    agent.generate("hi", { model: chat, modelOptions: { max_tokens: 100 } });
    // @ts-expect-error Chat request fields are not Responses fields
    chatAgent.stream("hi", { modelOptions: { max_output_tokens: 100 } });
    // @ts-expect-error Responses reasoning is not Chat reasoning_effort
    new OpenAIProvider({ api: "chat-completions", apiKey: "test", model: "fixture", reasoning: { effort: "high" } });
    // @ts-expect-error API belongs to the connection, not execution request overrides
    chatAgent.stream("hi", { modelOptions: { api: "responses" } });
    // @ts-expect-error Only one choice can be consumed by an Agent loop
    new OpenAIProvider({ api: "chat-completions", apiKey: "test", model: "fixture", n: 2 });
    agent.stream("hi", { modelOptions: { reasoning: { effort: "low" }, text: { verbosity: "low" } } });
    agent.generate("hi", { model: "another", modelOptions: { max_output_tokens: 100 } });
    // @ts-expect-error SDK reasoning effort has a specific union
    agent.stream("hi", { modelOptions: { reasoning: { effort: "invalid" } } });
    // @ts-expect-error Connection fields do not belong to request options
    agent.stream("hi", { modelOptions: { baseURL: "https://other.test" } });
    // @ts-expect-error Runtime-owned input is not a model option
    agent.stream("hi", { modelOptions: { input: "bypass" } });
    agent.generate("hi", { model: new OtherModel(), modelOptions: { max_tokens: 100 } });
    // @ts-expect-error Model override determines the option type, not the Agent default
    agent.stream("hi", { model: new OtherModel(), modelOptions: { max_output_tokens: 100 } });
    // @ts-expect-error model is required by the Agent constructor
    new Agent({ id: "missing" });
    // @ts-expect-error Provider input is derived by Agent
    new OpenAIProvider({ apiKey: "test", model: "fixture", input: "bypass" });
    // @ts-expect-error Provider-managed compaction requires a supported continuity codec
    new OpenAIProvider({ apiKey: "test", model: "fixture", context_management: [{ type: "compaction" }] });
  }
});
