# Tessar audit cleanup

This cleanup supersedes the affected implementation details in earlier plans.

- Agent calls accept `generate(message, options?)` and `stream(message, options?)`.
  The deprecated `{ input, ...options }` overload and `LegacyAgentExecutionOptions`
  are removed. Thread commands retain their existing object API.
- Memory and SQLite share the construction of `ThreadInfo`; validation,
  transaction boundaries, immutability and lineage behavior remain in place.
- Primary and auxiliary calls share model-attempt record initialization. Their
  execution, recovery and budget checks remain separate.
- `ProfileResolver` uses a native `Map`, retaining the 24-hour TTL and cache key
  components. `ProfileCache` is removed.
- Session subscribers and stream observers share error reporting. Delivery stays
  synchronous; rejected observer promises are reported without being awaited.
  Filtered Session subscriptions now return the callback's promise so async
  errors reach diagnostics instead of becoming unhandled rejections.
- Remove unused `ModelAttemptRecord.requestSnapshotRef`,
  `ToolExecutionRecord.resultRef`, `ExecutionPosition.recordRevision`, and the
  unused `AfterTool` / `Finalizing` phases. Existing stored JSON may retain extra
  keys; this cleanup does not rewrite or purge stored data. No SQL table changes
  are required.
- Remove `SessionService`; use `StorageBackend.sessions` directly. Both backends
  continue to call the shared `validateSession` function for CAS and scope checks.

Consumers importing the removed types, wrapper or fields need to update before
using this revision. No package versions or dependencies change in this cleanup.
