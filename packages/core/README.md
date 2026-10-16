# @tessar/core

Tessar's TypeScript API for Agent, Controller, Session, Thread, messages,
tools, hooks, state and checkpoints. Requires Node 24.14 or newer.

```sh
npm install @tessar/core@next
```

- `Agent` owns its model/instructions/limits and the agent loop.
- `Controller({ id, agent, plugins })` owns plugin setup, resources and sessions.
- Call `controller.initialize()` before Agent or Session execution, and
  `controller.dispose()` when finished.
- `agent.stream()` creates an independent task; `agent.generate()` collects the
  same execution. A Session manages a continuing conversation with
  `session.subscribe()` and queued `session.followUp()` inputs.
- Core manages state and checkpoints, using memory storage by default.

```ts
import { Agent, Controller, HumanMessage, type Plugin } from "@tessar/core";
import { createTool, toolResult } from "@tessar/core/tool";
```

Built-in and custom plugins use classes instantiated with `new`, implementing
the same `Plugin` instance contract. Providers and persistence backends are
separate plugins: `@tessar/openai` and `@tessar/sqlite`.

This is an alpha release. See the
[repository](https://github.com/hphucdev-04/tesseract) for complete TypeScript
examples and the current API contracts. The bundled model catalog includes its
upstream license at `src/models/catalog.LICENSE`.
