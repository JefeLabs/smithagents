import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { smithPaths } from "./paths.js";
import type { Workspace } from "./workspaces.js";
import {
  defaultViolation,
  ensureWorkspaceDir,
  initGitRepo,
  isGitRepo,
  loadWorkspacesFromDir,
  normalizeRepoBranch,
  removeWorkspaceFile,
  resolveRepo,
  saveWorkspace,
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
  const dir = await mkdtemp(join(tmpdir(), "ws-"));
  await assert.rejects(() => saveWorkspace(dir, { name: "Bad Name", repos: [{ name: "r", path: "/tmp" }] }));
  await saveWorkspace(dir, { name: "good", repos: [{ name: "r", path: "/tmp" }] });
  assert.equal((await loadWorkspacesFromDir(dir))[0]?.name, "good");
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

test("removeWorkspaceFile: rejects missing workspace with readable error, succeeds on existing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rm-"));
  await assert.rejects(() => removeWorkspaceFile(dir, "nope"), /Workspace "nope" not found/);
  await saveWorkspace(dir, { name: "exist", repos: [{ name: "r", path: "/tmp" }] });
  await removeWorkspaceFile(dir, "exist");
  assert.equal((await loadWorkspacesFromDir(dir)).length, 0);
});

test("atlassian and github config round-trip through save/load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-"));
  const ws: Workspace = {
    name: "acme",
    repos: [{ name: "web", path: "/tmp", branch: "main", github: { owner: "acme", repo: "web" } }],
    atlassian: { siteUrl: "https://acme.atlassian.net", jiraProjectKeys: ["ACME"], confluenceSpaceKeys: ["DOCS"] },
  };
  await saveWorkspace(dir, ws);
  const [loaded] = await loadWorkspacesFromDir(dir);
  assert.deepEqual(loaded?.atlassian, ws.atlassian);
  assert.deepEqual(loaded?.repos[0]?.github, { owner: "acme", repo: "web" });
});

test("a workspace atlassian block with connectorId round-trips through save/load unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workspaces-connectorid-"));
  const repoDir = join(dir, "repo");
  await mkdir(repoDir, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: repoDir });
  const ws: Workspace = {
    name: "acme",
    repos: [{ name: "web", path: repoDir }],
    atlassian: { siteUrl: "https://acme.atlassian.net", connectorId: "conn-1" },
  };
  await saveWorkspace(dir, ws);
  const [reloaded] = await loadWorkspacesFromDir(dir);
  assert.equal(reloaded!.atlassian?.connectorId, "conn-1");
});

test("a repo github block with connectorId round-trips through save/load unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workspaces-repo-connectorid-"));
  const repoDir = join(dir, "repo");
  await mkdir(repoDir, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: repoDir });
  const ws: Workspace = {
    name: "acme",
    repos: [{ name: "web", path: repoDir, github: { owner: "acme", repo: "web", connectorId: "conn-2" } }],
  };
  await saveWorkspace(dir, ws);
  const [reloaded] = await loadWorkspacesFromDir(dir);
  assert.equal(reloaded!.repos[0]!.github?.connectorId, "conn-2");
});

test("workspaceProblems does not require or validate connectorId — an unset one is fine", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workspaces-noconnid-"));
  const repoDir = join(dir, "repo");
  await mkdir(repoDir, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: repoDir });
  const ws: Workspace = {
    name: "acme",
    repos: [{ name: "web", path: repoDir, github: { owner: "acme", repo: "web" } }],
  };
  await saveWorkspace(dir, ws);
  const [reloaded] = await loadWorkspacesFromDir(dir);
  assert.equal(reloaded?.atlassian?.connectorId, undefined);
  assert.equal(reloaded?.repos[0]?.github?.connectorId, undefined);
});

test("saveWorkspace/loadWorkspacesFromDir round-trips the optional links field", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-links-"));
  await saveWorkspace(dir, {
    name: "acme",
    repos: [{ name: "web", path: dir }],
    links: ["https://acme.example/runbook"],
  });
  const [ws] = await loadWorkspacesFromDir(dir);
  assert.deepEqual(ws!.links, ["https://acme.example/runbook"]);
  await saveWorkspace(dir, { name: "plain", repos: [{ name: "web", path: dir }] });
  const plain = (await loadWorkspacesFromDir(dir)).find((w) => w.name === "plain");
  assert.equal(plain!.links, undefined);
});

test("initGitRepo: turns a plain directory into a git repository", async () => {
  const dir = await mkdtemp(join(tmpdir(), "initgit-"));
  assert.equal(await isGitRepo(dir), false);
  await initGitRepo(dir);
  assert.equal(await isGitRepo(dir), true);
});

test("a workspace record with sources round-trips through save and load untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-"));
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
  await saveWorkspace(dir, ws);
  const [loaded] = await loadWorkspacesFromDir(dir);
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
