# Standalone Agent API Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans, native execution in the current workspace as authorized by the user. Preserve all existing dirty work. Do not commit, publish, or redesign Controller/Session APIs in this phase.

**Goal:** Implement the reviewed Agent API: required default model, standalone execution, message-first calls, execution-local model/options overrides, and native OpenAI SDK configuration/retries.

**Architecture:** Reuse the existing loop/checkpoint functions with a structural execution environment instead of requiring a Controller instance. Standalone calls own an ephemeral memory backend/PluginHost and release them after deriving their result. Controller-backed calls continue using the existing backend/hooks. Direct adapters stay attached to their execution; persist request options and model identity, never SDK/client credentials.

**Tech stack:** Existing TypeScript, Vitest, Zod and pinned official OpenAI SDK. No new runtime dependencies.

**Spec:** [Agent API review](../specs/2026-10-17-tessar-agent-api-design.md).

## Constraints and implementation rulings

- `Agent.model` is required. Keep legacy model references and old object-input overloads temporarily for the existing Controller/Session consumers; the new standalone path requires an executable model. Mark legacy call signatures deprecated.
- Add an optional `options` snapshot and `withModel(modelId)` capability to the existing ModelAdapter contract. Infer native option types from executable model instances; preserve the existing metadata Model handle API for Controller compatibility.
- Override objects shallowly. A model-ID string reuses the default connection; an instance override carries its own connection/options. Do not merge a replaced provider's options with the Agent default.
- OpenAIProvider uses SDK client option types plus Responses request option types. Exclude runtime-owned fields and modes incompatible with the current loop. Never silently discard accepted provider options.
- Remove forced SDK retry/store/include defaults. Stream mode/input and available instructions/tools remain runtime data. SDK retries handle HTTP failures; no new Agent retry loop.
- Direct OpenAI instances carry a non-secret connection identity, preserved by same-client model selection; continuity must not replay opaque provider state through a different connection.
- Standalone init/cleanup is automatic and does not close externally owned clients. Preserve existing GenerateOutcome/event contracts. Do not add public Agent init/dispose.
- OpenAI is the provider package implemented in this phase. Other executable adapters use the same core contract; separate Anthropic/Google SDK packages and Controller/Session model-manager redesign remain subsequent work.

## Review focus

1. Concurrent overrides must not mutate defaults or share connection selection across executions.
2. Runtime-owned request fields must not be overridden, and absent provider options must remain absent.
3. Provider errors must preserve native exception identity, including retry exhaustion and partial-stream errors.
4. Automatic cleanup must run on completion/failure/abort and leave Agent/model reusable.
5. Existing Controller tools, queues, checkpoints and recovery must keep working while adopting the new model path.

## Tasks

### Task 1: Executable model contract and native OpenAI provider

Files: core models/contract, models/stream, models exports; openai adapter/provider/index/codec; provider tests.

- [x] Write failing tests for provider options passthrough/absence, shallow overrides, connection reuse, SDK retries and continuity isolation.
- [x] Run the new provider tests and record the expected missing-provider/API failures.
- [x] Implement OpenAIProvider, client configuration forwarding, native request options and profile snapshot access without constructor/getter network requests.
- [x] Run provider tests and type checks.

### Task 2: Standalone, message-first Agent

Files: agent, engine environment/frame/hooks/execution, loop, state execution schema; standalone Agent tests.

- [x] Write failing tests for required model, standalone generate/stream/tools, message forms, model-ID and instance override, shallow options, concurrent isolation and cleanup/error/abort reuse.
- [x] Run the tests to establish RED.
- [x] Supply execution-local environments to existing loop functions; snapshot outcome before standalone cleanup.
- [x] Preserve direct model/options through all model/tool iterations and checkpoint options for Controller-backed continuations.
- [x] Run focused tests and boundary checks.

### Task 3: Existing consumers and public documentation

Files: Controller minimum model bridge, testing harness, affected fixtures/type tests/README, existing examples only.

- [x] Update constructors that omitted required model; keep Controller/Session public APIs unchanged.
- [x] Add Controller/default executable-model and queued-session regression coverage.
- [x] Verify native option typing and old fixture compatibility; update docs to label implemented Agent features accurately.
- [x] Run all runnable package tests, relevant integration tests, typecheck, builds and boundaries. Report process/network restrictions separately.

## Verification commands

Use installed binaries directly; pnpm currently resolves a different store and may attempt a reinstall.

```powershell
node node_modules/vitest/vitest.mjs run packages/core/test/agent-standalone.test.ts packages/openai/test/provider.test.ts --configLoader native --pool threads --maxWorkers 4
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.tests.json
node scripts/check-boundaries.mjs
```

Track concrete RED/GREEN evidence and implementation decisions in this file as work proceeds. Source changes require successful relevant verification; this plan alone does not establish completion.

## Execution evidence — 2026-10-17

- Initial RED: 10 new tests failed on the absent OpenAIProvider/message-first standalone API and missing required-model validation. The implementation made those pass before expanding coverage.
- Fresh review found four defects: lost per-call connections during continuation, old-provider options carried across resume/recovery overrides, accepted unsupported compaction, and a missing SDK client transport key. Regression tests failed before the fixes; all four were fixed and independently re-reviewed.
- Focused Agent/provider/type suites: **23 passed**. Coverage includes SDK 429 retry/exhaustion, timeout, partial-stream failure without replay, connection isolation, concurrent shallow overrides, standalone tools and abort/reuse, queued Session defaults, suspension/recovery and option invalidation.
- Complete runnable selection: **159 tests / 42 files passed**:

  ```powershell
  node node_modules/vitest/vitest.mjs run packages/core/test packages/openai/test packages/sqlite/test packages/plugins/test/logger.test.ts tests/integration/parallel-tools.test.ts --configLoader native --pool threads --maxWorkers 4
  ```

- Typecheck passed: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.tests.json`.
- All six TypeScript builds passed: core, openai, sqlite, plugins, existing headless example and existing CLI example.
- `node scripts/check-boundaries.mjs` passed; `git diff --check` passed (existing LF/CRLF notices only).
- Built package smoke passed using public Agent/OpenAIProvider imports and the actual SDK with local fetch/SSE fixtures: standalone generate, streamed model-ID/options override, undeclared defaults absent, and optional Controller compatibility.
- Existing built headless and CLI examples ran directly and completed successfully.
- An expanded run attempted public-import, examples and plugin-manager subprocess suites: **8 tests failed at child-process spawn with EPERM** in this sandbox; the same run passed the 159 tests above. Release/package-distribution/SQLite process suites were not rerun here because they require the same unavailable child-process capability. These process suites are not counted as passing.
- No live provider account/API call, registry publish, Git commit or push was performed. SDK behavior was exercised against local fake HTTP/SSE responses, not a live model.

## Deliberate follow-on boundary

The Controller compatibility bridge registers only the Agent default provider and
uses existing lifecycle/collision rules. Per-call executable connections are
retained only while their execution is unfinished, then released from Agent
bookkeeping. A new OpenAIProvider gets a new opaque connectionId; recreating it
after a process restart does not automatically bind old checkpoints to that
client. Durable connection registration/rebinding and `session.model` belong
to the next Controller/Session design. Do not serialize credentials or silently
rebind an old checkpoint to a different connection to bypass this boundary.
