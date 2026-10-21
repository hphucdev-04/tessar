# Tessar Public API and Integrations Implementation Plan

> The child reservation/origin flow in this plan is obsolete as of 2026-10-21.
> Thread.stream is internal; plugins compose Agents through their public APIs.
> See [API-REVIEW.md](../../../API-REVIEW.md) for the current contract.

> Historical document — superseded by [Minimal Core Plan](2026-10-15-tessar-minimal-core-plan.md) and its English spec.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship public Agent/Controller/Session APIs, automatic model profiles, reference provider và examples chứng minh khả năng viết plugins độc lập.

**Architecture:** @tessar/core cung cấp trực tiếp Agent/Controller/Session/Thread cùng agent loop, model registry và public plugin APIs. SDK là các public exports này; không thêm package hoặc bridge runtime trung gian. Provider protocol và SQLite là packages riêng. Host tự sở hữu CLI/UI/backend/transport.

**Tech Stack:** Node.js >=24.14.0; pnpm 11.5.3; TypeScript 7.0.2; Vitest 5.0.4; OpenAI SDK 7.34.0; compiled ESM examples.

**Spec:** [Master](2026-10-15-tessar-implementation-plan.md), [B prerequisites](2026-10-15-tessar-durable-engine-plan.md), [public API](../specs/2026-10-15-tessar-public-api-state-machine-design.md).

## Global Constraints

- Agent và Controller bắt buộc id do dev định danh; Session không có public id.
- controller.initialize một lần; Agent/Session không có public initialize riêng.
- Agent có immutable default model; Session có selection riêng; MissingModel thay auto guess.
- Session dùng subscribe/followUp/abort/resume/recover và session.thread.switch; không thêm send/stream public.
- Scope là flat scalar metadata/filter, không phải identity hay authorization.
- Model.profile tự resolve, getter snapshot đồng bộ, TTL 24 giờ, unknown null.
- Storage/checkpoint luôn có sẵn; memory backend default.
- Core không có third-party production dependencies, không import filesystem, provider SDK hoặc SQLite; Agent/Controller/Session nằm trong core.
- Test default offline/deterministic; live provider smoke opt-in theo environment.
- TD-001 và migration Cube/full CLI/app backend không thuộc phase này.

## Review Focus

1. Hai Sessions cùng scope/model nhưng hoạt động khác: không leak selection, queue hoặc subscription; C4.
2. Metadata thiếu/offline/custom endpoint/account-specific: null/provenance và cache partition đúng, không init failure; C1/C2.
3. Agent.generate bị HITL: trả suspended cùng committed output/usage, không chờ UI; C3.
4. Model stream reasoning/tool fragments và lỗi giữa chừng: codec giữ state, usage attempt không bị nhân đôi; C2.
5. Package chạy từ dist/process khác: no startup side effects, plugins không import internals; C5/C6.

---

## Files và package boundaries

Core src gồm agent.ts, controller.ts, thread.ts, session.ts, session-thread.ts,
session-events.ts và model registry/resolution. Controller dùng trực tiếp cùng
agent loop trong package. Không tạo RuntimePort, bindRuntime, /runtime export
hoặc package @tessar/sdk. Provider package chỉ phụ thuộc core + official SDK.
Các file hiện ở packages/sdk là implementation cũ cần chuyển vào core, sửa
internal imports và kiểm thử trước khi xóa package cũ; không bỏ logic đã test.

Root examples là workspace packages có scripts build/start; compile TypeScript
bằng tsc, chạy dist qua Node; không thêm tsx runtime loader. Root tests integration
thực thi built exports riêng với source-alias tests.

### Task C1: Automatic model profile registry và metadata resolution

**Files**

- Reuse: packages/core/{package.json,tsconfig.json}.
- Create: packages/core/src/models/{registry,resolver,cache,catalog}.ts.
- Create: packages/core/src/models/catalog.snapshot.json, packages/core/src/models/catalog.LICENSE.
- Create: packages/core/src/index.ts, scripts/update-model-catalog.mjs.
- Test: packages/core/src/models/{registry,resolver}.test.ts.
- Modify: pnpm-lock.yaml.

**Interfaces**

- Consumes: A3 Model/Profile/MetadataResolver types, registry provider registrations.
- Produces: ModelRegistry.get(ref:ModelRef): Model, list(): readonly Model[];
  registry.registerProvider(registration): Disposer; refreshProfile({signal?}).
