# @tessar/sqlite

SQLite persistence for Tessar's state and checkpoint contracts, using Node's
built-in SQLite API. Requires Node 24.14 or newer.

```sh
npm install @tessar/core@next @tessar/sqlite@next
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

This is an alpha release. See the
[repository](https://github.com/hphucdev-04/tessar) for usage and contracts.
