import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emptyCliToolsFile, saveCliToolsFile } from "./cli-tools.js";
import { loadConfig } from "./config.js";
import { Dispatcher, resolveTaskWorktree } from "./dispatcher.js";
import { ToolLaunchError } from "./drivers/errors.js";
import { smithPaths } from "./paths.js";
import type { OrchestratorConfig, TaskManifest } from "./types.js";
import { saveWorkspace, type Workspace } from "./workspaces.js";

// A binary guaranteed not to resolve on PATH, so refreshCliTool's re-probe
// (fired fire-and-forget by both the gate and the catch block) fails fast on
// detection instead of hanging or touching a real installed CLI.
const NO_SUCH_BINARY: Record<TaskManifest["agent"], string> = {
  agy: "definitely-not-a-real-binary-xyz",
  claude: "definitely-not-a-real-binary-xyz",
  codex: "definitely-not-a-real-binary-xyz",
  opencode: "definitely-not-a-real-binary-xyz",
  copilot: "definitely-not-a-real-binary-xyz",
};

// resolveConnections is exercised through the Dispatcher instance rather than
// exported standalone, since it reads from the same `workspaces` and `users`
// dirs the rest of the module resolves relative to the configured state root
// (root defaults to this.config.smithRoot, overridable for tests) — the test
// drives it via a minimal manifest + a real repo/user fixture on disk.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dispatch-conn-"));
  await mkdir(join(root, "workspaces"), { recursive: true });
  await mkdir(join(root, "users"), { recursive: true });
  const repoPath = join(root, "repo");
  await mkdir(repoPath, { recursive: true });
  await writeFile(
    join(root, "workspaces/acme.json"),
    JSON.stringify({
      name: "acme",
      repos: [{ name: "web", path: repoPath, github: { owner: "acme", repo: "web", connectorId: "gh-conn-1" } }],
      atlassian: { siteUrl: "https://acme.atlassian.net", jiraProjectKeys: ["ACME"], connectorId: "atl-conn-1" },
    }),
  );
  await writeFile(
    join(root, "users/edwin.json"),
    JSON.stringify({
      id: "edwin",
      name: "Edwin",
      default: true,
      connectors: [
        {
          id: "atl-conn-1",
          vendorId: "atlassian",
          label: "default",
          fields: { email: "e@acme.com", apiToken: "atl-tok" },
        },
        { id: "gh-conn-1", vendorId: "github", label: "default", fields: { token: "gh-tok" } },
      ],
    }),
  );
  return { root, repoPath };
}

test("resolveConnections: pairs the current user credential with the repo-matched workspace config", async () => {
  const { root, repoPath } = await fixture();
  const dispatcher = new Dispatcher({} as OrchestratorConfig);
  const manifest = { context: { repoPath } } as TaskManifest;
  const resolved = await dispatcher.resolveConnections(manifest, root);
  assert.deepEqual(resolved.atlassian, {
    siteUrl: "https://acme.atlassian.net",
    jiraProjectKeys: ["ACME"],
    connectorId: "atl-conn-1",
  });
  assert.equal(resolved.env.SMITH_ATLASSIAN_EMAIL, "e@acme.com");
  assert.equal(resolved.env.SMITH_ATLASSIAN_TOKEN, "atl-tok");
  assert.equal(resolved.env.GH_TOKEN, "gh-tok");
});

test("resolveConnections: missing workspace atlassian config or missing user credential both skip injection cleanly", async () => {
  const { root } = await fixture();
  // repoPath not matched by any workspace -> everything skipped
  const dispatcher = new Dispatcher({} as OrchestratorConfig);
  const resolved = await dispatcher.resolveConnections({ context: { repoPath: "/nope" } } as TaskManifest, root);
  assert.equal(resolved.atlassian, undefined);
  assert.equal(resolved.env.SMITH_ATLASSIAN_TOKEN, undefined);
  assert.equal(resolved.env.GH_TOKEN, undefined);
});

