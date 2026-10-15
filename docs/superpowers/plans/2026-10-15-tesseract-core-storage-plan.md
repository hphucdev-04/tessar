# Tesseract Core Contracts and Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cung cấp primitives, plugin contracts và core state management có memory/SQLite backend cùng semantics.

**Architecture:** Pure TypeScript core owns schemas, validation, logical commit, queries và fork. Backend chỉ thực hiện physical persistence và atomic ownership/publication. Chưa tạo Controller/Session hoặc gọi provider thật.

**Tech Stack:** Node.js >=24.14.0; pnpm 11.5.3; TypeScript 7.0.2; Vitest 5.0.4; ESM/NodeNext; isolated node:sqlite backend.

**Spec:** [Master plan](2026-10-15-tesseract-implementation-plan.md), [public contract §§3–12,16](../specs/2026-10-15-tesseract-public-api-state-machine-design.md), [state records](../specs/2026-10-14-tesseract-state-design.md).

## Global Constraints

- Core không có third-party production dependencies, không import filesystem, provider SDK, SQLite, Controller hoặc Session implementation.
- Storage/checkpoint luôn có sẵn; memory backend default, SQLite reference backend qua node:sqlite trong package riêng.
- Scope là flat scalar equality + AND; pagination 50 mặc định, tối đa 200.
- Canonical writes là required; staged data chưa publish không phải committed.
- IDs logical không thay lease/fencing tokens. Checkpoint không chứa executable code hoặc secrets.
- TypeScript 7.0.2, Vitest 5.0.4; ESM/NodeNext, strict, declaration exports.
- SQLite dùng parameterized SQL, WAL, busy timeout 5000 ms, BEGIN IMMEDIATE.
- TD-001 installer/discovery/loader ngoài phạm vi.

## Review Focus

1. Scope có key __proto__, false, 0 và missing: own-key, type-sensitive AND; A5.
2. Publish acknowledgement mất hoặc commitId bị reuse với payload khác: lookup idempotent, conflict khác payload; A4.
3. Hai live processes cùng logical IDs: lease token riêng, stale fencing token không publish; A6.
4. History tăng giữa hai page hoặc source bị delete sau fork: pinned snapshot/membership độc lập; A5.
5. Opaque reasoning/provider state và unknown usage: codec không làm mất data, null không đổi thành 0; A1/A3.

---

## Files và interfaces chung

Xem tree ở master; các tests đặt cạnh module trong package, naming *.test.ts.
package.json/tsconfig.json được tạo cùng deliverable đầu tiên của package.
Không chia module theo từng feature memory/skills/compression.

Storage serializable types dùng JsonValue/JsonObject; validate rejects cycles,
undefined, bigint, non-finite numbers và functions. IDs là strings opaque.
Clock interface now(): string; IdGenerator next(kind: string): string cho
deterministic tests; lease expiry dùng backend clock riêng, không client Clock.

Storage ports ở A4 là một contract chung, không để SQLite tạo API song song:

~~~ts
interface StorageBackend {
  readonly id: string;
  readonly capabilities: {
    durable: boolean;
    atomicPublish: true;
    coordination: "single-process" | "multi-process";
  };
  readonly threads: ThreadStore;
  readonly executions: ExecutionStore;
  readonly checkpoints: CheckpointStore;
  readonly commits: CommitPort;
  readonly ownership: OwnershipPort;
  close(): Promise<void>;
}
interface CommitPort {
  stage(batch: CommitBatch): Promise<void>;
  publish(request: PublishRequest): Promise<CommitReceipt>;
  lookupCommit(commitId: string): Promise<CommitReceipt | null>;
}
interface OwnershipPort {
  acquire(request: { threadId: string; ownerToken: string; ttlMs: number }): Promise<Lease>;
  renew(lease: Lease, ttlMs: number): Promise<Lease>;
  release(lease: Lease): Promise<void>;
}
interface Lease {
  threadId: string; ownerToken: string; fencingToken: number; expiresAt: string;
}
interface PublishRequest {
  commitId: string; threadId: string; expectedRevision: number; lease: Lease;
}
interface CommitReceipt {
  commitId: string; threadId: string; revision: number; checkpointId: string;
}
~~~

