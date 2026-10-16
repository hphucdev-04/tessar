# @tessar/openai

OpenAI Responses provider and automatic model metadata integration for Tessar.
Requires Node 24.14 or newer and uses the official OpenAI SDK.

```sh
npm install @tessar/core@next @tessar/openai@next
```

```ts
import { Agent, Controller, HumanMessage } from "@tessar/core";
import { OpenAIPlugin } from "@tessar/openai";

const agent = new Agent({
  id: "assistant",
  model: { providerId: "openai", modelId: process.env.OPENAI_MODEL! },
});
const controller = new Controller({
  id: "application",
  agent,
  plugins: [new OpenAIPlugin({ apiKey: process.env.OPENAI_API_KEY! })],
});

try {
  await controller.initialize();
  const result = await agent.generate({ input: new HumanMessage("Hello") });
  console.log(result.output);
} finally {
  await controller.dispose();
}
```

Provider SDK exceptions retain their original identity. The adapter disables
implicit SDK retries. Model metadata may be incomplete and carries provenance.

This is an alpha release. See the
[repository](https://github.com/hphucdev-04/tesseract) for complete contracts.
