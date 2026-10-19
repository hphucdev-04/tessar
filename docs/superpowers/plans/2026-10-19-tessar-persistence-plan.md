# Tessar Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Execution method: native, as previously selected by the user. Steps use checkboxes for tracking.

**Goal:** Correct ownership and restart behavior, reduce duplicated SQLite state, and persist Sessions without changing the plugin ownership model.

**Architecture:** Preserve logical checkpoint snapshots while storing message/record versions once per change. Core owns backend-independent records, query semantics and lifecycle; SQLite implements indexed queries and transactional v1-to-v2 migration. Executable Agents/providers remain application code, and persisted model bindings supply compatibility information.

**Tech Stack:** Existing TypeScript, Node >=24.14.0, native node:sqlite, Vitest, Zod, installed OpenAI SDK. No new dependencies.

**Spec:** [2026-10-19-tessar-persistence-design.md](../specs/2026-10-19-tessar-persistence-design.md), approved 2026-10-19.

## Global Constraints

- Core owns persistence semantics. Backend plugins select the storage technology.
- Agent remains independently executable; constructing an Agent performs no DB I/O.
- Controller initializes shared resources. Plugins remain attached to Controller.
- Scope remains a scalar filter and does not become an authentication service.
- Existing dirty work must be preserved. No package publication, dependency changes, commit, or automatic deletion of user data is part of this work.
- Keep thread title in metadata; no migration solely to move that field.
- Keep followUp queue ephemeral until a durable-inbox contract is separately defined.
- Do not introduce event sourcing or a second execution engine.
- Work in the current checkout: its existing dirty changes are part of the reviewed input. Do not reset, stash, or copy an older clean branch over them.
- Core stays free of node:* and provider-package imports. Use global Web Crypto/TextEncoder for portable fingerprints and comparison helpers where needed.
- Existing test directories remain siblings of src. Do not create test files inside src.
- Change no user database as a development test. Use generated fixtures in temporary directories and clean up only verified test paths.

## Review Focus

1. Same commit ID with changed payload after staging cleanup must still fail (Task 3).
2. Unicode/punctuation scope keys, false versus zero, and non-ASCII IDs must have identical memory/SQLite filtering and cursor ordering (Task 5).
3. Concurrent Session handles, thread deletion, and failed selection writes must not emit misleading success or silently lose state (Task 7).
4. A reused provider binding with a different endpoint/protocol must fail even when model ID is unchanged; old unknown bindings require an explicit host decision (Tasks 2 and 8).
5. Migration must retain every historical fork point, plugin snapshot and commit receipt, including unfinished/staged work (Task 4).

## Files and responsibility boundaries

| Area | Files |
| --- | --- |
| Logical records and backend ports | Modify packages/core/src/state/schema.ts, storage-ports.ts, queries.ts, memory-backend.ts, commit.ts |
| Session persistence | Add packages/core/src/state/sessions.ts; modify controller.ts and session.ts |
| Physical schema and migration | Modify packages/sqlite/src/schema.ts; add migration.ts |
| Versioned rows and SQL query implementation | Add packages/sqlite/src/versions.ts and queries.ts; modify backend.ts and ownership.ts |
| Provider binding and compatibility | Modify packages/core/src/models/contract.ts, models/registry.ts, models/stream.ts and packages/openai/src/provider.ts, codec.ts, chat-codec.ts |
| Cleanup and fork | Modify packages/core/src/state/threads.ts, fork.ts and thread.ts |
| Execution timing | Modify trace/records.ts, engine/frame.ts, checkpoint.ts, execution.ts, interrupt.ts, services.ts and loop.ts |
| Public contracts/docs | Modify exports, READMEs, SQLITE-STATE.md and the two existing examples |

Each new file owns a concrete responsibility; avoid generic repositories, SQL-builder frameworks, model factories from JSON, or additional manager classes.

## Shared interfaces

Add these types to state/schema.ts; use the existing JsonObject, Instruction,
ModelRef, Scope and Page types.

```ts
interface ModelConnectionDescriptor {
  providerId: string;
  connectionId: string;
  protocol: string;
  endpoint: string;
}
interface StoredModelSelection {
  ref: ModelRef;
  options?: JsonObject;
  connection?: ModelConnectionDescriptor;
}
interface SessionRecord {
  id: string;
  agentId: string;
  scope: Scope;
  metadata: JsonObject;
  selectedThreadId: string | null;
  selectedModel: StoredModelSelection;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
```

