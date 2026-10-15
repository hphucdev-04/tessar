# Writing a Tesseract plugin

Use public exports from `@tesseract/core`. A plugin has an ID and setup callback;
the callback receives `tesseract: PluginContext`. No apiVersion is required.

```ts
import { AgentEvents, createTool, toolResult, type Plugin } from "@tesseract/core";

export const greeting: Plugin = {
  id: "greeting",
  setup(tesseract) {
    tesseract.tools.register(createTool({
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
    tesseract.hook(AgentEvents.ModelUsage, event => {
      console.log(event.payload.usage);
    });
  },
};
```

The schema describes input to the model; parse validates untrusted arguments and
infers the executor's input type. Use your preferred validator if already present.
Core does not require a schema library. Both Tool and createTool use one executor.

## Hooks and lifecycle

`tesseract.hook(AgentEvents.BeforeTool, handler)` registers a typed hook. Constants
are string values without a framework prefix. Transform hooks return replacements;
decision hooks return explicit allow/deny/continue/stop decisions. A later handler
cannot overturn a denial. Required handler failures stop execution; notification
errors go to Controller diagnostics. Notifications do not expose mutable execution
services. Session.subscribe is observation and is not awaited as a policy hook.

Custom events extend EventMap with HookSpec payload/result/context types. Their
default runtime behavior is notification; use the optional registration options
`{kind: "transformation" | "decision" | "barrier"}` for a custom non-notification
contract. A host rejects conflicting kinds/versions for an existing event name.

Setup may return a disposer or register cleanup with tesseract.defer. Setup failure
rolls back its registrations. Captured executions keep detached plugin resources
alive until release; new executions see the updated registry. Storage is fixed
after initialization. Importing the core starts no runtime and performs no requests.

## State, interruption and external work

Use tesseract.state.define for plugin namespaces, then state access at supported
transform/decision boundaries. Thread/stream/turn state participates in Thread
checkpoints. Explicit agent/session-owned CAS transactions have separate lifetimes;
they are not atomic with a Thread checkpoint or rewound by a Thread fork.

Register typed interruption contracts with tesseract.interruptions.register.
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

During development, import the plugin object and pass it in Agent options. A CLI
can package those imports and dependencies for its users. Local files can use only
the host-provided API and need no runtime SDK import. Any additional imported npm
dependency must be resolvable from the plugin's environment. The CLI/application
owns discovery/loading and installation; these facilities remain deferred as TD-001.
