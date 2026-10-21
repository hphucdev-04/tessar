# Session API Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore the agreed Session model/thread API and remove Controller duplicates.
**Architecture:** Relocate existing eventful thread operations to an internal module; Session delegates with its scope/context. Keep registry private to Controller and pass Session the model catalog it needs. Preserve execution/storage protocols.
**Tech Stack:** TypeScript ESM, Node >=24.14.0, pnpm 11.5.3, Vitest.
**Spec:** ../specs/2026-10-20-tessar-session-api.md

## Global Constraints

- Preserve unrelated dirty changes; no publish, commit or dependency additions.
- No instructions in Session thread.create; no model.set/setModel compatibility aliases.
- Part-level metadata is a deferred note only.
- Audit is a report, not permission for additional simplifications.

## Review Focus

- Native model IDs containing slashes and distinct registered connections.
- Denied/failed model changes and no accidental credential persistence.
- Inputs accepted before/after switch retain their own model/options.
- Scope and current Session revision after deleting/purging a selected thread.
- Standalone Agent and compiled package declarations remain usable.

### Task 1: Model manager

- [x] Add failing tests for four methods, options, events, queue snapshots and restoration.
- [x] Implement Session manager and private registry; migrate model callers/docs.
- [x] Run focused tests and typecheck.

### Task 2: Thread ownership

- [x] Add API-boundary and instruction/queue regression tests.
- [x] Move Controller thread methods into internal functions; route Session through them.
- [x] Migrate internal tests and public process fixtures; hide Thread execution declarations.
- [x] Build and test scope, hooks, fork/delete/purge and persistence.

### Task 3: Verification and audit

- [x] Update public guides and note the breaking API migration.
- [x] Run source/declaration checks, relevant package/integration/storage tests.
- [x] Audit all source, tests, dependencies and tooling for complexity; save ranked findings.

## Execution record (2026-10-21)

- Model/API regression tests first failed against the legacy Controller registry;
  completed implementation passes all seven new Session API tests.
- Ruling: normalize seeded messages using the existing codec routine. Move that
  routine from Agent to the message codec to avoid the new Agent/Thread runtime
  import cycle; keep it outside the package entrypoint.
- Ruling: reuse deletion revision validation for purge; retain the existing
  requirement to soft-delete before purging. No schema migration.
- `pnpm typecheck` and `pnpm check:boundaries`: passed.
- Built all six packages and both private fixture applications using direct
  TypeScript CLI commands. Compiled an external-style consumer against built
  declarations without source aliases or skipLibCheck; removed APIs correctly
  produce type errors, and the consumer runs successfully.
- Final package/storage run with `.env.storage`: 314 passed, 17 MongoDB tests
  skipped (no configured MongoDB URL). Four process-spawning plugin-manager tests
  were excluded after confirming the sandbox rejects them with `spawn EPERM`.
  Full `pnpm test` therefore remains blocked on those four tests here.
- PostgreSQL and persistence-restart focused run: 41 passed, 17 MongoDB skipped
  (includes seven Session API tests already counted in the package run).
- Direct PowerShell-launched Node processes verified ordinary SQLite suspension
  and resume, recovery after a crash before suspension notification, and recovery
  after the answer checkpoint. Expired test leases explicitly for crash recovery;
  each case recorded exactly one execute and one resume call.
- Independent read-only final review found no critical/important issues and ran
  39 focused tests successfully.
- Whole-tree complexity audit covered 98 TypeScript source files, 62 package test
  files, integration/fixture tests, dependencies and tooling. Four suggestions,
  approximately 33 lines and zero dependencies; report only, no audit fixes applied.
  See `../specs/2026-10-21-tessar-ponytail-audit.md`.
