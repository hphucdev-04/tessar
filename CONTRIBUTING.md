# Contributing to Tessar

This page is for contributors and maintainers working on the SDK itself. To use
Tessar in an application, start with the [developer guides](examples/guide/README.md).

## Local development

Requires Node.js >=24.14.0 and pnpm 11.5.3.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test --maxWorkers 4
pnpm test:integration --maxWorkers 4
pnpm check:boundaries
```

The private applications in `tests/fixtures/apps/cli` and
`tests/fixtures/apps/headless` are consumers used by integration tests. Keep their
sources in the repository; build outputs and `node_modules` remain ignored. They are not
included in npm releases.

For real database tests, set `TESSAR_TEST_POSTGRES_URL` and
`TESSAR_TEST_MONGODB_URL` in the environment or ignored `.env.storage`, then run:

```sh
pnpm test:storage --maxWorkers 4
```

These tests use generated schemas/databases and skip when their URLs are absent.
MongoDB needs a replica set or sharded deployment supporting transactions.

## Releases

All six public packages share one release version. Update `version` in
`packages/{core,openai,plugins,sqlite,postgresql,mongodb}/package.json` together.
The private workspace root's version is not used for publishing. Commit all
release changes to `release` before creating the matching tag:

```sh
git push origin release
git tag v0.1.1
git push origin v0.1.1
```

Use the next unpublished version, rather than copying the example version.
Pushes to `release` and pull requests run CI. Tag pushes matching `v*` trigger
`.github/workflows/release.yml`, which calls the reusable CI, checks versions,
builds and packs the packages, validates the archives and publishes them.
Stable tags use npm `latest`; prerelease tags such as `v0.2.0-beta.1` use `next`.

Each package needs npm Trusted Publishing configured for GitHub owner
`tessar-ai`, repository `tessar`, workflow `release.yml`, no environment and
permission to run `npm publish`. The workflow uses OIDC rather than `NPM_TOKEN`.
See [npm's setup instructions](https://docs.npmjs.com/trusted-publishers/).

New packages need an initial authenticated publish before configuring their
package settings. Use a separate bootstrap version so the subsequent release
workflow does not attempt to republish an existing version.

To inspect a release locally without publishing, use PowerShell:

```powershell
$env:RELEASE_TAG = 'v0.1.1'
node scripts/release.mjs check
pnpm build
pnpm --filter './packages/*' -r pack --pack-destination "$PWD/dist/release"
node scripts/release.mjs verify
```

Publication is sequential and is not atomic. If a package fails after earlier
packages succeed, inspect the registry and use the saved workflow archives to
publish only missing packages. The current workflow does not skip existing
versions. Re-running an old tag uses its original commit, including its workflow.