Keep ModelConnectionDescriptor in models/contract.ts and import it as a type
from state/schema.ts, rather than creating a runtime import cycle. The shapes
above describe the shared contract, not a requirement to co-locate all types.

Add to StorageBackend:

```ts
sessions: {
  get(id: string, query?: StateQuery): Promise<SessionRecord | null>;
  page(query: StateQuery & PageOptions & { agentId: string }): Promise<Page<SessionRecord>>;
  compareAndSet(value: SessionRecord, expectedRevision: number): Promise<void>;
};
```

Scope is immutable on Session updates. Session writes validate selected-thread existence and scope compatibility in the same backend operation.
Session and thread IDs are backend-local. agentId identifies the Agent supplied by application code; there is no agents table or Agent foreign key. Wrong-Agent restoration fails rather than adopting another Agent.

Retain existing full checkpoint/record reads for execution. Add required query
ports, implemented by both memory and SQLite:

```ts
// ThreadStore
get(id: string, options?: { includeDeleted?: boolean }): Promise<ThreadInfo | null>;
page(query: StateQuery & PageOptions): Promise<Page<ThreadInfo>>;
purge(id: string, query?: StateQuery): Promise<void>;
// CheckpointStore
page(threadId: string, options: PageOptions): Promise<Page<CheckpointInfo>>;
history(threadId: string, options: HistoryOptions, query?: StateQuery): Promise<HistoryDataPage>;
// ExecutionStore
page<K extends RecordKind>(kind: K, threadId: string,
  query: PageOptions & { streamId?: string; turnId?: string;
    status?: string; atCheckpointId?: string }): Promise<Page<RecordTypes[K]>>;
```

Move CheckpointInfo and HistoryOptions into state/schema.ts and re-export from
queries.ts for existing imports. HistoryDataPage has items: readonly MessageData[],
checkpointId, revision, and nextCursor; StateQueries decodes only the returned page.
Keep the 1..200 page-size constraint and default 50. Cursors are opaque, versioned
and query-bound; invalid shapes and mismatched bindings fail InvalidCursor.

## Task 1: Bind every publication to the correct thread lease

**Files:** core/state/commit.ts, core/state/memory-backend.ts, sqlite/backend.ts,
sqlite/ownership.ts, core/src/testing/storage-conformance.ts (under packages).

**Interfaces:** Preserve CommitCoordinator.commit and CommitPort.publish signatures.
Enforce lease.threadId == request.threadId == staged batch.threadId on fresh publish.

- [x] Add a shared conformance case: acquire A and B, publish a batch for B with A's lease, assert OwnershipLost and unchanged B head; then publish with B's lease successfully.
- [x] Run `node node_modules/vitest/vitest.mjs run packages/core/test/state/memory-backend.test.ts packages/sqlite/test/backend.test.ts --configLoader native --pool threads --maxWorkers 4`; confirm the new assertion fails first.
- [x] Validate the binding in both backend publish paths and in the coordinator before staging a fresh write. Preserve valid already-published receipt replay without requiring a live lease.
- [x] Rerun the same command; all ownership, stale-fence and idempotency checks pass.

## Task 2: Stable provider bindings and compatibility metadata

**Files:** packages/core/src/models/{contract,registry,stream}.ts;
packages/openai/src/{provider,codec,chat-codec}.ts;
packages/openai/test/{provider,chat-completions,public-types}.test.ts.

**Interfaces:** Add optional readonly connection: ModelConnectionDescriptor to
ModelAdapter. OpenAIProviderOptions accepts connectionId?: string. It is not a
native provider option and is rejected as a modelOptions override.

- [x] Add tests: two new providers with the same explicit connectionId, endpoint, protocol and model accept serialized assistant history; two implicit providers remain isolated; a different explicit ID fails; same ID with different endpoint/protocol fails. Exercise Responses and Chat codecs.
- [x] Run `node node_modules/vitest/vitest.mjs run packages/openai/test/provider.test.ts packages/openai/test/chat-completions.test.ts --configLoader native --pool threads --maxWorkers 4`; confirm new checks fail.
- [x] Store the effective client endpoint and protocol in the nonsecret connection descriptor and new native continuity payloads; validate descriptor compatibility before reuse. withModel preserves the binding. Do not include auth/header values or derive identity from secret hashes.
- [x] Preserve old continuity only when the application explicitly registers the exact old connectionId. Legacy payloads lack an endpoint descriptor: document that this is a host attestation, not a migration-inferred match. Never rewrite historical IDs or remove providerState automatically.
- [x] Rerun the focused tests. Assert request bodies contain neither connectionId nor the descriptor and unconfigured native parameters remain omitted.

