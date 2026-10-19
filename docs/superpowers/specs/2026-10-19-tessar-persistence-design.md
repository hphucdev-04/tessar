# Tessar persistence revision

Date: 2026-10-19

Status: implemented and verified on 2026-10-19. Agent-table proposal withdrawn by the user.

## Intent and authorization

The user requested optimization of the audited persistence implementation, a
Session table, and an explanation of storage for
a hypothetical background-task plugin. This design covers those requirements.
It does not implement a background-task plugin or make one part of core.

Core owns persistence semantics. Backend plugins select the storage technology.
Agent remains independently executable; constructing an Agent performs no DB I/O.
Controller initializes shared resources. Plugins remain attached to Controller.
Scope remains a scalar filter and does not become an authentication service.

Existing dirty work must be preserved. No package publication, dependency changes,
commit, or automatic deletion of user data is part of this work.

## Evidence from the audit

1. Memory and SQLite accept a valid lease for thread A when publishing a batch
   for thread B. Ownership validation must bind the lease to the publication target.
2. Recreating OpenAIProvider with identical configuration creates a new random
   connection identity. SQLite history survives, but native assistant continuity
   fails validation on the next turn. Both protocol codecs exhibit this behavior;
   the Responses path was also reproduced through Controller and a reopened DB.
3. One hundred messages followed by two renames produce three checkpoints,
   three hundred message rows, and three retained staging batches.
4. History reads deserialize full checkpoints. List queries load collections and
   paginate/filter in memory. Existing indexes do not solve this access pattern.
5. Plugin state is persisted inside checkpoint state; the plugin_states record
   table is not populated by normal plugin-state updates.
6. Session selection and its input queue are process-local. There is no Session
   record. Some trace timing fields are never completed. Delete is soft-only.

Existing focused checks: 22 passed; three subprocess checks skipped in this
environment. Six temporary audit checks reproduced the findings; they were
removed after review. Provider checks used fake HTTP/SSE, not live credentials.

## Alternatives and recommendation

| Approach | Benefit | Cost |
| --- | --- | --- |
| Retain full physical snapshots, add entities | Smallest migration | Retains write amplification and expensive history queries |
| Version changed messages and records, reconstruct logical checkpoints | Preserves existing snapshot semantics while reducing duplicate writes | Requires migration and indexed revision queries |
| Replace state with an event log and reducers | Potentially compact event history | Changes the runtime/recovery model and adds replay complexity |

Recommend the second approach. Checkpoint remains the public, consistent snapshot.
Its physical representation need not contain another full copy of every message
and trace record. Do not introduce event sourcing or a second execution engine.

## Logical ownership

| Entity | Responsibility |
| --- | --- |
| Agent | Executable definition in application code; never stored in a dedicated table |
| Session | Durable working context: agent reference, scope, selected thread/model, metadata |
| Thread | Conversation identity and history, independent of Session lifetime |
| Checkpoint | Immutable version of thread state and continuation position |
| Stream/turn/attempt/tool/interrupt | Execution accounting and recovery records |
| Plugin state | Namespaced extension data with explicit owner and revision |

A thread has no mandatory Session parent: standalone execution, subagents and
multiple Session handles must continue to work. A Session selects a thread; it
does not own or duplicate that thread's history. Thread listing remains scoped,
not implicitly restricted to threads created by one Session.

## Agent remains application code

User decision: no agents table, descriptor, registration write or serialized Agent factory. Session.agentId identifies the Agent constructed by the host; restoration checks that identity. Agent execution remains independent of Controller and storage.

## Proposed Session record and API

| Field | Meaning |
| --- | --- |
| id | Automatically generated durable identity, exposed as session.id |
| agentId | Identity of the Agent supplied by application code (no FK) |
| scope | Immutable scalar scope filter |
| metadata | Application-owned JSON data |
| selectedThreadId | Nullable reference to the selected conversation |
| selectedModel | Provider/model/connection reference and serializable request options |
| revision | Compare-and-set revision for Session mutations |
| createdAt / updatedAt | Persistent timestamps |

Proposed public entry points (API changes requiring review):

