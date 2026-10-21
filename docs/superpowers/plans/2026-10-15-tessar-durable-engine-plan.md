# Tessar Durable Agent Loop Implementation Plan

> The child reservation/admission protocol in Task B5 was removed on 2026-10-21.
> Do not reimplement it from this plan. The current contract is
> [API-REVIEW.md](../../../API-REVIEW.md); plugins own Agent orchestration.

> Historical document — superseded by [Minimal Core Plan](2026-10-15-tessar-minimal-core-plan.md) and its English spec.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chạy model/tool turns trên canonical state, hỗ trợ checkpoint/HITL/recovery và public extension primitives qua cùng engine.

**Architecture:** Agent trực tiếp sở hữu loop và dùng contracts/storage từ phần A. Controller quản lý lifecycle/resources; Session là API tương tác trên cùng Agent trong core. Tất cả side-effect dispatch có durable pre-dispatch boundary; results chỉ tiếp tục sau commit. Stream là attachment cho durable execution, không thêm class execution trung gian.

**Tech Stack:** Pure TypeScript core, Vitest scripted providers/fault injection; SQLite cross-process suite từ A.

**Spec:** [Master](2026-10-15-tessar-implementation-plan.md), [A prerequisites](2026-10-15-tessar-core-storage-plan.md), [public contract §§6–12](../specs/2026-10-15-tessar-public-api-state-machine-design.md), [state trace/usage](../specs/2026-10-14-tessar-state-design.md).

## Global Constraints

- Agent loop, logical state/schema, commit, checkpoint, suspend/resume, recovery, fork thuộc core.
- Defaults: 32 turns, 64 model attempts, 128 tool calls; budgets tiếp tục qua restart.
- Canonical writes là required; không dispatch model/tool khi pre-call commit lỗi.
- Resume mặc định model đã checkpoint; explicit override cho request mới được phép.
- Unknown external tool outcome cần reconcile hoặc quyết định tường minh; không automatic retry.
- Iterator buffer 512 events hoặc 4 MiB; detach không tự abort execution.
- Suspend persist request/cursor trước notification; không serialize JavaScript stack.
- Plugins implement feature policies; core không có compression/skills/memory/subagent strategy.

## Review Focus

1. Approval response trùng/không hợp lệ: validation trước consume, đúng một transition thắng; B2.
2. Crash ngay sau side-effect dispatch trước commit: unknown outcome không replay; B3.
3. Subscriber chậm/disconnect đúng lúc suspended: execution còn recoverable, old signal không hủy resume; B4.
4. Plugin detach trong tool batch hoặc qua HITL: registry references/manifest giữ contracts; B5.
5. Auxiliary/child calls qua retry/fork: đúng lineage, direct/inclusive usage không đếm trùng; B5.

---

## Files và agent execution interfaces

Loop thuộc packages/core/src/agent.ts; các helpers hiện có ở
packages/core/src/engine/{context,tool-executor,interrupt,resume,recovery,delivery,
tracked-effects}.ts. Không tạo class engine bọc bên dưới Agent. Giữ helpers
khi chúng có trách nhiệm rõ ràng, không tách file chỉ để giảm số dòng.

Agent và các plugin-facing types được export từ @tessar/core. Các execution
helpers/internal admission chỉ phục vụ core và testing harness; không tạo thêm
runtime port hoặc bắt application dựng backend/registry để new Agent.

~~~ts
interface AgentOptions {
  id: string;
  model?: Model | ModelRef;
  instructions?: string | Instruction;
  limits?: Partial<StreamLimits>;
}
type ExecutionRequest =
  | { kind: "input"; threadId: string; input: readonly MessageData[]; model: ModelRef;
      origin?: ExecutionOrigin; context?: JsonObject; limits?: Partial<StreamLimits> }
  | { kind: "resume"; threadId: string; interruptId: string; value: JsonValue;
      model?: ModelRef }
  | { kind: "recover"; threadId: string; streamId: string; model?: ModelRef };
