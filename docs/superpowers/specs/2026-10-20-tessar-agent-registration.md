# Agent identity and plugin registration

Status: implemented. Replaces the earlier proposal for a Controller subagents field.

## Scope

Keep the existing single configured Agent on Controller. Plugins decide how to
delegate, fork context, create fresh context, schedule work and launch processes.
No subagents option, built-in delegate tool, routing layer or Agent database table
is added.

## Identity

- Agent and Controller constructors reject duplicate live IDs with
  `RegistrationConflict`. Each class has its own ID namespace.
- Identity is local to the loaded core module, not a database uniqueness rule or
  a coordinator across processes or separate core copies.
- Reserve an ID only after successful validation. Failed Controller binding
  releases its reservation without binding or closing the candidate Agent.
- `await agent.shutdown()` and `await controller.dispose()` release their IDs.
  Repeated cleanup cannot release an ID belonging to a replacement instance.
- Weak references and finalization avoid retaining otherwise unreachable
  instances. Immediate ID reuse requires explicit cleanup, not reliance on GC.
- Completing a standalone call does not close its reusable Agent.

## Plugin API

```ts
class ResearchPlugin implements Plugin {
  readonly id = "research";
  setup(tessar: PluginContext): void {
    const agent = new Agent({ id: "researcher", model });
    tessar.agent.register(agent);
    // Invoke this instance from the plugin's own hooks or tools.
  }
}
```

Registration adds the Agent to the existing capability registry under kind
`agent` and its declared ID. Controller's configured Agent is already present.
Registry conflicts reject registration before transferring ownership.

Successfully registered Agents follow the plugin's existing resource lifecycle:
setup rollback closes them; detach hides them from new captures; existing
captures delay shutdown until released. Registration does not attach a Controller,
choose a model for another Agent, create a tool or start execution. A worker can
use standalone stream/generate with its own executable model and tools.

PluginManager already resolves external plugins' SDK imports to the host SDK.
The same registration API applies before and after packaging.

## Verification

- Seven focused identity/registration tests pass, including rollback, ID reuse
  and capture retention. Existing tests use unique standalone Agent IDs.
- All package builds, test typechecking and dependency boundary checks pass.
- Package suite: 236 passed; four PluginManager tests fail at child-process
  creation with `spawn EPERM`.
- Integration suite: six passed, three skipped; 15 tests require child processes
  blocked by this environment. Those tests cover examples (three), release
  validation (eight), plugin distribution (three), and public imports (one).
- Direct smoke against built packages loads an external TypeScript plugin,
  checks host constructor identity, registers and executes its worker, rejects a
  duplicate worker ID, then detaches and reuses that ID. No live provider called.
- The packed CLI integration fixture now exercises registration and worker
  execution, but packing/installing it remains unverified here due to `EPERM`.
