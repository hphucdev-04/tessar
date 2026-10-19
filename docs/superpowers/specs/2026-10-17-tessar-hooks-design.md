# Unified Tessar hook contract

Date: 2026-10-17.

Status: implemented in `packages/core/src/events/type.ts`. The shared catalog has
62 built-in events: 54 existing boundaries, five operation decisions and three
successful thread notifications. All use the same registration and dispatcher.

## Agreed acceptance criterion

Plugins must be able to implement the agreed extension use cases through public
contracts, with the correct execution/session/thread context, supported
interception boundaries and their own state. Core supplies execution mechanisms;
plugins and hosts own specialized behavior and policy.

Evaluate this against concrete plugin flows, not event counts, constant names or
a mechanically complete before/during/after set. A missing public capability is
not fixed by adding a notification with no actionable contract.

## Shared architecture

- All built-in and plugin-defined events use the same EventMap, registration API
  (`tessar.hook`) and dispatch mechanism. Agent, Controller, Session and Thread
  identify where an operation happens; they do not introduce separate buses.
- Event identifiers remain strings. The type map and exported constants provide
  payload/result/context typing and autocomplete. Import groups directly:
  `model.select`, `tool.before`, `session.created`. Hyphenated string segments
  use camelCase keys: `thread.beforeDelete === "thread.before-delete"` and
  `session.model.beforeChange === "session.model.before-change"`. There is no
  `events` root prefix. AgentEvents/SessionEvents are replaced; string identifiers
  remain unchanged. Names do not define routing, authorization or isolation.
- Each Controller owns its plugin registrations and context. A shared mechanism
  does not mean a process-global bus that mixes unrelated users or applications.
- A hook is justified by a concrete extension capability: observe, transform,
  decide, or await work before proceeding. Do not generate before/after events
  mechanically for every method.
- Tools, models, storage and state/control APIs are extension contracts alongside
  hooks. Notifications cannot substitute for an API that performs an action.

## Existing dispatch contracts

| Kind | Result and ordering | Handler failure |
| --- | --- | --- |
| Notification (N) | Handlers are awaited in registration order by dispatch; return values do not alter the operation. Some callers, including Session notifications, dispatch without awaiting completion. | Report a diagnostic and continue. |
| Transformation (T) | A returned value becomes the next handler's payload. Undefined preserves the previous value. Call sites validate protected identity/scope fields. | Propagate; the operation does not silently continue. |
| Decision (D) | Return an action supported by that boundary. Execution boundaries may suspend through the registered interruption/checkpoint contract. Deny/stop is not overwritten by a later permissive result. | Propagate. |
| Barrier (B) | Await handlers before proceeding. Return values do not transform payloads. | Propagate to the caller; actual persisted effects depend on the operation boundary. |

Execution captures its registrations for continuation. Attaching a plugin affects
new executions after successful setup; detaching it does not rewrite the captured
registration set of an execution already using it.

## Lifecycle placement and hook authority

Lifecycle placement and handler authority are separate properties. An event's
position in the flow does not automatically make it mutable or cancellable.

- Before work: preparation transforms inputs; a decision boundary can authorize,
  reject or perform another action explicitly supported by that boundary.
- During work: start/update/delta events report actual ongoing work. Progress may
  occur zero or many times. It does not permit arbitrary checkpoint suspension.
- Once a result exists: a result transform may run before persistence; an end or
  committed notification describes the outcome at its documented boundary.
- On failure: error/recovery boundaries have their own contracts.

For example, the tool path has prepare/before/start/update/result/end boundaries.
Long-running streams naturally expose deltas or progress. Short operations such
as selecting a model or renaming a thread need no fabricated "during" phase.

## Existing built-in inventory

N is the default below. T, D and B are annotated explicitly.

| Operation | Events |
| --- | --- |
| Runtime lifecycle | `ready`, `shutdown` (B), `diagnostic` |
| Session lifecycle | `session.created`, `session.before-close` (B), `session.closed` |
| Session model selection | `session.model-changed` |
| Session thread management | `session.thread-created`, `session.thread-switched`, `session.thread-renamed`, `session.thread-forked`, `session.thread-deleted` |
| Session input queue | `session.input-queued`, `session.input-discarded` |
| Thread lifecycle | `thread.prepare` (T), `thread.started`, `thread.updated`, `thread.before-shutdown` (B), `thread.shutdown` |
| Input | `input.prepare` (T), `input.received` |
| Execution stream | `stream.before` (D), `stream.started`, `stream.before-end` (B), `stream.end`, `stream.error`, `stream.suspended`, `stream.resumed`, `stream.cancel` |
| Turn | `turn.start`, `turn.end`, `turn.decision` (D) |
| Request context | `context.prepare` (T), `tools.select` (T) |
| Model | `model.select` (D), `model.request` (T), `model.start`, `model.response` (T), `model.end`, `model.usage`, `model.error`, `model.recover` (D) |
| Message | `message.prepare` (T), `message.before-commit` (B), `message.delta`, `message.committed` |
| Tool | `tool.prepare` (T), `tool.before` (D), `tool.start`, `tool.update`, `tool.result` (T), `tool.end`, `tool.error` |
| Checkpoint | `checkpoint.committed` |

