import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { migrateWorkspaceRecords } from "./migrate-state.js";
import { smithPaths } from "./paths.js";
import { loadRegistry, saveRegistryEntry } from "./workspace-registry.js";
import type { Workspace } from "./workspaces.js";
import {
  assertContext,
  assertNoWorkspaceDirCollision,
  boardsDirFor,
  collidingWorkspaceDirs,
  defaultViolation,
  ensureWorkspaceDir,
  initGitRepo,
  isGitRepo,
  loadAllContexts,
  loadWorkspaces,
  normalizeRepoBranch,
  removeWorkspaceFile,
  repoLessRefusal,
  resolveRepo,
  saveWorkspace,
  settingsPathFor,
  slugForDir,
  validSources,
  WorkspaceDirCollisionError,
  workspaceDir,
} from "./workspaces.js";

const execFileAsync = promisify(execFile);

test("resolveRepo never resolves into an archived workspace", () => {
  const ws: Workspace[] = [
    { name: "old", archived: true, default: true, repos: [{ name: "r", path: "/tmp/a" }] },
    { name: "live", repos: [{ name: "r", path: "/tmp/b" }] },
  ];
  assert.equal(resolveRepo(ws, undefined, undefined)?.workspace.name, "live");
  assert.equal(resolveRepo(ws, "old", undefined), null);
});

test("saveWorkspace rejects a bad slug and round-trips a good one", async () => {
  const root = await mkdtemp(join(tmpdir(), "ws-"));
  const paths = smithPaths(root);
  await assert.rejects(() => saveWorkspace(paths, { name: "Bad Name", repos: [{ name: "r", path: "/tmp" }] }));
  await saveWorkspace(paths, { name: "good", repos: [{ name: "r", path: "/tmp" }] });
  assert.equal((await loadWorkspaces(paths))[0]?.name, "good");
});

test("isGitRepo: true for a real repo, false for a plain dir", async () => {
  const repo = await mkdtemp(join(tmpdir(), "git-"));
  await promisify(execFile)("git", ["init", "-q"], { cwd: repo });
  assert.equal(await isGitRepo(repo), true);
  const plain = await mkdtemp(join(tmpdir(), "plain-"));
  assert.equal(await isGitRepo(plain), false);
});

test("defaultViolation blocks removing the default while other active workspaces exist", () => {
  const all: Workspace[] = [
    { name: "a", default: true, repos: [{ name: "r", path: "/tmp" }] },
    { name: "b", repos: [{ name: "r", path: "/tmp" }] },
  ];
  assert.match(defaultViolation(all, "a") ?? "", /default/);
  assert.equal(defaultViolation(all, "b"), null);
  assert.equal(defaultViolation([all[0]!], "a"), null); // last one may go
});

test("normalizeRepoBranch: defaults a blank or omitted branch to main, leaves a real one alone", () => {
  const repos = normalizeRepoBranch([
    { name: "r1", path: "/tmp/a", branch: "" },
    { name: "r2", path: "/tmp/b", branch: "   " },
    { name: "r3", path: "/tmp/c" },
    { name: "r4", path: "/tmp/d", branch: "develop" },
  ]);
  assert.deepEqual(
    repos.map((r) => r.branch),
    ["main", "main", "main", "develop"],
  );
});

test("normalizeRepoBranch: drops the transient initGit flag so PUT can't persist it", () => {
  assert.equal("initGit" in normalizeRepoBranch([{ name: "web", path: "/x", initGit: true } as never])[0]!, false);
});

// A missing workspace is a no-op, not an error — mirrors removeRegistryEntry's
// contract (Task 1) and rm's { force: true }. The DELETE /workspaces route is
// what checks existence and 404s; this function's job is just to be idempotent.
test("removeWorkspaceFile: a missing name is a no-op, an existing one is removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "rm-"));
  const paths = smithPaths(root);
  await removeWorkspaceFile(paths, "nope"); // does not throw
  await saveWorkspace(paths, { name: "exist", repos: [{ name: "r", path: "/tmp" }] });
  await removeWorkspaceFile(paths, "exist");
  assert.equal((await loadWorkspaces(paths)).length, 0);
});

