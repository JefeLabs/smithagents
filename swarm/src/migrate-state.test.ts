import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { migrateState, needsMigration, SKIPPED_ENTRIES } from "./migrate-state.js";

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "smith-mig-"));
  mkdirSync(join(dir, "old", "agents"), { recursive: true });
  mkdirSync(join(dir, "old", "worktrees", "session-abc"), { recursive: true });
  mkdirSync(join(dir, "old", "logs"), { recursive: true });
  writeFileSync(join(dir, "old", "agents", "ignacio.json"), '{"id":"ignacio"}');
  writeFileSync(join(dir, "old", "cli-tools.json"), '{"version":1}');
  writeFileSync(join(dir, "old", "worktrees", "session-abc", "f.txt"), "live");
  writeFileSync(join(dir, "old", "logs", "a.log"), "noise");
  return dir;
}

test("migrateState: copies state and leaves the source completely untouched", async () => {
  const dir = fixture();
  try {
    const result = await migrateState(join(dir, "old"), join(dir, "new"));

    assert.equal(readFileSync(join(dir, "new", "agents", "ignacio.json"), "utf8"), '{"id":"ignacio"}');
    assert.equal(readFileSync(join(dir, "new", "cli-tools.json"), "utf8"), '{"version":1}');
    // The source must still be intact — rollback is "point the root back".
    assert.equal(readFileSync(join(dir, "old", "agents", "ignacio.json"), "utf8"), '{"id":"ignacio"}');
    assert.ok(result.copied.includes("agents"));
    assert.ok(result.copied.includes("cli-tools.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migrateState: never copies worktrees or logs", async () => {
  const dir = fixture();
  try {
    const result = await migrateState(join(dir, "old"), join(dir, "new"));

    for (const skipped of SKIPPED_ENTRIES) {
      assert.throws(
        () => readFileSync(join(dir, "new", skipped, "x")),
        `${skipped} must not be copied — live worktrees are bound to their absolute paths`,
      );
      assert.ok(result.skipped.includes(skipped));
    }
    // …and the originals are still there for the running sessions.
    assert.equal(readFileSync(join(dir, "old", "worktrees", "session-abc", "f.txt"), "utf8"), "live");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migrateState: refuses to overwrite an entry that already exists in the target", async () => {
  const dir = fixture();
  try {
    mkdirSync(join(dir, "new"), { recursive: true });
    writeFileSync(join(dir, "new", "cli-tools.json"), '{"version":"PRECIOUS"}');

    await assert.rejects(
      () => migrateState(join(dir, "old"), join(dir, "new")),
      /cli-tools\.json/,
      "must name the colliding entry rather than silently overwriting it",
    );
    assert.equal(readFileSync(join(dir, "new", "cli-tools.json"), "utf8"), '{"version":"PRECIOUS"}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("needsMigration: null when the target already has state, else the source to copy from", async () => {
  const dir = fixture();
  try {
    assert.equal(await needsMigration(join(dir, "new"), [join(dir, "old")]), join(dir, "old"));

    mkdirSync(join(dir, "new", "agents"), { recursive: true });
    assert.equal(await needsMigration(join(dir, "new"), [join(dir, "old")]), null);

    assert.equal(await needsMigration(join(dir, "empty-target"), [join(dir, "no-such-old")]), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("needsMigration: an unreadable target must not be mistaken for an absent one", async () => {
  if (process.getuid?.() === 0) {
    // chmod 0o000 does not restrict root's own access, so this test would pass
    // vacuously as root — skip rather than pretend the discrimination was proven.
    return;
  }
  const dir = fixture();
  const locked = join(dir, "locked");
  mkdirSync(locked, { recursive: true });
  chmodSync(locked, 0o000);
  try {
    // An EACCES on readdir(to) must propagate as a rejection, not be swallowed
    // into "no entries" — that would report a genuinely unreadable target as
    // safe to migrate into.
    await assert.rejects(() => needsMigration(locked, [join(dir, "old")]));
  } finally {
    chmodSync(locked, 0o700); // restore so rmSync below can traverse and remove it
    rmSync(dir, { recursive: true, force: true });
  }
});