CommitBatch chứa commitId/threadId/expectedRevision/checkpoint và các immutable
records/decisions cần publish. stage cùng commitId cùng canonical payload hash
là idempotent; khác payload reject CommitConflict. Publish verify lease chưa
expired, fencing current và expectedRevision; receipt trở thành visible atomically.
Deleted thread có tombstone, không tái sử dụng identity hoặc làm mất refs của forks.

### Task A1: Message/instruction primitives và workspace có kiểm chứng

**Files**

- Create: package.json, pnpm-workspace.yaml, pnpm-lock.yaml, tsconfig.json, tsconfig.base.json, vitest.config.ts, .gitignore.
- Create: packages/core/package.json, packages/core/tsconfig.json.
- Create: packages/core/src/{json,errors,index}.ts.
- Create: packages/core/src/messages/{message,parts,codec}.ts.
- Create: packages/core/src/instructions/instruction.ts.
- Test: packages/core/src/messages/message.test.ts, packages/core/src/instructions/instruction.test.ts.

**Interfaces**

- Consumes: MessageData/part variants từ state/core spec, baseline §16.
- Produces: JsonValue, JsonObject, ErrorInfo, TesseractError(code, message, details?);
  SystemMessage/HumanMessage/AssistantMessage(content, options?), ToolMessage({toolCallId, content, ...options});
  MessageCodec.encode(message: Message): MessageData, decode(data: MessageData): Message;
  buildInstruction(sections: readonly InstructionSection[]): Instruction.
- Produces: constructors immutable; options gồm id?, metadata?, providerState?;
  no ID option thì IdGenerator sinh, codec giữ đúng ID/ordering/opaque JSON.

- [ ] **Step 1:** Tạo minimal package/test configuration với versions baseline,
      scripts master, source aliases và test typecheck. Viết tests:

~~~ts
const message = new AssistantMessage([
  { type: "reasoning", text: "consider", providerState: { signature: "sig" } },
  { type: "text", text: "answer" },
], { id: "m1" });
expect(MessageCodec.decode(MessageCodec.encode(message))).toEqual(message);
expect(new HumanMessage("hello").role).toBe("user");
expect(() => buildInstruction([{ id: "a", content: "1" }, { id: "a", content: "2" }]))
  .toThrowError(expect.objectContaining({ code: "InvalidConfiguration" }));
expect(() => MessageCodec.decode({ ...MessageCodec.encode(message), metadata: { bad: NaN } }))
  .toThrow();
~~~

      Thêm readonly compile assertions và string/structured ToolMessage correlation.
- [ ] **Step 2:** Chạy pnpm install rồi pnpm exec vitest run packages/core/src/messages/message.test.ts packages/core/src/instructions/instruction.test.ts.
      Expected FAIL vì constructors/codec/buildInstruction chưa tồn tại.
- [ ] **Step 3:** Implement primitives, JSON validation và instruction normalize/
      ordered sections. Namespace origin nằm ở composition, không cấm section
      cùng id ở hai nguồn khác nhau. Export public APIs; không startup side effects.
- [ ] **Step 4:** Chạy cùng test command và pnpm typecheck; expected PASS,
      bao gồm @ts-expect-error mutation assertions. root test:integration được
      cấu hình chỉ matching integration, không chạy khi chưa có suite.
- [ ] **Step 5:** Kiểm tra git root như master; nếu chưa có repo thì git init.
      Commit exact workspace configs và A1 files:

~~~powershell
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json tsconfig.base.json vitest.config.ts .gitignore packages/core/package.json packages/core/tsconfig.json packages/core/src/json.ts packages/core/src/errors.ts packages/core/src/index.ts packages/core/src/messages/message.ts packages/core/src/messages/parts.ts packages/core/src/messages/codec.ts packages/core/src/messages/message.test.ts packages/core/src/instructions/instruction.ts packages/core/src/instructions/instruction.test.ts
git commit -m "feat(core): add immutable messages and instructions"
~~~

### Task A2: Typed event catalog và atomic plugin registration

