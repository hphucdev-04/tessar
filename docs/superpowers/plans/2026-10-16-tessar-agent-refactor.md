# Agent responsibility refactor

**Goal:** Repay the large Agent file debt before packaging. Preserve public APIs and execution behavior, including the newly implemented tool contract.

**Approach:** Keep Agent as the public configuration/admission/job owner. Extract ordinary functions by existing responsibility; retain the function-based loop and avoid introducing another execution class. Reuse the existing LoopContext callbacks to keep the module dependency graph acyclic. Share repeated frame construction and record loading across input, recovery, and resume.

## Files

- `agent.ts`: public contracts, configuration, controller binding, stream/generate, admission, cancellation delegation, shutdown.
- `engine/frame.ts`: execution types, shared record/frame loading, ownership heartbeat.
- `engine/execution.ts`: execution admission/driver, failure cleanup and cancellation.
- `engine/checkpoint.ts`: record changes, usage aggregation, checkpoint/message commits, terminal finalization.
- `engine/hooks.ts`: execution event context, hook cursor dispatch and durable suspension.
- `engine/services.ts`: tracked service composition and auxiliary model calls.
- `engine/resume.ts`: retain validators; add resume/recovery preparation using shared frame construction.
- `loop.ts` and `engine/tool-executor.ts`: import execution frame types from their owner.

## Constraints

- No public AgentEngine, new public runtime layer, base class, dependency, or behavior/configuration changes.
- Preserve original provider errors, scope, ownership, hook cursor, budgets, child lineage, and ToolMessage correlation.
- Preserve all existing dirty tool/release work. Publishing remains deferred.

## Checks

- [x] Establish focused Agent/interrupt/recovery/parallel-tool baseline.
- [x] Extract functions and deduplicate frame construction; preserve root type exports.
- [x] Verify types and absence of runtime import cycles.
- [x] Run existing unit and SQLite regression tests, compile public packages/examples, smoke built APIs.
- [x] Inspect diff and report file sizes and verification limitations.

## Verification

- Agent reduced from 1,574 to 251 lines. New modules: frame 114, checkpoint 237, hooks 178, services 178, execution 332 lines; existing resume module now 333 lines.
- Existing focused tests: 26 passed before and after extraction. The runnable regression suite passed 136 tests across 39 files, including SQLite failure/recovery, parallel tools, cancellation, scoped state, plugin continuity and queued Session input.
- Typecheck, all six package/example compilations, package boundaries/import-cycle checks and diff whitespace checks passed using the installed compiler directly.
- Built public API smoke passed for Agent model/tool/model execution and two queued Session inputs.
- The previously reported subprocess test restrictions remain: this refactor does not establish passing results for the 19 tests blocked by `spawn EPERM` or the three process capability skips. Package-manager preflight/store restrictions were avoided by invoking installed compiler/test entrypoints directly; no sandbox permissions or store configuration changed.
- All previous tool API and release-preparation edits are preserved. No commit, tag, pack or publish was performed during this refactor.
