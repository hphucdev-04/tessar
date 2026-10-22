# Trace executions with Langfuse

[All guides](README.md)

Install the optional integration alongside your model adapter:

```sh
npm install @tessar/core @tessar/openai @tessar/langfuse zod
```

Supply your application's credentials in an ignored `.env`:

```dotenv
OPENAI_API_KEY=your-provider-key
OPENAI_MODEL=your-model-id
LANGFUSE_PUBLIC_KEY=your-langfuse-public-key
LANGFUSE_SECRET_KEY=your-langfuse-secret-key
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

Use the base URL for your Langfuse Cloud region or self-hosted deployment.
The plugin uses the official Langfuse JS SDK v6 and requires self-hosted Langfuse
v4.59.0 or newer. See [the SDK requirements](https://langfuse.com/docs/observability/sdk/overview).

Save as `tracing.ts`:

```ts
import { Agent, Controller } from "@tessar/core";
import { OpenAIProvider } from "@tessar/openai";
import { LangfusePlugin } from "@tessar/langfuse";

const agent = new Agent({
  id: "assistant",
  model: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: process.env.OPENAI_MODEL!,
  }),
});
const controller = new Controller({
  id: "my-app",
  agent,
  plugins: [new LangfusePlugin({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
    tags: ["my-app"],
  })],
});

try {
  await controller.initialize();
  for await (const event of agent.stream("Introduce yourself.")) {
    if (event.type === "message.delta" && event.payload.partKind === "text") {
      process.stdout.write(event.payload.delta);
    }
  }
} finally {
  await controller.dispose();
}
```

```sh
node --env-file=.env tracing.ts
```

`generate()` and Session execution use the same instrumentation. A separate
Session is not required for direct Agent calls after Controller initialization.

## Trace contents

```text
Thread trace (Session calls) / Stream trace (direct Agent calls)
└── Agent observation
    ├── turn 1
    │   ├── Model generation (one per attempt)
    │   └── Tool
    │       └── Auxiliary model generation, if used
    ├── turn 2
    │   └── Model generation
    └── turn 3 (a later follow-up on the same Thread)
        └── Model generation
```

Model input records the effective request after context/request hooks. Output
records the model response; tool observations record arguments and results.
Requests, responses and scope metadata are sent to the configured Langfuse
project. Credentials used to configure the plugin are not observation metadata.

| Observation | Input | Output |
| --- | --- | --- |
| Agent (named with `Agent.id`) | Accepted input messages, or resume/recovery details for a continued segment | Stream output messages; committed partial output when suspended or interrupted |
| `turn 1`, `turn 2`, ... | The latest effective primary model request in that Turn, after context/request hooks | Assistant and tool messages committed during that Turn segment, in commit order |
| Model generation | Its own effective request, including auxiliary requests | Its model response, before message commit transformations |
| Tool | Actual arguments | Tool result message |

Session follow-ups on the same Thread append to the same trace. Its ID is
`sha256(thread.id).slice(0, 32)`, independent of Controller and Session IDs.
Different Threads have separate traces; returning to a Thread continues its
Turn numbers. Direct Agent calls start numbering at one within each Stream.
A retry remains in the same
Turn, with a separate generation for each attempt. Auxiliary generations do not
replace the enclosing Turn's input or become conversation output.

When no output was committed, Agent/Turn output is an empty array. A generation
that fails before responding has no output; its error is recorded separately.
Existing Thread parents are referenced after resume/recovery rather than sent
again. The root's input/output, timing and status describe the first execution
segment that created it; they are not a cumulative conversation snapshot. A
suspended Turn's exported fields remain partial. New generations and tools
record subsequent work under that same parent, and new Turn nodes continue the
sequence. Inspect each generation's `input.messages` for the effective history.

Tessar IDs remain attached as metadata. If a Session exists, its ID populates
Langfuse's session grouping; Thread IDs distinguish conversations within it.
Scope keys remain application-defined metadata rather than assumed user roles
or authentication identities.

Each retry is a distinct generation. Cache/reasoning tokens are split from the
inclusive input/output counts to avoid counting the same tokens twice. Unknown
values remain absent; complete raw usage and provenance are stored as metadata.

The plugin saves a small counter and parent-creation flags in Thread checkpoint
plugin state (`langfuse` / `trace`), without adding a core table or `trace_id`
column. A persistent backend retains these across process restarts. Forked
Threads reset this state and receive a new trace. Parent IDs are deterministic;
already exported observations are never replayed to simulate history.

Export remains best-effort and cannot reconstruct events lost in an abrupt
process termination. Checkpoint flags are not delivery acknowledgements from
Langfuse. This is not an exactly-once telemetry journal.

The plugin owns its tracer and exporter. It uses explicit parent spans and does
not register a global OpenTelemetry provider or context manager. Background
batching is handled by the official SDK. Always await Controller disposal before
exiting a short-lived process so buffered observations can be flushed.

## Names, tags, prompts and scores

```ts
const tracing = new LangfusePlugin({
  traceName: "Support conversation", // Optional; defaults to Agent ID / Thread ID.
  tags: ["support", "production"],
  prompt: { name: "support-system", version: 3 }, // Optional existing Langfuse prompt.
});
```

Trace name and tags are propagated to every observation, including tools. A
tool's observation name remains its actual tool name, such as `get_weather`.
`prompt` links primary generations to a prompt in Langfuse Prompt Management;
it does not upload `buildInstruction()` content or link unrelated auxiliary calls.
See [Langfuse tags](https://langfuse.com/docs/observability/features/tags).

| Langfuse field | Source |
| --- | --- |
| Trace Name | `traceName`, or the Agent ID / Thread ID default, on every observation |
| Provided Model Name | The generation's configured model ID; `openrouter/free` remains that requested router alias |
| Prompt Name | Optional `prompt.name` and `prompt.version`, referring to an existing Langfuse prompt |
| Trace Tags | Optional application-defined `tags` |
| Time to First Token | First primary text/reasoning delta's time; absent if no such delta was emitted |
| Cost | Langfuse model pricing matched against the provided model name and reported usage |
| Score | Application evaluation or user feedback submitted through Langfuse's scoring SDK/API |

An arbitrary router alias may not match a priced model definition. Configure a
matching definition in Langfuse when needed; the plugin does not guess the
routed model, private prices, or zero cost. Provider usage details are retained
as metadata, but are not automatically converted into USD cost. See
[cost tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking).

Scores are separate from token usage and tool success. An application that
computes a score can install the optional official SDK:

```sh
npm install @langfuse/client @langfuse/tracing
```

```ts
import { LangfuseClient } from "@langfuse/client";
import { createTraceId } from "@langfuse/tracing";

const client = new LangfuseClient(); // Uses the same LANGFUSE_* environment variables.
const traceId = await createTraceId(threadId); // Same SHA-256 derivation as this plugin.
client.score.create({ traceId, name: "helpfulness", value: 1, dataType: "BOOLEAN" });
await client.flush();
```

Use a score your application actually measured; Tessar does not auto-score
responses. See [scores via SDK](https://langfuse.com/docs/evaluation/evaluation-methods/scores-via-sdk).