**Files**

- Create: packages/core/src/events/{definition,catalog,dispatcher}.ts.
- Create: packages/core/src/plugins/{context,host,registry}.ts.
- Test: packages/core/src/events/dispatcher.test.ts, packages/core/src/plugins/host.test.ts.
- Modify: packages/core/src/index.ts.

**Interfaces**

- Consumes: JsonValue, ErrorInfo, Disposer = () => void | Promise<void>.
- Produces: EventDefinition<P,R,K>, defineEvent(config), EventEnvelope.is(def);
  AgentEvents foundation lifecycle definitions (PascalCase, stable namespaced IDs);
  notification/transformation/decision/barrier kinds, typed HookContext/decisions.
- defineEvent<P,R,K>(config:{id:string;version:number;owner:string;kind:K})
  → EventDefinition<P,R,K>; handlers/result inference lấy từ definition.
- Produces: Plugin {id, apiVersion, setup(api: PluginContext)}, PluginHost.initialize(plugins),
  attach(plugin), detach(id), capture(): RegistryLease, RegistryLease.release().
  PluginContext.on(def,handler), emit(def,payload), generic staged registry.register.
- A2 chưa import domain contracts chưa tồn tại. A3 thêm tools/models registries
  và typed model/tool events; A4 thêm storage/checkpoint events; A5 thêm state;
  B2 thêm interruptions; B5 thêm effects. B1 hoàn thiện boundary dispatch catalog.
- PluginContext.on notification Promise được await theo plugin dispatcher;
  Session host observers sau này là observation sync riêng, không await callback.

- [ ] **Step 1:** Viết tests cho inference và semantics:

~~~ts
const seen: string[] = [];
const host = new PluginHost({ diagnostics: (error) => seen.push(error.code) });
await host.initialize([denyPlugin, allowPlugin]);
expect(await host.dispatch(TestEvents.Decide, toolEvent, hookContext))
  .toMatchObject({ decision: "deny" });
const generation = host.capture();
await expect(host.attach(failingSetupPlugin)).rejects.toThrow();
const afterFailure = host.capture();
expect(afterFailure.generation).toBe(generation.generation);
afterFailure.release();
await host.detach(denyPlugin.id);
expect(disposeDeny).not.toHaveBeenCalled();
generation.release();
expect(await disposed).toBe(true);
~~~

      TestEvents.Decide là custom decision definition có allow/deny result,
      không phụ thuộc Tool chưa có ở A3. Fixtures trong host.test.ts tạo Plugin
      instances thật; promise disposed
      được disposer resolve, không sleep. Test transform chaining, required
      barrier failure, notification diagnostics, custom definition collision,
      equivalent definition IDs và incompatible versions; readonly context.
- [ ] **Step 2:** pnpm exec vitest run packages/core/src/events/dispatcher.test.ts packages/core/src/plugins/host.test.ts — FAIL missing definitions/host.
- [ ] **Step 3:** Implement deterministic ordering, fail-closed decision merge,
      staging setup/disposers rollback, reverse teardown, registry references.
      Stable IDs có version/owner validation; không object-identity-only matching.
      Không import file chưa tồn tại; no-op defaults không thêm feature policy.
      Domain catalog/boundaries được bổ sung có typed tests ở A3/B1.
- [ ] **Step 4:** Chạy Step 2 và pnpm typecheck — PASS; wrong handler return/
      wrong payload compile rejected, observer không thể đổi decision.
- [ ] **Step 5:** Commit:

~~~powershell
git add packages/core/src/events/definition.ts packages/core/src/events/catalog.ts packages/core/src/events/dispatcher.ts packages/core/src/events/dispatcher.test.ts packages/core/src/plugins/context.ts packages/core/src/plugins/host.ts packages/core/src/plugins/registry.ts packages/core/src/plugins/host.test.ts packages/core/src/index.ts
git commit -m "feat(core): add typed hooks and versioned plugin registry"
~~~

### Task A3: Model/tool contracts, trace và normalized usage

**Files**

