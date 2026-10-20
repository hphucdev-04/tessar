import { expect, it } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("scripts/release.mjs");
const names = ["core", "openai", "plugins", "sqlite", "postgresql", "mongodb"];

function fixture(version: string, exercise: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "tessar-release-test-"));
  try {
    for (const name of names) {
      const directory = join(root, "packages", name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "package.json"), JSON.stringify({
        name: "@tessar/" + name, version, type: "module",
        publishConfig: { access: "public", registry: "https://registry.npmjs.org/" },
        repository: { url: "git+https://github.com/hphucdev-04/tessar.git" },
        exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
      }));
    }
    exercise(root);
  } finally {
    const target = resolve(root);
    if (!target.startsWith(resolve(tmpdir()) + "\\") && !target.startsWith(resolve(tmpdir()) + "/"))
      throw Error("Unsafe cleanup target: " + target);
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function run(root: string, tag: string, mode = "check") {
  return spawnSync(process.execPath, [script, mode], {
    cwd: root, encoding: "utf8", timeout: 10000, windowsHide: true,
    env: { ...process.env, RELEASE_TAG: tag, GITHUB_OUTPUT: join(root, "outputs") },
  });
}

it.each([
  ["1.2.3", "latest"],
  ["1.3.0-beta.1", "next"],
])("selects the npm channel for %s and emits workflow outputs", (version, tag) => {
  fixture(version, root => {
    const result = run(root, "v" + version);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ version, tag });
    expect(readFileSync(join(root, "outputs"), "utf8")).toBe(`version=${version}\ntag=${tag}\n`);
  });
});

it.each(["sqlite", "postgresql", "mongodb"])("rejects a tag that differs from %s before releasing anything", name => {
  fixture("1.2.3", root => {
    const path = join(root, "packages", name, "package.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...manifest, version: "1.2.2" }));
    const result = run(root, "v1.2.3");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`@tessar/${name} version must match v1.2.3`);
  });
});

it.each(["main", "v01.2.3", "v1.2.3-beta.01", "v1.2.3\ntag=latest"])("rejects invalid release tag %j", tag => {
  fixture("1.2.3", root => {
    const result = run(root, tag);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Expected a release tag");
  });
});

it("checks actual tarballs and rejects unresolved workspace dependencies", () => {
  fixture("1.2.3", root => {
    const packed = join(root, "package"), archives = join(root, "dist/release");
    mkdirSync(join(packed, "dist"), { recursive: true });
    mkdirSync(archives, { recursive: true });
    writeFileSync(join(packed, "dist/index.js"), "export {};\n");
    writeFileSync(join(packed, "dist/index.d.ts"), "export {};\n");
    writeFileSync(join(packed, "README.md"), "Fixture\n");
    for (const name of names) {
      const manifest = JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8"));
      if (["openai", "sqlite", "postgresql", "mongodb"].includes(name)) manifest.dependencies = { "@tessar/core": "1.2.3" };
      if (name === "plugins") manifest.peerDependencies = { "@tessar/core": "^1.2.3" };
      writeFileSync(join(packed, "package.json"), JSON.stringify(manifest));
      execFileSync("tar", ["-czf", join(archives, `tessar-${name}-1.2.3.tgz`), "package"], { cwd: root });
    }
    const valid = run(root, "v1.2.3", "verify");
    expect(valid.status, valid.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(join(packed, "package.json"), "utf8"));
    manifest.dependencies = { "@tessar/core": "workspace:*" };
    writeFileSync(join(packed, "package.json"), JSON.stringify(manifest));
    execFileSync("tar", ["-czf", join(archives, "tessar-mongodb-1.2.3.tgz"), "package"], { cwd: root });
    const invalid = run(root, "v1.2.3", "verify");
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain("Unresolved workspace dependency");
  });
});