## Task 3: Compact commits and versioned SQLite writes

**Files:** packages/core/src/state/{commit,storage-ports,memory-backend,schema}.ts;
packages/core/src/engine/frame.ts; packages/sqlite/src/{schema,backend}.ts;
new packages/sqlite/src/versions.ts; packages/core/src/testing/storage-conformance.ts;
new packages/sqlite/test/versions.test.ts.

**Interfaces:** Add async commitFingerprint(batch: CommitBatch): Promise<string>
in commit.ts using canonicalJson and Web Crypto SHA-256. Keep public CommitReceipt
shape; retain the fingerprint in backend receipt storage. Remove plugin_states
from RecordTypes/recordTables, leaving checkpoint.state.pluginStates intact.

- [x] Add tests asserting 100 unchanged messages and two renames produce 100 physical message versions, three logical checkpoints and zero published staging rows; every checkpoint still hydrates correctly.
- [x] Add tests asserting a changed record creates exactly one new version, old checkpoints retain old values, and reordered/removed message versions reconstruct correctly.
- [x] Extend shared conformance: retry identical commit after staging cleanup succeeds; altered payload with reused ID fails; a failed publish retains its unpublished batch.
- [x] Run focused SQLite/conformance tests and verify failures before implementation.
- [x] Implement v2 DDL for fresh databases. Message/trace versions use (thread_id,id,from_revision) keys, exclusive to_revision, and a unique current version per (thread_id,id). Message versions also carry position. Trace columns include real parent IDs and pagination timestamp. Compute changed versions by canonical content comparison; absent trace entries in a delta batch remain unchanged.
- [x] Store checkpoint body without messages using a private persisted type. Store message count and computed fork-safety metadata as checkpoint query columns. checkpoints.get hydrates public Checkpoint.state.messages from the revision-visible rows.
- [x] Publish versions, checkpoint, head, receipt/fingerprint and staging removal atomically. Keep the FK-dependent thread head insertion/update in the transaction and use deferred constraints where insertion order requires it. Hash before opening a synchronous SQL transaction.
- [x] Mirror fingerprint/retry/cleanup semantics in memory, retain its simple immutable snapshots, and update engine record loading after removing the unused record kind.
- [x] Run `node node_modules/vitest/vitest.mjs run packages/sqlite/test packages/core/test/state --configLoader native --pool threads --maxWorkers 4`; verify old logical contracts and new row-count assertions.

## Task 4: Migrate v1 databases without losing history

**Files:** new packages/sqlite/src/migration.ts;
modify packages/sqlite/src/{schema,versions,backend}.ts;
new packages/sqlite/test/migration.test.ts.

**Interfaces:** migrateV1(db: DatabaseSync, createSchema: (db: DatabaseSync) => void): void is called by schema
initialization only for version 1. Bootstrap and migration finish at user_version=2;
unsupported newer versions fail without mutation. Synchronous DB changes occur in
one BEGIN IMMEDIATE transaction; migration fingerprints are computed synchronously under the write lock.

- [x] Create a checked-in test fixture builder reproducing v1 DDL and rows, independent of current v2 initialization. Include multiple checkpoints, native message state, summary/cursor snapshots, changed traces, fork lineage, soft deletes, receipts, leases, owned state and one unpublished batch.
- [x] Test that every hydrated checkpoint, record view, fork point and receipt equals its v1 counterpart after migration and reopen; IDs and logical schemaVersion remain unchanged.
- [x] Test nonempty legacy plugin_states, missing staged payload for a receipt, invalid JSON and an injected SQL failure: initialization rejects and original schema/data/user_version remain intact. Refuse inconsistent data rather than invent fingerprints or silently discard it.
- [x] Run `node node_modules/vitest/vitest.mjs run packages/sqlite/test/migration.test.ts --configLoader native --pool threads --maxWorkers 1` and confirm failing coverage.
- [x] Build v2 replacement tables, import thread checkpoints in revision order through versions.ts, fingerprint original committed batches, retain only unpublished staging, preserve leases/owned state, and swap tables inside the transaction. Do not touch plugin-owned tables or invent Sessions for legacy threads.
- [x] Recheck schema version after acquiring the migration lock so concurrent openers cannot both migrate. Exercise two independently opened connections; skip actual subprocess concurrency only when the environment forbids it.
- [x] Rerun migration and backend tests, including FK integrity checks and rollback/reopen assertions. Compare test database row counts, not a live user's database.

