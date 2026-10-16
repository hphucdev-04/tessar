# Writing a Tessar plugin

Use public exports from `@tessar/core`. Built-in and custom plugins are classes
instantiated with `new`. Implement `Plugin` to describe the instance's ID and setup
method; no base class or apiVersion is required. Setup receives `tessar: PluginContext`.

```ts
import { AgentEvents, createTool, toolResult, type Plugin, type PluginContext } from "@tessar/core";

export class GreetingPlugin implements Plugin {
  readonly id = "greeting";
  setup(tessar: PluginContext): void {
    tessar.tools.register(createTool({
      name: "greet",
      description: "Greet one person",
      input: {
        jsonSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
        parse(value) {
          if (!value || typeof value !== "object" || Array.isArray(value) ||
              Object.keys(value).length !== 1 || !("name" in value) ||
              typeof value.name !== "string") throw new TypeError("Expected a name");
          return { name: value.name };
        },
      },
      async execute(input) { return toolResult(`Hello, ${input.name}`); },
    }));
    tessar.hook(AgentEvents.ModelUsage, event => {
      console.log(event.payload.usage);
    });
  }
}

export default new GreetingPlugin();
```

The schema describes input to the model; parse validates untrusted arguments and
infers the executor's input type. Use your preferred validator if already present.
Core does not require a schema library. Both Tool and createTool use one executor.

## Hooks and lifecycle

`tessar.hook(AgentEvents.BeforeTool, handler)` registers a typed hook. Constants
are string values without a framework prefix. Transform hooks return replacements;
decision hooks return explicit allow/deny/continue/stop decisions. A later handler
cannot overturn a denial. Required handler failures stop execution; notification
errors go to Controller diagnostics. Notifications do not expose mutable execution
services. Session.subscribe is observation and is not awaited as a policy hook.

`AgentEvents.Diagnostic` exposes Controller diagnostics through the same hook API.
Error records carry an explicit source (`tessar`, `provider`, `plugin`, `tool`,
`storage`, `application`) and available component identity. Provider/plugin
exceptions retain their original objects in-process; JSON snapshots belong to
trace/state. A diagnostic handler failure is isolated without emitting another
diagnostic. `@tessar/plugins/logger` subscribes to lifecycle notifications and diagnostics;
its default writer emits JSON to stderr, and `write(entry)` selects another sink.

Custom events extend EventMap with HookSpec payload/result/context types. Their
default runtime behavior is notification; use the optional registration options
`{kind: "transformation" | "decision" | "barrier"}` for a custom non-notification
contract. A host rejects conflicting kinds/versions for an existing event name.

Setup may return a disposer or register cleanup with tessar.defer. Setup failure
rolls back its registrations. Captured executions keep detached plugin resources
alive until release; new executions see the updated registry. Storage is fixed
after initialization. Importing the core starts no runtime and performs no requests.

## State, interruption and external work

Use tessar.state.define for plugin namespaces, then state access at supported
transform/decision boundaries. Thread/stream/turn state participates in Thread
checkpoints. Explicit agent/session-owned CAS transactions have separate lifetimes;
they are not atomic with a Thread checkpoint or rewound by a Thread fork.

Register typed interruption contracts with tessar.interruptions.register.
Decision context.suspend persists a request and cursor; response resolution must
be deterministic. The host handles the UI and calls Session.resume later. Schema
and interruption versions protect actual persisted data, independently of plugin
setup. Optional plugin version/configuration identifiers guard continuation when
the host needs to detect changed code or configuration after restart.

Tool context models.stream tracks auxiliary usage. effects.execute checkpoints
intent/outcome for a registered effect; unknown outcomes need reconcile evidence.
executions.reserveChild records child lineage before dispatch. A child runs on a
separate Thread with the reserved origin. Thread.stream is available to plugin
authors through Controller; factories and subagents use the same Agent loop.

Raw I/O in an arbitrary callback is not automatically durable or exactly-once.
Plugins own skill sources, long-term memory storage, command syntax, compression
policy and subagent concurrency/process/result/error handling. Core supplies the
generic state, hooks, checkpoints, progress, cancellation and trace mechanisms.

## Distribution

