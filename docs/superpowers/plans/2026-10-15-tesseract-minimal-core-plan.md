# Tesseract Minimal Core Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan natively, task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the agreed core package and plugin API with a working Agent,
Controller and Session, preserving tested persistence and provider behavior.

**Architecture:** Agent owns execution directly; Controller owns resources;
Session is an interaction facade in the same package. Events are string
constants plus an extensible type map. Reuse the existing storage, trace,
provider and metadata code; remove the abandoned SDK package and bridges.

**Tech Stack:** Node >=24.14.0, pnpm 11.5.3, TypeScript 7.0.2, Vitest 5.0.4,
ESM, built-in node:sqlite in its adapter, OpenAI SDK 7.34.0 in @tesseract/openai.

**Spec:** [Minimal Core Design](../specs/2026-10-15-tesseract-minimal-core-design.md).
This plan supersedes the previous master/subplans. Native execution was already
selected, and the user explicitly requested writing these documents then implementing.

## Global constraints

- @tesseract/core exports Agent/Controller/Session/Thread and all public primitives.
- No extra engine class, runtime port, bind adapter or @tesseract/sdk package.
- Plugin setup parameter is tesseract; registration is tesseract.hook, never on.
- No required apiVersion and no core. event-name prefix.
- Preserve required storage/checkpoint validation, fencing and recovery guarantees.
- Keep existing meaningful tests; do not add dependencies or product policies.
- Preserve unrelated .agents skill files and all user changes. Do not publish/push.
- Worktree .git is currently read-only; preserve changes without bypassing permissions.

## Review focus

1. Same-scope Sessions must not share selection, observers or volatile queues.
2. Resume after plugin reorder must follow the saved handler manifest/cursor.
3. Event dispatch must keep typed payloads/results and never leak execution services.
4. Aborted/unknown effects must not be repeated or falsely marked completed.
5. Built imports must use only public exports and perform no product startup I/O.

## Task 1: String events and plugin registration

Files: core events/{definition,catalog,dispatcher}.ts, plugins/{context,host,registry}.ts,
agent.ts and engine/{resume,delivery,tracked-effects}.ts; existing event/plugin tests.

Produces: AgentEvents string constants, EventMap/StreamEvent, PluginContext.hook,
Plugin {id,setup}; per-host hook kind/version metadata; immutable event identities.

- [ ] Add tests for string constants, inferred hook payload/result, no mandatory apiVersion,
  custom hooks and saved-order continuation. Run them and observe failures.
- [ ] Replace definition objects with strings/types and per-host registration metadata;
  migrate all source/tests to setup(tesseract) and hook. Remove old aliases/prefixes.
- [ ] Run event/plugin tests and strict typecheck; existing behavior tests stay meaningful.

## Task 2: Agent, Controller and Thread in core

Files: core/{agent,controller,thread,index}.ts, models/{registry,resolver,cache,catalog}.ts,
testing/harness.ts and existing Agent/Controller/Thread/model tests; workspace config/scripts.

Produces: Agent(options).stream/generate; Controller.initialize/create/get/list/delete/
forkThread/models/plugins/dispose; scoped Thread APIs from the spec. Agent directly
contains the existing execution logic. Helpers may be plain functions where justified.

- [ ] Run existing constructor/lifecycle/parity/query tests and observe missing implementations.
- [ ] Complete the interrupted source migration, fix internal imports, and remove old SDK
  package aliases/files. Compose resources directly in Controller with no intermediary port.
- [ ] Ensure asynchronous Thread preparation still returns one Stream attachment immediately;
  input admission checks readiness/scope/limits before dispatch and preserves cleanup.
- [ ] Run focused tests, full core tests, strict typecheck, build and SQLite process tests.

## Task 3: Session interaction and queue

Files: core/{session,session-thread,session-events,controller,index}.ts and focused tests.

Produces: createSession({scope?,model?}), typed subscribe, enqueue receipts, resume/recover
admission receipts, abort/dispose, selected Thread facade and per-instance events.

- [ ] Add gated-model tests: FIFO, captured model, suspension hold/resume drain, failed/cancelled
  discard, same-scope isolation, switch failure, safe fork and active disposal refusal. Run RED.
- [ ] Implement the facade on the existing Agent admission/delivery paths, without another loop.
- [ ] Add public compile assertions excluding id/send/stream/initialize/per-method scope overrides.
- [ ] Run Session tests, full unit suite, strict typecheck, build and process recovery tests.

## Task 4: Public consumers, examples and final verification

Files: tests/integration/public-imports.test.ts, examples/{cli,headless}, README.md,
docs/plugin-authoring.md, scripts/check-boundaries.mjs and CI workflow.

Produces: offline CLI/headless consumers using public imports; a concise plugin example
using tesseract.hook and real tool registration; source/package boundary checks and CI.

- [ ] Add failing black-box tests for built core exports and offline example processes.
- [ ] Implement minimal hosts/docs and boundary checks; no filesystem plugin loader/installer.
- [ ] Verify pnpm install --frozen-lockfile, typecheck, build, test, test:integration,
  check:boundaries and git diff --check. Report scripted/SSE/process evidence separately.
- [ ] Perform one fresh whole-change review as required by native execution, fix important
  findings with regression checks, and record any actual limitations. No release claim.
