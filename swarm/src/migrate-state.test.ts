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
import { loadWorkspaces, settingsPathFor, type Workspace, workspaceDir } from "./workspaces.js";

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

/**
 * NOTE: this test's expected outcome changed from the original brief. The
 * brief's version expected the "STALE" flat record removed unconditionally
 * once a same-named settings.json existed — reasonable when the only known
 * cause of divergence was a genuine post-migration edit via saveWorkspace().
 * The content-check added for the same-name-sibling-collision finding (two
 * flat records that happen to share a name, only one of which actually
 * migrated) can't tell that apart from "these are honestly two different
 * records" without comparing content — so it no longer deletes on a name
 * match alone. See task-3-report.md's "Fix round 3" section.
 */
test("migrateWorkspaceRecords: never overwrites an existing settings.json — and never deletes a flat record whose content actually differs from it", async () => {
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

    const result = await migrateWorkspaceRecords(paths);

    const kept = JSON.parse(readFileSync(settingsPathFor(dir), "utf8"));
    assert.equal(kept.description, "NEWER", "the existing settings.json is authoritative — never overwritten");
    assert.ok(
      statSync(join(paths.workspaces, "pg.json")).isFile(),
      "a flat record whose content differs from the destination is kept, not guessed-safe-to-delete",
    );
    assert.ok(result.skipped.includes("pg"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateWorkspaceRecords: a flat record byte-identical to an already-migrated settings.json is removed — nothing is lost", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-dup-"));
  try {
    const paths = smithPaths(root);
    const dir = join(paths.workspaces, "pg");
    mkdirSync(join(dir, "config"), { recursive: true });
    mkdirSync(paths.workspaces, { recursive: true });
    const record = { name: "pg", description: "SAME", repos: [{ name: "r", path: "/abs/r" }] };
    writeFileSync(settingsPathFor(dir), JSON.stringify(record));
    writeFileSync(join(paths.workspaces, "pg.json"), JSON.stringify(record));

    const result = await migrateWorkspaceRecords(paths);

    assert.throws(
      () => statSync(join(paths.workspaces, "pg.json")),
      "a duplicate that is genuinely byte-identical is safe to remove — nothing in it was unique",
    );
    assert.ok(result.skipped.includes("pg"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A single persisting record proves nothing about idempotency once it has
 * migrated: on run two the flat file is already gone, loadWorkspaceFilesFromDir
 * returns [], and the loop body never executes at all — `moved === []` is
 * trivially true either way. A record that keeps a flat sibling around (the
 * collision fixture: one side always loses and stays flat) forces the loop
 * body to run again on every pass, so this actually exercises repeated runs
 * instead of the empty-directory case.
 */
test("migrateWorkspaceRecords: is idempotent — repeated runs over persisting state are stable and lose nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-twice-"));
  try {
    const paths = smithPaths(root);
    mkdirSync(paths.workspaces, { recursive: true });
    writeFileSync(
      join(paths.workspaces, "foo bar.json"),
      JSON.stringify({ name: "foo bar", repos: [{ name: "r", path: "/abs/r" }] }),
    );
    writeFileSync(
      join(paths.workspaces, "foo_bar.json"),
      JSON.stringify({ name: "foo_bar", repos: [{ name: "r", path: "/abs/r" }] }),
    );

    const first = await migrateWorkspaceRecords(paths);
    const second = await migrateWorkspaceRecords(paths);
    const third = await migrateWorkspaceRecords(paths);

    assert.equal(first.moved.length, 1, "one of the two claims the directory on the first run");
    assert.equal(first.skipped.length, 1, "the other is skipped from the very first run");

    // The winner's flat file is gone after run one, so it is never a
    // candidate again — only the permanently-colliding loser keeps showing
    // up, and it can never resolve to "moved" on its own (a human has to
    // rename one side). Idempotent here means: stably re-skipped, not
    // re-moved, and never dropped.
    assert.deepEqual(second.moved, [], "nothing is left to move on a rerun");
    assert.deepEqual(
      second.skipped,
      first.skipped,
      "the unresolved collision is reported stably, not silently dropped",
    );
    assert.deepEqual(third.moved, [], "and stays that way on a third run");
    assert.deepEqual(third.skipped, first.skipped);

    const winner = first.moved[0] as string;
    const loser = winner === "foo bar" ? "foo_bar" : "foo bar";

    // Not just "still on disk" — still LOADABLE, after three passes: the
    // winner via its migrated directory, the loser via the dual-source flat
    // fallback.
    const all = await loadWorkspaces(paths);
    assert.ok(
      all.some((w) => w.name === winner),
      "the winner still loads",
    );
    assert.ok(
      all.some((w) => w.name === loser),
      "the loser still loads too — nothing was lost",
    );
    assert.ok(
      statSync(join(paths.workspaces, `${loser}.json`)).isFile(),
      "the loser's flat record survives three runs",
    );
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

test("migrateWorkspaceRecords: two different names that slug to the same directory never destroy the loser's flat record", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-collide-"));
  try {
    const paths = smithPaths(root);
    mkdirSync(paths.workspaces, { recursive: true });
    // slugForDir collapses any run of non-alphanumerics to one dash, so "foo bar"
    // and "foo_bar" both resolve to .../workspaces/foo-bar — assertContext does not
    // enforce saveWorkspace's name format, so legacy data can carry either.
    //
    // A literal case-only pair ("Foo"/"foo", the example this guard was written
    // for) can't be used as a fixture here: this machine's default filesystem
    // (APFS, case-insensitive) treats "Foo.json" and "foo.json" as the same
    // directory entry, so the second write silently clobbers the first before
    // migrateWorkspaceRecords ever runs — verified directly, see task-3-report.md.
    // This pair exercises the identical guard (settings.json parses but names a
    // different workspace) without depending on filesystem case-sensitivity.
    writeFileSync(
      join(paths.workspaces, "foo bar.json"),
      JSON.stringify({ name: "foo bar", repos: [{ name: "r", path: "/abs/r" }] }),
    );
    writeFileSync(
      join(paths.workspaces, "foo_bar.json"),
      JSON.stringify({ name: "foo_bar", repos: [{ name: "r", path: "/abs/r" }] }),
    );

    const result = await migrateWorkspaceRecords(paths);

    assert.equal(result.moved.length, 1, "only whichever name claims the directory first migrates");
    assert.equal(result.skipped.length, 1, "the other is skipped, not silently merged away");
    const winner = result.moved[0] as string;
    const loser = winner === "foo bar" ? "foo_bar" : "foo bar";
    assert.ok(result.skipped.includes(loser));

    // The property under test: the loser's flat record must survive.
    assert.ok(statSync(join(paths.workspaces, `${loser}.json`)).isFile(), "the loser's flat record survives");

    // And the directory holds only whichever workspace actually claimed it.
    const onDisk = JSON.parse(readFileSync(settingsPathFor(join(paths.workspaces, "foo-bar")), "utf8"));
    assert.equal(onDisk.name, winner);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateWorkspaceRecords: deletes the file a record was actually read from, never a name-derived guess", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-wrongfile-"));
  try {
    const paths = smithPaths(root);
    mkdirSync(paths.workspaces, { recursive: true });
    // Two distinct files that both hold a record named "pg" but with different
    // content — e.g. a copy that got hand-edited afterward. A name-derived
    // delete path (`${ws.name}.json`) can't tell these two files apart and,
    // for whichever one is processed first, deletes the OTHER one by guessing
    // its name from content rather than tracking the file it came from.
    writeFileSync(
      join(paths.workspaces, "aaa.json"),
      JSON.stringify({ name: "pg", description: "FROM aaa.json", repos: [{ name: "r", path: "/abs/r" }] }),
    );
    writeFileSync(
      join(paths.workspaces, "pg.json"),
      JSON.stringify({ name: "pg", description: "FROM pg.json", repos: [{ name: "r", path: "/abs/r" }] }),
    );

    const result = await migrateWorkspaceRecords(paths);

    assert.equal(result.moved.length, 1, "only one of the two same-named records claims the directory");
    assert.equal(result.skipped.length, 1, "the other is never silently merged away");

    const onDisk = JSON.parse(readFileSync(settingsPathFor(join(paths.workspaces, "pg")), "utf8"));
    const winnerFile = onDisk.description === "FROM aaa.json" ? "aaa.json" : "pg.json";
    const loserFile = winnerFile === "aaa.json" ? "pg.json" : "aaa.json";

    // The property under test: whichever file did NOT win must still exist,
    // holding its own original content — never deleted on the strength of a
    // guessed filename that happened to name a file it never came from.
    assert.ok(
      statSync(join(paths.workspaces, loserFile)).isFile(),
      `${loserFile} must survive — its content was never migrated`,
    );
    const loserOnDisk = JSON.parse(readFileSync(join(paths.workspaces, loserFile), "utf8"));
    assert.equal(
      loserOnDisk.description,
      loserFile === "aaa.json" ? "FROM aaa.json" : "FROM pg.json",
      "and its content is untouched",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateWorkspaceRecords: a settings.json that parses but fails validation is corrupt, not authoritative", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-semivalid-"));
  try {
    const paths = smithPaths(root);
    const dir = join(paths.workspaces, "pg");
    mkdirSync(join(dir, "config"), { recursive: true });
    mkdirSync(paths.workspaces, { recursive: true });
    // Parses as JSON and its name matches, but it's missing `repos` — not a
    // valid workspace record. This migration moves records into a
    // human-editable per-workspace file specifically so they can be
    // hand-edited; a bad edit landing in exactly this shape is the designed
    // use case, not an exotic one.
    writeFileSync(settingsPathFor(dir), JSON.stringify({ name: "pg" }));
    writeFileSync(
      join(paths.workspaces, "pg.json"),
      JSON.stringify({ name: "pg", repos: [{ name: "r", path: "/abs/r" }] }),
    );

    const result = await migrateWorkspaceRecords(paths);

    assert.ok(statSync(join(paths.workspaces, "pg.json")).isFile(), "the only valid copy must survive");
    assert.ok(result.skipped.includes("pg"), "reported as skipped, not silently moved");

    // The amplification this guards against: registering the invalid
    // settings.json would make loadWorkspaces() throw for the WHOLE install
    // on the very next read — after destroying the flat copy that could have
    // fixed it.
    await assert.doesNotReject(() => loadWorkspaces(paths));
    const all = await loadWorkspaces(paths);
    assert.ok(
      all.some((w) => w.name === "pg"),
      "the workspace still loads, via the surviving flat record",
    );
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