## Task 5: Backend pagination and filtering

**Files:** packages/core/src/state/{schema,storage-ports,queries,memory-backend,fork}.ts;
packages/sqlite/src/{schema,backend,versions}.ts; new packages/sqlite/src/queries.ts;
packages/core/test/state/queries.test.ts; new packages/sqlite/test/queries.test.ts.

**Interfaces:** Implement the required page/history ports declared above; keep
full listRecords for engine recovery. StateQueries performs access checks and
MessageCodec decoding, then delegates the bounded query instead of slicing a
full hydrated collection. ForkService can still request full snapshots explicitly.

- [x] Add backend-parity tests for checkpoint-bound history paging while new messages arrive, stream/turn filters, wrong scope/cursor, false versus 0 versus "0", and scope keys containing dots, quotes and Unicode.
- [x] Add ordering cases with identical timestamps and punctuation/non-ASCII IDs. Use ordinal UTF-8 byte ordering in memory, matching SQLite BINARY; do not mix localeCompare sorting with relational cursor comparisons.
- [x] Add a check that getHistory and listCheckpoints do not call full checkpoints.get/list. Assert result size and SQLite query plans for history-position and parent-record queries.
- [x] Run new query tests, confirm failures, then implement bound SQL JSON predicates with parameterized keys/values, typed scalar matching, LIMIT limit+1 and keyset cursors. Validate the complete cursor shape before reading fields.
- [x] Add indexes matching thread/revision/position, record-parent/date/ID and current-row lookups. Arbitrary scope JSON filters remain documented scans; do not claim arbitrary-key index coverage.
- [x] Run `node node_modules/vitest/vitest.mjs run packages/core/test/state packages/sqlite/test --configLoader native --pool threads --maxWorkers 4` and verify parity plus historical fork behavior.

## Task 6: Withdrawn — no Agent table

User decision: do not persist Agent descriptors. Keep Agent definitions in application code. Session.agentId remains an identity check without a foreign key.

## Task 7: Durable Session lifecycle and CAS mutations

**Files:** new packages/core/src/state/sessions.ts;
modify packages/core/src/{controller,session,thread,index}.ts,
plugins/context.ts, events/definition.ts, state/{schema,storage-ports,memory-backend}.ts;
packages/sqlite/src/{schema,backend,queries}.ts;
new packages/core/test/state/sessions.test.ts;
packages/core/test/{session,controller,agent-standalone}.test.ts;
packages/core/test/events/operation-hooks.test.ts;
packages/plugins/test/logger.test.ts; packages/openai/test/chat-completions.test.ts;
examples/{cli,headless}/src/main.ts.

**Interfaces:**
- Controller.createSession(options?: SessionOptions): Promise<Session>.
- Controller.getSession(id: string, query?: StateQuery): Promise<Session | null>.
- Controller.listSessions(query?: StateQuery & PageOptions): Promise<Page<SessionRecord>>, restricted to controller.agent.id.
- Session.id: string; SessionOptions adds metadata?: JsonObject.
- SessionService(backend: StorageBackend): create(record: SessionRecord): Promise<void>, get(id: string, query?: StateQuery): Promise<SessionRecord | null>, update(record: SessionRecord, expectedRevision: number): Promise<void>.
- Keep existing setModel/thread.* method names. Do not redesign unrelated model APIs during this task.

- [x] Test two Sessions with identical scope receive different IDs; reopen/get restores selection/model/metadata; scope mismatch returns null; wrong Agent fails; dispose retains durable data and no automatic work starts on restore.
- [x] Test two restored handles racing a selection update: one succeeds, the stale one fails CommitConflict and emits no success event. Inject storage failure and assert visible selection/model remain unchanged.
- [x] Test newly created thread survives a failed Session selection CAS and is discoverable; the failed operation emits no session.threadCreated success. Test deleted selected thread clears all stored selections and increments their revisions in the delete transaction.
- [x] Run these tests to establish failures, then implement backend session CAS validation and Session creation/restoration. Session constructors remain synchronous/internal to the async factory; no public Session.initialize is added.
- [x] Commit Session changes before updating local fields or notifying hooks. Revalidate selection against current state before admitting input. On restoration, resolve and validate persisted model binding using registered executable providers; missing/incompatible providers fail without overwriting the record.
- [x] Carry sessionId in relevant hook contexts and expose id in SessionHookHandle. Keep subscriptions runtime-local, queue receipts ephemeral and InputCommitted the durable boundary. Do not persist closures or scheduler jobs.
- [x] Update every createSession caller found by `rg -n 'createSession\(' packages tests examples -g '*.ts'` to await it, including rejected-promise expectations in lifecycle tests and async test/example helpers.
- [x] Run `node node_modules/vitest/vitest.mjs run packages/core/test/session.test.ts packages/core/test/controller.test.ts packages/core/test/state packages/core/test/events/operation-hooks.test.ts packages/plugins/test/logger.test.ts packages/openai/test/chat-completions.test.ts packages/sqlite/test --configLoader native --pool threads --maxWorkers 4`.