- Produces: ProfileResolver.resolve(ref, authCachePartition, signal?) →
  Promise<ModelProfile>; Model.profile sync immutable current snapshot.
  Model handle cannot silently rebind to different controller/provider registration.
- Produces: cache keys exact providerId/modelId/endpoint/auth partition; provider
  plugin supplies opaque partition key, never credential stored in catalog/cache.
- Resolution precedence per field: matching provider facts → exact cached catalog/
  explicit alias → bundled snapshot → null; provenance/freshness/tiers preserved.

- [ ] **Step 1:** Viết fixture-based tests:

~~~ts
const model = registry.get({ providerId: "custom", modelId: "unknown" });
expect(model.profile.contextWindow).toBeNull();
expect(model.profile.capabilities.reasoning).toBeNull();
expect(fetchMetadata).not.toHaveBeenCalled();
const before = model.profile;
await flushScheduledMetadata();
expect(model.profile).not.toBe(before);
expect(before.contextWindow).toBeNull();
expect(Object.isFrozen(model.profile)).toBe(true);
expect(accountA.profile).not.toEqual(accountB.profile);
~~~

      get schedules resolver after return; getter itself never fetches. Test fake
      clock TTL24h, stale offline fallback, unknown model/provider distinctions,
      gateway no fuzzy/pricing borrowing, tiered pricing, explicit alias version,
      provider facts absent fields do not overwrite known snapshot with fake values.
      Failed refresh metadata diagnostics, model inference still available.
- [ ] **Step 2:** pnpm exec vitest run packages/core/src/models/registry.test.ts packages/core/src/models/resolver.test.ts — FAIL missing SDK registry.
- [ ] **Step 3:** Implement resolver/cache immutable replacement. Vendor catalog with
      pinned source revision/hash/license via update script, checked in artifact,
      no network build step. Runtime background refresh bounded/abortable, coalesce
      same partition requests; dispose aborts work, never logs credentials.
- [ ] **Step 4:** Step 2 + pnpm typecheck, pnpm build — PASS. Offline snapshot test
      has network stub reject all requests; getter/read and initial registry succeed.
- [ ] **Step 5:** Commit:

~~~powershell
git add packages/core/package.json packages/core/tsconfig.json packages/core/src/models/registry.ts packages/core/src/models/resolver.ts packages/core/src/models/cache.ts packages/core/src/models/catalog.ts packages/core/src/models/catalog.snapshot.json packages/core/src/models/catalog.LICENSE packages/core/src/models/registry.test.ts packages/core/src/models/resolver.test.ts packages/core/src/index.ts scripts/update-model-catalog.mjs pnpm-lock.yaml
git commit -m "feat(sdk): resolve immutable model profiles automatically"
~~~

### Task C2: OpenAI reference plugin/helper và provider codec

**Files**

- Create: packages/openai/{package.json,tsconfig.json}.
- Create: packages/openai/src/{plugin,adapter,codec,metadata,index}.ts.
- Test: packages/openai/src/{adapter,codec,metadata}.test.ts.
- Modify: pnpm-lock.yaml.

**Interfaces**

- Consumes: core PluginContext.models registration, ModelAdapter/MetadataResolver,
  MessageData/ModelUsage, explicit endpoint auth configuration.
- Produces: new OpenAIPlugin({apiKey, providerId?:string, baseURL?:string,
  fetch?:typeof globalThis.fetch, metadataPartition?:string}) implements Plugin.
  Default providerId openai; register Responses API adapter/resolver, profile exact
  modelRef identity. OpenAI-compatible Chat Completions protocol không tự suy ra.
- Produces: OpenAIAdapter implements ModelAdapter; OpenAIMessageCodec.toProvider/
  fromProvider preserve item/part IDs, tool call IDs, encrypted reasoning continuity
  fields khi API trả, no fabricated private thinking.
- Model invocation dùng official SDK, streaming và AbortSignal. Disable SDK
  implicit request retries (maxRetries0) để core attempt accounting/retry policy
  luôn thấy từng attempt thật. Metadata requests retry policy riêng, bounded.

- [ ] **Step 1:** Official SDK custom fetch backed by mocked HTTP/SSE fixture:

~~~ts
expect(requests[0].body.model).toBe("fixture-model");
expect(requests[0].body.input).toEqual(expectedProviderItems);
expect(chunks.filter(c => c.type === "message-delta").map(c => c.partKind))
  .toEqual(["reasoning", "text"]);
