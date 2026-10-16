# Tesseract Minimal Core Design

Status: implemented and locally verified on Windows. This English spec
supersedes the earlier core/public-API specs and their implementation plans.
The user explicitly requested this rewrite followed by native implementation.
Existing code is an unfinished migration, not a clean baseline to discard.

## Purpose and boundaries

Tesseract is an independent framework and SDK for CLI agents and agents embedded
in applications. Cube is a consumer. "Anything is a plugin" means a minimal
working runtime with public extension points, not a built-in product policy.

One main package, `@tesseract/core`, exports Agent, Controller, Session, Thread,
messages, tools, instructions, event constants/types and plugin contracts.
SDK describes these public APIs; it is not another package or runtime layer.
Agent directly owns the loop. Controller owns initialization and resources.
Session owns interaction, selection and its input queue. There is no separate
engine class, runtime port, binding adapter or second model/tool loop.
Agent delegates the turn, model and tool steps to internal functions in
`packages/core/src/loop.ts`. New input, resume and recovery enter the same loop;
admission, checkpoint commits, interruption handling and finalization remain
owned by Agent. This is an internal refactor with no public API change.

`@tesseract/openai` implements OpenAI protocol/auth/metadata. Storage adapters,
including `@tesseract/sqlite`, implement physical persistence. Core
owns state management and checkpoint semantics and has a default memory backend.
Core has no third-party runtime dependencies or Node filesystem/database imports.

## Plugin API

