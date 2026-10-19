# @tessar/plugins

Optional Node host utilities for loading plugins after an application is packaged,
managing npm plugin packages, and structured logging. Requires Node 24.14 or newer.

```sh
npm install @tessar/core @tessar/plugins
```

```ts
import { PluginManager } from "@tessar/plugins";
import { LoggerPlugin } from "@tessar/plugins/logger";

const manager = new PluginManager({
  directory: ".my-cli",
  hostUrl: import.meta.url,
});
const plugins = [new LoggerPlugin(), ...await manager.load()];
// Pass plugins to new Controller({ id, agent, plugins }).
// Dispose Controller first, then call manager.dispose() in finally.
```

Custom files under `plugins/`, or folders with an index entry, default-export a
plugin instance. The manager supplies the host's public `@tessar/core` imports.
Erasable TypeScript custom files are supported; npm packages publish JavaScript.

`install(source)`, `update(name?)` and `remove(name)` use npm in the managed `npm/`
subdirectory. Installed package names are recorded in `plugins.json` under
`packages`; custom files are discovered automatically. `load()` never installs
missing dependencies. A consuming CLI chooses its own command name and directory.

Logger writes JSON lifecycle/error entries to stderr by default. Use
`new LoggerPlugin({ write: entry => yourLogger.write(entry) })` for another sink.

This is an early 0.x release. See the
[repository](https://github.com/hphucdev-04/tessar) for usage and contracts.