expect(roundTripProviderState).toEqual(encryptedReasoningFixture);
expect(usage.inputTokens).toBe(100);
expect(usage.cacheReadInputTokens).toBe(40);
expect(usage.outputTokens).toBe(30);
expect(usage.reasoningOutputTokens).toBe(10);
expect(usage.totalTokens).toBe(130);
~~~

      Fixture event names from pinned SDK types, test actual parsed fetch response.
      Tool argument fragmented JSON, two tool calls ordering, usage cumulative
      final snapshot, empty/incomplete response, HTTP429/error stream, abort,
      unsupported context rejects before HTTP, missing usage null.
      Metadata API lacking context/pricing leaves fallback/null, never dev-entered profile.
- [ ] **Step 2:** pnpm exec vitest run packages/openai/src/adapter.test.ts packages/openai/src/codec.test.ts packages/openai/src/metadata.test.ts — FAIL missing adapter.
- [ ] **Step 3:** Implement isolated official SDK mapping and register helper APIs.
      Version codec data in providerState; unknown protocol fields preserved only
      if needed for round-trip, redact credentials/raw headers from ErrorInfo.
      Don't advertise Anthropic/Google adapters from normalized type support.
- [ ] **Step 4:** Step 2 + pnpm typecheck, pnpm build — PASS. HTTP429 request count1
      before core retry; optional live smoke only with existing env key, evidence
      labelled live API if actually run. Mocked SSE is mandatory default gate.
- [ ] **Step 5:** Commit:

~~~powershell
git add packages/openai/package.json packages/openai/tsconfig.json packages/openai/src/plugin.ts packages/openai/src/adapter.ts packages/openai/src/codec.ts packages/openai/src/metadata.ts packages/openai/src/index.ts packages/openai/src/adapter.test.ts packages/openai/src/codec.test.ts packages/openai/src/metadata.test.ts pnpm-lock.yaml
git commit -m "feat(provider): add OpenAI streaming helper and profile resolver"
~~~

### Task C3: Agent/Controller lifecycle và low-level Thread APIs

**Files**

- Create: packages/core/src/{agent,controller,thread}.ts.
- Test: packages/core/src/{controller,agent,thread}.test.ts.
- Modify: packages/core/src/index.ts, packages/core/package.json.

**Interfaces**

- Consumes: Agent loop từ B, A StateQueries/ForkService/PluginHost, C1 ModelRegistry.
- Produces: Agent({id, model?, instructions?, limits?}) with stream(options)
  → Stream; generate(options) → Promise<GenerateOutcome>. Options.input required,
  model optional, scope/context/signal/limits optional. Model resolution explicit
  override → Agent default → MissingModel.
- Produces: Controller sở hữu và dùng trực tiếp cùng core agent loop.
  Một Agent instance gắn với một Controller; Controller thứ hai bị từ chối.
  Agent/Controller/Thread được export trực tiếp từ @tessar/core, không cần
  bridge runtime hoặc testing subpath để chạy production.
- Produces: Controller({id,agent,plugins?}), initialize():Promise<void>, dispose():Promise<void>,
  models, plugins, create/get/list/delete/forkThread exact signatures public spec.
  createSession added C4; no public Agent.initialize/dispose.
- Produces: core Thread implements public §5 query/stream/cancelStream/dispose APIs;
  ThreadStreamOptions accepts optional origin:ExecutionOrigin for child admissions.
  New input low-level requires explicit model; resume/recover inherit checkpoint.
- GenerateOutcome {threadId,streamId,status,output:readonly Message[],usage:UsageSummary,
  interrupt:InterruptRecord|null,error:ErrorInfo|null}; status same logical stream,
  storage/admission attachment failures reject with typed error. Suspended returns.

- [ ] **Step 1:** Viết tests:

~~~ts
expect(() => new Agent({ id: "" })).toThrow();
expect(() => new Controller({ id: "", agent })).toThrow();
expect(await Promise.all([controller.initialize(), controller.initialize()]))
  .toEqual([undefined, undefined]);
expect(plugin.setup).toHaveBeenCalledTimes(1);
const outcome = await agent.generate({ input: new HumanMessage("ask") });
expect(outcome.status).toBe("suspended");
expect(outcome.interrupt).not.toBeNull();
const savedThread = (await controller.getThread(outcome.threadId))!;
expect(outcome.streamId).toBe((await savedThread.snapshot()).activeStreamId);
expect(agentDefaultRef).toEqual(originalDefaultRef);
~~~

      Tests Agent.stream/generate parity committed messages/
      usage, one runtime, same model defaults, per-call override no mutation,
      immutable base instruction snapshot after restart, typed missing-model/not-ready.
      Thread scope mismatch read-null/mutation rejection and all trace query methods.
      Initialization rollback/disposer reverse, backend conflict, attach backend
      after ready rejected, dispose idempotent/active work stopped/pending durable kept.
