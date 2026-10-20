shrink: Deduplicate connection identity and reserved request-option checks in the two OpenAI adapters (about 15 lines net). Use one local validation function; retain each protocol's distinct codec and option rules. [packages/openai/src/adapter.ts:82](../../../packages/openai/src/adapter.ts#L82), [packages/openai/src/chat-adapter.ts:42](../../../packages/openai/src/chat-adapter.ts#L42).

delete: Remove unused imports in engine/frame, engine/interrupt, engine/services, loop, models/registry and SQLite/MongoDB modules (about 9 lines net). Replace with nothing; TypeScript's optional noUnusedLocals/noUnusedParameters check identifies them. [packages/core/src/engine/services.ts:2](../../../packages/core/src/engine/services.ts#L2), [packages/mongodb/src/backend.ts:46](../../../packages/mongodb/src/backend.ts#L46), [packages/sqlite/src/queries.ts:4](../../../packages/sqlite/src/queries.ts#L4).

delete: Remove the unread plugin generation counter, its two increments and RegistryLease constructor plumbing (about 5 lines). Replace with nothing; leases already capture handler/value arrays and hold slot references, and no consumer reads generation. [packages/core/src/plugins/host.ts:27](../../../packages/core/src/plugins/host.ts#L27), [packages/core/src/plugins/registry.ts:36](../../../packages/core/src/plugins/registry.ts#L36).

yagni: Remove the stateless ContextAssembler and RecoveryService class shells (about 4 lines net). Export buildContext/planRecovery functions and call them directly; preserve their algorithms and tests. [packages/core/src/engine/context.ts:12](../../../packages/core/src/engine/context.ts#L12), [packages/core/src/engine/recovery.ts:12](../../../packages/core/src/engine/recovery.ts#L12).

net: -33 lines, -0 deps possible.

## Applied on 2026-10-21

All four findings are applied. Actual source reduction against the working-tree
snapshot immediately before this cleanup: **41 lines**, with no dependency changes.
The estimate above describes the original audit.

- The OpenAI adapters share an internal request validator. Their protocol-specific
  codecs, restrictions, error codes and error messages remain unchanged.
- Unused source imports and the unused model-refresh scheduling argument were removed.
- The unread generation counter and constructor argument were removed; registry
  snapshots and plugin reference counting retain their existing behavior.
- `buildContext` and `planRecovery` replace stateless class shells; their algorithms
  remain unchanged. No new public package exports.

Validation: typecheck, package boundaries, direct builds of six packages and two
fixture applications passed. Optional unused-local/parameter checks passed for
the affected source packages. Package and persistence tests: **319 passed**;
**17 MongoDB tests skipped** because no MongoDB URL was configured. The four
plugin-manager tests already blocked by sandbox `spawn EPERM` were excluded.
