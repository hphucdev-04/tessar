import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Release policy is shared by local checks and GitHub Actions; no registry writes.
const mode = process.argv[2] ?? "check";
assert.ok(["check", "verify"].includes(mode), "Usage: node scripts/release.mjs [check|verify]");
const ref = process.env.RELEASE_TAG ?? "";
const number = "(?:0|[1-9]\\d*)";
const identifier = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][\\dA-Za-z-]*)";
const match = new RegExp(`^v(${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?)$`).exec(ref);
assert.ok(match && match[0] === ref, "Expected a release tag such as v0.1.0 or v0.2.0-beta.1");
const version = match[1];
const tag = version.includes("-") ? "next" : "latest";

for (const name of ["core", "openai", "plugins", "sqlite", "postgresql", "mongodb"]) {
  const expected = "@tessar/" + name;
  const source = JSON.parse(readFileSync(resolve("packages", name, "package.json"), "utf8"));
  assert.equal(source.name, expected, "Unexpected package name");
  assert.equal(source.version, version, `${expected} version must match ${ref}`);
  assert.ok(!source.private, `${expected} must be publishable`);
  assert.equal(source.publishConfig?.access, "public");
  assert.equal(source.publishConfig?.registry, "https://registry.npmjs.org/");
  assert.equal(source.repository?.url, "git+https://github.com/hphucdev-04/tessar.git");
  if (source.publishConfig.tag !== undefined)
    assert.equal(source.publishConfig.tag, tag, `${expected} has a conflicting publish tag`);

  if (mode !== "verify") continue;
  const archive = resolve("dist/release", `tessar-${name}-${version}.tgz`);
  const tar = args => execFileSync("tar", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const packed = JSON.parse(tar(["-xOf", archive, "package/package.json"]));
  assert.equal(packed.name, expected);
  assert.equal(packed.version, version);
  assert.ok(!JSON.stringify(packed).includes("workspace:"), "Unresolved workspace dependency in " + expected);
  assert.equal(packed.publishConfig?.access, "public");
  assert.equal(packed.repository?.url, source.repository.url);
  const files = tar(["-tzf", archive]).trim().split(/\r?\n/);
  assert.ok(files.includes("package/README.md"), "Missing README in " + expected);
  assert.ok(!files.some(file => /\/(?:test|tests|node_modules)\/|\.test\.|\/(?:\.env|\.npmrc)$/.test(file)), "Unexpected private/test files in " + expected);
  for (const target of Object.values(packed.exports).flatMap(value => Object.values(value)))
    assert.ok(files.includes("package/" + target.replace(/^\.\//, "")), "Missing export " + target);
  if (["openai", "sqlite", "postgresql", "mongodb"].includes(name))
    assert.equal(packed.dependencies?.["@tessar/core"], version, "Incorrect core dependency in " + expected);
  if (name === "plugins")
    assert.equal(packed.peerDependencies?.["@tessar/core"], "^" + version, "Incorrect core peer dependency");
}

if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${tag}\n`);
console.log(JSON.stringify({ version, tag }));