The original inventory has 54 events: 35 N, 9 T, 5 D, 5 B. With the implemented
additions below, the total is 62: 38 N, 9 T, 10 D, 5 B.

### Important boundary distinctions

- `model.select` decides the executable model for a model request. A Session's
  `session.model-changed` reports a change to its selected model. They describe
  different operations and have different return contracts.
- `thread.updated` currently follows an execution checkpoint commit. It does not
  represent every rename, fork or delete performed through Controller APIs.
- `session.thread-*` notifications describe operations performed through a
  Session. Direct Controller thread operations do not automatically emit them.
- `ModelRequest` is Tessar's normalized request before provider serialization;
  it is not the final HTTP body, headers or provider-native streaming event.
- Execution transformation/decision hooks receive state and tracked execution
  services. Session hooks receive typed Session capabilities. Execution hooks
  receive Session/Thread handles when invoked through those handles, including
  resume, recovery and cancellation. One EventMap does not imply identical context.

## Implemented Controller/Session additions

These decisions authorize concrete operations before mutation. Each handler may
return allow/deny/undefined only; undefined allows. Invalid results fail immediately
with InvalidHookResult, even if a later handler would allow. Denial remains sticky
and rejects with OperationDenied. Handler exceptions propagate to the caller.

| Event string | Purpose | Permitted decisions |
| --- | --- | --- |
| `session.model.before-change` | Validate a requested Session model/connection change before assigning it or emitting ModelChanged. | Allow or deny. |
| `session.thread.before-switch` | Validate selection of the target thread before replacing the current Session selection. | Allow or deny. |
| `thread.before-fork` | Enforce fork policy before creating the target branch, including direct Controller calls. | Allow or deny. |
| `thread.before-rename` | Enforce rename policy before changing the persisted title. | Allow or deny. |
| `thread.before-delete` | Enforce delete policy before changing persisted state. | Allow or deny. |

The corresponding successful-after notifications must cover the shared operation
path, including direct Controller calls:

| Decision boundary | Successful-after notification | Notification status |
| --- | --- | --- |
| `session.model.before-change` | `session.model-changed` | Already implemented. |
| `session.thread.before-switch` | `session.thread-switched` | Already implemented. |
| `thread.before-fork` | `thread.forked` | Implemented. |
| `thread.before-rename` | `thread.renamed` | Implemented. |
| `thread.before-delete` | `thread.deleted` | Implemented. |

A denied or failed operation does not emit its successful-after notification.
These are concrete operation boundaries, not a rule to manufacture symmetric
events for every API method.

`await session.setModel(model)` waits for policy before assigning the model. Queue
entries retain their accepted model/thread snapshot. Concurrent/reentrant Session
control mutations reject with SessionBusy; readiness and target state are checked
again after awaited policies. Reads and queued input remain available. These
boundaries do not acquire execution suspension/resume semantics. Existing scope
and storage busy checks remain mandatory after a hook allows work.

SessionHookHandle exposes scope, model, setModel, thread operations and followUp;
ThreadHookHandle exposes identity/scope and read APIs. Session hooks require their
Session capability. Shared thread operations expose their Thread capability, and
execution handles follow the caller through admission/continuation/cancellation.
They are actual objects narrowed by types for trusted plugins, not a sandbox.
Await-dependent active-execution methods are excluded from the capability types.
No handle or client is persisted into event payloads/checkpoints. After deletion,
reads through that Thread naturally fail with ThreadNotFound.

Model instance registration remains the separately agreed Controller/Session
design direction and is not implemented by this hook change.

Compression, skills, memory policy, slash commands, subagents and UI remain
plugin/host behavior. Their generic state/context/control requirements must be
validated without putting their policies into core. Provider-native telemetry
can use adapter/plugin-defined events through the same extension mechanism.

## Verification

The implementation plan records current test/build/review evidence. Tests cover
policy ordering and invalid results, denial/storage failure without success,
scope isolation, reentrant controls, awaited selection races and execution handle
routing. Provider account/API behavior and specialized plugins are outside this
verification.