- Create: packages/core/src/models/{contract,profile}.ts.
- Create: packages/core/src/tools/{tool,input-definition}.ts.
- Create: packages/core/src/trace/{records,usage}.ts.
- Create: packages/core/src/testing/scripted-provider.ts.
- Test: packages/core/src/tools/tool.test.ts, packages/core/src/trace/usage.test.ts, packages/core/src/models/contract.test.ts.
- Modify: packages/core/src/index.ts, packages/core/package.json, packages/core/src/plugins/context.ts, packages/core/src/events/catalog.ts.

**Interfaces**

- Consumes: MessageData, typed registration/context from A2.
- Produces: ModelRef, ModelRequest, ModelChunk, ModelResponse, ModelAdapter {
  ref; stream(request: ModelRequest, context: ModelCallContext): AsyncIterable<ModelChunk>;
  validate(request: ModelRequest): void }; signal là ModelCallContext.signal.
- ModelChunk variants: message-delta {messageId,partId,partKind,delta},
  usage {usage:ModelUsage} và response {response:ModelResponse}; adapter errors
  throw typed provider error, không masquerade thành final response.
- Produces: Model/Profile/ModelPricing/ProfileMetadata types như public spec,
  MetadataResolver.resolve(ref, {signal}): Promise<ProfilePatch>; getter không network.
- Produces: InputDefinition<T> {jsonSchema, parse(value: unknown): T};
  Tool<I> và createTool({name, description, input, execute, recovery?}): Tool<I>;
  execute(input, context: ToolExecutionContext): Promise<ToolResult>, progress qua context.emit.
- Produces: Stream/Turn/ModelAttempt/ToolExecution records và UsageSummary theo state
  spec; aggregateUsage(attempts: readonly ModelAttemptRecord[]): UsageSummary.
- Produces: ScriptedProvider(scripts: readonly ModelScript[]) với calls immutable
  request log; scripts yield chunks/response/error và AbortSignal kiểm chứng.
  Export /testing riêng, deterministic fixture helpers cho các phần sau.

- [ ] **Step 1:** Viết typed tool và usage tests:

~~~ts
expect(createTool(toolDefinition)).toBeInstanceOf(Tool);
expect(() => tool.input.parse({ count: "wrong" })).toThrow();
const usage = aggregateUsage([
  attempt("a", { inputTokens: 100, outputTokens: 30, totalTokens: 130, cacheReadInputTokens: 40, reasoningOutputTokens: 10 }),
  attempt("b", { inputTokens: null, outputTokens: 5 }, "failed"),
]);
expect(usage.metrics.outputTokens.knownTotal).toBe(35);
expect(usage.metrics.inputTokens.knownTotal).toBe(100);
expect(usage.metrics.inputTokens.coverage).toBe("partial");
expect(usage.metrics.totalTokens.knownTotal).toBe(130);
expect(usage.metrics.totalTokens.coverage).toBe("partial");
~~~

      attempt helper tạo complete records trong usage.test.ts. Assert cumulative
      updates thay snapshot cùng attempt (không sum repeated reports), failed retry
      known counts, cache/reasoning subsets không cộng lại, billed unknown null.
      Model contract tests preserve part order/opaque signatures và request validation.
- [ ] **Step 2:** pnpm exec vitest run packages/core/src/tools/tool.test.ts packages/core/src/trace/usage.test.ts packages/core/src/models/contract.test.ts — FAIL missing modules.
- [ ] **Step 3:** Implement types/validators/tool class/helper và usage projections.
      Metrics {knownTotal:number|null, knownAttempts:number, totalAttempts:number,
      coverage:complete|partial|unavailable} theo state spec; subtotal đã biết
      không biến thành total complete. Không buộc Zod hoặc tích hợp vendor SDK.
      ScriptedProvider hỗ trợ stable pause gates cho cancellation/fault tests.
      Thêm tools/models registration ports và typed model/tool catalog; không
      import storage types cho đến A4. Empty attempt set có known0 complete.
- [ ] **Step 4:** Step 2 + pnpm typecheck — PASS; Tool execute nhận đúng inferred
      input type, unknown model profile fields không thành false/0.
- [ ] **Step 5:** Commit:

~~~powershell
git add packages/core/src/models/contract.ts packages/core/src/models/profile.ts packages/core/src/models/contract.test.ts packages/core/src/tools/tool.ts packages/core/src/tools/input-definition.ts packages/core/src/tools/tool.test.ts packages/core/src/trace/records.ts packages/core/src/trace/usage.ts packages/core/src/trace/usage.test.ts packages/core/src/testing/scripted-provider.ts packages/core/src/index.ts packages/core/package.json packages/core/src/plugins/context.ts packages/core/src/events/catalog.ts
git commit -m "feat(core): define model tools and attempt usage contracts"
~~~

### Task A4: State schema, memory backend và atomic commit coordinator

**Files**

- Create: packages/core/src/state/{schema,storage-ports,memory-backend,commit}.ts.
- Create: packages/core/src/testing/storage-conformance.ts.
- Test: packages/core/src/state/commit.test.ts, packages/core/src/state/memory-backend.test.ts.
- Modify: packages/core/src/index.ts, packages/core/src/plugins/context.ts, packages/core/src/events/catalog.ts.

**Interfaces**

- Consumes: A1 MessageData/JSON, A3 records, public spec Checkpoint/ExecutionPosition.
- Produces: nine logical record families (threads, streams, turns, model_attempts,
  tool_executions, messages, plugin_states, checkpoints, interrupts), schemaVersion=1.
- Produces: StorageBackend/CommitPort/OwnershipPort et al. như contract đầu plan;
  ThreadStore.get(id), list(query), ExecutionStore.getStream/getInterrupt/listRecords,
  CheckpointStore.get(id), list(threadId,page), tất cả async nullable/page reads.
- Produces: CommitCoordinator.commit(batch: CommitBatch, lease: Lease): Promise<CommitReceipt>;
  createMemoryBackend({clock?, ids?}?): StorageBackend; stage/publish/lookup as above.
- Produces: storageConformance(name, factory: () => Promise<StorageBackend>):
  registers shared backend tests; testing-only Vitest dev dependency, không
  import testing module từ production exports. fault wrapper trong commit.test.ts
  forwards backend ports và inject failures, không sửa production algorithm.

- [ ] **Step 1:** Viết conformance và coordinator tests:

~~~ts
await backend.commits.stage(batch);
expect(await backend.checkpoints.get(batch.checkpoint.id)).toBeNull();
const receipt = await coordinator.commit(batch, lease);
expect(await backend.commits.lookupCommit(batch.commitId)).toEqual(receipt);
expect(await coordinator.commit(batch, lease)).toEqual(receipt);
await expect(coordinator.commit(changedSameCommitId, lease))
  .rejects.toMatchObject({ code: "CommitConflict" });
expect(afterLostAcknowledgement.modelDispatches).toBe(0);
~~~

      Fixtures exact batch/reference graph in tests. Fault cases: missing referenced
      record refuses publication, concurrent same revision one winner, lost publish
      ack resolved by lookup, lookup unavailable surfaces StorageUnavailable and no
      success event. Thread creation uses expectedRevision=0 → revision1.
- [ ] **Step 2:** pnpm exec vitest run packages/core/src/state/commit.test.ts packages/core/src/state/memory-backend.test.ts — FAIL missing ports/coordinator.
- [ ] **Step 3:** Implement staged immutable namespaces, atomically visible head/
      record membership, CAS + fencing + commitId, required write failure behavior.
      Validate canonical invariants before publication; no event from stage alone.
      Clock/ID injection core-only; ownership uses backend-authoritative now.
- [ ] **Step 4:** Step 2 + pnpm typecheck — PASS shared conformance. Verify closing
      memory backend loses state by design, not advertised restart durability.
- [ ] **Step 5:** Commit:

~~~powershell
git add packages/core/src/state/schema.ts packages/core/src/state/storage-ports.ts packages/core/src/state/memory-backend.ts packages/core/src/state/commit.ts packages/core/src/state/commit.test.ts packages/core/src/state/memory-backend.test.ts packages/core/src/testing/storage-conformance.ts packages/core/src/index.ts packages/core/src/plugins/context.ts packages/core/src/events/catalog.ts
git commit -m "feat(core): add canonical state and fenced atomic commits"
~~~

