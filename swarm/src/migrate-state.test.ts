import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "./config.js";
import {
  isInitialized,
  markInitialized,
  migrateBoards,
  migrateState,
  migrateWorkspaceRecords,
  needsMigration,
  SKIPPED_ENTRIES,
} from "./migrate-state.js";
import { smithPaths } from "./paths.js";
import { createBoard, saveBoard } from "./work-items.js";
import { loadRegistry } from "./workspace-registry.js";
import { settingsPathFor, type Workspace, workspaceDir } from "./workspaces.js";

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

test("isInitialized / markInitialized: false until marked, then true — and marking twice does not throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "smith-init-"));
  try {
    assert.equal(await isInitialized(dir), false, "a root with no marker has not booted yet");
    await markInitialized(dir);
    assert.equal(await isInitialized(dir), true);
    await markInitialized(dir); // idempotent — a second boot must not fail here
    assert.equal(await isInitialized(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test("migrateState: an empty directory already in the target is not a collision — the source's contents land in it", async () => {
  const dir = fixture();
  try {
    // Mirrors production: ensureDirectories() seeds an empty queue/ under the
    // fresh root before migrateState ever runs.
    mkdirSync(join(dir, "old", "queue"), { recursive: true });
    writeFileSync(join(dir, "old", "queue", "task-1.json"), '{"id":"task-1"}');
    mkdirSync(join(dir, "new", "queue"), { recursive: true }); // pre-seeded, empty

    const result = await migrateState(join(dir, "old"), join(dir, "new"));

    assert.equal(readFileSync(join(dir, "new", "queue", "task-1.json"), "utf8"), '{"id":"task-1"}');
    assert.ok(result.copied.includes("queue"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migrateState: a non-empty directory in the target is still a collision", async () => {
  const dir = fixture();
  try {
    mkdirSync(join(dir, "old", "queue"), { recursive: true });
    writeFileSync(join(dir, "old", "queue", "task-1.json"), '{"id":"task-1"}');
    mkdirSync(join(dir, "new", "queue"), { recursive: true });
    writeFileSync(join(dir, "new", "queue", "pending.json"), '{"id":"PRECIOUS"}'); // real pending state

    await assert.rejects(
      () => migrateState(join(dir, "old"), join(dir, "new")),
      /queue/,
      "a non-empty target directory must still refuse — it could hold real pending state",
    );
    assert.equal(readFileSync(join(dir, "new", "queue", "pending.json"), "utf8"), '{"id":"PRECIOUS"}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("needsMigration: null when the target already holds everything the legacy root does, else the legacy root to copy from", async () => {
  const dir = fixture();
  try {
    assert.equal(await needsMigration(join(dir, "new"), [join(dir, "old")]), join(dir, "old"));

    // The target must hold every substantive entry the legacy root has — not
    // merely be non-empty — before the gate goes quiet.
    mkdirSync(join(dir, "new", "agents"), { recursive: true });
    writeFileSync(join(dir, "new", "cli-tools.json"), '{"version":1}');
    assert.equal(await needsMigration(join(dir, "new"), [join(dir, "old")]), null);

    assert.equal(await needsMigration(join(dir, "empty-target"), [join(dir, "no-such-old")]), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("needsMigration: a target holding only boot-seeded scaffolding must not hide real legacy state", async () => {
  const dir = fixture();
  try {
    // Mirrors what actually bit production: by the time the startup guard
    // runs, loadConfig()'s ensureDirectories() and boot have already seeded
    // the new root with structural dirs and a settings file. The target is
    // non-empty, but none of it is the user's actual state — "agents" here
    // stands in for the real users/workspaces/work/sessions left behind in
    // the legacy root.
    mkdirSync(join(dir, "new", "queue"), { recursive: true });
    mkdirSync(join(dir, "new", "worktrees"), { recursive: true });
    mkdirSync(join(dir, "new", "logs"), { recursive: true });
    writeFileSync(join(dir, "new", "cli-tools.json"), '{"version":1}');

    assert.equal(
      await needsMigration(join(dir, "new"), [join(dir, "old")]),
      join(dir, "old"),
      "a non-empty but scaffolding-only target must not read as already-migrated",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("needsMigration is the startup gate: it reports the source instead of letting a server come up empty", async () => {
  const dir = fixture();
  try {
    // A fresh root with the user's real state still in the legacy location.
    const source = await needsMigration(join(dir, "new"), [join(dir, "old")]);
    assert.equal(source, join(dir, "old"), "must surface the legacy root rather than returning null");

    // After migrating, the gate goes quiet — startup proceeds on later boots.
    await migrateState(join(dir, "old"), join(dir, "new"));
    assert.equal(await needsMigration(join(dir, "new"), [join(dir, "old")]), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The positive control this migration guard never had: every other test
 * above drives needsMigration() directly against hand-rolled fixtures, so
 * none of them would notice a gap between "what a test imagines boot
 * creates" and what boot actually creates. This one runs the real sequence —
 * loadConfig() (which runs ensureDirectories() and seeds queue/, worktrees/,
 * and logs/ under the root) followed immediately by needsMigration() against
 * that same, now-scaffolded root — with a legacy fixture holding real state
 * sitting alongside it. The guard must still see through the boot-seeded
 * scaffolding to the real state it's missing.
 */
test("needsMigration after the real loadConfig(): boot-seeded scaffolding must not hide real legacy state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "smith-boot-"));
  try {
    const legacyDir = join(dir, "legacy");
    mkdirSync(join(legacyDir, "agents"), { recursive: true });
    writeFileSync(join(legacyDir, "agents", "ignacio.json"), '{"id":"ignacio"}');
    writeFileSync(join(legacyDir, "cli-tools.json"), '{"version":1}');

    // The real boot path, not a simulation of it: loadConfig() scaffolds
    // queue/, worktrees/, and logs/ under smithRoot as a side effect, before
    // this test — or server.ts's start() — ever calls needsMigration.
    const cfg = loadConfig({ smithRoot: join(dir, "new") });

    const legacy = await needsMigration(cfg.smithRoot, [legacyDir]);
    assert.equal(
      legacy,
      legacyDir,
      "a root freshly scaffolded by the real loadConfig() must still be recognized as needing migration when real legacy state exists",
    );
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

test("migrateBoards: moves a workspace's board into its config, leaves personal alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-boards-"));
  try {
    const paths = smithPaths(root);
    const ws = { name: "pg", repos: [] } as Workspace;
    mkdirSync(paths.work, { recursive: true });
    await saveBoard(paths.work, createBoard("deliver", "pg"));
    await saveBoard(paths.work, createBoard("personal"));

    const result = await migrateBoards(paths, [ws]);

    const target = join(workspaceDir(paths, ws), "config", "boards", "pg-deliver.json");
    assert.ok(statSync(target).isFile(), "the workspace board moved into its config");
    assert.throws(() => statSync(join(paths.work, "pg-deliver.json")), "and is gone from the host dir");
    assert.ok(statSync(join(paths.work, "personal.json")).isFile(), "personal stayed at host level");
    assert.deepEqual(
      result.moved.map((m) => m.id),
      ["pg-deliver"],
    );
    assert.deepEqual(result.kept, ["personal"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateBoards: a board whose workspace no longer exists is kept, never dropped", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-orphan-"));
  try {
    const paths = smithPaths(root);
    mkdirSync(paths.work, { recursive: true });
    await saveBoard(paths.work, createBoard("deliver", "deleted-ws"));

    const result = await migrateBoards(paths, []);

    assert.ok(statSync(join(paths.work, "deleted-ws-deliver.json")).isFile(), "the orphan stays put");
    assert.deepEqual(result.moved, []);
    assert.deepEqual(result.kept, ["deleted-ws-deliver"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateBoards: is idempotent — a second run moves nothing and loses nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-twice-"));
  try {
    const paths = smithPaths(root);
    const ws = { name: "pg", repos: [] } as Workspace;
    mkdirSync(paths.work, { recursive: true });
    await saveBoard(paths.work, createBoard("deliver", "pg"));

    await migrateBoards(paths, [ws]);
    const second = await migrateBoards(paths, [ws]);

    assert.deepEqual(second.moved, [], "nothing left to move");
    const target = join(workspaceDir(paths, ws), "config", "boards", "pg-deliver.json");
    assert.ok(statSync(target).isFile(), "and the moved board is still there");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateBoards: a workspace copy already on disk is authoritative — never overwritten by a stale host copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-newer-"));
  try {
    const paths = smithPaths(root);
    const ws = { name: "pg", repos: [] } as Workspace;
    mkdirSync(paths.work, { recursive: true });

    // The stale original: still sitting in the host dir, never edited since Task 2 landed.
    const staleHost = createBoard("deliver", "pg");
    staleHost.name = "STALE";
    await saveBoard(paths.work, staleHost);

    // The live copy: written into the workspace dir by a post-Task-2 edit, and
    // therefore the one actually being served by loadAllBoards' workspace-first order.
    const targetDir = join(workspaceDir(paths, ws), "config", "boards");
    mkdirSync(targetDir, { recursive: true });
    const newerWorkspace = createBoard("deliver", "pg");
    newerWorkspace.name = "NEWER";
    await saveBoard(targetDir, newerWorkspace);

    const result = await migrateBoards(paths, [ws]);

    const onDisk = JSON.parse(readFileSync(join(targetDir, "pg-deliver.json"), "utf8"));
    assert.equal(onDisk.name, "NEWER", "the workspace copy must survive untouched — it is the authoritative one");
    assert.throws(() => statSync(join(paths.work, "pg-deliver.json")), "the stale host copy is removed");
    assert.deepEqual(
      result.moved.map((m) => m.id),
      ["pg-deliver"],
      "still reported as moved, even though nothing was copied",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateWorkspaceRecords: writes settings.json, registers the dir, removes the flat record", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-rec-"));
  try {
    const paths = smithPaths(root);
    mkdirSync(paths.workspaces, { recursive: true });
    writeFileSync(
      join(paths.workspaces, "pg.json"),
      JSON.stringify({ name: "pg", description: "REAL", repos: [{ name: "r", path: "/abs/r" }] }),
    );

    const result = await migrateWorkspaceRecords(paths);

    const dir = join(paths.workspaces, "pg");
    assert.ok(statSync(settingsPathFor(dir)).isFile(), "settings.json written");
    assert.deepEqual(await loadRegistry(paths), { pg: dir }, "registered");
    assert.throws(() => statSync(join(paths.workspaces, "pg.json")), "flat record removed");
    assert.deepEqual(result.moved, ["pg"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateWorkspaceRecords: never overwrites an existing settings.json", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-keep-"));
  try {
    const paths = smithPaths(root);
    const dir = join(paths.workspaces, "pg");
    mkdirSync(join(dir, "config"), { recursive: true });
    mkdirSync(paths.workspaces, { recursive: true });
    writeFileSync(
      settingsPathFor(dir),
      JSON.stringify({ name: "pg", description: "NEWER", repos: [{ name: "r", path: "/abs/r" }] }),
    );
    writeFileSync(
      join(paths.workspaces, "pg.json"),
      JSON.stringify({ name: "pg", description: "STALE", repos: [{ name: "r", path: "/abs/r" }] }),
    );

    await migrateWorkspaceRecords(paths);

    const kept = JSON.parse(readFileSync(settingsPathFor(dir), "utf8"));
    assert.equal(kept.description, "NEWER", "the existing settings.json is authoritative");
    assert.throws(() => statSync(join(paths.workspaces, "pg.json")), "stale flat record still removed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateWorkspaceRecords: is idempotent", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-twice-"));
  try {
    const paths = smithPaths(root);
    mkdirSync(paths.workspaces, { recursive: true });
    writeFileSync(
      join(paths.workspaces, "pg.json"),
      JSON.stringify({ name: "pg", repos: [{ name: "r", path: "/abs/r" }] }),
    );

    await migrateWorkspaceRecords(paths);
    const second = await migrateWorkspaceRecords(paths);

    assert.deepEqual(second.moved, [], "nothing left to move");
    assert.ok(statSync(settingsPathFor(join(paths.workspaces, "pg"))).isFile(), "and the record survives");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateWorkspaceRecords: a settings.json that exists but does not parse is never used to justify deleting the flat record", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-corrupt-"));
  try {
    const paths = smithPaths(root);
    const dir = join(paths.workspaces, "pg");
    mkdirSync(join(dir, "config"), { recursive: true });
    mkdirSync(paths.workspaces, { recursive: true });
    // A truncated write from a crash mid-migration: the file exists, but does not parse.
    writeFileSync(settingsPathFor(dir), '{"name": "pg", "repos": [{"nam');
    writeFileSync(
      join(paths.workspaces, "pg.json"),
      JSON.stringify({ name: "pg", repos: [{ name: "r", path: "/abs/r" }] }),
    );

    const result = await migrateWorkspaceRecords(paths);

    assert.ok(statSync(join(paths.workspaces, "pg.json")).isFile(), "the only good copy must survive");
    assert.ok(result.skipped.includes("pg"), "reported as skipped, not silently moved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateWorkspaceRecords: one record whose name has no directory-safe characters is skipped, not fatal", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-badname-"));
  try {
    const paths = smithPaths(root);
    mkdirSync(paths.workspaces, { recursive: true });
    // "..." slugs to the empty string — ensureWorkspaceDir refuses it.
    writeFileSync(
      join(paths.workspaces, "....json"),
      JSON.stringify({ name: "...", repos: [{ name: "r", path: "/abs/r" }] }),
    );
    writeFileSync(
      join(paths.workspaces, "goodws.json"),
      JSON.stringify({ name: "goodws", repos: [{ name: "r", path: "/abs/r" }] }),
    );

    const result = await migrateWorkspaceRecords(paths);

    assert.deepEqual(result.moved, ["goodws"], "the good record still migrates");
    assert.ok(result.skipped.includes("..."), "the unslugable record is skipped, not thrown");
    assert.ok(statSync(join(paths.workspaces, "....json")).isFile(), "its flat record is left untouched");
    assert.throws(() => statSync(join(paths.workspaces, "goodws.json")), "the good record's flat file is gone");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateWorkspaceRecords: a flat group record is never touched — no directory, no registry entry", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-group-"));
  try {
    const paths = smithPaths(root);
    mkdirSync(paths.workspaces, { recursive: true });
    const groupRaw = JSON.stringify({ name: "squad", members: ["a", "b"], repos: [] });
    writeFileSync(join(paths.workspaces, "squad.json"), groupRaw);
    writeFileSync(
      join(paths.workspaces, "pg.json"),
      JSON.stringify({ name: "pg", repos: [{ name: "r", path: "/abs/r" }] }),
    );

    const result = await migrateWorkspaceRecords(paths);

    assert.equal(
      readFileSync(join(paths.workspaces, "squad.json"), "utf8"),
      groupRaw,
      "the group's flat record is byte-for-byte untouched",
    );
    assert.ok(!result.moved.includes("squad"), "the group is never reported as moved");
    assert.throws(
      () => statSync(join(paths.workspaces, "squad", "config", "settings.json")),
      "no directory was created for the group",
    );
    assert.deepEqual(
      await loadRegistry(paths),
      { pg: join(paths.workspaces, "pg") },
      "only the workspace got a registry entry",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