```ts
const session = await controller.createSession({
  scope: { userId: "user-1" },
  metadata: {},
});

await session.thread.create({ title: "Research" });
const sessionId = session.id;

// In a later runtime, after registering compatible Agent/providers/plugins:
const restored = await controller.getSession(sessionId, {
  scope: { userId: "user-1" },
});
```

`createSession` becomes async so success means the initial record is committed.
This is an explicit breaking change from the current synchronous factory.
`getSession` returns a restored Session handle or null when missing/out of scope;
it checks that the Controller has the required Agent before returning a handle.
`listSessions` returns paginated Session descriptors without starting work.

Selection and model mutations must commit before changing the visible handle
and emitting success notifications. Concurrent handles use revision checks;
stale writes fail instead of silently overwriting another handle's selection.
Thread creation plus initial selection must have a defined failure outcome:
the thread may exist if a subsequent Session CAS fails, but the operation must
report failure and must not emit a successful selection notification. The thread
remains discoverable through scoped thread listing; it is not partially written.

Deleting a selected thread clears persistent Session references in the backend
transaction. Existing handles must revalidate their selection before admitting
new work. Disposing a Session closes its runtime attachment; it does not delete
the durable record or mark a suspended execution completed.

The existing followUp queue remains in memory in this revision. A queued-input
receipt does not claim durability; InputCommitted is the durable boundary. A
durable inbox, automatic replay, retry policy and scheduling are separate work.
Restoring a Session never starts queued jobs or recovers executions automatically.

Subscriptions, AbortController instances, SDK clients and active promises are
recreated by application/runtime code. They are not columns in the Session table.

## Physical SQLite representation

Use a schema migration from version 1 to version 2. Keep logical Checkpoint
objects unchanged at the public boundary where practical.

| Table/group | Proposed responsibility |
| --- | --- |
| sessions | Session records and indexed agent/selection/timestamp columns |
| threads | Current thread head with indexed query columns |
| checkpoints | Immutable checkpoint metadata, execution cursor, instructions and plugin state; history hydrated from versioned messages |
| messages | Message versions with thread ID, position, valid-from revision and exclusive valid-to revision |
| streams, turns, model_attempts, tool_executions, interrupts | Changed record versions with revision intervals and indexed relationship columns |
| staging | Unpublished batches only |
| commits | Durable idempotency receipts plus payload fingerprint |
| leases | Thread-bound ownership and fencing |
| owned_states | Independently committed plugin state for agent/session owners |

Remove the unused plugin_states projection from the normal execution-record
path. Preserve all actual checkpoint plugin state. Migration must detect any
nonempty legacy plugin_states rows and refuse a lossy migration rather than
silently discard custom data.

Versioned rows are visible at revision R when `from_revision <= R` and
`to_revision IS NULL OR R < to_revision`. Insert a new version only when its
canonical data or ordering changes. A rename does not copy message/trace rows.
Public checkpoint reads reconstruct exactly the state at that revision.
The engine still needs a full logical context; this work does not promise to
eliminate all in-memory snapshot copies or introduce incremental model context.

Index actual queries: thread and revision, history position, stream/turn parent
IDs, record IDs, Session agent/selected-thread, and stable pagination keys.
Scope supports arbitrary scalar keys; use parameterized JSON predicates to
filter in SQL. Do not claim an index for every arbitrary user-defined key.
Do not hardcode userId/workspaceId into the generic storage contract.

Move pagination/filtering to backend query ports, with equivalent memory-backend
semantics. History cursors remain checkpoint-bound; use consistent ordinal
ordering for cursor comparisons in both backends. Metadata-only checkpoint lists
must not hydrate every historical conversation.

## Atomicity, retries and cleanup

Validate `lease.threadId === request.threadId === batch.threadId` in both
backends. Keep fencing, expiry, expected revision and parent checks.

Publish changed versions, checkpoint, thread head and commit receipt in one
transaction. The publish transaction also removes the staged payload.
Retain a canonical payload fingerprint with the receipt so retrying the same
commit succeeds, while reusing its ID with another payload fails after cleanup.
Failed/unpublished batches remain inspectable; do not replay them blindly.

Use FK constraints where lifetime ownership is clear, including versioned rows
and checkpoints belonging to a thread. Keep lineage preservation explicit;
do not introduce cascades that delete descendants or break a fork's history.

