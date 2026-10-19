# Tools Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. The user explicitly requested implementation; no delegation.

**Goal:** Implement the approved Zod tool API, direct Agent tools, automatic ToolMessage results, and parallel durable dispatch.

**Architecture:** Reuse the current registry and lifecycle hooks. Separate sequential tool preparation/result publication from concurrent executions, preserving per-call records and recovery.

**Tech Stack:** TypeScript, Zod 4 native JSON Schema, Node 24, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-16-tessar-tools-design.md`

## Global Constraints

- Keep `name`, `schema`, optional `metadata`; no tool retry/enabled configuration.
- No concurrency limit unless explicitly configured; `concurrency` is reserved in Agent.tools.
- Keep original provider errors and all checkpoint/interrupt behavior.
- Preserve existing release edits; do not commit, tag, or publish.

## Review Focus

- Missing return, non-JSON data, and unbound serialized tool messages must fail.
- Input transforms execute once; provider JSON schema describes input, not transformed output.
- Out-of-order completion must not lose results, misattribute effects, or trigger the next model early.
- Suspension/cancellation and crash recovery must not replay completed tool calls.
- Direct/plugin tool name collisions fail, including plugins attached after initialization.

### Task 1: Tool and message contracts

- [x] Write and run failing tests for Zod inference/validation, normalized results, explicit message preservation, correlation validation, and OpenAI JSON output.
- [x] Implement Zod Tool schema, ToolMessage constructor/correlation binding, and provider data serialization.
- [x] Migrate existing tool users; run focused tests/typecheck.

### Task 2: Agent tools and durable parallel dispatch

- [x] Write and run failing tests for direct registration, collisions, unlimited/limited execution, ordered results, suspension, abort, attribution, and batch recovery.
- [x] Reuse registry registration for Agent-owned tools; validate configuration.
- [x] Implement sequential preparation, concurrent dispatch with per-call completion checkpoints, ordered publication, and reconciliation for all pending dispatched calls.
- [x] Run focused runtime/recovery tests.

### Task 3: Documentation and verification

- [x] Update existing READMEs and examples to demonstrate agreed APIs.
- [x] Run typecheck, build, unit/integration tests, and package boundary checks.
- [x] Review the final diff, preserving release preparation and documenting validation limits.

## Execution notes

- Tool/message tests failed against the old API, then passed after implementation. Parallel scheduling tests likewise failed before Agent tool registration and batch dispatch existed.
- Review exposed and fixed a concurrent auxiliary model-budget race, duplicate result-ID reuse, a final-tool checkpoint phase gap, and pre-dispatch cancellation being incorrectly marked as an unknown dispatched operation. Each has a regression check.
- Typecheck, all six package/example compilations through direct `tsc`, package boundaries, diff whitespace, and the lockfile-only frozen install check passed. Built public API execution passed for the model/tool/model flow with Zod and automatic JSON results.
- 136 tests passed across 39 runnable files, including real SQLite result-publication failure/recovery. The full unit/integration commands were attempted: 19 subprocess tests were blocked by `spawn EPERM`; three existing process capability tests skipped. These are not reported as passing. `pnpm -r build` has the same process restriction; direct compiler runs passed instead.
- The existing `.gitignore` excludes `examples/`; local existing examples were updated without changing ignore policy. The spec/plan use the repository's tracked `*-tessar-*` naming pattern.
- Existing release version/README preparation is preserved. No commit, tag, push or npm publish was performed.
- Final verification used the installed compiler and Vitest entrypoints directly: pnpm's dependency preflight attempted an install against a different store directory and aborted a non-interactive modules purge. No store configuration or sandbox permissions were changed; a fresh full install was not verified.