```ts
interface Plugin {
  readonly id: string;
  setup(tesseract: PluginContext): void | Disposer | Promise<void | Disposer>;
}

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

Built-in and user-defined plugins use the same class/instance convention:
`class MyPlugin implements Plugin`, instantiated with `new MyPlugin(options)`.
`Plugin` describes the instance contract; no base class is required. External
modules default-export an instance (`export default new MyPlugin()`), and the
loader passes it to the same core lifecycle without constructing it again.

`PluginContext` exposes hook, emit, tools.register, models.registerProvider,
storage.registerBackend, state.define, interruptions.register, effects.register,
registry.register and defer. The callback parameter is named `tesseract` in
examples/implementations. There is no `.on` alias and no required apiVersion.
Optional plugin version/configuration identifiers remain available for durable
continuation checks; ordinary plugins need not provide them.

`AgentEvents.BeforeTool === "tool.before"`. All public event constants are
strings without a `core.` prefix. An extensible TypeScript EventMap maps names
to payload/result/context types. There is no runtime event-definition object.
Callbacks receive `{ type, payload, ...executionIdentity }`. Discriminated
event unions support `event.type === AgentEvents.MessageDelta` narrowing.
Constants supply autocomplete. Plugin authors may augment EventMap for custom
events; custom notifications need no declaration at runtime. Custom transform,
decision or barrier hooks specify their kind at registration, stored per host.

Hooks execute in registration order. Transforms compose; deny/stop wins over
later allow/continue. Required policy/transform/barrier errors fail execution;
notification errors go to diagnostics. Host observers are never awaited policy.
Attach/detach affects new executions; captured registrations remain alive until
their executions release them. Setup failure rolls back; cleanup runs in reverse.
The selected storage backend cannot change after initialization.

## Public runtime

```ts
const agent = new Agent({ id: "assistant", model, instructions });
const controller = new Controller({ id: "application", agent, plugins });
await controller.initialize();
const session = controller.createSession({ scope: { userId: "u1" } });
await session.thread.create();
session.subscribe(event => render(event));
await session.followUp(new HumanMessage("Hello"));
```

Agent and Controller require nonempty developer-assigned IDs. Session has no
public ID or initialize/send/stream API. Constructors perform no I/O.
Concurrent initialize calls share a promise; failed initialization cleans up.
One Agent instance belongs to one Controller. Disposal closes runtime resources
and cancels active work without deleting durable pending requests or history.

Agent accepts immutable default model/instructions/limits. Controller accepts
`plugins?: readonly Plugin[]`, snapshots the initial list at construction and owns
plugin setup, registration, attach/detach and cleanup. Agent has no plugins option
or plugin-list property; its loop uses the Controller's registry.
Agent.stream({input, model?, scope?, context?, signal?, limits?}) creates an
independent Thread automatically and returns one event iterator attachment.
Agent.generate consumes the same execution to terminal outcome or suspension:
`{threadId, streamId, status, output, usage, interrupt, error}`. No second loop,
mandatory stream.result, or indefinite wait for human input. Explicit model
overrides do not mutate defaults. Missing model raises MissingModel.

Controller exposes models, plugins.attach/detach, createSession, createThread,
getThread(id, query?), listThreads(query?), deleteThread(id, query?),
forkThread(id, options?) and dispose. Thread exposes snapshot, stream,
getHistory, get/listCheckpoints, get/listStreams, listTurns, listModelAttempts,
listToolExecutions, get/listInterrupts, cancelStream and dispose.
Thread.stream takes exactly one of input, resume or recover. New input requires
an explicit model; resume/recover inherit checkpoint selection unless overridden.
All handle queries bind actual Thread identity/scope. Handle disposal preserves state.

Session exposes model, setModel, subscribe(all or typed), followUp, resume,
recover, abort, dispose and thread.create/switch/get/getId/list/rename/fork/
delete/getHistory. Scope is a plain scalar filter, not identity/auth/DI; no
per-operation Session scope overrides. Create selects; fork does not. Failed
switch preserves selection. Active execution makes changing selection/disposal
SessionBusy; suspended Threads can be left selected or switched away from.

followUp accepts an immutable input into a FIFO and returns `{id, threadId}`,
not a model result. Capture Thread and model at enqueue. Only admitted input is
durable. Completed executions drain the queue; suspended ones hold it;
failed/cancelled/stopped ones discard queued input with InputDiscarded events.
Resume/recover receipts `{threadId,streamId}` acknowledge durable admission.
Events route per Session instance even when two Sessions have identical scope.
Created is observable after factory return. Close has a required BeforeClose
barrier; observers cannot delay policy. Dispose does not delete a suspended Thread.
Closing blocks new Session work before awaiting the barrier. A failed barrier
leaves the Session usable; concurrent disposal shares the pending close operation.

## Data, execution and durability

HumanMessage, SystemMessage, AssistantMessage and ToolMessage preserve IDs,
ordered structured parts and opaque provider reasoning state. createTool and
Tool use one executor contract: JSON Schema plus an input parser, AbortSignal,
structured results/progress and optional reconciliation. No required schema library.
buildInstruction is pure ordered immutable composition with unique section IDs.
Context assembly uses full canonical history, not a UI history page. Snapshot
Agent instructions at admission; explicit transforms may adjust request context.

Each stream/turn/model attempt/tool execution has built-in trace records.
Terminal execution ends its active turn with a status, timestamp and error;
durable turn-end notifications follow checkpoint publication. BeforeTool stop
decisions stop the stream, and policy failures cannot become ordinary tool results.
Token/cache/reasoning usage has null unknowns, provenance and attempt deduplication.
Retry is explicit plugin policy; provider SDK implicit retries are disabled.
Auxiliary model calls and child reservations use the same trace/budget/lineage
mechanisms. Orchestration strategy remains plugin code.

State writes stage immutable checkpoints then publish atomically with head CAS,
fencing and commitId lookup after a lost acknowledgement. Publish before durable
notifications. Ownership uses unique process lease tokens, not Controller IDs.
SQLite must preserve the same semantics across processes. Agent/session-owned
plugin-state CAS transactions are explicit and separate from Thread checkpoints.

Suspension persists request, handler cursor, decision state and budgets, releases
the process attachment, and resumes the same stream with a new handle. Validate
and consume responses atomically once. Supported boundaries are BeforeStream,
BeforeTool, ModelSelect, ModelRecover and TurnDecision. Do not serialize JS stacks.
Recovery reuses committed results. Unknown external effects require reconciliation
or an explicit decision; they are never blindly repeated. Preserve schema and
interruption versions where persisted data really requires compatibility checks.

Fork only at an exact safe checkpoint/message boundary, inherit scope, isolate
future state, and do not copy pending work or count inherited usage again.
History pages are pinned to a checkpoint, chronological within each page.
Stream detach is independent of abort; observers have no iterator buffer.
Defaults: 32 turns, 64 model attempts, 128 tool calls, iterator buffer 512 events
or 4 MiB, page size 50/max 200, profile cache TTL 24 hours.

Model.profile is an automatic immutable snapshot; getters perform no network I/O.
Resolve exact provider/model/endpoint/account metadata, preserve provenance and
tiered prices, and use null for unknowns. Offline metadata does not block readiness.
OpenAI preserves available encrypted reasoning continuity and ordered tool calls.

## Scope and verification

Errors have an explicit component source: tesseract, provider, plugin, tool,
storage or application. There is no unknown source or blanket InternalError
classification. TesseractError represents framework failures. Provider/plugin
exceptions propagate without replacing their identity; checkpoint/trace records
store JSON error snapshots with source, name, code and available SDK fields.
OpenAI SDK failures remain SDK exceptions; adapter implementation failures remain
framework failures. AgentEvents.Diagnostic exposes diagnostic records to plugins
and isolates diagnostic handler failures without recursive emission.
The optional @tesseract/plugins/logger subpath writes lifecycle/error notifications to
stderr as JSON or a host-supplied write callback. Core owns no logging destination.

Host applications own UI, transport, auth and processes. Skills, long-term memory,
commands, compression, telemetry export and subagent strategies remain plugins.
TD-001 was deferred in the initial core phase and is now addressed for Node/npm
hosts by the [distribution extension](2026-10-15-plugin-distribution-design.md).
Imported plugin instances and runtime attach/detach continue to work.
Local plugin files need no additional installation when using only host-provided
APIs; imported npm dependencies must be available to the host's loader.

Reuse existing tests and memory/SQLite/provider implementations. Verify source
types, builds, hooks, runtime APIs, offline HTTP/SSE, actual SQLite processes and
built public-package consumers. Do not claim npm publication, Cube migration,
all provider support or automatic durability for arbitrary plugin I/O.

Local verification passed strict typecheck, all package/example builds, 97 unit
tests, 7 integration tests, package boundaries and the catalog-license pack check.
Integration tests include actual SQLite processes and CLI approval across restart.
OpenAI tests use HTTP/SSE fixtures; no live API call or hosted Linux CI was run.
The independent reviewer confirmed concrete defects but reached its usage limit
before its final report. Confirmed findings were fixed with regression checks;
the implementer completed the remaining inspection and verification.
