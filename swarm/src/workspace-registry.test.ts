import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { smithPaths } from "./paths.js";
import { loadRegistry, registryPath, removeRegistryEntry, saveRegistryEntry } from "./workspace-registry.js";

test("registryPath: workspaces.json sits at the state root, beside the workspaces dir", () => {
  const paths = smithPaths("/state");
  assert.equal(registryPath(paths), join("/state", "workspaces.json"));
});

test("loadRegistry: an absent registry is an empty one, not an error", async () => {
  const root = mkdtempSync(join(tmpdir(), "reg-absent-"));
  try {
    assert.deepEqual(await loadRegistry(smithPaths(root)), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saveRegistryEntry: adds an entry without disturbing the others", async () => {
  const root = mkdtempSync(join(tmpdir(), "reg-add-"));
  try {
    const paths = smithPaths(root);
    await saveRegistryEntry(paths, "alpha", "/dirs/alpha");
    await saveRegistryEntry(paths, "beta", "/dirs/beta");
    await saveRegistryEntry(paths, "alpha", "/dirs/alpha-moved");

    assert.deepEqual(await loadRegistry(paths), {
      alpha: "/dirs/alpha-moved",
      beta: "/dirs/beta",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removeRegistryEntry: drops one entry, and a missing name is a no-op", async () => {
  const root = mkdtempSync(join(tmpdir(), "reg-rm-"));
  try {
    const paths = smithPaths(root);
    await saveRegistryEntry(paths, "alpha", "/dirs/alpha");
    await saveRegistryEntry(paths, "beta", "/dirs/beta");

    await removeRegistryEntry(paths, "alpha");
    assert.deepEqual(await loadRegistry(paths), { beta: "/dirs/beta" });

    await removeRegistryEntry(paths, "never-existed");
    assert.deepEqual(await loadRegistry(paths), { beta: "/dirs/beta" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadRegistry: a malformed registry throws rather than silently reporting no workspaces", async () => {
  const root = mkdtempSync(join(tmpdir(), "reg-bad-"));
  try {
    const paths = smithPaths(root);
    writeFileSync(registryPath(paths), "{not json");
    // Returning {} here would look exactly like a fresh install and would let
    // the server come up owning nothing. It must fail loudly instead.
    await assert.rejects(() => loadRegistry(paths));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