During development, instantiate the plugin class with `new` and pass the instance
in Controller options. For external loading, default-export an instance, for example
`export default new GreetingPlugin()`. The loader passes that instance to core;
it does not instantiate classes or require a different plugin API.
Node hosts can also use `PluginManager` from the optional `@tessar/plugins`.
The host chooses its directory, calls load before constructing Controller and keeps
the manager alive through Controller disposal. Use a finally block even if loading
or initialization fails. The loader does not call setup or install missing packages.

```ts
const manager = new PluginManager({ directory: resolve(".tessar"), hostUrl: import.meta.url });
let controller: Controller | undefined;
try {
  const agent = new Agent({ id: "host", model });
  controller = new Controller({ id: "host", agent, plugins: await manager.load() });
  await controller.initialize();
  // Use the ordinary Agent/Session APIs.
} finally {
  try { await controller?.dispose(); }
  finally { manager.dispose(); }
}
```

Discovery loads sorted files from `<directory>/plugins`, followed by package
names in `<directory>/plugins.json`'s `packages` array. Each module must
default-export a Plugin object. A plugin folder can expose `index.mjs`, `index.js`,
`index.cjs`, `index.mts`, `index.ts` or `index.cts`. Put helper modules inside that
folder; top-level files in plugins are treated as entry points. Declaration files
are ignored. `load(["./custom.mjs", "some-package"])` selects explicit sources
instead; relative paths resolve from the configured directory, while packages
resolve from `<directory>/npm/`.

```json
{
  "packages": ["some-plugin", "@scope/another-plugin"]
}
```

Custom files in `plugins/` do not need entries in this configuration. The npm
manifest and lockfile live at `npm/package.json` and `npm/package-lock.json`,
with installed packages in `npm/node_modules/`. The host chooses the root directory
name; `.tessar` is only the demo's default. Constructors and loading do not
create this layout; `install()` creates the npm environment when needed. Custom
plugin directories are created by the host or user.

Local plugins may import the host's public `@tessar/core` exports, including
AgentEvents/createTool/message classes, without installing another SDK copy.
Scoped Node hooks map SDK imports in the plugin graph to the host, including lazy
imports. Other imports resolve normally relative to the importing file; missing
bare package imports can also resolve from the managed `npm/` environment, with
the original import/require conditions. Dispose
the manager after runtime shutdown to deregister those hooks.

Node 24.14+ directly executes local erasable TypeScript. It does not process
tsconfig aliases, TSX, enums or parameter-property transforms. npm packages must
publish JavaScript and declare a compatible `@tessar/core` peer dependency.
Mark that peer optional to avoid npm installing a separate SDK copy; use a
development dependency to build and typecheck the plugin.
The loader supplies the host SDK; it does not adapt incompatible APIs or invent a
separate apiVersion. Existing plugin/interruption versions still guard saved work.

`install(source, {name?})`, `update(name?)` and `remove(name)` delegate to installed
npm in `<directory>/npm/`. The default source can be an npm package/version
or a local package directory. Git/URL/tarball sources should provide their package
name, e.g. `install("git+https://example.com/team/plugin.git#v1", {name: "my-plugin"})`.
The demo CLI accepts `plugins install <source> --name <package>` and `--plugin-dir`.
CLI local paths resolve from the shell's working directory; PluginManager API
local paths resolve from its configured directory. An explicit package name must
match the source's package metadata, even if that name is already a helper dependency.
Only successfully installed plugin names enter `plugins.json`'s `packages` array;
other direct dependencies remain helpers. Existing config/manifest fields and npm
lockfiles are preserved. `remove()` removes the package through npm, then removes
its configuration entry; it does not delete custom files.
Install saves exact versions; update obeys saved dependency constraints. Install an
explicit newer version to move outside them. Await operations and use a single
mutating process per directory. npm may run package lifecycle scripts, and a failed
npm operation is not an atomic rollback of its filesystem changes.

Loading executes trusted code. Module evaluation side effects are not rolled back.
Node caches modules, so restart the host after changing/updating a module on disk.
Runtime attach/detach still works with loaded plugin objects. This is verified for
Node/npm hosts; Bun-compiled binaries and Node SEA require separate packaging tests.

The earlier flat layout (`package.json` with `tessar.plugins` at the manager
root) is replaced. For an existing environment, put the chosen package names in
`plugins.json` and reinstall those packages through the manager into `npm/`.
Existing files are not moved or deleted automatically.