test('resolveConnections: resolves Atlassian env vars through workspace.atlassian.connectorId, not "any atlassian connector the user has"', async () => {
  const root = await mkdtemp(join(tmpdir(), "dispatch-conn-"));
  await mkdir(join(root, "workspaces"), { recursive: true });
  await mkdir(join(root, "users"), { recursive: true });
  const repoPath = join(root, "repo");
  await mkdir(repoPath, { recursive: true });
  await writeFile(
    join(root, "workspaces/acme.json"),
    JSON.stringify({
      name: "acme",
      repos: [{ name: "web", path: repoPath }],
      atlassian: { siteUrl: "https://acme.atlassian.net", connectorId: "atl-conn-2" },
    }),
  );
  await writeFile(
    join(root, "users/edwin.json"),
    JSON.stringify({
      id: "edwin",
      name: "Edwin",
      default: true,
      connectors: [
        {
          id: "atl-conn-1",
          vendorId: "atlassian",
          label: "personal",
          fields: { email: "first@acme.com", apiToken: "first-tok" },
        },
        {
          id: "atl-conn-2",
          vendorId: "atlassian",
          label: "acme-corp",
          fields: { email: "second@acme.com", apiToken: "second-tok" },
        },
      ],
    }),
  );
  const dispatcher = new Dispatcher({} as OrchestratorConfig);
  const resolved = await dispatcher.resolveConnections({ context: { repoPath } } as TaskManifest, root);
  assert.equal(resolved.env.SMITH_ATLASSIAN_EMAIL, "second@acme.com");
  assert.equal(resolved.env.SMITH_ATLASSIAN_TOKEN, "second-tok");
});

test("resolveConnections: an unset connectorId resolves to no Atlassian injection, not a crash and not a guess", async () => {
  const root = await mkdtemp(join(tmpdir(), "dispatch-conn-"));
  await mkdir(join(root, "workspaces"), { recursive: true });
  await mkdir(join(root, "users"), { recursive: true });
  const repoPath = join(root, "repo");
  await mkdir(repoPath, { recursive: true });
  await writeFile(
    join(root, "workspaces/acme.json"),
    JSON.stringify({
      name: "acme",
      repos: [{ name: "web", path: repoPath }],
      atlassian: { siteUrl: "https://acme.atlassian.net" },
    }),
  );
  await writeFile(
    join(root, "users/edwin.json"),
    JSON.stringify({
      id: "edwin",
      name: "Edwin",
      default: true,
      connectors: [
        {
          id: "atl-conn-1",
          vendorId: "atlassian",
          label: "default",
          fields: { email: "e@acme.com", apiToken: "atl-tok" },
        },
      ],
    }),
  );
  const dispatcher = new Dispatcher({} as OrchestratorConfig);
  const resolved = await dispatcher.resolveConnections({ context: { repoPath } } as TaskManifest, root);
  assert.equal(resolved.atlassian, undefined);
  assert.equal(resolved.env.SMITH_ATLASSIAN_EMAIL, undefined);
  assert.equal(resolved.env.SMITH_ATLASSIAN_TOKEN, undefined);
});

test("resolveConnections: a connectorId pointing at a deleted/nonexistent connector resolves to no injection, same as unset", async () => {
  const root = await mkdtemp(join(tmpdir(), "dispatch-conn-"));
  await mkdir(join(root, "workspaces"), { recursive: true });
  await mkdir(join(root, "users"), { recursive: true });
  const repoPath = join(root, "repo");
  await mkdir(repoPath, { recursive: true });
  await writeFile(
    join(root, "workspaces/acme.json"),
    JSON.stringify({
      name: "acme",
      repos: [{ name: "web", path: repoPath }],
      atlassian: { siteUrl: "https://acme.atlassian.net", connectorId: "does-not-exist" },
    }),
  );
  await writeFile(
    join(root, "users/edwin.json"),
    JSON.stringify({
      id: "edwin",
      name: "Edwin",
      default: true,
      connectors: [
        {
          id: "atl-conn-1",
          vendorId: "atlassian",
          label: "default",
          fields: { email: "e@acme.com", apiToken: "atl-tok" },
        },
      ],
    }),
  );
  const dispatcher = new Dispatcher({} as OrchestratorConfig);
  const resolved = await dispatcher.resolveConnections({ context: { repoPath } } as TaskManifest, root);
  assert.equal(resolved.atlassian, undefined);
  assert.equal(resolved.env.SMITH_ATLASSIAN_EMAIL, undefined);
  assert.equal(resolved.env.SMITH_ATLASSIAN_TOKEN, undefined);
});