- [ ] **Step 2:** pnpm exec vitest run packages/core/src/controller.test.ts packages/core/src/agent.test.ts packages/core/src/thread.test.ts — FAIL constructors absent.
- [ ] **Step 3:** Implement Agent/Controller/Thread trực tiếp trong core, cùng loop.
      Constructor no I/O. initialize shares Promise and publishes ready after setup;
      failed init cleanup, explicit failure state, recreate controller to retry.
      Controller.id preserved independent of unique process owner tokens.
      Standalone Agent creates core Thread state automatically; no Session needed.
      Generate consumes same engine until terminal/suspend, not provider single-call.
- [ ] **Step 4:** Step 2 + pnpm typecheck, pnpm build — PASS; compile negative tests
      require Agent/Controller id and reject agent.initialize. Thread.dispose only
      handle resources, doesn't erase conversation. Import barrels perform no I/O.
- [ ] **Step 5:** Commit:

~~~powershell
git add packages/core/src/agent.ts packages/core/src/index.ts packages/core/package.json packages/core/src/controller.ts packages/core/src/thread.ts packages/core/src/controller.test.ts packages/core/src/agent.test.ts packages/core/src/thread.test.ts
git commit -m "feat(sdk): compose Agent Controller and low-level Thread APIs"
~~~

### Task C4: Session subscription, thread façade và followUp queue

**Files**

- Create: packages/core/src/{session,session-thread,session-events}.ts.
- Test: packages/core/src/{session,session-thread,session-queue}.test.ts.
- Modify: packages/core/src/{controller,index}.ts.

**Interfaces**

- Consumes: C3 Controller/Thread, B delivery/interrupt/recovery, A scope queries.
- Produces: Controller.createSession({scope?,model?}):Session; Session {controller,
  agent,scope,model,thread}, setModel(model):void, subscribe(observer):Disposer,
  subscribe(def,observer):Disposer, followUp(input):Promise<QueuedInputReceipt>,
  resume({interruptId,value,model?}):Promise<ExecutionReceipt>,
  recover({streamId,model?}):Promise<ExecutionReceipt>, abort(reason?):Promise<void>,
  dispose():Promise<void>. No public id/send/stream/initialize.
- Produces: QueuedInputReceipt {id,threadId}; ExecutionReceipt {streamId,threadId}.
  followUp receipt accepted by runtime queue, resume/recover after durable admission.
  Results/deltas/terminal via subscribe, callbacks not awaited as policies.
- Produces: thread.create/switch/get/getId/list/rename/fork/delete/getHistory exactly
  public spec. No per-call scope override. Session requires selected Thread for input.
- Produces: SessionEvents catalog §5.5 + InputQueued/InputDiscarded notifications
  carrying queue receipt/cause. Non-completed terminal discards pending runtime queue
  explicitly; suspended holds it; completed drains FIFO. New explicit followUp after
  terminal can start fresh. Dispose discards unadmitted inputs with Closed reason.

- [ ] **Step 1:** Viết tests cùng scope hai Sessions:

~~~ts
const a = controller.createSession({ scope: { userId: "u" } });
const b = controller.createSession({ scope: { userId: "u" } });
await a.thread.create();
expect(b.thread.getId()).toBeNull();
const aSeen: SessionEvent[] = [];
const bSeen: SessionEvent[] = [];
a.subscribe(e => aSeen.push(e));
b.subscribe(e => bSeen.push(e));
const receipt = await a.followUp(new HumanMessage("first"));
expect(receipt.threadId).toBe(a.thread.getId());
expect(bSeen.some(e => e.streamId === runningStreamId)).toBe(false);
await expect(a.thread.switch(otherThread.id)).rejects.toMatchObject({ code: "SessionBusy" });
~~~

      Queue tests use model gates: idle admit, busy FIFO, capture enqueue-time model/
      Thread, Promise receipt before model output, suspend holds queued input,
      invalid response doesn't drain, resume complete drains, cancel/fail/stopped
      emits InputDiscarded and no automatic next dispatch. No iterator allocation.
      Thread API tests lookup scope/null, switch failure preserves old id/model,
      fork doesn't select, create selects, rename metadata.title, delete clears
      current, history pinned, suspended thread switch elsewhere doesn't resume it.
      Events Created queued after factory, per-instance routing even same scope,
      ModelChanged snapshot, handler throw diagnostics, BeforeClose awaited,
      active dispose SessionBusy, suspended dispose durable state unchanged.
