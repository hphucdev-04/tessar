# Unified Tessar hooks implementation plan

> Execute inline with superpowers:executing-plans and TDD as requested. Preserve
> existing dirty work in D:\tessar; no commit, publish or new dependencies.

**Goal:** Implement the agreed shared hook boundaries and lowercase event map.

**Spec:** ../specs/2026-10-17-tessar-hooks-design.md

**Architecture:** Keep EventMap/PluginHost/dispatcher. Public lowercase event groups
use camelCase keys and existing string identifiers. Add five policy
decisions and three successful thread notifications. Scope and storage validation
remain mandatory. Existing model-provider redesign and specialized plugins are
outside this change.

## Implementation rulings

- Replace AgentEvents/SessionEvents with directly imported groups: `model.select`,
  `thread.beforeDelete`, `session.threadSwitched`, `session.model.beforeChange`.
  No `events` root prefix. Hyphenated string segments become camelCase map keys;
  event strings remain unchanged. No extra event bus.
- New operation decisions support allow/deny/undefined only. Undefined allows;
  deny rejects with OperationDenied; invalid results reject with InvalidHookResult.
  Each handler result is validated before any later handler can hide it.
- setModel becomes async so policy handlers can be awaited before assigning the
  selection; existing callers must await it before queuing inputs using that model.
- Session control mutations reject reentrant/concurrent control operations with
  SessionBusy. Reads remain available. Recheck readiness/selection invariants
  after awaited policies; never publish success after denial/failure.
- Thread policies and success events run in Controller's shared public operations,
  covering direct calls and Session wrappers. Validate scope before dispatch and
  preserve scope filters for the actual storage operation.
- Hook context may expose the relevant Session through a typed safe capability
  subset (selection, queued input and thread operations), and a read-only Thread
  handle. Execution contexts receive these only when invoked through such handles;
  no handles or clients are persisted into checkpoints/events.

## Tasks

### 1. Shared event map and contract
- [x] Add failing tests for lowercase map, async decisions and invalid results.
- [x] Consolidate constants/types in events/type.ts and migrate repo consumers.
- [x] Implement operation decision validation using the existing dispatcher.

### 2. Session and Thread boundaries
- [x] Add failing tests for allow/deny, ordering, scope and storage failures,
  reentrant changes and Session-local context.
- [x] Implement awaited Session model/thread-switch policy hooks and control guard.
- [x] Implement Controller thread fork/rename/delete policy/success hooks.
- [x] Wire the typed capability contexts through Session lifecycle/execution paths.

### 3. Integration and verification
- [x] Update logger, public docs/types and existing async setModel callers.
- [x] Run focused suites, full runnable suites, typecheck, builds and boundaries.
- [x] Obtain a fresh read-only review; fix material findings and record evidence.

## Review focus

- Invalid policy results must fail even when a later policy returns allow.
- A denied, failed or out-of-scope operation must not mutate state or emit success.
- Async policy cannot race another selection/close or bypass storage busy checks.
- Context handles never become serialized payload/checkpoint data or leak across
  Sessions; await-dependent lifecycle methods are not offered as hook capabilities.
- Model/thread changes preserve the snapshot already taken for queued input.

## Progress / evidence

Completed in the existing checkout; baseline was 159 runnable tests.

- RED/GREEN evidence: missing policy boundaries/map exports, invalid decisions,
  caller-mutated fork options, stale switch target activity and missing cancellation
  handles were reproduced before their implementation/fixes. Sixteen operation
  tests now cover these contracts.
- Focused operation + Session verification: 22 tests passed.
- Runnable full selection: 175 tests in 43 files passed (core, OpenAI, SQLite,
  logger and parallel-tools integration).
- Full package test command: 174 passed, four failures in
  packages/plugins/test/index.test.ts, all spawn EPERM from the sandbox. These
  cover local discovery/lazy SDK imports, package exports/dependencies, invalid
  manifests/exports, and npm install/update/remove. They are not counted as passed.
- Workspace test typecheck passed; all four package builds and both existing
  example builds passed. Package boundaries verified.
- Built public-import smoke passed with fetch disabled: direct camelCase groups,
  Session execution/model change, post-rename logging and LoggerPlugin.
- Fresh independent read-only review completed. Its cancellation handle gap was
  reproduced and fixed through Session/Thread -> Agent -> restored frame; no
  remaining material findings. Active frames retain their original caller context.
- No commit, publish, provider network request or specialized plugin was performed.