interface ExecutionOrigin {
  parentStreamId: string; parentToolExecutionId?: string; dispatchId: string;
}
class Agent {
  constructor(options: AgentOptions);
  readonly id: string;
  stream(options: AgentExecutionOptions): Stream;
  generate(options: AgentExecutionOptions): Promise<GenerateOutcome>;
}
~~~

DeliveryTarget là internal discriminated union iterator | observer, một đường
canonical event emission; observer có handler sync và diagnostics. Stream public
theo spec: id nullable trước admission, threadId, handleId, signal, abort,
AsyncIterable. Engine đặt handle identity trước I/O; không claim durable admission
cho đến StreamStarted. Failed admission phát StreamError, không StreamEnd giả.

Harness.create({modelScripts?, plugins?, backend?, limits?, ids?, clock?})
→ Promise<EngineHarness>; harness exposes agent, queries, provider, backend,
admit(request) → Stream (testing-only, đi vào cùng Agent loop),
createThread(options?) → Promise<ThreadInfo>, collect(stream) → Promise<StreamEvent[]>,
records(streamId) → Promise<ExecutionRecords>, checkpoint(threadId),
atBoundary(phase,callback), crashAt(phase), dispose().
atBoundary/crashAt là fault hooks **testing-only**, không thay core policy contracts.
Fixtures trong tests tự dùng stable scripts, không gọi Internet và không sleep.

### Task B1: Model → tools → model loop với canonical checkpoints

**Files**

- Create: packages/core/src/agent.ts, packages/core/src/engine/{context,tool-executor}.ts.
- Create: packages/core/src/testing/harness.ts.
- Test: packages/core/src/agent-loop.test.ts, packages/core/src/engine/context.test.ts.
- Modify: packages/core/src/index.ts, packages/core/package.json, packages/core/src/events/catalog.ts.

**Interfaces**

- Consumes: A1–A5 schemas, models/tools, hooks, state, coordinator, usage.
- Produces: Agent trực tiếp chạy loop, ExecutionRequest, StreamLimits default32/64/128;
  ExecutionContext {signal, identities, context, state, models} (tracked methods B5).
- B1 Stream delivery dùng minimal queue trong Agent; B4 dùng helper delivery.ts
  và thêm đầy đủ bounds/detach semantics. Không import delivery.ts chưa tồn tại.
- Produces: ContextAssembler.build(checkpoint, instructions, selectedTools, model)
  → ModelRequest; public ContextPrepare transform observes effective immutable context.
- Produces: InputDecision.continue(messages) | handled({output}) | reject(error);
  TurnDecision.continue() | stop(reason); ToolDecision.allow() | deny(reason).
- Produces: canonical records and all non-interrupt events §9.1, model retry decision
  only before response commit and only within attempt limits. Tools serial phase1.

- [ ] **Step 1:** Viết test loop với ScriptedProvider hai responses:
      response1 chứa tool call; response2 text final. Assert:

~~~ts
const events = await harness.collect(harness.admit(inputRequest));
const records = await harness.records(events.find(e => e.is(AgentEvents.StreamStarted))!.streamId);
expect(harness.provider.calls).toHaveLength(2);
expect(tool.execute).toHaveBeenCalledTimes(1);
expect(records.turns).toHaveLength(2);
expect(records.attempts).toHaveLength(2);
expect(records.messages.map(m => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
expect(records.stream.status).toBe("completed");
expect(events.filter(e => e.is(AgentEvents.StreamEnd))).toHaveLength(1);
~~~

      Context suite seeds >50 messages, asserts next model request uses full
      checkpoint history, not getHistory page; ordered Agent+Thread+plugin
      instructions; reasoning parts exact. Table-test each transform/policy hook
      with actual boundary invocation and payload type (no mere catalog presence).
      Input handled results: no model attempt, committed structured output, known0
      usage. Deny chain cannot be overridden; selected tool must be registered.
- [ ] **Step 2:** pnpm exec vitest run packages/core/src/agent-loop.test.ts packages/core/src/engine/context.test.ts — FAIL Agent loop missing.
- [ ] **Step 3:** Implement admission, full context assembly, attempt and tool
      pre-dispatch commits, streamed deltas, response transforms + validation,
      committed tool messages, continuation and terminal barriers. Persist budget
      increments before dispatch; no implicit retry. Model/tool validator failures
      become typed errors/results, never execute invalid arguments.
- [ ] **Step 4:** Step 2 + pnpm typecheck — PASS. Test limits stop correct boundary,
      retry usage retained, transformed message correlation rejected, required
      storage failure prevents dispatch and doesn't emit completed.
- [ ] **Step 5:** Commit:

~~~powershell
git add packages/core/src/agent.ts packages/core/src/engine/context.ts packages/core/src/engine/tool-executor.ts packages/core/src/agent-loop.test.ts packages/core/src/engine/context.test.ts packages/core/src/testing/harness.ts packages/core/src/index.ts packages/core/package.json packages/core/src/events/catalog.ts
git commit -m "feat(core): run checkpointed model and tool turns"
~~~

### Task B2: Generic interruption và atomic resume

**Files**

- Create: packages/core/src/engine/{interrupt,resume}.ts.
- Test: packages/core/src/engine/interrupt.test.ts.
- Modify: packages/core/src/agent.ts, packages/core/src/engine/context.ts, packages/core/src/plugins/context.ts, packages/core/src/index.ts, packages/core/src/events/catalog.ts.

**Interfaces**

- Consumes: B1 engine, A4 interrupt schema/commit, A2 typed decision chain.
- Produces: defineInterruption<P,R,D>({id,version,response:InputDefinition<R>,
  resolve:(response:R,payload:P)=>D}): InterruptionDefinition<P,R,D>;
  api.interruptions.register(definition); context.suspend(def,payload): SuspendDecision.
- Produces: ResumeService.resume(request: Extract<ExecutionRequest,{kind:"resume"}>)
  → durable admission receipt + next handler cursor. resolve deterministic/no I/O.
- Suspend-supported boundaries: BeforeStream, TurnDecision, ModelSelect,
  BeforeTool và ModelRecover decision hooks. Transformation/notification/barrier
  hooks không nhận context.suspend; compile rejection pins unsupported use.
  Pending operation digest binds final arguments/executor contract separately from
  next model choice. Generic payload không có approval-specific schema trong core.

- [ ] **Step 1:** Approval là external test plugin, không engine feature:

~~~ts
const firstEvents = await harness.collect(harness.admit(inputRequest));
const pending = firstEvents.find(e => e.is(AgentEvents.StreamSuspended))!;
expect((await harness.queries.getInterrupt(threadId, pending.payload.interrupt.id))!.status)
  .toBe("pending");
expect(tool.execute).not.toHaveBeenCalled();
await expect(resumeWith({ approved: "invalid" })).rejects.toMatchObject({ code: "InvalidResumeResponse" });
const winners = await Promise.allSettled([resumeWith({ approved: true }), resumeWith({ approved: true })]);
expect(winners.filter(r => r.status === "fulfilled")).toHaveLength(1);
expect(tool.execute).toHaveBeenCalledTimes(1);
expect(firstStreamId).toBe(resumedStreamId);
expect(firstHandleId).not.toBe(resumedHandleId);
~~~

      resumeWith fixture collects stream and rejects on StreamError, not false
      assumption engine.start async throws. Restart same backend/new host before
      response; test prior handlers not replayed, later handlers called once,
      response atomic with cursor, denial closes call with ToolMessage.
      Default old model vs explicit new compatible model; new adapter rejects
      incompatible signature before call without rewriting old attempts.
- [ ] **Step 2:** pnpm exec vitest run packages/core/src/engine/interrupt.test.ts — FAIL missing interruption/resume.
- [ ] **Step 3:** Implement immutable request/response/decision records, handler cursor,
      atomic consume CAS and lease handoff. Publish suspended checkpoint before
      notification and release attachment resources. Resume resolves manifest,
      validates schema/action digest, snapshots decision and continues chain.
      Keep suspended when response/required contract validation fails pre-consume.
- [ ] **Step 4:** Step 2 + pnpm typecheck — PASS; test all five supported boundaries
      with at least one cursor/resume assertion each, invalid/no pending response,
      changed tool arguments require revalidation, no new turn/attempt on notification.
- [ ] **Step 5:** Commit:

~~~powershell
git add packages/core/src/engine/interrupt.ts packages/core/src/engine/resume.ts packages/core/src/engine/interrupt.test.ts packages/core/src/agent.ts packages/core/src/engine/context.ts packages/core/src/plugins/context.ts packages/core/src/index.ts packages/core/src/events/catalog.ts
git commit -m "feat(core): persist interruptions and consume responses atomically"
~~~

### Task B3: Crash recovery, storage uncertainty và side-effect reconciliation

**Files**

- Create: packages/core/src/engine/recovery.ts.
- Test: packages/core/src/engine/recovery.test.ts.
- Modify: packages/core/src/agent.ts, packages/core/src/engine/tool-executor.ts, packages/core/src/tools/tool.ts, packages/core/src/testing/harness.ts.
- Modify: tests/fixtures/sqlite-worker.ts, tests/integration/sqlite-process.test.ts.

**Interfaces**

- Consumes: B1/B2 checkpoints/cursor/results, A4 ownership/commitId lookup.
- Produces: ToolRecovery {idempotencyKey(input,identity):string;
  reconcile(operation):Promise<completed(ToolResult)|safeToRetry|unknown>};
  no recovery contract => unknown after dispatch.
- Produces: RecoveryService.recover(recoverRequest): Promise<RecoveryPlan>,
  plan branches use committed result / new model attempt / suspended request /
  reconciled effect / RecoveryRequired. ModelRecover hook owns retry permission.
- Produces: owner-loss cancellation propagates signal, no new schedule or publish;
  known runtime outcome retained while commit verification retries, no blind replay.

- [ ] **Step 1:** Table-driven crash positions:

~~~ts
expect(await crashAndRecover("after-model-result-commit")).toMatchObject({
  modelCalls: 1, duplicatedToolCalls: 0,
});
expect(await crashAndRecover("after-tool-result-commit")).toMatchObject({
  toolCalls: 1, status: "completed",
});
expect(await crashAndRecover("after-tool-dispatch-before-result")).toMatchObject({
  toolCalls: 1, error: "RecoveryRequired", status: "interrupted",
});
expect(await crashAndRecover("publish-ack-lost")).toMatchObject({
  duplicateBoundary: false, unknownCommit: false,
});
~~~

      Helpers return persisted status + real scripted/spied dispatch counts.
      Cases: still-live owner OwnerActive; stale same Controller.id fenced;
      unknown model attempt marked interrupted then new attempt only policy allows;
      storage failure pre-dispatch0, post-effect preserves uncertainty/no terminal;
      failed/terminal AlreadyTerminal; in-flight unknown tool cancellation not unlock.
      Model attempted usage remains partial, budgets don't reset.
- [ ] **Step 2:** pnpm exec vitest run packages/core/src/engine/recovery.test.ts tests/integration/sqlite-process.test.ts — FAIL recovery missing.
- [ ] **Step 3:** Implement recovery decisions from durable phase and known outcomes.
      Distinguish not-dispatched proven vs unknown dispatch (missing ack insufficient).
      Reconcile outside transaction through tracked recovery contracts; commit result/
      resolution before scheduling. Check ownership at each boundary, renew leases,
      stop on lost ownership. Host acknowledgement explicit and recorded when chosen.
- [ ] **Step 4:** pnpm build, Step 2, pnpm typecheck — PASS. At least two actual
      child-process kill/reopen tests: result committed and tool outcome unknown.
      IPC barrier proves exact crash window; retain DB evidence until assertions.
- [ ] **Step 5:** Commit:

~~~powershell
git add packages/core/src/engine/recovery.ts packages/core/src/engine/recovery.test.ts packages/core/src/agent.ts packages/core/src/engine/tool-executor.ts packages/core/src/tools/tool.ts packages/core/src/testing/harness.ts tests/fixtures/sqlite-worker.ts tests/integration/sqlite-process.test.ts
git commit -m "feat(core): recover executions without replaying unknown effects"
~~~

### Task B4: Stream delivery, cancellation và cleanup

**Files**

- Create: packages/core/src/engine/delivery.ts.
- Test: packages/core/src/engine/delivery.test.ts.
- Modify: packages/core/src/agent.ts, packages/core/src/engine/{resume,recovery}.ts, packages/core/src/index.ts.

**Interfaces**

- Consumes: AgentEvents/StreamEnvelope, B1 engine and B2 suspension.
- Produces: Stream AsyncIterable as public spec; createDelivery(target,{maxEvents=512,
  maxBytes=4*1024*1024}) with emit/close/detach internal API.
- Produces: subscription-only target no iterator allocation, one async consumer
  per Stream, ConsumerTooSlow error replaces unread queue then iterator closes.
- Produces: Stream.abort sync acceptance; engine.cancel async acceptance vs durable
  outcome events; AbortSignal listener belongs attachment, detached terminal handle
  cannot cancel a later resume handle.

- [ ] **Step 1:** Viết tests:

~~~ts
const stream = startWithBlockedConsumer();
await emitEvents(513);
expect(await nextError(stream)).toMatchObject({ code: "ConsumerTooSlow" });
expect((await harness.records(stream.id!)).stream.status).toBe("running");
await releaseModelGate();
expect((await awaitTerminalRecord()).status).toBe("completed");
await oldHandle.abort();
expect(resumedModelSignal.aborted).toBe(false);
~~~

      Additional exact4MiB threshold (UTF-8 byte accounting, oversized single event),
      break/iterator.return detaches, immediate consumer gets early events, second
      iterator rejected, session-style observer needs no drain/overflow, observer
      throw diagnostics only. Abort pending model/tool, ignored tool signal causes
      recovery-required, required finalizer failure and cleanup order, single end.
- [ ] **Step 2:** pnpm exec vitest run packages/core/src/engine/delivery.test.ts — FAIL bounded delivery absent.
- [ ] **Step 3:** Implement single logical emission path, bounded iterator queue,
      explicit attachment close, cancellation propagation/cleanup. On storage/lease
      error emit attachment StreamError without fabricated durable StreamEnd.
      AbortSignal before admission prevents work; HTTP disconnect independent
      unless host explicitly bound that signal as execution cancellation.
- [ ] **Step 4:** Step 2 + pnpm typecheck — PASS; no unhandled rejections or leaked
      signal listeners in repeated suspend/resume/dispose test.
- [ ] **Step 5:** Commit:

~~~powershell
git add packages/core/src/engine/delivery.ts packages/core/src/engine/delivery.test.ts packages/core/src/agent.ts packages/core/src/engine/resume.ts packages/core/src/engine/recovery.ts packages/core/src/index.ts
git commit -m "feat(core): bound stream delivery and separate detach from abort"
~~~

### Task B5: Public tracked execution primitives và plugin continuity

**Files**

- Create: packages/core/src/engine/tracked-effects.ts.
- Test: packages/core/src/engine/{tracked-effects,plugin-continuity}.test.ts.
- Modify: packages/core/src/engine/{context,engine}.ts, packages/core/src/plugins/context.ts, packages/core/src/index.ts.
- Modify: packages/core/src/state/schema.ts, packages/core/src/models/contract.ts.

**Interfaces**

- Consumes: B1–B4 loop/cursor/usage, A2 generations, A4 plugin state/coordinator.
- Produces: ToolExecutionContext.models.stream({model,request,purpose:"auxiliary"})
  → AsyncIterable<ModelChunk>; records belong existing turn/toolExecution.
- Produces: defineEffect<I,O>({id,version,input,output,execute,reconcile?}),
  api.effects.register(def), context.effects.execute(def,input,{key}): Promise<O>.
  Effect records namespace in plugin state plus core execution cursor, not a tenth
  competing conversation schema. Stable key bound to owner/contract/input digest;
  incompatible reuse rejects. Unknown dispatch follows B3, no generic automatic retry.
- Produces: context.executions.reserveChild({threadId,dispatchKey})
  → Promise<ChildReservation>; ChildReservation {streamId,threadId,origin:ExecutionOrigin}.
  Child admission with matching origin consumes reservation once, same dispatchId
  lookup returns same identity. Origin is serializable provenance, not permission.
- Produces: parent/child links persisted; directUsage and inclusiveUsage projections
  deduplicate descendant attempt IDs. No core process spawning or scheduler.
- Produces: runtime SDK later exposes same child reservation/admission ports to
  plugins; process plugin owns serialized dispatch, reconciliation and result reduction.

- [ ] **Step 1:** Viết tests:

~~~ts
expect(auxiliaryAttempt.purpose).toBe("auxiliary");
expect(auxiliaryAttempt.toolExecutionId).toBe(parentTool.id);
expect(parent.directUsage.metrics.inputTokens.knownTotal).toBe(10);
expect(parent.inclusiveUsage.metrics.inputTokens.knownTotal).toBe(30);
expect(child.directUsage.metrics.inputTokens.knownTotal).toBe(20);
expect(await reserveAgain()).toEqual(reservation);
expect(await recoverUnknownChildDispatch()).toMatchObject({ code: "RecoveryRequired" });
expect(dispatchChild).toHaveBeenCalledTimes(1);
~~~

      Fixture seeds parent10/child20 tokens; fork copied history0 new usage.
      Test concurrent child admissions same dispatchId one winner, cyclic lineage
      rejects, result/digest validation, unknown effect no replay. Plugin continuity:
      attach new hooks invisible current stream, detach defers dispose while active,
      suspend releases refs, optional observer missing resumes, required policy/
      executor/codec missing keeps request pending and ResumeIncompatible.
- [ ] **Step 2:** pnpm exec vitest run packages/core/src/engine/tracked-effects.test.ts packages/core/src/engine/plugin-continuity.test.ts — FAIL tracked methods absent.
- [ ] **Step 3:** Implement generic tracked calls/effects/lineage through existing
      commit/recovery path, not nested untracked HTTP. Finalize manifest compatibility
      resolution by stable IDs/version/config digest; explicit model override only
      resolves new provider request, doesn't replace remaining hook chain.
      Persist decisions derived from mutable agent/session plugin state.
- [ ] **Step 4:** Step 2 + pnpm typecheck; run B1–B4 suites once after context changes
      — PASS. No skills/memory/slash/subagent feature namespace in engine.
- [ ] **Step 5:** Commit:

~~~powershell
git add packages/core/src/engine/tracked-effects.ts packages/core/src/engine/tracked-effects.test.ts packages/core/src/engine/plugin-continuity.test.ts packages/core/src/engine/context.ts packages/core/src/agent.ts packages/core/src/plugins/context.ts packages/core/src/index.ts packages/core/src/state/schema.ts packages/core/src/models/contract.ts
git commit -m "feat(core): track plugin effects auxiliary calls and child lineage"
~~~

## Gate B

- [ ] pnpm typecheck, pnpm build, pnpm test, pnpm test:integration — PASS.
- [ ] Evidence table records each crash boundary, committed checkpoint, expected
      dispatch counts, terminal vs attachment error and usage coverage.
- [ ] Engine runs with ScriptedProvider only; no claim provider/OpenAI integration
      or public Controller/Session is finished before C.