- [ ] **Step 2:** pnpm exec vitest run packages/core/src/session.test.ts packages/core/src/session-thread.test.ts packages/core/src/session-queue.test.ts — FAIL Session absent.
- [ ] **Step 3:** Implement façade/queue and per-instance subscription routing on
      shared typed dispatcher. Resolve default model at createSession; missing
      default+option throws MissingModel, do not guess. Bind foreground identity
      before async cancel; old stream/thread can't drift after switch.
      resume/recover receipt never means final model result. No duplicated engine.
- [ ] **Step 4:** Step 2 + pnpm typecheck, pnpm build — PASS. Add @ts-expect-error
      for session.id/send/stream/initialize and per-operation scope override.
      Restart tests resume via new Session+scope+thread.switch, no old Session needed.
- [ ] **Step 5:** Commit:

~~~powershell
git add packages/core/src/session.ts packages/core/src/session-thread.ts packages/core/src/session-events.ts packages/core/src/session.test.ts packages/core/src/session-thread.test.ts packages/core/src/session-queue.test.ts packages/core/src/controller.ts packages/core/src/index.ts
git commit -m "feat(sdk): add scoped sessions subscriptions and follow-up queue"
~~~

### Task C5: External plugin proofs cho skills/memory/commands/subagents

**Files**

- Create: examples/plugins/{skills,memory,commands,subagents}/index.ts.
- Create: tests/fixtures/child-agent-worker.ts.
- Test: tests/integration/plugin-ecosystem.test.ts.
- Create: docs/plugin-authoring.md.

**Interfaces**

- Consumes: only public @tessar/core, /testing and sqlite
  exports; no imports to src paths/engine implementation.
- Produces: createSkillsPlugin({load:()=>Promise<SkillData[]>}), SkillData {id,content};
  inject via ContextPrepare, loader owns source, no core SKILL.md parser.
- Produces: createMemoryPlugin({recall,remember}) callbacks with host-owned memory
  backend; plugin namespace/cache separate from canonical conversation storage.
- Produces: createCommandsPlugin({commands}) handles InputPrepare → handled output.
  Command names/args/registry/UI entirely example-owned.
- Produces: createSubagentsPlugin({getController,dispatch,reduce}) registers Tool;
  getController lazy closure resolves host Controller after initialize.
  dispatch strategy examples in-process and fresh child process; thread fresh/fork,
  sequential/parallel cap2, aggregate results through ToolResult/custom progress.
  No new production orchestration scheduler or external memory dependency.

- [ ] **Step 1:** Integration assertions:

~~~ts
expect(skillSource.reads).toBe(1);
expect(nextModelRequest.instructions).toContain("loaded skill");
expect(memoryBackend.writes).toHaveLength(1);
expect(canonicalMessages.some(m => m.role === "memory")).toBe(false);
expect(await executeCommand("/help")).toMatchObject({ modelCalls: 0 });
expect(await runChildren("parallel")).toMatchObject({ maxConcurrent: 2, completed: 2 });
expect(await runChildren("sequential")).toMatchObject({ maxConcurrent: 1, completed: 2 });
expect(child.parentStreamId).toBe(parent.id);
expect(forkedChildNewUsage).toBe(0);
~~~

      Test fresh vs fork prefixes, parent result includes structured child outcomes,
      independent scope isolation, progress events custom typed definition, child
      errors/abort/HITL returned explicitly, no parent model hallucination of success.
      Actual process worker exchanges serializable DTOs; same SQLite backend stores
      child lineage. Crash after dispatch before parent outcome reconciliation
      does not spawn child again; unknown effect errors RecoveryRequired.
- [ ] **Step 2:** pnpm exec vitest run tests/integration/plugin-ecosystem.test.ts — FAIL proof factories absent.
- [ ] **Step 3:** Implement examples through existing hook/state/tracked-effects/
      child reservation APIs. Process dispatch owns IPC/startup/cancellation/
      timeout/reconcile. Worker reconstructs own Controller with dev IDs and
      plugins, uses reserved ExecutionOrigin, no serialized plugin functions.
      Feature policy remains example module. Do not add feature-specific engine hooks.
