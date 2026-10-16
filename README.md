# Tessar

An independent TypeScript framework and SDK for CLI agents and agents embedded
in applications. The core runs an agent; plugins supply capabilities and policy.

This repository contains workspace packages under development. They have not
been published to npm, and Cube has not been migrated.

| Package | Responsibility |
| --- | --- |
| `@tessar/core` | Agent, Controller, Session, Thread, messages, tools, hooks, state, checkpoints and default memory storage |
| `@tessar/openai` | OpenAI Responses adapter and provider metadata integration |
| `@tessar/plugins` | Optional Node host utilities for discovery, loading and npm package management; logger plugin at `/logger` |
| `@tessar/sqlite` | Reference SQLite backend with atomic checkpoints and process fencing |

## Public API

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
import { createTool, toolResult, type ToolDefinition } from "@tessar/core/tool";
```

```ts
import { AgentEvents, type Plugin, type PluginContext } from "@tessar/core";

class BlockWritePlugin implements Plugin {
  readonly id = "block-write";
  setup(tessar: PluginContext): void {
    tessar.hook(AgentEvents.BeforeTool, event => {
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
durability boundaries. `@tessar/plugins` provides opt-in discovery/loading and
npm install/update/remove for Node hosts. Core does not scan root directories or
install dependencies.

```ts
import { PluginManager } from "@tessar/plugins";
import { resolve } from "node:path";

const manager = new PluginManager({
  directory: resolve(".tessar"),
  hostUrl: import.meta.url,
});
// Pass await manager.load() to Controller's plugins.
// In finally: await controller.dispose(), then manager.dispose().
```

Put a default-exported plugin in `.tessar/plugins/example.mjs` (or erasable
`.ts`). It imports the host's `@tessar/core` without a separate SDK install.
Additional dependencies use normal Node resolution from the plugin environment.

The host chooses the directory name. The demo uses `.tessar`; a consuming CLI
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
from the managed `npm/` environment. `@tessar/core` resolves from the host.

## Logging

Add `new LoggerPlugin()` from `@tessar/plugins/logger` to the Controller's `plugins` for JSON
logs on stderr. Supply `new LoggerPlugin({ write: entry => yourLogger.write(entry) })`
to choose another destination. Entries include event type, timestamp and execution
identity. Error payloads identify their source: `tessar`, `provider`, `plugin`,
`tool`, `storage` or `application`, with the relevant provider/plugin/tool identity.
SDK exceptions keep their original object when thrown; trace/state store JSON error
records. Diagnostic hook failures are isolated to prevent recursive logging.
The subpath also default-exports the stderr logger plugin for
`PluginManager.load(["@tessar/plugins/logger"])` when the package is available
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

## Publishing

The four public packages share one release version. Update `version` in
`packages/{core,openai,plugins,sqlite}/package.json` together; the private workspace
root's version is not used for publishing. Commit the version changes before
creating the matching Git tag, for example:

```sh
git tag v0.1.0
git push origin v0.1.0
```

`.github/workflows/release.yml` calls the existing Ubuntu/Windows CI, validates
the tag against all four package versions, builds and packs with pnpm, and checks
the actual archives before publishing. Stable versions use `latest`; prereleases
such as `v0.2.0-beta.1` use `next`. Archives are saved as a workflow artifact.
Packages publish sequentially: core, OpenAI, plugins, SQLite.

Configure npm Trusted Publishing for **each package** with GitHub owner
`hphucdev-04`, repository `tessar`, workflow filename `release.yml`, no environment,
and **Allow npm publish** enabled. The publish job uses OIDC; no `NPM_TOKEN` secret
is needed. See [npm's trusted publisher setup](https://docs.npmjs.com/trusted-publishers/).
If the packages do not exist yet, publish their first versions from a logged-in
terminal, then configure their trusted publishers. For that first publish, build
and pack locally with pnpm and use `npm publish <archive.tgz> --access public
--tag next` for the current alpha, or `--tag latest` for a stable version.

To check the current alpha locally without publishing (PowerShell):

```powershell
$env:RELEASE_TAG = 'v0.1.0-alpha.0'
node scripts/release.mjs check
pnpm build
pnpm --filter './packages/*' -r pack --pack-destination "$PWD/dist/release"
node scripts/release.mjs verify
```

Publishing several npm packages is not atomic. If a publish fails after an earlier
package succeeds, keep the saved archives, inspect which versions reached npm, and
publish only the missing packages. A full rerun does not skip published versions.

Current authority: [English spec](docs/superpowers/specs/2026-10-15-tessar-minimal-core-design.md)
and [English plan](docs/superpowers/plans/2026-10-15-tessar-minimal-core-plan.md).
Earlier design documents are historical and are superseded by these documents.
[Plugin distribution spec](docs/superpowers/specs/2026-10-15-plugin-distribution-design.md)
and [plan](docs/superpowers/plans/2026-10-15-plugin-distribution-plan.md) extend them
for Node/npm hosts. Standalone executable packaging requires its own runtime proof.