Keep soft delete as the existing default. Add explicit permanent cleanup for a
soft-deleted, inactive thread only; reject cleanup while another thread retains
a lineage dependency. Clear Session selections and remove dependent execution,
checkpoint and commit data transactionally. Do not enable automatic retention
that removes history/checkpoints without the application opting in.

Migrate all checkpoints in revision order and compare hydrated before/after
snapshots, IDs, plugin state, trace versions and receipts. Roll back fully on
failure. Do not reset user databases or regenerate identities. Existing random
provider-connection IDs require explicit application-authorized rebinding;
migration must not guess their original endpoint or credential boundary.

## Provider continuity through restart

Connection identity must describe a resumable binding, not merely a new object.
Propose an optional explicit `connectionId` in provider construction for durable
bindings. It is Tessar configuration, never part of a provider request body.

```ts
new OpenAIProvider({
  connectionId: "primary-openai",
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-6.1-sol",
});
```

The application is responsible for registering the same trusted endpoint/account
binding under that identity. Persist a nonsecret compatibility descriptor for
protocol and effective endpoint; reject conflicting reuse rather than weakening
native continuity checks. Secrets remain outside the DB. Existing ephemeral
usage can retain generated identity. This explicit binding is preferable to
silently treating two different credentials on one endpoint as interchangeable.

Do not automatically strip reasoning/providerState to make recovery pass.
Same-provider model changes remain subject to codec compatibility. Recovery of
executions must still validate plugin contracts and unknown tool side effects.

## Trace correctness

Record model-attempt duration and time to first output where observed; include
auxiliary calls. Preserve unavailable values when a crash prevents measurement.
Do not confuse time spent waiting for HITL with active execution duration.
Define active-segment accounting before populating stream duration; never infer
active duration solely from wall-clock end minus start across suspension.
Link auxiliary responses when there is a real persisted message identity; do not
invent a reference to a message that was never committed.

## Background-task plugin: storage boundary

Three distinct cases:

1. Small JSON state tied to a conversation uses thread plugin state and existing
   checkpoints. It shares the selected backend without declaring SQL tables.
2. Independent agent/session plugin state uses the owned-state CAS contract.
   This is a state store, not a job scheduler; the current API does not offer
   due-job indexes, atomic job claims, or startup enumeration for workers.
3. A scheduler requiring those operations owns its job storage and migrations.
   A dedicated SQLite file, Postgres schema or external queue is valid.

The generic plugin API currently exposes backend registration, not a raw SQLite
connection or an API for installing arbitrary tables. Do not add a core table
named background_tasks for this example. A SQLite-specific plugin could open a
host-provided database path and own prefixed tables, but that couples it to SQLite,
adds write contention, and does not share Tessar's commit transaction. It must
not edit internal tables or PRAGMA user_version. A separate file is the safer
default for that specialized implementation, not a requirement for all plugins.

This revision does not add a generic SQL escape hatch or a collection/query
engine to core. Such a capability needs concrete cross-backend requirements.

## Verification and implementation order

1. Regression checks for cross-thread lease rejection in both backends.
2. Define and test durable provider bindings and explicit legacy rebinding.
3. Storage v2 migration and versioned reads/writes, fingerprinted commit retries.
4. Indexed paginated queries, fork/history parity and scoped access checks.
5. Durable Session APIs, conflict and failure handling.
6. Explicit cleanup and trace timing semantics.
7. Update SQLITE-STATE.md with actual resulting rows and restart examples.

Required scenarios: same-scope distinct Sessions; stale Session writers; restart
and next-turn chat with fake Responses and Chat providers; suspended execution
recovery; incompatible bindings; plugin summary/cursor recovery; history paging
while appending; exact historical fork; interrupted migration rollback; duplicate
commit after staging cleanup; permanent cleanup guards; unchanged-message row
counts across rename/checkpoint transitions. Run existing state/backend/runtime
tests and relevant builds. Report skipped process tests separately.

## Review-sensitive decisions

- Make createSession asynchronous to acknowledge persistence explicitly.
- Keep Agent definitions in application code; do not create an agents table.
- Use explicit stable provider bindings for durable continuity.
- Keep followUp queue ephemeral until a durable-inbox contract is separately defined.
- Keep thread title in metadata; no migration solely to move that field.

These decisions are approved design requirements, not already shipped APIs.
