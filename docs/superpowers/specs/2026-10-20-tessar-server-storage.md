# PostgreSQL and MongoDB storage plugins

Provide built-in, separately installable `@tessar/postgresql` and
`@tessar/mongodb` packages implementing the existing StorageBackend contract.
Like SQLite, plugins register with `tessar.storage.register(backend)` and own
their connection lifecycle. No Agent, Controller, Session or state API redesign.

## Public API

- `new PostgresqlStoragePlugin({ connectionString, schema? })` and
  `createPostgresqlBackend(options)`; default schema `tessar`.
- `new MongoDBStoragePlugin({ uri, databaseName })` and
  `createMongoDBBackend(options)`.
- Native `pg` and `mongodb` drivers; no ORM. Each factory creates its own client,
  initializes namespaced tables/collections and closes on setup failure.
- Driver connection options may be exposed for TLS/pool configuration without
  accepting an externally owned client. Backend close is idempotent.

## Storage invariants

Preserve immutable checkpoints/history, revision-based CAS, scope filters,
session selection, plugin-owned state, cursor pagination, staging visibility,
commit fingerprint idempotency, fork lineage and guarded purge. Database time
drives ownership expiry. Fencing tokens increase and survive release/purge.
Publish all checkpoint/record/head/receipt changes atomically, including clearing
session selections on thread deletion. Publication must serialize with lease
takeover, fork-source purge and selected-thread validation. Guard released and
expired leases, mismatched parents, conflicting checkpoint IDs and commit IDs.

Use database-native transactions and indexed entity/version records. Avoid
copying the complete conversation and trace into every checkpoint; adapt SQLite's
version intervals and checkpoint hydration. MongoDB needs a replica set or
sharded deployment for transactions; reject unsupported standalone deployments.
Do not hide driver failures or claim fault tolerance from in-memory mocks.

## Alignment with SQLite

All adapters separate schema, ownership, version storage and query responsibilities.
The server adapters keep connection/transaction lifecycle in `database.ts`.
Physical schema versions are independent: SQLite 2, PostgreSQL 1 and MongoDB 1.
Reject unsupported versions before application DDL; preserve existing data and
never reset a database automatically. Plugin registration failures close the new
connection while preserving the registration error.

The shared storage contract checks receipt membership, checkpoint identity reuse
and monotonically increasing fencing through purge (including reuse of the same
owner token). Every durable adapter rechecks lease expiry before committing a
publication. Memory storage retains its counters and receipt membership rules.

## Verification

Run the shared storage conformance suite against real databases configured by
`TESSAR_TEST_POSTGRES_URL` and `TESSAR_TEST_MONGODB_URL`. Each test uses a unique
schema/database owned by that test, and cleanup affects only that resource.
Add restart, stale CAS, history/version, paging/scope, fork/purge, concurrency and
lease tests. Tests skip explicitly when URLs are absent. `.env.storage` is ignored
and can be loaded with Node's `--env-file-if-exists` flag. CI supplies disposable
databases. User already has databases and will supply environment settings.

Keep source-package builds, public-import checks, release package enumeration and
documentation consistent. Do not publish or change versions in this task.