## Task 8: Verify durable model binding through actual application paths

**Files:** packages/core/src/{controller,session}.ts, state/sessions.ts,
models/{registry,stream}.ts;
new tests/integration/persistence-restart.test.ts;
packages/openai/README.md.

**Interfaces:** Registered adapter connection descriptors feed StoredModelSelection.
Provider registry handles must preserve the executable adapter's descriptor when
restoring by ModelRef, rather than dropping connection information. Existing
native continuity and registry-manifest checks remain authoritative.

- [x] Test fake Responses and Chat: create Controller/Agent with explicit binding and SQLite, create Session, finish a turn, dispose, create new objects, restore Session, send the next turn. Assert old history is sent, model options are preserved and one new HTTP call occurs.
- [x] Test suspend/dispose/reopen/resume retains stream ID and summary/cursor plugin state, without executing an already completed tool twice. Use a registered explicit reconciliation policy for unknown external tool outcomes.
- [x] Test same binding ID with changed endpoint/protocol, missing provider, and replaced plugin contract fail before model/tool side effects.
- [x] Add a legacy test with a random stored connection ID: implicit reconstruction fails; a new provider explicitly configured with that saved ID restores compatible legacy history. Document that the host must verify the trusted binding; do not make migration guess it.
- [x] Run `node node_modules/vitest/vitest.mjs run tests/integration/persistence-restart.test.ts packages/core/test/engine/recovery.test.ts packages/core/test/engine/plugin-continuity.test.ts --configLoader native --pool threads --maxWorkers 4`; fix the shared binding/restore path until these pass, then rerun the provider codec tests.

## Task 9: Explicit purge with lineage and ownership protection

**Files:** packages/core/src/{controller,thread}.ts, state/{threads,memory-backend}.ts;
packages/sqlite/src/backend.ts;
packages/core/test/state/fork.test.ts; new packages/sqlite/test/purge.test.ts.

**Interfaces:** Controller.purgeThread(id: string, query?: StateQuery): Promise<void>
delegates to ThreadService.purge and ThreadStore.purge. Keep deleteThread as soft
delete; no automatic cleanup timer or Session cascade deletion is added.

- [x] Test rejection of live threads, active executions, active leases, wrong scope, and any retained child lineage reference. Test purging an eligible soft-deleted thread removes its snapshots, versions, staging/receipts and lease, while preserving other threads and plugin-owned tables.
- [x] Run failing purge tests, then implement all guards and deletion within one backend write transaction. Revalidate conditions after acquiring the transaction; reads must include deleted heads for these checks.
- [x] Load the deleted head through the internal includeDeleted read, check scope, and authorize through the existing thread.beforeDelete hook with an additive permanent flag; report the flag on thread.deleted. Ordinary getThread still hides deleted records. Do not reuse the existing live-thread-only context lookup or bypass plugin deletion policy.
- [x] Rerun purge, fork, operation-hook and migration tests. Verify foreign_key_check is empty and retained forks stay readable.

## Task 10: Truthful timing and final compatibility verification

**Files:** packages/core/src/trace/records.ts, engine/{frame,checkpoint,execution,interrupt,services}.ts, loop.ts;
new packages/core/test/engine/timing.test.ts;
SQLITE-STATE.md, README.md, packages/{core,sqlite,openai}/README.md,
docs/plugin-authoring.md, examples/{cli,headless}/src/main.ts.

**Interfaces:** Use a monotonic per-attachment timer for active runtime segments.
Add optional ExecutionPosition.timing: { completedActiveMs: number; segmentOpen:
boolean; complete: boolean }. ExecutionFrame holds activeSegmentStartedAt?: number
from performance.now(). A checkpoint of an open segment records elapsed observed
time and resets the in-memory segment baseline; orderly suspension/finish closes
it. Recovering an open segment or a legacy position without timing marks the
total incomplete. StreamRecord.durationMs is null when complete is false, and
otherwise contains completedActiveMs at terminal completion. Preserve legacy
record loading. No extra public timer/controller class is required.