test("resolveConnections: GH_TOKEN resolves through repo.github.connectorId, per-repo — two repos in the same workspace can resolve different GitHub tokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "dispatch-conn-"));
  await mkdir(join(root, "workspaces"), { recursive: true });
  await mkdir(join(root, "users"), { recursive: true });
  const repoPathA = join(root, "repo-a");
  const repoPathB = join(root, "repo-b");
  await mkdir(repoPathA, { recursive: true });
  await mkdir(repoPathB, { recursive: true });
  await writeFile(
    join(root, "workspaces/acme.json"),
    JSON.stringify({
      name: "acme",
      repos: [
        { name: "a", path: repoPathA, github: { owner: "acme", repo: "a", connectorId: "gh-conn-1" } },
        { name: "b", path: repoPathB, github: { owner: "acme", repo: "b", connectorId: "gh-conn-2" } },
      ],
    }),
  );
  await writeFile(
    join(root, "users/edwin.json"),
    JSON.stringify({
      id: "edwin",
      name: "Edwin",
      default: true,
      connectors: [
        { id: "gh-conn-1", vendorId: "github", label: "personal", fields: { token: "tok-a" } },
        { id: "gh-conn-2", vendorId: "github", label: "acme-corp", fields: { token: "tok-b" } },
      ],
    }),
  );
  const dispatcher = new Dispatcher({} as OrchestratorConfig);
  const resolvedA = await dispatcher.resolveConnections({ context: { repoPath: repoPathA } } as TaskManifest, root);
  const resolvedB = await dispatcher.resolveConnections({ context: { repoPath: repoPathB } } as TaskManifest, root);
  assert.equal(resolvedA.env.GH_TOKEN, "tok-a");
  assert.equal(resolvedB.env.GH_TOKEN, "tok-b");
});

test("resolveConnections: a repo with no github.connectorId set resolves no GH_TOKEN, even if the user has GitHub connectors", async () => {
  const root = await mkdtemp(join(tmpdir(), "dispatch-conn-"));
  await mkdir(join(root, "workspaces"), { recursive: true });
  await mkdir(join(root, "users"), { recursive: true });
  const repoPath = join(root, "repo");
  await mkdir(repoPath, { recursive: true });
  await writeFile(
    join(root, "workspaces/acme.json"),
    JSON.stringify({
      name: "acme",
      repos: [{ name: "web", path: repoPath, github: { owner: "acme", repo: "web" } }],
    }),
  );
  await writeFile(
    join(root, "users/edwin.json"),
    JSON.stringify({
      id: "edwin",
      name: "Edwin",
      default: true,
      connectors: [{ id: "gh-conn-1", vendorId: "github", label: "default", fields: { token: "gh-tok" } }],
    }),
  );
  const dispatcher = new Dispatcher({} as OrchestratorConfig);
  const resolved = await dispatcher.resolveConnections({ context: { repoPath } } as TaskManifest, root);
  assert.equal(resolved.env.GH_TOKEN, undefined);
});

// ---------------------------------------------------------------------------
// dispatch(): CLI tool registry gate — the first await in dispatch(), before
// resolveConnections and before the try block, so a confirmed negative blocks
// with nothing else (git, tmux, worktrees) touched.
// ---------------------------------------------------------------------------

test("dispatch: rejects with a subscription-inactive ToolLaunchError when the registry has a confirmed negative for the manifest agent", async () => {
  const smithRoot = await mkdtemp(join(tmpdir(), "dispatch-gate-"));
  const file = emptyCliToolsFile();
  file.tools.claude = {
    detected: true,
    authOk: false,
    enabled: true,
    detail: "not logged in — run `claude /login`",
    lastCheckedAt: "2026-08-06T00:00:00.000Z",
  };
  await saveCliToolsFile(join(smithRoot, "cli-tools.json"), file);

  const config = loadConfig({ smithRoot, agentCommands: NO_SUCH_BINARY });
  const dispatcher = new Dispatcher(config);
  const manifest: TaskManifest = {
    taskId: "gate-blocked-task",
    prompt: "irrelevant — the gate blocks before this matters",
    context: { files: [], repository: "https://github.com/acme/repo", branch: "main" },
    agent: "claude",
    createdAt: new Date().toISOString(),
    priority: "normal",
  };

  await assert.rejects(
    () => dispatcher.dispatch(manifest),
    (err: unknown) => {
      assert.ok(err instanceof ToolLaunchError);
      assert.match((err as Error).message, /subscription-inactive: not logged in/);
      return true;
    },
  );
});

// No dispatch()-level fail-open test on purpose: letting dispatch() run past
// the gate reaches the real teardown(), whose killPattern('sub-') sweeps the
// HOST tmux server — a live-session hazard from a unit test. Fail-open
// semantics (absent file/entry never blocks) are pinned at the primitive
// level in cli-tools.test.ts (gateReason/isActive), and the gate's wiring is
// proven by the confirmed-negative test above, which throws before the try
// block so teardown never runs.

// ---------------------------------------------------------------------------
// resolveTaskWorktree(): where a task's agent runs — a workspace-instance for
// workspace-routed tasks, the legacy detached worktree for everything else.
// ---------------------------------------------------------------------------

