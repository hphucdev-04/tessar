# Plugins

[All guides](README.md) · Next: [Storage](storage.md)

A plugin is a class instance implementing `Plugin`. Its `setup(tessar)` method
registers capabilities and hooks. Pass plugin instances to a Controller; their
setup and cleanup follow the Controller's lifecycle.

## Register a tool and extend instructions

Install the optional logger package:

```sh
npm install @tessar/plugins
```

Save as `plugins.ts` after the [setup](README.md).

```ts
import {
  Agent, Controller, buildInstruction, context,
  type Plugin, type PluginContext,
} from "@tessar/core";
import { createTool } from "@tessar/core/tool";
import { OpenAIProvider } from "@tessar/openai";
import { LoggerPlugin } from "@tessar/plugins/logger";
import { z } from "zod";

class AppInfoPlugin implements Plugin {
  readonly id = "app-info";

  setup(tessar: PluginContext): void {
    tessar.tools.register(createTool({
      name: "app_info",
      description: "Read the application's name.",
      schema: z.object({}),
      execute: () => ({ name: "My assistant" }),
    }));

    tessar.hook(context.prepare, event => ({
      ...event.payload,
      instructions: buildInstruction([
        ...event.payload.instructions.sections,
        {
          id: "app-info:instructions",
          order: 1000,
          content: "Use app_info when asked about this application.",
        },
      ]),
    }));
  }
}

const agent = new Agent({
  id: "assistant",
  model: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: process.env.OPENAI_MODEL!,
  }),
  instructions: "You are a concise assistant.",
});
const controller = new Controller({
  id: "my-app",
  agent,
  plugins: [new AppInfoPlugin(), new LoggerPlugin()],
});

try {
  await controller.initialize();
  console.log((await agent.generate("What application is this?")).output);
} finally {
  await controller.dispose();
}
```

`context.prepare` transforms a model request before it is sent. The example keeps
the existing request and instructions, then adds an ordered section. This affects
the prepared request; it does not rewrite stored conversation history. Section
order controls instruction placement independently of plugin discovery order.
The logger writes JSON entries to stderr by default.

## Hook and registration APIs

| API | Purpose |
| --- | --- |
| `tessar.tools.register(tool)` | Add an application tool |
| `tessar.models.register(provider)` | Add a model provider factory |
| `tessar.storage.register(backend)` | Select the Controller's storage backend |
| `tessar.agent.register(agent)` | Register an Agent owned by this plugin |
| `tessar.state.define(definition)` | Define checkpointed plugin state |
| `tessar.effects.register(definition)` | Define a tracked effect |
| `tessar.interruptions.register(definition)` | Define a resumable interruption |
| `tessar.registry.register(kind, id, value)` | Expose a custom capability |
| `tessar.hook(event, handler)` | Observe, transform or decide at an extension point |
| `tessar.defer(cleanup)` | Release resources when the plugin is disposed |

Import event maps such as `context`, `tool`, `message` and `stream` for
autocomplete. Their values remain ordinary event strings. Handler payloads and
return values depend on the hook; observation alone does not modify execution.
Hook context exposes captured capabilities through `registry.get()` and `list()`.

A provider instance on Agent already supplies its provider binding to Controller.
Do not register the same provider ID again through a plugin. Different provider
IDs can be added when your application needs a model catalog.

## Load plugins after packaging your CLI

Use this separate host example instead of the preceding one. Save as
`load-plugins.ts`; your CLI can choose any directory name.

```ts
import { Agent, Controller } from "@tessar/core";
import { OpenAIProvider } from "@tessar/openai";
import { PluginManager } from "@tessar/plugins";

const manager = new PluginManager({
  directory: ".my-cli",
  hostUrl: import.meta.url,
});
const agent = new Agent({
  id: "assistant",
  model: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: process.env.OPENAI_MODEL!,
  }),
});
let controller: Controller | undefined;
try {
  const userPlugins = await manager.load();
  controller = new Controller({ id: "my-cli", agent, plugins: userPlugins });
  await controller.initialize();
  console.log((await agent.generate("Hello")).output);
} finally {
  try { await controller?.dispose(); }
  finally { manager.dispose(); }
}
```

Users can place custom files in `.my-cli/plugins/`. For example, save this as
`.my-cli/plugins/local-info.ts`:

```ts
import { ready, type Plugin, type PluginContext } from "@tessar/core";

// For a custom file with no extra package dependencies, implement Plugin directly.
class LocalInfoPlugin implements Plugin {
  readonly id = "local-info";
  setup(tessar: PluginContext): void {
    tessar.hook(ready, () => { console.error("Local plugin loaded"); });
  }
}
export default new LocalInfoPlugin();
```

The loader supplies the host's `@tessar/core`; custom files do not need their own
core installation. Erasable TypeScript is supported. Other dependencies still
need to be available in the plugin's environment.

```text
.my-cli/
├── plugins/                 # Custom files, or directories with index entries
│   └── local-info.ts
├── plugins.json             # Installed plugin entry names
└── npm/                     # Managed npm package environment
    ├── package.json
    ├── package-lock.json
    └── node_modules/
```

For distributed plugin packages, expose `manager.install(source)`,
`manager.update(name)` and `manager.remove(name)` through your own CLI commands.
Installation records entries in `plugins.json`; `load()` discovers custom files
and loads configured packages, without installing missing dependencies. Tessar
does not impose a CLI command name. See [PluginManager](../../packages/plugins/README.md).

## Change active plugins without a manager

Controller accepts plugin instances. PluginManager only discovers/imports external
modules and manages npm packages; it does not run plugin setup or cleanup.

On an initialized Controller, an application can enable a logger for future
executions and later disable it, using an ordinary imported plugin:

```ts
await controller.plugins.attach(new LoggerPlugin());
// Execute work with logging enabled.
await controller.plugins.detach("logger");
```

These operations need no PluginManager. Existing executions keep their captured
plugin registrations until they release them; cleanup can therefore occur after
`detach()` resolves. Storage must be configured before initialization.

Applications with a fixed plugin list only need the constructor's `plugins` array
and `controller.dispose()` at shutdown. External plugins can use the same runtime
operations after a separate `manager.load()` call. Loading does not watch files,
activate plugins or filter IDs already attached to the Controller.
