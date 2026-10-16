# Tesseract

An independent TypeScript framework and SDK for CLI agents and agents embedded
in applications. The core runs an agent; plugins supply capabilities and policy.

This repository contains workspace packages under development. They have not
been published to npm, and Cube has not been migrated.

| Package | Responsibility |
| --- | --- |
| `@tesseract/core` | Agent, Controller, Session, Thread, messages, tools, hooks, state, checkpoints and default memory storage |
| `@tesseract/openai` | OpenAI Responses adapter and provider metadata integration |
| `@tesseract/plugins` | Optional Node host utilities for discovery, loading and npm package management; logger plugin at `/logger` |
| `@tesseract/sqlite` | Reference SQLite backend with atomic checkpoints and process fencing |

## Public API

```ts
import { Agent, Controller, HumanMessage } from "@tesseract/core";
import { OpenAIPlugin } from "@tesseract/openai";

const agent = new Agent({
  id: "assistant",
  model: { providerId: "openai", modelId: process.env.OPENAI_MODEL! },
});
const controller = new Controller({
  id: "application",
  agent,
  plugins: [new OpenAIPlugin({ apiKey: process.env.OPENAI_API_KEY! })],
});
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

Import tool APIs directly when defining tools:

```ts
import { createTool, toolResult, type ToolDefinition } from "@tesseract/core/tool";
```

```ts
import { AgentEvents, type Plugin, type PluginContext } from "@tesseract/core";

class BlockWritePlugin implements Plugin {
  readonly id = "block-write";
  setup(tesseract: PluginContext): void {
    tesseract.hook(AgentEvents.BeforeTool, event => {
      if (event.payload.tool.name === "write") {
        return { decision: "deny", reason: "Write tool disabled" };
      }
    });
  }
}

const blockWrite = new BlockWritePlugin();
```

Event constants are strings, such as `AgentEvents.BeforeTool === "tool.before"`.
Types provide autocomplete and inferred payloads/results. Plugins do not declare
apiVersion. Built-in and custom plugins use classes instantiated with `new`.
`Plugin` describes the instance's ID and setup contract; no base class is required.
Add imported plugin instances to Controller options or use
`controller.plugins.attach(plugin)` / `detach(id)` while ready.

[Plugin authoring](docs/plugin-authoring.md) describes tools, state, cleanup and
durability boundaries. `@tesseract/plugins` provides opt-in discovery/loading and
npm install/update/remove for Node hosts. Core does not scan root directories or
install dependencies.

```ts
import { PluginManager } from "@tesseract/plugins";
import { resolve } from "node:path";

const manager = new PluginManager({
  directory: resolve(".tesseract"),
  hostUrl: import.meta.url,
});
// Pass await manager.load() to Controller's plugins.
// In finally: await controller.dispose(), then manager.dispose().
```

Put a default-exported plugin in `.tesseract/plugins/example.mjs` (or erasable
`.ts`). It imports the host's `@tesseract/core` without a separate SDK install.
Additional dependencies use normal Node resolution from the plugin environment.

The host chooses the directory name. The demo uses `.tesseract`; a consuming CLI
can use `.my-cli` instead:

```text
.my-cli/
├── plugins/                 # Custom files or folders with an index entry
│   ├── custom.mjs
│   └── my-plugin/index.mjs
├── plugins.json             # { "packages": ["some-plugin"] }
└── npm/
    ├── package.json         # npm dependencies
    ├── package-lock.json
    └── node_modules/
```

Custom plugins are discovered automatically. `install()` installs npm packages
under `npm/` and records their names in `plugins.json`. Loading never installs
missing packages. Local files can use their own nearby dependencies or dependencies
from the managed `npm/` environment. `@tesseract/core` resolves from the host.

## Logging

Add `new LoggerPlugin()` from `@tesseract/plugins/logger` to the Controller's `plugins` for JSON
logs on stderr. Supply `new LoggerPlugin({ write: entry => yourLogger.write(entry) })`
to choose another destination. Entries include event type, timestamp and execution
identity. Error payloads identify their source: `tesseract`, `provider`, `plugin`,
`tool`, `storage` or `application`, with the relevant provider/plugin/tool identity.
SDK exceptions keep their original object when thrown; trace/state store JSON error
records. Diagnostic hook failures are isolated to prevent recursive logging.
The subpath also default-exports the stderr logger plugin for
`PluginManager.load(["@tesseract/plugins/logger"])` when the package is available
in the configured directory's `npm/` environment. Core is an optional peer dependency; the
loader supplies the host's SDK without npm installing another copy.

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
node examples/cli/dist/main.js plugins list
node examples/cli/dist/main.js plugins install example-plugin
node examples/cli/dist/main.js plugins update example-plugin
node examples/cli/dist/main.js plugins remove example-plugin
```

The `hello --db ./state.db --approval` command prints a suspended execution with
Thread/interrupt IDs. Resume
in a new process with `--db ./state.db --thread <id> --resume <interrupt-id> --approval`.
CLI uses a scripted provider by default; `--openai` requires OPENAI_API_KEY and
OPENAI_MODEL. No live API is required by the default checks.

Current authority: [English spec](docs/superpowers/specs/2026-10-15-tesseract-minimal-core-design.md)
and [English plan](docs/superpowers/plans/2026-10-15-tesseract-minimal-core-plan.md).
Earlier design documents are historical and are superseded by these documents.
[Plugin distribution spec](docs/superpowers/specs/2026-10-15-plugin-distribution-design.md)
and [plan](docs/superpowers/plans/2026-10-15-plugin-distribution-plan.md) extend them
for Node/npm hosts. Standalone executable packaging requires its own runtime proof.
