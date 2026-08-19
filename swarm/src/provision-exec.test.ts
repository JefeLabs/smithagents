import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { copyProvisionPaths } from "./provision-exec.js";

/** A source/dest pair under one temp root, cleaned by the caller. */
function makePair(label: string) {
  const root = mkdtempSync(join(tmpdir(), `prov-${label}-`));
  const source = join(root, "src");
  const dest = join(root, "dst");
  mkdirSync(source, { recursive: true });
  mkdirSync(dest, { recursive: true });
  return { root, source, dest };
}

test("copies a directory and reports it", async () => {
  const { root, source, dest } = makePair("dir");
  try {
    mkdirSync(join(source, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(source, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");

    const result = await copyProvisionPaths(source, dest, ["node_modules"]);

    assert.deepEqual(result.copied, ["node_modules"]);
    assert.deepEqual(result.failed, []);
    assert.ok(statSync(join(dest, "node_modules", "pkg", "index.js")).isFile());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the copy is INDEPENDENT — writing to it never reaches the source", async () => {
  const { root, source, dest } = makePair("indep");
  try {
    mkdirSync(join(source, ".cache"), { recursive: true });
    writeFileSync(join(source, ".cache", "a.txt"), "original\n");

    await copyProvisionPaths(source, dest, [".cache"]);
    writeFileSync(join(dest, ".cache", "a.txt"), "changed\n");

    // A shared tree between concurrent agents is what instance isolation exists
    // to prevent; this is the assertion that proves it is not shared.
    assert.equal(readFileSync(join(source, ".cache", "a.txt"), "utf8"), "original\n");
    assert.equal(statSync(join(dest, ".cache")).isSymbolicLink(), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the destination root is never a symlink, whatever the source contains", async () => {
  const { root, source, dest } = makePair("nolink");
  try {
    mkdirSync(join(source, "store"), { recursive: true });
    writeFileSync(join(source, "store", "real.txt"), "x\n");
    mkdirSync(join(source, "node_modules"), { recursive: true });
    // pnpm's node_modules is largely links into a content-addressed store, so
    // this is the realistic shape rather than an exotic one.
    symlinkSync(join(source, "store"), join(source, "node_modules", "linked"));

    await copyProvisionPaths(source, dest, ["node_modules"]);

    assert.equal(statSync(join(dest, "node_modules")).isSymbolicLink(), false);
    // The inner link is PRESERVED as a link — copying pnpm's store by value
    // would duplicate gigabytes for no gain.
    assert.equal(readlinkSync(join(dest, "node_modules", "linked")), join(source, "store"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing path is reported, never thrown — copy is an optimization", async () => {
  const { root, source, dest } = makePair("missing");
  try {
    const result = await copyProvisionPaths(source, dest, ["absent"]);
    assert.deepEqual(result.copied, []);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0]?.path, "absent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one failure does not stop the paths after it", async () => {
  const { root, source, dest } = makePair("partial");
  try {
    mkdirSync(join(source, "good"), { recursive: true });
    writeFileSync(join(source, "good", "f.txt"), "y\n");

    const result = await copyProvisionPaths(source, dest, ["absent", "good"]);

    assert.deepEqual(result.copied, ["good"]);
    assert.equal(result.failed.length, 1);
    assert.ok(statSync(join(dest, "good", "f.txt")).isFile());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty path list is a no-op success", async () => {
  const { root, source, dest } = makePair("empty");
  try {
    assert.deepEqual(await copyProvisionPaths(source, dest, []), { copied: [], failed: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