test("atlassian and github config round-trip through save/load", async () => {
  const root = await mkdtemp(join(tmpdir(), "ws-"));
  const paths = smithPaths(root);
  const ws: Workspace = {
    name: "acme",
    repos: [{ name: "web", path: "/tmp", branch: "main", github: { owner: "acme", repo: "web" } }],
    atlassian: { siteUrl: "https://acme.atlassian.net", jiraProjectKeys: ["ACME"], confluenceSpaceKeys: ["DOCS"] },
  };
  await saveWorkspace(paths, ws);
  const [loaded] = await loadWorkspaces(paths);
  assert.deepEqual(loaded?.atlassian, ws.atlassian);
  assert.deepEqual(loaded?.repos[0]?.github, { owner: "acme", repo: "web" });
});

test("a workspace atlassian block with connectorId round-trips through save/load unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspaces-connectorid-"));
  const paths = smithPaths(root);
  const repoDir = join(root, "repo");
  await mkdir(repoDir, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: repoDir });
  const ws: Workspace = {
    name: "acme",
    repos: [{ name: "web", path: repoDir }],
    atlassian: { siteUrl: "https://acme.atlassian.net", connectorId: "conn-1" },
  };
  await saveWorkspace(paths, ws);
  const [reloaded] = await loadWorkspaces(paths);
  assert.equal(reloaded!.atlassian?.connectorId, "conn-1");
});

test("a repo github block with connectorId round-trips through save/load unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspaces-repo-connectorid-"));
  const paths = smithPaths(root);
  const repoDir = join(root, "repo");
  await mkdir(repoDir, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: repoDir });
  const ws: Workspace = {
    name: "acme",
    repos: [{ name: "web", path: repoDir, github: { owner: "acme", repo: "web", connectorId: "conn-2" } }],
  };
  await saveWorkspace(paths, ws);
  const [reloaded] = await loadWorkspaces(paths);
  assert.equal(reloaded!.repos[0]!.github?.connectorId, "conn-2");
});

test("workspaceProblems does not require or validate connectorId — an unset one is fine", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspaces-noconnid-"));
  const paths = smithPaths(root);
  const repoDir = join(root, "repo");
  await mkdir(repoDir, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: repoDir });
  const ws: Workspace = {
    name: "acme",
    repos: [{ name: "web", path: repoDir, github: { owner: "acme", repo: "web" } }],
  };
  await saveWorkspace(paths, ws);
  const [reloaded] = await loadWorkspaces(paths);
  assert.equal(reloaded?.atlassian?.connectorId, undefined);
  assert.equal(reloaded?.repos[0]?.github?.connectorId, undefined);
});

test("saveWorkspace/loadWorkspaces round-trips the optional links field", async () => {
  const root = await mkdtemp(join(tmpdir(), "ws-links-"));
  const paths = smithPaths(root);
  await saveWorkspace(paths, {
    name: "acme",
    repos: [{ name: "web", path: root }],
    links: ["https://acme.example/runbook"],
  });
  const [ws] = await loadWorkspaces(paths);
  assert.deepEqual(ws!.links, ["https://acme.example/runbook"]);
  await saveWorkspace(paths, { name: "plain", repos: [{ name: "web", path: root }] });
  const plain = (await loadWorkspaces(paths)).find((w) => w.name === "plain");
  assert.equal(plain!.links, undefined);
});

test("initGitRepo: turns a plain directory into a git repository", async () => {
  const dir = await mkdtemp(join(tmpdir(), "initgit-"));
  assert.equal(await isGitRepo(dir), false);
  await initGitRepo(dir);
  assert.equal(await isGitRepo(dir), true);
});

test("a workspace record with sources round-trips through save and load untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "ws-"));
  const paths = smithPaths(root);
  const ws: Workspace = {
    name: "acme",
    repos: [{ name: "app", path: "/tmp/app" }],
    sources: [
      {
        id: "jira-plan",
        name: "PROJ tickets",
        preset: "jira",
        origin: { connectorId: "atl-1", url: "https://acme.atlassian.net", query: "project = PROJ" },
        cadence: "nightly",
        transform: { mode: "map" },
        enabled: true,
      },
    ],
  };
  await saveWorkspace(paths, ws);
  const [loaded] = await loadWorkspaces(paths);
  assert.deepEqual(loaded.sources, ws.sources);
});

