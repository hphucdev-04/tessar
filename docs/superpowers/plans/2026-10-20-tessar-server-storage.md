# Server Storage Implementation Plan

**Goal:** Add PostgreSQL and MongoDB plugins using the existing storage contract.
**Spec:** ../specs/2026-10-20-tessar-server-storage.md
**Architecture:** Independent native adapters; existing core validation and query
helpers reused. No new storage framework or shared runtime dependency.

- [x] Implement PostgreSQL package, native transactions/indexes, plugin, README
  and real-database conformance/concurrency/restart tests.
- [x] Implement MongoDB package, transactional collections/version records,
  plugin, README and real-database conformance/concurrency/restart tests.
- [x] Install driver dependencies and update workspace aliases, lockfile,
  package/release enumeration and CI database test job.
- [x] Build all six packages, typecheck, run existing package tests and review
  atomicity/fencing and cleanup.
- [ ] Run new tests against configured real databases when URLs are available.

PostgreSQL and MongoDB implementation tasks own their package directories only
and can run independently. Root owns shared files, dependency installation and
integration. Keep existing uncommitted registry work intact.


## Verification record

- Six package builds, root typecheck and boundary checks pass.
- Existing runnable package suite: 241 pass; new database cases explicitly skip
  without URLs. The known child-process plugin suite remains excluded because
  this environment rejects child process creation with EPERM.
- New package public imports and unsafe PostgreSQL schema rejection pass.
- Package tarballs can be generated; no publishing has been performed.
- pnpm registry requests receive ECONNREFUSED in this environment. Native drivers
  were installed with npm into ignored local tooling paths. The lockfile extends
  existing resolutions using those exact installed versions and integrity records;
  its importer specs and complete dependency graph were checked. A native frozen
  pnpm installation is still to be verified in CI or an unrestricted environment.
- A separate source review found a MongoDB lease expiry gap during long publish.
  Added a final guarded server-time lease check and a slow-write regression test.
  Real database runtime validation remains pending `.env.storage` settings.


## Storage alignment follow-up

- SQLite, PostgreSQL and MongoDB now separate schema, ownership, version storage
  and query responsibilities. Server adapters keep pool/client transactions in
  database.ts; no new core storage abstraction was introduced.
- Schema markers: SQLite user_version=2; PostgreSQL schema_metadata=1; MongoDB
  tessar_schema=1. Unsupported versions fail before application DDL. Existing
  supported/unversioned data is retained; there is no automatic reset.
- SQLite purge now retains lease counters, and all durable publications recheck
  expiry before commit. Receipt membership and checkpoint identity conflicts are
  checked consistently. Shared conformance regressions were observed failing and
  then passing on memory/SQLite.
- All three plugin setup paths close rejected backends while preserving the
  original registration error. Nine lifecycle checks pass.
- Latest runnable package suite: 258 passed, 37 conditional database cases skipped.
  The known process-spawn plugin suite remains excluded (EPERM).
- The updated PostgreSQL URL now works: its complete package suite passes 25 tests
  against the real database. MongoDB URL remains absent: 3 lifecycle tests pass,
  16 database tests explicitly skip.
- Builds, root typecheck, boundaries and source correctness review pass.
- Final ponytail-review verdict: Lean already. Ship. The initial redundant-column
  suggestion was withdrawn because safe removal requires a schema migration whose
  complexity outweighs the saving in this alignment work. No review findings remain.