### Task A5: Scope/query/history, plugin state và safe fork

**Files**

- Create: packages/core/src/state/{scope,queries,plugin-state,fork}.ts.
- Test: packages/core/src/state/{queries,plugin-state,fork}.test.ts.
- Modify: packages/core/src/index.ts, packages/core/src/plugins/context.ts.

**Interfaces**

- Consumes: A4 backend/coordinator, immutable checkpoints, registry manifest.
- Produces: matchesScope(state: Scope, filter: Scope): boolean;
  StateQueries(backend).getThread/listThreads/getHistory/listCheckpoints/
  getStream/listStreams/listTurns/listModelAttempts/listToolExecutions/listInterrupts.
  Query options/result shapes theo public spec §5; reads require matching context.
- Produces: definePluginState({pluginId, namespace, schemaVersion, initial, migrate?, fork?});
  scoped context.state.get/update/commit with immutable reads/staged updates.
  ownerType thread/stream/turn/agent/session; session owner uses private runtime token,
  không public Session.id; agent/session state riêng khỏi Thread checkpoint.
- Produces: ForkService.fork(sourceId: string, options: ForkOptions & StateQuery): Promise<ThreadInfo>;
  ForkOptions {atCheckpointId?:string, atMessageId?:string, metadata?:JsonObject};
  selectors mutually exclusive, default current checkpoint, unsafe thì reject
  không tự lùi về checkpoint cũ.
  CheckpointInfo {forkable,unsafeReason} computed by canonical invariants/codec.

- [ ] **Step 1:** Viết tests:

~~~ts
expect(matchesScope({ n: 0, flag: false }, { n: 0 })).toBe(true);
expect(matchesScope({ n: "0" }, { n: 0 })).toBe(false);
expect(matchesScope({}, { flag: false })).toBe(false);
expect(matchesScope(JSON.parse('{"__proto__":"x"}'), JSON.parse('{"__proto__":"x"}'))).toBe(true);
const first = await queries.getHistory(threadId, { limit: 2 });
await appendNewCommittedMessage();
const second = await queries.getHistory(threadId, { cursor: first.nextCursor! });
expect(second.checkpointId).toBe(first.checkpointId);
expect(new Set([...first.items, ...second.items].map(m => m.id)).size).toBe(4);
await expect(forks.fork(threadId, { atCheckpointId: openToolBatch.id }))
  .rejects.toMatchObject({ code: "UnsafeForkPoint" });
~~~

      append helper uses coordinator, not direct mutation. Additional fork tests:
      preserve message IDs + thread-scoped lookup, own membership after source
      deletion, lineage exact checkpoint, usage0 new executions, thread state
      copy/custom/reset, stream/turn reset, agent/session not rewound.
      Migration creates revision, leaves source snapshot; stale cursor mismatch
      returns InvalidCursor, missing checkpoint distinct from empty history.
      Fork tests include both selectors rejected together, atMessageId requires
      exact checkpoint at boundary, unsafe current never silently uses older one,
      metadata override cannot replace source scope/lineage.
- [ ] **Step 2:** pnpm exec vitest run packages/core/src/state/queries.test.ts packages/core/src/state/plugin-state.test.ts packages/core/src/state/fork.test.ts — FAIL missing services.
- [ ] **Step 3:** Implement scoped queries and stable opaque cursor binding
      thread/filter/checkpoint/position; canonical chronological history within page.
      Enforce own-property scalar scope finite values and immutable metadata.
      Fork prefix rejects unmatched tool/provider units; source locks/transitions
      exclude unsafe pending work, new Thread gets independent root checkpoint.
- [ ] **Step 4:** Step 2 + pnpm typecheck — PASS; pages never use UI projection
      as model context, unauthorized scope returns null/no mutation.
- [ ] **Step 5:** Commit:

~~~powershell
git add packages/core/src/state/scope.ts packages/core/src/state/queries.ts packages/core/src/state/queries.test.ts packages/core/src/state/plugin-state.ts packages/core/src/state/plugin-state.test.ts packages/core/src/state/fork.ts packages/core/src/state/fork.test.ts packages/core/src/index.ts packages/core/src/plugins/context.ts
git commit -m "feat(core): add scoped history plugin state and safe forks"
~~~

### Task A6: SQLite reference backend và cross-process ownership

**Files**

- Create: packages/storage-sqlite/{package.json,tsconfig.json}.
- Create: packages/storage-sqlite/src/{backend,schema,ownership,index}.ts.
- Test: packages/storage-sqlite/src/backend.test.ts.
- Create: tests/fixtures/sqlite-worker.ts; tests/integration/sqlite-process.test.ts.
- Modify: package.json, pnpm-lock.yaml (workspace dependency graph only).

**Interfaces**

- Consumes: public StorageBackend ports and shared /testing conformance.
- Produces: createSqliteBackend({filename}): Promise<StorageBackend>;
  SqliteStoragePlugin({filename}) implements Plugin, registers backend once.
  Production lease expiry uses SQL database time. Test-only fixture expires
  row trong temp database; application không truyền clock để cướp live lease.
- Produces: sqlite-worker fixture accepts JSON stdin commands acquire/renew/
  stage/publish/lookup/close, returns JSON output; ownerToken unique per process.

- [ ] **Step 1:** Reuse full conformance against temp SQLite DB; write process test:

~~~ts
const [a, b] = await Promise.all([
  workerA.acquire({ threadId, controllerId: "same" }),
  workerB.acquire({ threadId, controllerId: "same" }),
]);
expect([a, b].filter(r => r.ok)).toHaveLength(1);
const winner = a.ok ? { worker: workerA, result: a } : { worker: workerB, result: b };
const loser = a.ok ? workerB : workerA;
await expireLeaseInTestDatabase();
const newer = await loser.acquire({ threadId, controllerId: "same" });
expect(newer.lease.fencingToken).toBeGreaterThan(winner.result.lease.fencingToken);
expect(await winner.worker.publish(winner.result.lease)).toMatchObject({ error: "OwnershipLost" });
~~~

      Make winner/loser explicit by deriving them from result before later steps,
      không assume workerA thắng. Fixture barriers qua IPC/DB, không timing sleeps.
      Test restart reads pending interrupt/checkpoint, crash before/after head
      publication, migration schema version refusal, parameterized weird scope keys.
- [ ] **Step 2:** pnpm exec vitest run packages/storage-sqlite/src/backend.test.ts tests/integration/sqlite-process.test.ts — FAIL missing backend/worker.
- [ ] **Step 3:** Implement version1 tables/indexes cho nine logical families +
      commits/staging/leases/membership, transaction BEGIN IMMEDIATE, WAL,
      busy timeout5000, SQL authoritative expiry và monotonic fencing retained
      after release. DatabaseSync isolated here; no core import of node:sqlite.
- [ ] **Step 4:** pnpm build rồi Step 2, pnpm typecheck — PASS. Child processes
      import built package exports; verify DB reopen, close workers/connections,
      Windows temp teardown with bounded retry (5 ×100ms) only after close.
- [ ] **Step 5:** Commit:

~~~powershell
git add packages/storage-sqlite/package.json packages/storage-sqlite/tsconfig.json packages/storage-sqlite/src/backend.ts packages/storage-sqlite/src/schema.ts packages/storage-sqlite/src/ownership.ts packages/storage-sqlite/src/index.ts packages/storage-sqlite/src/backend.test.ts tests/fixtures/sqlite-worker.ts tests/integration/sqlite-process.test.ts package.json pnpm-lock.yaml
git commit -m "feat(storage): add SQLite backend with process fencing"
~~~

## Gate A

- [ ] pnpm typecheck && pnpm build (chạy thành hai commands PowerShell nếu cần).
- [ ] pnpm test — core và SQLite suites PASS.
- [ ] pnpm test:integration — SQLite actual child-process suite PASS.
- [ ] Không claim agent runtime đã chạy: phần A chỉ cung cấp nền tảng cho B.
