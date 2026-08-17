import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { smithPaths } from "./paths.js";
import { loadRegistry, saveRegistryEntry } from "./workspace-registry.js";
import type { Workspace } from "./workspaces.js";
import {
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
  resolveRepo,
  saveWorkspace,
  settingsPathFor,
  slugForDir,
  validSources,
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
