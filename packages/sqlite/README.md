# @tessar/sqlite

SQLite persistence for Tessar's state and checkpoint contracts, using Node's
built-in SQLite API. Requires Node 24.14 or newer.

```sh
npm install @tessar/core @tessar/sqlite
```

```ts
import { SqliteStoragePlugin } from "@tessar/sqlite";

const storage = new SqliteStoragePlugin({ filename: "./state.db" });
// Include storage in new Controller({ id, agent, plugins: [storage, ...] }).
```

Core owns state/checkpoint behavior; this plugin supplies physical persistence.
Choose the backend before Controller initialization. Scope filters bind queries
to application-selected metadata; applications own authentication and authorization.

Node's SQLite API is experimental. This backend uses synchronous database
operations and is a reference implementation, not a server throughput claim.

This is an early 0.x release. See the
[repository](https://github.com/hphucdev-04/tessar) for usage and contracts.

## Schema v2

Initialization transactionally migrates v1 databases, preserving checkpoint IDs,
historical message/trace views, plugin snapshots, leases and commit receipts.
Inconsistent source data (including nonempty legacy `plugin_states` projections
or receipts without their original staged batches) aborts and rolls back. There
is no automatic reset or lossy fallback. No Sessions are invented for old threads.

Messages and trace records have revision intervals instead of one copy per
checkpoint. Public checkpoints still hydrate complete logical history. Successful
publication removes staging; receipt fingerprints continue rejecting a changed
payload with the same commit ID. Session selection writes use transactional CAS.
There is no `agents` table.

History and record pages use bounded SQL queries and indexed parent/date/ID
columns. Arbitrary scalar scope keys are bound JSON predicates and may require
scanning candidates; there is no automatic index per scope key. SQLite uses
synchronous operations, so large writes can still block the Node event loop.

Delete remains soft. Purge is explicit, guarded by ownership and retained fork
lineage, and never removes plugin-owned tables. Plugins needing independent job
claims or scheduling indexes own their database/schema and migrations; the core
state API exposes JSON state, not raw SQL access.

Lease fencing counters survive purge. A stale lease cannot regain ownership when
the same thread ID and owner token are reused. Publication checks ownership again
before committing; an expired lease rolls back the complete publication.

See [the database map](../../SQLITE-STATE.md) for tables and actual fixture rows.