test("validSources accepts absent, rejects rows missing id/name/preset/cadence/transform/enabled", () => {
  assert.equal(validSources(undefined), true);
  assert.equal(validSources([]), true);
  assert.equal(
    validSources([
      {
        id: "s1",
        name: "n",
        preset: "custom",
        origin: {},
        cadence: "6h",
        transform: { mode: "analyze" },
        enabled: true,
      },
    ]),
    true,
  );
  assert.equal(validSources([{ id: "s1" }]), false);
  assert.equal(
    validSources([
      { id: "s1", name: "n", preset: "nope", origin: {}, cadence: "6h", transform: { mode: "map" }, enabled: true },
    ]),
    false,
  );
  assert.equal(
    validSources([
      { id: "s1", name: "n", preset: "jira", origin: {}, cadence: "weekly", transform: { mode: "map" }, enabled: true },
    ]),
    false,
  );
  assert.equal(validSources("x"), false);
});

test("workspaceDir: defaults under the state root's workspaces directory", () => {
  const paths = smithPaths("/state");
  assert.equal(
    workspaceDir(paths, { name: "proving-ground", repos: [] } as Workspace),
    join("/state", "workspaces", "proving-ground"),
  );
});

test("workspaceDir: an explicit dir wins, so a workspace can live anywhere", () => {
  const paths = smithPaths("/state");
  assert.equal(
    workspaceDir(paths, { name: "proving-ground", dir: "/Users/me/Development/pg", repos: [] } as Workspace),
    "/Users/me/Development/pg",
  );
});

test("workspaceDir: a relative explicit dir is resolved, never left relative", () => {
  const paths = smithPaths("/state");
  const got = workspaceDir(paths, { name: "pg", dir: "some/where", repos: [] } as Workspace);
  assert.ok(isAbsolute(got), `expected an absolute path, got ${got}`);
});

test("slugForDir: a workspace name becomes a safe directory name", () => {
  assert.equal(slugForDir("proving-ground"), "proving-ground");
  assert.equal(slugForDir("My Client / Q3"), "my-client-q3");
  assert.equal(slugForDir("  spaced  "), "spaced");
});

test("slugForDir: refuses a name that would escape its parent", () => {
  // A workspace named "../../etc" must never resolve outside the state root.
  const paths = smithPaths("/state");
  const got = workspaceDir(paths, { name: "../../etc", repos: [] } as Workspace);
  assert.ok(
    got.startsWith(`${join("/state", "workspaces")}/`),
    `a traversal-shaped name must stay inside the workspaces dir; got ${got}`,
  );
});