- [ ] **Step 4:** pnpm build rồi Step 2, pnpm typecheck — PASS; public imports only.
      Docs show which callback owns skill source/memory DB/command execution/
      child lifecycle and why raw untracked I/O isn't automatically durable.
- [ ] **Step 5:** Commit:

~~~powershell
git add examples/plugins/skills/index.ts examples/plugins/memory/index.ts examples/plugins/commands/index.ts examples/plugins/subagents/index.ts tests/fixtures/child-agent-worker.ts tests/integration/plugin-ecosystem.test.ts docs/plugin-authoring.md
git commit -m "test(sdk): prove external skill memory command and subagent plugins"
~~~

### Task C6: CLI/headless examples, package boundary checks và release gate

**Files**

- Create: examples/cli/{package.json,tsconfig.json,src/main.ts}.
- Create: examples/headless/{package.json,tsconfig.json,src/main.ts}.
- Create: scripts/check-boundaries.mjs, .github/workflows/ci.yml, README.md.
- Test: tests/integration/{public-imports,examples}.test.ts.
- Modify: package.json, tsconfig.json, vitest.config.ts, pnpm-lock.yaml, docs/plugin-authoring.md.

**Interfaces**

- Consumes: all built package exports and C5 examples, no internal imports.
- Produces: CLI host using Controller + Session.subscribe/followUp, SQLite optional,
  profile readable immediately, SIGINT → explicit abort/shutdown. Scripted provider
  offline mode mandatory; OpenAI env opt-in; no full coding agent/TUI claims.
- Produces: headless example uses Agent.generate/stream on same initialized runtime
  and scoped Session example, no HTTP framework/auth/server included.
- Produces: @tessar/core exports '.' cho public APIs và './testing' cho test
  helpers; public import smoke runs outside source alias resolver.
- Produces: check:boundaries rejects core Node/platform/provider imports, cycles,
  external examples importing private src paths, executable barrels.

- [ ] **Step 1:** Black-box tests:

~~~ts
expect(await importBuiltPackagesInChildProcess()).toMatchObject({
  stdout: "", productFileReads: 0, productNetworkCalls: 0,
});
expect(await runCliOffline(["hello"])).toMatchObject({ exitCode: 0, output: "fixture answer" });
expect(await runHeadlessOffline()).toMatchObject({ exitCode: 0, status: "completed" });
expect(await restartCliWithPendingApproval()).toMatchObject({ toolCalls: 1, sameStreamId: true });
expect(await checkForbiddenImportFixture()).toMatchObject({ exitCode: 1 });
~~~

      Imports spy fs/network only after Node module loader setup; distinguish file
      reads needed to load modules from product startup I/O. Package smoke uses
      built workspace exports from temp consumer with workspace package symlinks,
      verifies declarations/typecheck, testing-only dependency not normal runtime.
      CLI subscription smoke waits terminal event, doesn't exit at receipt.
- [ ] **Step 2:** pnpm build rồi pnpm exec vitest run tests/integration/public-imports.test.ts tests/integration/examples.test.ts — FAIL examples/check scripts absent.
- [ ] **Step 3:** Implement minimal hosts, docs public API quickstarts, exports and
      CI pinned baseline (Windows + Linux). CI pnpm frozen lockfile → typecheck →
      build → unit → integration → boundary checks. README marks reference backend/
      provider coverage, queue volatility, metadata unknown and deferred TD-001.
- [ ] **Step 4:** Run master exit gate exactly once after final edits; fix concrete
      failures then rerun affected checks. Expected PASS including built example
      process tests. Review diff for accidental secrets/artifacts/unrelated edits.
- [ ] **Step 5:** Commit:

~~~powershell
git add examples/cli/package.json examples/cli/tsconfig.json examples/cli/src/main.ts examples/headless/package.json examples/headless/tsconfig.json examples/headless/src/main.ts scripts/check-boundaries.mjs .github/workflows/ci.yml README.md tests/integration/public-imports.test.ts tests/integration/examples.test.ts package.json tsconfig.json vitest.config.ts pnpm-lock.yaml docs/plugin-authoring.md
git commit -m "docs(sdk): ship public host examples and verification gates"
~~~

## Gate C

- [ ] Master exit gate PASS, package exports and external proof plugins checked.
- [ ] Evidence explicitly separates scripted provider, mocked HTTP/SSE, SQLite
      real processes, built CLI and optional live OpenAI smoke.
- [ ] Không tuyên bố đã migrate Cube, có installer/loader, có mọi providers hoặc
      tự động durable mọi subagent/memory I/O.