function makeManifest(overrides: { taskId: string; context: TaskManifest["context"] }): TaskManifest {
  return {
    taskId: overrides.taskId,
    prompt: "irrelevant to worktree resolution",
    context: overrides.context,
    agent: "claude",
    createdAt: new Date().toISOString(),
    priority: "normal",
  };
}

function commit(cwd: string, msg: string): void {
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg], { cwd });
}

/** A plain git repo at `path`, with one commit. */
function makeGitRepo(path: string): string {
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  writeFileSync(join(path, "README.md"), "hi\n");
  commit(path, "init");
  return path;
}

/**
 * A workspace directory whose config/ and named repo are real git repos —
 * same shape as workspace-instances.test.ts's fixture. `ws.dir` is pinned to
 * `dir` explicitly so workspaceDir() resolves to it directly rather than the
 * default under the state root.
 */
function makeWorkspaceFixture(root: string, repoName: string): { dir: string; ws: Workspace } {
  const dir = mkdtempSync(join(root, "ws-"));
  const cfg = join(dir, "config");
  execFileSync("git", ["init", "-q", "-b", "main", cfg]);
  writeFileSync(join(cfg, "settings.json"), "{}\n");
  commit(cfg, "config");

  const repoPath = join(dir, repoName);
  execFileSync("git", ["init", "-q", "-b", "main", repoPath]);
  writeFileSync(join(repoPath, "README.md"), `${repoName}\n`);
  commit(repoPath, "init");

  const ws: Workspace = { name: "proj", repos: [{ name: repoName, path: repoPath }], dir };
  return { dir, ws };
}

test("resolveTaskWorktree: a workspace-routed task runs inside a workspace-instance", async () => {
  const root = mkdtempSync(join(tmpdir(), "disp-inst-"));
  try {
    const paths = smithPaths(root);
    const { dir, ws } = makeWorkspaceFixture(root, "app");
    await saveWorkspace(paths, ws);

    const manifest = makeManifest({
      taskId: "t-1",
      context: {
        workspace: ws.name,
        repo: "app",
        repoPath: ws.repos[0].path,
        branch: "main",
        files: [],
        repository: "",
      },
    });

    const { path: worktree, created } = await resolveTaskWorktree(manifest, {
      worktreeDir: join(root, "worktrees"),
      smithRoot: root,
    });

    assert.equal(worktree, join(dir, ".runtime", "instances", "t-1", "app"), "runs in the instance's repo worktree");
    assert.ok(created, "createInstance already created this worktree");
    assert.ok(statSync(join(dir, ".runtime", "instances", "t-1", "config")).isDirectory(), "config/ is alongside it");
    assert.ok(!worktree.startsWith(join(root, "worktrees")), "NOT in the detached worktrees directory");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveTaskWorktree: a non-workspace task keeps the legacy detached worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "disp-legacy-"));
  try {
    const repo = makeGitRepo(join(root, "solo"));
    const manifest = makeManifest({
      taskId: "t-2",
      context: { repoPath: repo, branch: "main", files: [], repository: "" },
    });

    const { path: worktree, created } = await resolveTaskWorktree(manifest, {
      worktreeDir: join(root, "worktrees"),
      smithRoot: root,
    });

    assert.match(worktree, /worktrees[/\\]t-2$/, "legacy path unchanged");
    assert.equal(created, false, "prepareWorktree still owns `git worktree add` for the legacy path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveTaskWorktree: workspace set but repo unset falls back to legacy", async () => {
  const root = mkdtempSync(join(tmpdir(), "disp-norepo-"));
  try {
    const paths = smithPaths(root);
    const { ws } = makeWorkspaceFixture(root, "app");
    await saveWorkspace(paths, ws);

    const manifest = makeManifest({
      taskId: "t-3",
      context: { workspace: ws.name, repoPath: ws.repos[0].path, branch: "main", files: [], repository: "" },
    });

    const { created } = await resolveTaskWorktree(manifest, {
      worktreeDir: join(root, "worktrees"),
      smithRoot: root,
    });

    assert.equal(created, false, "repo unset means nothing to route to an instance — legacy path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveTaskWorktree: an unknown workspace name falls back to legacy", async () => {
  const root = mkdtempSync(join(tmpdir(), "disp-unknown-"));
  try {
    const repo = makeGitRepo(join(root, "solo"));
    const manifest = makeManifest({
      taskId: "t-4",
      context: { workspace: "does-not-exist", repo: "app", repoPath: repo, branch: "main", files: [], repository: "" },
    });

    const { created } = await resolveTaskWorktree(manifest, {
      worktreeDir: join(root, "worktrees"),
      smithRoot: root,
    });

    assert.equal(created, false, "an unresolvable workspace name falls back to legacy, not a crash");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