test("ensureWorkspaceDir: creates config/ and .runtime/, and is idempotent", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-dir-"));
  try {
    const paths = smithPaths(root);
    const ws = { name: "proving-ground", repos: [] } as Workspace;

    const dir = await ensureWorkspaceDir(paths, ws);
    assert.equal(dir, join(root, "workspaces", "proving-ground"));
    assert.ok(statSync(join(dir, "config")).isDirectory(), "config/ exists");
    assert.ok(statSync(join(dir, ".runtime")).isDirectory(), ".runtime/ exists");

    // Running twice must not throw and must not disturb existing contents.
    writeFileSync(join(dir, "config", "keep.txt"), "kept");
    await ensureWorkspaceDir(paths, ws);
    assert.equal(readFileSync(join(dir, "config", "keep.txt"), "utf8"), "kept");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureWorkspaceDir: honours an explicit dir outside the state root", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-root-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "ws-elsewhere-"));
  try {
    const paths = smithPaths(root);
    const target = join(elsewhere, "my-project");
    const dir = await ensureWorkspaceDir(paths, { name: "pg", dir: target, repos: [] } as Workspace);

    assert.equal(dir, target);
    assert.ok(statSync(join(target, "config")).isDirectory(), "config/ created at the explicit dir");
    assert.throws(() => statSync(join(root, "workspaces", "pg")), "nothing created under the state root");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("ensureWorkspaceDir: refuses a name that slugs to empty rather than writing into the shared workspaces root", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-empty-slug-"));
  try {
    const paths = smithPaths(root);
    const ws = { name: "...", repos: [] } as Workspace;

    await assert.rejects(() => ensureWorkspaceDir(paths, ws), /"\.\.\."/);
    // Nothing may be written into the shared parent — not even the parent
    // itself should have been created by this call.
    assert.throws(() => statSync(paths.workspaces), "nothing created under the workspaces root");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("boardsDirFor: a workspace's boards live under its own config/", () => {
  const paths = smithPaths("/state");
  const ws = { name: "proving-ground", repos: [] } as Workspace;
  assert.equal(
    boardsDirFor(paths, [ws], "proving-ground"),
    join("/state", "workspaces", "proving-ground", "config", "boards"),
  );
});

test("boardsDirFor: a board with no workspace stays in the host work dir", () => {
  const paths = smithPaths("/state");
  // The `personal` board is workspace-less by design (capabilities.ts:359).
  assert.equal(boardsDirFor(paths, [], undefined), paths.work);
});

test("boardsDirFor: an unknown workspace id falls back to the host work dir", () => {
  const paths = smithPaths("/state");
  // An orphaned board — its workspace record was deleted — must remain
  // loadable rather than resolving to a directory that does not exist.
  assert.equal(boardsDirFor(paths, [], "deleted-workspace"), paths.work);
});

test("boardsDirFor: honours an explicit workspace dir", () => {
  const paths = smithPaths("/state");
  const ws = { name: "pg", dir: "/elsewhere/pg", repos: [] } as Workspace;
  assert.equal(boardsDirFor(paths, [ws], "pg"), join("/elsewhere/pg", "config", "boards"));
});

test("collidingWorkspaceDirs: reports two workspaces that would share one directory", () => {
  const paths = smithPaths("/state");
  // slugForDir is lossier than the name validator: "ab" and "ab-" are both
  // valid workspace names and both slug to "ab".
  const collisions = collidingWorkspaceDirs(paths, [
    { name: "ab", repos: [] } as Workspace,
    { name: "ab-", repos: [] } as Workspace,
    { name: "unique", repos: [] } as Workspace,
  ]);
  assert.equal(collisions.length, 1);
  assert.deepEqual(collisions[0].names.sort(), ["ab", "ab-"]);
  assert.equal(collisions[0].dir, join("/state", "workspaces", "ab"));
});

test("collidingWorkspaceDirs: silent when every workspace resolves uniquely", () => {
  const paths = smithPaths("/state");
  assert.deepEqual(
    collidingWorkspaceDirs(paths, [
      { name: "alpha", repos: [] } as Workspace,
      { name: "beta", repos: [] } as Workspace,
    ]),
    [],
  );
});

test("loadWorkspaces: reads a record from the workspace's own settings.json", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-settings-"));
  try {
    const paths = smithPaths(root);
    const dir = join(root, "elsewhere", "pg");
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(settingsPathFor(dir), JSON.stringify({ name: "pg", repos: [{ name: "r", path: "/abs/r" }] }));
    await saveRegistryEntry(paths, "pg", dir);

    const all = await loadWorkspaces(paths);
    assert.deepEqual(
      all.map((w) => w.name),
      ["pg"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadWorkspaces: still reads a flat record that has not been migrated", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-flat-"));
  try {
    const paths = smithPaths(root);
    mkdirSync(paths.workspaces, { recursive: true });
    writeFileSync(
      join(paths.workspaces, "legacy.json"),
      JSON.stringify({ name: "legacy", repos: [{ name: "r", path: "/abs/r" }] }),
    );

    const all = await loadWorkspaces(paths);
    assert.deepEqual(
      all.map((w) => w.name),
      ["legacy"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadWorkspaces: when a record exists in both places, settings.json wins", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-both-"));
  try {
    const paths = smithPaths(root);
    const dir = join(root, "workspaces", "dup");
    mkdirSync(join(dir, "config"), { recursive: true });
    mkdirSync(paths.workspaces, { recursive: true });
    writeFileSync(
      settingsPathFor(dir),
      JSON.stringify({ name: "dup", description: "NEW", repos: [{ name: "r", path: "/abs/r" }] }),
    );
    writeFileSync(
      join(paths.workspaces, "dup.json"),
      JSON.stringify({ name: "dup", description: "STALE", repos: [{ name: "r", path: "/abs/r" }] }),
    );
    await saveRegistryEntry(paths, "dup", dir);

    const all = await loadWorkspaces(paths);
    assert.equal(all.length, 1, "one workspace, not two");
    assert.equal(all[0].description, "NEW", "the settings.json copy is authoritative");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadWorkspaces: a registered settings.json that validates as a GROUP record is never returned as a phantom workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-reg-group-"));
  try {
    const paths = smithPaths(root);
    // A hand-editable settings.json can validate as a group (members, no
    // repos) just as easily as a workspace — its registry entry surviving
    // that edit is exactly the mechanism the flat loop below already guards
    // against via loadWorkspacesFromDir's own filter.
    const dir = join(paths.workspaces, "squad");
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(settingsPathFor(dir), JSON.stringify({ name: "squad", members: ["a", "b"], repos: [] }));
    await saveRegistryEntry(paths, "squad", dir);

    const all = await loadWorkspaces(paths);
    assert.deepEqual(all, [], "a group reached through the registry must never surface as a workspace");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadWorkspaces: two registry keys pointing at the same directory return the workspace once, not twice", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-reg-dedup-"));
  try {
    const paths = smithPaths(root);
    const dir = join(paths.workspaces, "ab");
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(settingsPathFor(dir), JSON.stringify({ name: "ab", repos: [{ name: "r", path: "/abs/r" }] }));
    // A registry can end up with two keys resolving to one directory —
    // saveWorkspace's new guard prevents new writes from creating this
    // going forward, but a reader must not double-count a registry that is
    // already in this shape (e.g. hand-edited).
    await saveRegistryEntry(paths, "ab", dir);
    await saveRegistryEntry(paths, "ab-stale-alias", dir);

    const all = await loadWorkspaces(paths);
    assert.equal(all.length, 1, "the same settings.json must not be read and pushed twice");
    assert.equal(all[0]?.name, "ab");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saveWorkspace: writes settings.json and registers the directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-save-"));
  try {
    const paths = smithPaths(root);
    const ws = { name: "fresh", repos: [{ name: "r", path: "/abs/r" }] } as Workspace;

    await saveWorkspace(paths, ws);

    const dir = workspaceDir(paths, ws);
    assert.ok(statSync(settingsPathFor(dir)).isFile(), "settings.json written");
    assert.deepEqual(await loadRegistry(paths), { fresh: dir }, "and registered");
    assert.deepEqual(
      (await loadWorkspaces(paths)).map((w) => w.name),
      ["fresh"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saveWorkspace: refuses to overwrite a DIFFERENT workspace's settings.json — 'ab' and 'ab-' both slug to 'ab'", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-collide-"));
  try {
    const paths = smithPaths(root);
    // "ab-" already owns the directory (an ordinary earlier save).
    await saveWorkspace(paths, { name: "ab-", repos: [{ name: "r", path: "/abs/r" }] });

    // An edit to "ab" — a DIFFERENT workspace that happens to slug to the
    // same directory — must be refused, not silently adopt "ab-"'s record.
    await assert.rejects(
      () => saveWorkspace(paths, { name: "ab", repos: [{ name: "r", path: "/abs/r" }] }),
      (err: unknown) => {
        assert.ok(err instanceof WorkspaceDirCollisionError);
        assert.equal(err.requestedName, "ab");
        assert.equal(err.existingName, "ab-");
        assert.match(err.message, /"ab"/);
        assert.match(err.message, /"ab-"/);
        return true;
      },
    );

    const dir = workspaceDir(paths, { name: "ab", repos: [] } as Workspace);
    const onDisk = JSON.parse(readFileSync(settingsPathFor(dir), "utf8"));
    assert.equal(onDisk.name, "ab-", "the existing workspace's record must survive completely untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saveWorkspace: a missing or corrupt destination is not a collision — an edit may still write (and self-heal) its own record", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-selfheal-"));
  try {
    const paths = smithPaths(root);
    const dir = workspaceDir(paths, { name: "pg", repos: [] } as Workspace);
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(settingsPathFor(dir), "{not json"); // corrupt — but nobody's identity to protect

    await saveWorkspace(paths, { name: "pg", description: "healed", repos: [{ name: "r", path: "/abs/r" }] });

    const onDisk = JSON.parse(readFileSync(settingsPathFor(dir), "utf8"));
    assert.equal(
      onDisk.description,
      "healed",
      "an edit to the SAME workspace can repair its own corrupt settings.json",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saveWorkspace: the full ab/ab- sequence — migration then an ordinary edit never destroys the loser's record", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-ab-seq-"));
  try {
    const paths = smithPaths(root);
    mkdirSync(paths.workspaces, { recursive: true });
    writeFileSync(
      join(paths.workspaces, "ab.json"),
      JSON.stringify({ name: "ab", repos: [{ name: "r", path: "/abs/r" }] }),
    );
    writeFileSync(
      join(paths.workspaces, "ab-.json"),
      JSON.stringify({ name: "ab-", repos: [{ name: "r", path: "/abs/r" }] }),
    );

    const migrated = await migrateWorkspaceRecords(paths);
    assert.equal(migrated.moved.length, 1, "only one of the two claims the directory during migration");
    assert.equal(migrated.skipped.length, 1, "the other survives flat — migrateWorkspaceRecords' own collision guard");

    const winner = migrated.moved[0] as string;
    const loser = winner === "ab" ? "ab-" : "ab";

    // The PUT-equivalent write: an ordinary edit to the loser, still
    // findable and editable via loadWorkspaces' flat-record fallback.
    await assert.rejects(
      () => saveWorkspace(paths, { name: loser, description: "edited", repos: [{ name: "r", path: "/abs/r" }] }),
      WorkspaceDirCollisionError,
    );

    const dir = workspaceDir(paths, { name: "ab", repos: [] } as Workspace);
    const onDisk = JSON.parse(readFileSync(settingsPathFor(dir), "utf8"));
    assert.equal(onDisk.name, winner, "the winner's record must survive completely untouched by the loser's edit");
    assert.equal(onDisk.description, undefined, "not overwritten by the loser's edit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertNoWorkspaceDirCollision: run before a demote loop, a collision leaves the demoted workspace untouched — the ordering POST/PUT rely on", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-demote-collide-"));
  try {
    const paths = smithPaths(root);
    await saveWorkspace(paths, { name: "keeper", default: true, repos: [{ name: "r", path: "/abs/r" }] });
    mkdirSync(paths.workspaces, { recursive: true });
    writeFileSync(
      join(paths.workspaces, "Foo.json"),
      JSON.stringify({ name: "Foo", repos: [{ name: "r", path: "/abs/r" }] }),
    );
    await migrateWorkspaceRecords(paths); // "Foo" now owns directory "foo"

    const incoming: Workspace = { name: "foo", default: true, repos: [{ name: "r", path: "/abs/r" }] };

    // What POST and PUT /workspaces now do, in order: check the collision
    // BEFORE anything else is touched — no demoted default, no saved record,
    // same guarantee ensureWorkspaceDir's own mkdir-failure ordering gives.
    await assert.rejects(() => assertNoWorkspaceDirCollision(paths, incoming), WorkspaceDirCollisionError);
    let [keeper] = (await loadWorkspaces(paths)).filter((w) => w.name === "keeper");
    assert.equal(keeper?.default, true, "the pre-flight check throws before any demote loop could run");

    // Characterizes the bug this ordering fixes: demoting the previous
    // default FIRST — the sequence the routes used before this fix, when
    // the collision was only discovered inside the final saveWorkspace(ws)
    // call — leaves "keeper" un-defaulted even though the incoming save is
    // then correctly refused. Nothing left flagged default.
    await saveWorkspace(paths, { ...keeper!, default: undefined });
    await assert.rejects(() => saveWorkspace(paths, incoming), WorkspaceDirCollisionError);
    [keeper] = (await loadWorkspaces(paths)).filter((w) => w.name === "keeper");
    assert.equal(
      keeper?.default,
      undefined,
      "demoting before the collision is caught leaves no workspace default — the exact bug",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saveWorkspace: a slugified submission collides with the legacy record it slugifies to, just like two different names would", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-foo-"));
  try {
    const paths = smithPaths(root);
    // A legacy record whose name pre-dates saveWorkspace's lowercase-only
    // name regex — reachable through migrateWorkspaceRecords (assertContext
    // does not enforce that format), not through saveWorkspace itself.
    mkdirSync(paths.workspaces, { recursive: true });
    writeFileSync(
      join(paths.workspaces, "Foo.json"),
      JSON.stringify({ name: "Foo", repos: [{ name: "r", path: "/abs/r" }] }),
    );
    await migrateWorkspaceRecords(paths);

    // POST /workspaces lowercases and slugifies the submitted name before
    // ever calling saveWorkspace (server.ts's inline slugify ahead of the
    // route's own collision check) — "Foo" submitted through the API
    // reaches saveWorkspace as "foo".
    await assert.rejects(
      () => saveWorkspace(paths, { name: "foo", repos: [{ name: "r", path: "/abs/r" }] }),
      WorkspaceDirCollisionError,
    );

    const dir = workspaceDir(paths, { name: "foo", repos: [] } as Workspace);
    const onDisk = JSON.parse(readFileSync(settingsPathFor(dir), "utf8"));
    assert.equal(onDisk.name, "Foo", "the legacy workspace's config and boards are never silently adopted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removeWorkspaceFile: deregisters and removes the flat record, leaving the directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-del-"));
  try {
    const paths = smithPaths(root);
    const ws = { name: "gone", repos: [{ name: "r", path: "/abs/r" }] } as Workspace;
    await saveWorkspace(paths, ws);

    await removeWorkspaceFile(paths, "gone");

    assert.deepEqual(await loadRegistry(paths), {}, "deregistered");
    assert.deepEqual(await loadWorkspaces(paths), [], "no longer loaded");
    // The directory itself is deliberately left — this plan deletes no data.
    assert.ok(statSync(workspaceDir(paths, ws)).isDirectory(), "directory remains");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadAllContexts: the ONE namespace across a settings.json-based workspace and a flat group", async () => {
  // The name-collision checks (POST /workspaces, POST /groups, and
  // migrateGroupsDir's `taken` set) need to see BOTH kinds together —
  // loadAllContextsFromDir alone goes blind to a workspace the moment it
  // moves to config/settings.json.
  const root = mkdtempSync(join(tmpdir(), "ws-allctx-"));
  try {
    const paths = smithPaths(root);
    const dir = join(paths.workspaces, "pg");
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(settingsPathFor(dir), JSON.stringify({ name: "pg", repos: [{ name: "r", path: "/abs/r" }] }));
    await saveRegistryEntry(paths, "pg", dir);
    mkdirSync(paths.workspaces, { recursive: true });
    writeFileSync(join(paths.workspaces, "a-group.json"), JSON.stringify({ name: "a-group", members: ["pg"] }));

    const all = await loadAllContexts(paths);
    assert.deepEqual(all.map((c) => c.name).sort(), ["a-group", "pg"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadAllContexts: a flat, unmigrated workspace is still visible alongside a group", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-allctx-flat-"));
  try {
    const paths = smithPaths(root);
    mkdirSync(paths.workspaces, { recursive: true });
    writeFileSync(
      join(paths.workspaces, "legacy.json"),
      JSON.stringify({ name: "legacy", repos: [{ name: "r", path: "/abs/r" }] }),
    );
    writeFileSync(join(paths.workspaces, "a-group.json"), JSON.stringify({ name: "a-group", members: [] }));

    const all = await loadAllContexts(paths);
    assert.deepEqual(all.map((c) => c.name).sort(), ["a-group", "legacy"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertContext: workKind is optional and passes through", () => {
  const ws = assertContext("w.json", {
    name: "acme",
    repos: [{ name: "app", path: "/tmp/app" }],
    workKind: "marketing",
  });
  assert.equal(ws.workKind, "marketing");
});

test("assertContext: a workspace with no workKind is still valid", () => {
  const ws = assertContext("w.json", { name: "acme", repos: [{ name: "app", path: "/tmp/app" }] });
  assert.equal(ws.workKind, undefined);
});

test("assertContext: a non-string workKind is refused", () => {
  assert.throws(
    () => assertContext("w.json", { name: "acme", repos: [{ name: "app", path: "/tmp/app" }], workKind: 7 }),
    /workKind/i,
  );
});

test("validSources: a preset from a non-software work kind is accepted", () => {
  const source = {
    id: "s1",
    name: "TikTok",
    preset: "tiktok",
    origin: { url: "https://example.test" },
    cadence: "hourly",
    transform: { mode: "map" },
    enabled: true,
  };
  assert.equal(validSources([source]), true, "a creator preset is as valid as a software one");
});

test("validSources: custom is always accepted", () => {
  const source = {
    id: "s2",
    name: "Anything",
    preset: "custom",
    origin: { url: "https://example.test", query: "q" },
    cadence: "nightly",
    transform: { mode: "analyze", prompt: "summarise" },
    enabled: true,
  };
  assert.equal(validSources([source]), true);
});

test("validSources: a preset no work kind declares is still refused", () => {
  const source = {
    id: "s3",
    name: "Typo",
    preset: "tikTok",
    origin: { url: "https://example.test" },
    cadence: "hourly",
    transform: { mode: "map" },
    enabled: true,
  };
  assert.equal(validSources([source]), false, "presets are data, but still a closed set — a typo is caught");
});

// The next two tests are a discrimination pair, not two independent checks:
// one proves assertContext ACCEPTS an empty repos array, the other proves it
// still REJECTS a malformed one. Together they prove the validator is still
// running its per-repo check and not merely stubbed to return its input —
// a stub that returned `v` unchanged would pass the first test too.
test("assertContext: a workspace with no repos is valid — the design half needs no git", () => {
  const ws = assertContext("w.json", { name: "acme", repos: [] });
  assert.equal(ws.name, "acme");
  assert.deepEqual(ws.repos, []);
});

test("assertContext: a workspace with a MALFORMED repo is still refused (pairs with the empty-repos test above)", () => {
  assert.throws(() => assertContext("w.json", { name: "acme", repos: [{ name: "app" }] }), /repos/i);
  assert.throws(
    () => assertContext("w.json", { name: "acme", repos: [{ name: "app", path: "relative/path" }] }),
    /repos/i,
  );
});

test("assertContext: a repo-less workspace still round-trips its other fields", () => {
  const ws = assertContext("w.json", { name: "acme", repos: [], workKind: "marketing", color: "#abc" });
  assert.equal(ws.workKind, "marketing");
  assert.equal(ws.color, "#abc");
});

test("assertContext: a GROUP carrying repos is still refused", () => {
  // Groups are identified by `members`, never by an empty repo list. Relaxing
  // the workspace branch must not blur the two shapes.
  assert.throws(
    () => assertContext("g.json", { name: "acme", members: ["a", "b"], repos: [{ name: "app", path: "/tmp/app" }] }),
    /group/i,
  );
});

test("assertContext: a workspace with no name is still refused, repos or not", () => {
  assert.throws(() => assertContext("w.json", { repos: [] }), /name/i);
});

test("repoLessRefusal: names the real problem for a workspace that exists but has no repo", () => {
  const wss = [{ name: "design", repos: [] }] as never;

  const refusal = repoLessRefusal(wss, "design");

  assert.ok(refusal, "a repo-less context gets a refusal");
  assert.match(refusal as string, /no repo/i);
  assert.match(refusal as string, /add one/i, "and tells the user how to fix it");
  assert.doesNotMatch(refusal as string, /unknown/i, "it is NOT an unknown-workspace error");
});

test("repoLessRefusal: null when the workspace has a repo — nothing to refuse", () => {
  const wss = [{ name: "coding", repos: [{ name: "app", path: "/tmp/app" }] }] as never;
  assert.equal(repoLessRefusal(wss, "coding"), null);
});

test("repoLessRefusal: null when the workspace is genuinely unknown — that is a different error", () => {
  const wss = [{ name: "design", repos: [] }] as never;
  assert.equal(repoLessRefusal(wss, "nope"), null, "an unknown name is the caller's existing 400, not this");
});

test("repoLessRefusal: falls back to the default workspace when none is named", () => {
  const wss = [
    { name: "coding", repos: [{ name: "app", path: "/tmp/app" }] },
    { name: "design", repos: [], default: true },
  ] as never;
  assert.ok(repoLessRefusal(wss, undefined), "the default workspace is the one a nameless request means");
});
