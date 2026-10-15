# Tesseract

An independent TypeScript framework and SDK for CLI agents and agents embedded
in applications. The core runs an agent; plugins supply capabilities and policy.

This repository contains workspace packages under development. They have not
been published to npm, and Cube has not been migrated.

| Package | Responsibility |
| --- | --- |
| `@tesseract/core` | Agent, Controller, Session, Thread, messages, tools, hooks, state, checkpoints and default memory storage |
| `@tesseract/openai` | OpenAI Responses adapter and provider metadata integration |
| `@tesseract/storage-sqlite` | Reference SQLite backend with atomic checkpoints and process fencing |

## Public API

```ts
import { Agent, Controller, HumanMessage } from "@tesseract/core";
import { OpenAIPlugin } from "@tesseract/openai";

const agent = new Agent({
  id: "assistant",
  model: { providerId: "openai", modelId: process.env.OPENAI_MODEL! },
  plugins: [OpenAIPlugin({ apiKey: process.env.OPENAI_API_KEY! })],
});
const controller = new Controller({ id: "application", agent });
await controller.initialize();

try {
  const result = await agent.generate({ input: new HumanMessage("Hello") });
  console.log(result.status, result.output);
} finally {
  await controller.dispose();
}
```

`generate` aggregates the same execution as `stream`; it may involve tools and
multiple model requests. It returns on completion or suspension. Alternatively,
consume `agent.stream(...)` with `for await`.

For a conversation, use a Session on the initialized Controller:

```ts
const session = controller.createSession({ scope: { userId: "u1" } });
await session.thread.create();
session.subscribe(event => console.log(event.type, event.payload));
await session.followUp(new HumanMessage("Hello"));
```

The receipt acknowledges queued input, not a final answer. Results arrive through
subscribe. Unadmitted queued input is in memory. Scope is a state filter; the host
owns authentication and authorization. Session has no public ID or initialize,
send or stream method. Controller and Agent require developer-assigned IDs.

## Plugins

```ts
import { AgentEvents, type Plugin } from "@tesseract/core";

const blockWrite: Plugin = {
  id: "block-write",
  setup(tesseract) {
    tesseract.hook(AgentEvents.BeforeTool, event => {
      if (event.payload.tool.name === "write") {
        return { decision: "deny", reason: "Write tool disabled" };
      }
    });
  },
};
```

Event constants are strings, such as `AgentEvents.BeforeTool === "tool.before"`.
Types provide autocomplete and inferred payloads/results. Plugins do not declare
apiVersion. Add imported plugin instances to Agent options or use
`controller.plugins.attach(plugin)` / `detach(id)` while ready.

[Plugin authoring](docs/plugin-authoring.md) describes tools, state, cleanup and
durability boundaries. Discovering/loading/installing plugin code after packaging
is deferred as TD-001. Core does not scan root directories or install dependencies.

## Storage, models and recovery

Core always manages state and checkpoints. Memory storage is the default; pass
`new SqliteStoragePlugin({ filename })` as a plugin for persistence. SQLite uses
Node's experimental synchronous SQLite API and is a reference implementation,
not a server throughput claim. Only the OpenAI adapter is shipped in this phase.

`controller.models.get(ref).profile` returns an automatic immutable snapshot.
Metadata may be incomplete/stale; unknown fields are null. Reading the getter
does not issue a network request. Provider metadata and bundled catalog fallbacks
use exact identities and preserve pricing provenance.

Suspension persists a request and cursor. Resume consumes a valid response once,
with the same stream ID and a new attachment. Unknown tool/effect outcomes require
reconciliation; checkpoints do not make arbitrary external I/O exactly-once.
Skills, long-term memory, commands, compression, subagent strategies and telemetry
export remain plugin/application concerns. Core supplies generic extension APIs.

## Development

Requires Node >=24.14.0 and pnpm 11.5.3.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm test:integration
pnpm check:boundaries

node examples/headless/dist/main.js
node examples/cli/dist/main.js hello
node examples/cli/dist/main.js hello --db ./state.db --approval
```

The last command prints a suspended execution with Thread/interrupt IDs. Resume
in a new process with `--db ./state.db --thread <id> --resume <interrupt-id> --approval`.
CLI uses a scripted provider by default; `--openai` requires OPENAI_API_KEY and
OPENAI_MODEL. No live API is required by the default checks.

Current authority: [English spec](docs/superpowers/specs/2026-10-15-tesseract-minimal-core-design.md)
and [English plan](docs/superpowers/plans/2026-10-15-tesseract-minimal-core-plan.md).
Earlier design documents are historical and are superseded by these documents.
