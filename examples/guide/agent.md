# Agent: start with a model

[All guides](README.md) · Next: [Tools](tools.md) or [Streaming](stream.md)

`Agent` owns its model, instructions, tools and execution loop. It requires an
application-defined `id` and a default `model`. It can run without a Controller,
Session, `initialize()` or per-call disposal.

## Generate a result

Save as `agent.ts` after completing the [setup](README.md).

```ts
import { Agent, buildInstruction } from "@tessar/core";
import { OpenAIProvider } from "@tessar/openai";

const model = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: process.env.OPENAI_MODEL!,
});

const agent = new Agent({
  id: "assistant",
  model,
  instructions: buildInstruction([
    { id: "base", order: 0, content: "You are a concise assistant." },
    { id: "style", order: 10, content: "Explain unfamiliar terms simply." },
  ]),
});

const result = await agent.generate("Explain what an agent loop does.");
console.log(result.status);
for (const message of result.output) {
  for (const part of message.content) {
    if (part.type === "text") console.log(part.text);
  }
}
console.log(result.usage.metrics);
```

`generate()` consumes the execution and returns its messages, usage and status
when it completes or suspends. An execution can include several model requests
and tool calls. It throws on an execution error. Use [streaming](stream.md) for
live events.

Instruction sections have unique IDs. Lower `order` values come first; IDs break
ties. Put stable sections before changing sections to keep their prompt prefix
stable. Sections are composed into one instruction string by the OpenAI adapter,
rather than becoming one system message each. Caching depends on the endpoint.

## Supply conversation messages yourself

Direct calls do not automatically share history. This snippet explicitly passes
an earlier answer into a new execution:

```ts
import { HumanMessage, SystemMessage } from "@tessar/core";

const next = await agent.generate([
  new SystemMessage("Use short examples."),
  new HumanMessage("Explain what an agent loop does."),
  ...result.output,
  new HumanMessage("Now show a concrete example."),
]);
console.log(next.output);
```

For automatic thread history and queued input, use a [Session](sessions.md).

## Override one execution

Keep the existing endpoint and credentials, but select a different model on that
connection and override its request options:

```ts
const alternateModelId = process.env.OPENAI_ALTERNATE_MODEL;
if (alternateModelId) {
  const alternate = await agent.generate("Explain briefly.", {
    model: alternateModelId,
    modelOptions: { max_output_tokens: 1024 },
  });
  console.log(alternate.output);
}
```

The same options argument works with `agent.stream(input, options)`. Overrides
apply only to that execution. Nested option objects replace the previous object;
they are not deep-merged. Unconfigured options are left to the provider SDK.

To change endpoint, credentials or protocol, pass another model instance:

```ts
if (process.env.COMPATIBLE_API_KEY && process.env.COMPATIBLE_MODEL &&
    process.env.COMPATIBLE_BASE_URL) {
  const compatible = new OpenAIProvider({
    api: "chat-completions",
    apiKey: process.env.COMPATIBLE_API_KEY,
    baseURL: process.env.COMPATIBLE_BASE_URL,
    model: process.env.COMPATIBLE_MODEL,
  });
  console.log((await agent.generate("Hello", { model: compatible })).output);
}
```

Choose the protocol your endpoint supports. Responses and Chat Completions have
different native option names; see [the provider reference](../../packages/openai/README.md).
SDK client settings such as `timeout`, `maxRetries` and `defaultHeaders` belong
in the provider constructor. Reading `model.profile` returns a metadata snapshot;
`await model.refreshProfile()` explicitly refreshes it. Missing metadata fields
can be `null`.