- [x] Add fake-clock tests: model attempt ends at 40ms with first delta at 10ms => durationMs=40 and timeToFirstOutputMs=10; same for auxiliary calls; no observed output => first-output timing null.
- [x] Add active-segment test: 20ms work, 10,000ms HITL wait, 30ms resumed work => stream active duration 50ms. Crash without closing a segment => total duration null, not 0 or wall-clock elapsed time. Keep already persisted usage unchanged through resume.
- [x] Run timing tests to confirm failures, then measure successful/error exits, close segments at suspension/terminal checkpoints, and mark unclosed recovered segments incomplete. Populate auxiliary responseMessageId only when an actual committed message exists.
- [x] Run package tests, focused persistence integrations, typecheck and package boundaries using the commands below. Fix relevant failures; distinguish environment-blocked subprocess tests from runtime failures.
- [x] Build core first, dependent packages next, then the two examples. Update public API examples for async Session creation and stable provider binding. Document the storage-port breaking changes and failure semantics.
- [x] Regenerate SQLITE-STATE.md examples from a temporary real SQLite scenario and show new row counts, Session rows, plugin state, restart and migration. Label fake provider responses and shortened sample IDs explicitly.
- [x] Run one fresh final review of the completed scope under the native workflow; address concrete findings and rerun only affected checks. Do not publish or commit.

## Verification commands

```powershell
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.tests.json
node scripts/check-boundaries.mjs
node node_modules/vitest/vitest.mjs run --configLoader native --pool threads --maxWorkers 4 --exclude "tests/integration/**"
node node_modules/vitest/vitest.mjs run tests/integration/persistence-restart.test.ts tests/integration/sqlite-process.test.ts tests/integration/parallel-tools.test.ts tests/integration/public-imports.test.ts --configLoader native --pool threads --maxWorkers 4
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json
node node_modules/typescript/bin/tsc -p packages/sqlite/tsconfig.json
node node_modules/typescript/bin/tsc -p packages/openai/tsconfig.json
node node_modules/typescript/bin/tsc -p packages/plugins/tsconfig.json
node node_modules/typescript/bin/tsc -p examples/cli/tsconfig.json
node node_modules/typescript/bin/tsc -p examples/headless/tsconfig.json
```

Run known child-process-dependent tests when permitted; explicitly report EPERM
or skips and their names. A reopened database within one process is a restart
simulation, not proof of process-crash recovery. No live provider requests are
required for protocol/persistence checks, and no test claims a provider cache hit.

## Self-review and completion ledger

- Spec coverage: ownership (1); bindings/restart (2,8); physical storage and retries (3); migration (4); bounded queries (5); Agent table withdrawn (6); Sessions (7); cleanup (9); timing/docs (10).
- Review Focus cases map to concrete tests above; no arbitrary SQL API or background-task schema is introduced.
- Native execution method is preserved. Implementation completed; Task 6 was withdrawn by the user. Verification results and review decisions are recorded below.
- Record actual command results, environment limitations and any approved deviations here during execution. Do not turn planned outcomes into completion claims.

## Execution outcome — 2026-10-19

Tasks 1–5 and 7–10 implemented. Task 6 withdrawn: no Agent table, descriptor service or Agent FK. Agent definitions remain application code.

- 233 package tests passed (51 files); 24 integration tests passed (7 files), no skips.
- Typecheck, package boundaries, four package builds and two example builds passed.
- Fresh review found three Important issues; all were fixed with reproducing regressions: stale Session deletion, direct Thread continuation binding validation, and fork publication racing purge. No deferred minor findings.
- Migration uses synchronous node:crypto SHA-256 inside its SQLite transaction instead of async hashing while locked.
- `session.created` is delivered to plugin hooks after persistence, not replayed to later subscriptions or restored handles.
- Concurrent standalone-call completion order remains unspecified; tests compare calls by model ID.
- Offline distribution fixtures pack a copied local Zod dependency, without changing production dependencies or using the network.
- Real process crash tests passed. Provider requests in protocol tests are mocked; live provider behavior and production migration throughput were not measured.
- Existing dirty checkout preserved. No commit or publication. The detailed execution ledger and test logs remain under `.superpowers/sdd/2026-10-19-tessar-persistence-plan/`.
