import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CliToolRefresher, emptyCliToolsFile, saveCliToolsFile } from "./cli-tools.js";
import { loadConfig } from "./config.js";
import { delegationKey, verifyDelegationToken } from "./delegation-token.js";
import { createLegacyWorktree, Dispatcher, resolveTaskWorktree, taskClonePath } from "./dispatcher.js";
import { ToolLaunchError } from "./drivers/errors.js";
import type { CommandRunner } from "./drivers/types.js";
import { makeGitRepo, makeOrgRepo } from "./org-repo.fixture.js";
import { smithPaths } from "./paths.js";
import { DockerRuntime } from "./runtime.js";
import { createTaskClone } from "./task-clone.js";
import type { OrchestratorConfig, TaskManifest } from "./types.js";
import { saveWorkspace, type Workspace } from "./workspaces.js";

// A binary guaranteed not to resolve on PATH, so the on-failure re-probe
// (started in the background by both the gate and the catch block) fails fast on
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

/**
 * A workspace whose subtree lives in an org repo under `root/config` and whose
 * named repo is a real git repo. `ws.dir` is pinned so workspaceDir() resolves
 * to it directly rather than the default under the state root.
 */
function makeWorkspaceFixture(root: string, repoName: string): { dir: string; ws: Workspace } {
  makeOrgRepo(root, ["proj"]);
  const dir = mkdtempSync(join(root, "ws-"));
  const repoPath = makeGitRepo(join(dir, repoName));
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
    assert.ok(
      statSync(join(dir, ".runtime", "instances", "t-1", "config", "workspaces", "proj")).isDirectory(),
      "config/ is alongside it",
    );
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

// ---------------------------------------------------------------------------
// createLegacyWorktree(): the same DWIM-avoidance workspace-instances.ts's
// resolveStartPoint gives an instance's repo member, applied to the legacy
// (non-workspace) path — a pre-existing bug, fixed opportunistically once the
// DWIM behaviour was characterized (see workspace-instances.ts's doc comment).
// ---------------------------------------------------------------------------

test("createLegacyWorktree: a base that exists only as a remote-tracking ref still lands on the requested branch, not one named after the base", async () => {
  const root = mkdtempSync(join(tmpdir(), "disp-legacy-dwim-"));
  try {
    const origin = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "-b", "main", origin]);
    writeFileSync(join(origin, "README.md"), "hi\n");
    execFileSync("git", ["add", "-A"], { cwd: origin });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: origin });

    const clone = join(root, "clone");
    execFileSync("git", ["clone", "-q", origin, clone]);
    // Move off main and delete the local branch — only origin/main remains,
    // exactly the scenario that trips git's DWIM (see workspace-instances.ts).
    execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: clone });
    execFileSync("git", ["branch", "-D", "main"], { cwd: clone });

    const worktreePath = join(root, "wt");
    const git = async (args: string[], cwd?: string): Promise<string> => execFileSync("git", args, { cwd }).toString();

    await createLegacyWorktree(worktreePath, "smith/t-legacy-dwim", clone, "main", git);

    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath }).toString().trim();
    assert.equal(branch, "smith/t-legacy-dwim", "the requested branch name is honored, not overridden by git's DWIM");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createLegacyWorktree: no repoPath passes the base through unchanged — no source clone to resolve against", async () => {
  const calls: Array<{ args: string[]; cwd: string | undefined }> = [];
  const git = async (args: string[], cwd?: string): Promise<string> => {
    calls.push({ args, cwd });
    return "";
  };

  await createLegacyWorktree("/tmp/wt-unused", "smith/t-legacy-norepo", undefined, "release/only-remote", git);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args, [
    "worktree",
    "add",
    "/tmp/wt-unused",
    "-b",
    "smith/t-legacy-norepo",
    "--",
    "release/only-remote",
  ]);
  assert.equal(
    calls[0]?.cwd,
    undefined,
    "no cwd, and the base is untouched — matches the pre-fix legacy call exactly for this case",
  );
});

test("dispatch: a blocked attempt re-probes through the refresher it was given, which close() settles before teardown", async () => {
  const smithRoot = await mkdtemp(join(tmpdir(), "dispatch-refresh-"));
  const file = emptyCliToolsFile();
  file.tools.claude = {
    detected: true,
    authOk: false,
    enabled: true,
    detail: "not logged in",
    lastCheckedAt: "2026-08-06T00:00:00.000Z",
  };
  await saveCliToolsFile(join(smithRoot, "cli-tools.json"), file);

  // The re-probe returns only when the test says so, like a slow CLI under load.
  const probed: string[][] = [];
  let firstProbe!: () => void;
  const probeStarted = new Promise<void>((resolve) => {
    firstProbe = resolve;
  });
  let finishProbes!: () => void;
  const probesFinish = new Promise<void>((resolve) => {
    finishProbes = resolve;
  });
  const slow: CommandRunner = async (argv) => {
    probed.push(argv);
    firstProbe();
    await probesFinish;
    return { code: 0, stdout: "/usr/local/bin/claude\n", stderr: "" };
  };
  const refresher = new CliToolRefresher(slow);
  const dispatcher = new Dispatcher(loadConfig({ smithRoot }), undefined, refresher);
  const manifest: TaskManifest = {
    taskId: "gate-blocked-refresh",
    prompt: "irrelevant — the gate blocks first",
    context: { files: [], repository: "https://github.com/acme/repo", branch: "main" },
    agent: "claude",
    createdAt: new Date().toISOString(),
    priority: "normal",
  };
  await assert.rejects(() => dispatcher.dispatch(manifest), ToolLaunchError);
  await probeStarted;
  assert.ok(probed.length > 0, "the re-probe ran through the injected refresher");

  await refresher.close(); // what the server's stop() does
  await rm(smithRoot, { recursive: true, force: true });
  finishProbes();
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline && !existsSync(smithRoot)) await new Promise((r) => setTimeout(r, 20));
  const recreated = existsSync(smithRoot);
  await rm(smithRoot, { recursive: true, force: true });
  assert.equal(recreated, false, "a dispatcher re-probe outlived close() and recreated the deleted root");
});

test("buildAgentCommand: a worktree's bin/ adds smith-delegate but cannot shadow the tools the agent runs", async () => {
  const smithRoot = await mkdtemp(join(tmpdir(), "dispatch-path-"));
  const worktree = join(smithRoot, "wt");
  try {
    // A repo can commit anything under bin/. Were the worktree's bin/ first on
    // PATH, a planted bin/git would replace the real one for the whole session.
    await mkdir(join(worktree, "bin"), { recursive: true });
    await writeFile(join(worktree, "bin", "git"), "#!/bin/sh\necho HIJACKED\nexit 1\n", { mode: 0o755 });
    await writeFile(join(worktree, "bin", "smith-delegate"), "#!/bin/sh\necho delegate-found\n", { mode: 0o755 });

    const config = loadConfig({
      smithRoot,
      agentCommands: { ...NO_SUCH_BINARY, claude: "git --version; smith-delegate; echo" },
    });
    const dispatcher = new Dispatcher(config) as unknown as {
      buildAgentCommand(manifest: TaskManifest, worktreePath: string): string;
    };
    const command = dispatcher.buildAgentCommand(
      {
        taskId: "path-order",
        prompt: "irrelevant",
        context: { files: [], repository: "", branch: "main" },
        agent: "claude",
        createdAt: new Date().toISOString(),
        priority: "normal",
      },
      worktree,
    );

    const output = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" });
    assert.doesNotMatch(output, /HIJACKED/);
    assert.match(output, /git version/);
    assert.match(output, /delegate-found/, "smith-delegate must still resolve from the worktree's bin/");
  } finally {
    await rm(smithRoot, { recursive: true, force: true });
  }
});

test("sessionEnv: every session can call this swarm back, aimed at the parent task's own workspace/repo/branch", async () => {
  const smithRoot = await mkdtemp(join(tmpdir(), "dispatch-env-"));
  try {
    const config = loadConfig({ smithRoot, agentCommands: NO_SUCH_BINARY, swarmUrl: "http://127.0.0.1:7777" });
    const dispatcher = new Dispatcher(config) as unknown as {
      sessionEnv(manifest: TaskManifest, connectionsEnv: Record<string, string>): Record<string, string>;
    };
    const manifest: TaskManifest = {
      taskId: "env",
      prompt: "irrelevant",
      context: { files: [], repository: "", branch: "dev", workspace: "acme", repo: "web", repoPath: "/x/web" },
      agent: "claude",
      createdAt: new Date().toISOString(),
      priority: "normal",
    };
    // Without workspace/repo, POST /tasks resolves the DEFAULT workspace's repo,
    // so a sub-task of a repo-X task would run in repo Y.
    assert.deepEqual(dispatcher.sessionEnv(manifest, { GH_TOKEN: "gh-tok" }), {
      SMITH_URL: "http://127.0.0.1:7777",
      SMITH_WORKSPACE: "acme",
      SMITH_REPO: "web",
      SMITH_BRANCH: "dev",
      GH_TOKEN: "gh-tok",
      SMITH_API_TOKEN: "",
      SMITH_BROKER_TOKEN: "",
    });
    // An unrouted task sends only what it knows; the swarm picks its default.
    assert.deepEqual(
      dispatcher.sessionEnv({ ...manifest, context: { files: [], repository: "", branch: "main" } }, {}),
      {
        SMITH_URL: "http://127.0.0.1:7777",
        SMITH_BRANCH: "main",
        SMITH_API_TOKEN: "",
        SMITH_BROKER_TOKEN: "",
      },
    );
  } finally {
    await rm(smithRoot, { recursive: true, force: true });
  }
});

test("sessionEnv: with a delegation key the session gets a token scoped to its own task — never the admin token", async () => {
  const smithRoot = await mkdtemp(join(tmpdir(), "dispatch-env-"));
  try {
    const key = delegationKey("admin-secret");
    const config = loadConfig({ smithRoot, agentCommands: NO_SUCH_BINARY, delegationKey: key });
    const dispatcher = new Dispatcher(config) as unknown as {
      sessionEnv(manifest: TaskManifest, connectionsEnv: Record<string, string>): Record<string, string>;
    };
    const manifest: TaskManifest = {
      taskId: "env",
      prompt: "irrelevant",
      context: { files: [], repository: "", branch: "dev", workspace: "acme", repo: "web", repoPath: "/x/web" },
      agent: "claude",
      createdAt: new Date().toISOString(),
      priority: "normal",
    };
    // A connector (or the inherited env) must not be able to smuggle the admin
    // token, or the broker bridge token, in.
    const env = dispatcher.sessionEnv(manifest, {
      SMITH_API_TOKEN: "admin-secret",
      SMITH_BROKER_TOKEN: "bridge-secret",
    });
    assert.equal(env.SMITH_API_TOKEN, "");
    assert.equal(env.SMITH_BROKER_TOKEN, "");
    assert.deepEqual(verifyDelegationToken(key, env.SMITH_DELEGATE_TOKEN), {
      task: "env",
      workspace: "acme",
      repo: "web",
      branch: "dev",
      runtime: "tmux",
      depth: 0,
    });
    const child = dispatcher.sessionEnv(
      { ...manifest, runtime: "docker", delegation: { parentTaskId: "p", depth: 2 } },
      {},
    );
    assert.deepEqual(verifyDelegationToken(key, child.SMITH_DELEGATE_TOKEN), {
      task: "env",
      workspace: "acme",
      repo: "web",
      branch: "dev",
      runtime: "docker",
      depth: 2,
    });
  } finally {
    await rm(smithRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Docker tasks run in disposable clones (docker git isolation, Task 4).
// ---------------------------------------------------------------------------

type CloneDispatcher = {
  prepareTaskClone(manifest: TaskManifest, connections: object): Promise<import("./task-clone.js").TaskClone>;
  openPullRequest(
    manifest: TaskManifest,
    cwd: string,
    from?: { head: string; baseRev: string },
  ): Promise<string | undefined>;
  finalizeAndImport(
    manifest: TaskManifest,
    clone: import("./task-clone.js").TaskClone,
    runner: { runOnce(cwd: string, command: string, mounts: string[]): Promise<{ exitCode: number; output: string }> },
    uploadPack: string,
    completed: boolean,
  ): Promise<{ imported: true } | { imported: false; error: string }>;
  run(cmd: string, args: string[], cwd?: string): Promise<string>;
};

test("prepareTaskClone: a docker task gets a fresh clone with smith-delegate, its plumbing excluded, and no branch in the user's repo", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "disp-clone-")));
  try {
    const repo = makeGitRepo(join(root, "solo"));
    const delegate = join(root, "smith-delegate");
    writeFileSync(delegate, "#!/bin/sh\necho hi\n", { mode: 0o755 });
    const config = loadConfig({ smithRoot: root, agentCommands: NO_SUCH_BINARY, delegateBin: delegate });
    const d = new Dispatcher(config) as unknown as CloneDispatcher;
    const manifest = makeManifest({
      taskId: "t-clone",
      context: { repoPath: repo, branch: "main", files: [], repository: "" },
    });
    manifest.runtime = "docker";

    const clone = await d.prepareTaskClone(manifest, {});
    assert.equal(clone.path, taskClonePath(root, "t-clone"));
    assert.ok(existsSync(join(clone.path, "bin", "smith-delegate")));
    assert.match(readFileSync(join(clone.path, ".git", "info", "exclude"), "utf8"), /bin\/smith-delegate/);
    const refs = execFileSync("git", ["branch", "--list", "smith/t-clone"], { cwd: repo, encoding: "utf8" });
    assert.equal(refs.trim(), "", "the user's repo gains no branch until import");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareTaskClone: a docker task with no repository is refused", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "disp-clone-norepo-")));
  try {
    const d = new Dispatcher(
      loadConfig({ smithRoot: root, agentCommands: NO_SUCH_BINARY }),
    ) as unknown as CloneDispatcher;
    const manifest = makeManifest({ taskId: "t-nr", context: { branch: "main", files: [], repository: "" } });
    await assert.rejects(d.prepareTaskClone(manifest, {}), /a docker task needs a repository/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareTaskClone: an invalid base branch is refused before any git runs", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "disp-clone-bad-")));
  try {
    const repo = makeGitRepo(join(root, "solo"));
    const d = new Dispatcher(
      loadConfig({ smithRoot: root, agentCommands: NO_SUCH_BINARY }),
    ) as unknown as CloneDispatcher;
    const manifest = makeManifest({
      taskId: "t-bad",
      context: { repoPath: repo, branch: "--upload-pack=x", files: [], repository: "" },
    });
    await assert.rejects(d.prepareTaskClone(manifest, {}), /Invalid base branch/);
    assert.ok(!existsSync(taskClonePath(root, "t-bad")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openPullRequest from the user's repo: counts and titles from the base commit, pushes with hooks off, never reads HEAD", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "disp-pr-")));
  try {
    const repo = join(root, "repo");
    const d = new Dispatcher(
      loadConfig({ smithRoot: root, agentCommands: NO_SUCH_BINARY }),
    ) as unknown as CloneDispatcher;
    const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
    d.run = async (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      if (cmd === "gh") return "https://github.com/acme/web/pull/7";
      if (args[0] === "remote") return "origin";
      if (args[0] === "rev-list") return "1";
      if (args[0] === "log") return "feat: agent work";
      return "";
    };
    const manifest = makeManifest({
      taskId: "t-1",
      context: { repoPath: repo, branch: "main", files: [], repository: "" },
    });
    const url = await d.openPullRequest(manifest, repo, { head: "smith/t-1", baseRev: "abc123" });
    assert.equal(url, "https://github.com/acme/web/pull/7");
    assert.ok(calls.every((c) => c.cwd === repo));
    assert.deepEqual(calls.find((c) => c.args[0] === "rev-list")?.args, ["rev-list", "--count", "abc123..smith/t-1"]);
    assert.ok(calls.find((c) => c.args[0] === "log")?.args.includes("abc123..smith/t-1"));
    assert.deepEqual(calls.find((c) => c.args.includes("push"))?.args, [
      "-c",
      "core.hooksPath=/dev/null",
      "push",
      "--no-verify",
      "origin",
      "smith/t-1",
    ]);
    for (const c of calls) {
      assert.ok(!c.args.some((a) => a === "HEAD" || a.endsWith("..HEAD")), `no HEAD in ${c.args.join(" ")}`);
    }
    const gh = calls.find((c) => c.cmd === "gh");
    assert.ok(gh?.args.join(" ").includes("--head smith/t-1"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("finalizeAndImport never throws: with docker gone, the clone is kept and the import reports false", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "disp-fin-")));
  const realError = console.error;
  try {
    const repo = makeGitRepo(join(root, "solo"));
    const d = new Dispatcher(
      loadConfig({ smithRoot: root, agentCommands: NO_SUCH_BINARY }),
    ) as unknown as CloneDispatcher;
    const clone = await createTaskClone(repo, taskClonePath(root, "t-fin"), "t-fin", "main");
    const manifest = makeManifest({
      taskId: "t-fin",
      context: { repoPath: repo, branch: "main", files: [], repository: "" },
    });
    const sentinel = join(root, "import-attempted");
    const logged: string[] = [];
    console.error = (...a: unknown[]) => {
      logged.push(a.map(String).join(" "));
    };
    const outcome = await d.finalizeAndImport(
      manifest,
      clone,
      {
        runOnce: async () => {
          throw new Error("Cannot connect to the Docker daemon");
        },
      },
      `touch ${sentinel}; false`,
      true,
    );
    console.error = realError;
    assert.equal(outcome.imported, false);
    assert.match(outcome.imported ? "" : outcome.error, /^git fetch failed: \S/, "the import's own error comes back");
    assert.ok(existsSync(sentinel), "the import was attempted despite the dead finalize");
    assert.ok(
      logged.some((l) =>
        l.includes(
          `import failed for t-fin; clone kept at ${clone.path} — do not run git in it on the host (a container wrote it):`,
        ),
      ),
      logged.join("\n"),
    );
    assert.ok(existsSync(clone.path));
  } finally {
    console.error = realError;
    rmSync(root, { recursive: true, force: true });
  }
});

async function importFixture(taskId: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "disp-imp-")));
  const repo = makeGitRepo(join(root, "solo"));
  const d = new Dispatcher(
    loadConfig({ smithRoot: root, agentCommands: NO_SUCH_BINARY }),
  ) as unknown as CloneDispatcher;
  const clone = await createTaskClone(repo, taskClonePath(root, taskId), taskId, "main");
  writeFileSync(join(clone.path, "work.txt"), "agent work\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: clone.path, encoding: "utf8" }).trim();
  git("add", "work.txt");
  git("-c", "user.name=a", "-c", "user.email=a@b", "commit", "-q", "-m", "agent commit");
  const manifest = makeManifest({
    taskId,
    context: { repoPath: repo, branch: "main", files: [], repository: "" },
  });
  return { root, repo, d, clone, manifest, tip: git("rev-parse", "HEAD") };
}

test("finalizeAndImport: a non-zero finalize exit is logged and the agent's commits still come home", async () => {
  const { root, repo, d, clone, manifest, tip } = await importFixture("t-nz");
  const realError = console.error;
  try {
    const logged: string[] = [];
    console.error = (...a: unknown[]) => {
      logged.push(a.map(String).join(" "));
    };
    const outcome = await d.finalizeAndImport(
      manifest,
      clone,
      { runOnce: async () => ({ exitCode: 1, output: "x" }) },
      "git-upload-pack",
      true,
    );
    console.error = realError;
    assert.deepEqual(outcome, { imported: true });
    assert.ok(logged.some((l) => l.includes("finalize exited 1")));
    assert.equal(execFileSync("git", ["rev-parse", "smith/t-nz"], { cwd: repo, encoding: "utf8" }).trim(), tip);
  } finally {
    console.error = realError;
    rmSync(root, { recursive: true, force: true });
  }
});

test("finalizeAndImport: a finalize that throws (marker deleted, timeout) still imports", async () => {
  const { root, repo, d, clone, manifest, tip } = await importFixture("t-th");
  const realError = console.error;
  try {
    const logged: string[] = [];
    console.error = (...a: unknown[]) => {
      logged.push(a.map(String).join(" "));
    };
    const outcome = await d.finalizeAndImport(
      manifest,
      clone,
      {
        runOnce: async () => {
          throw new Error("refusing to start a container on a non-clone");
        },
      },
      "git-upload-pack",
      true,
    );
    console.error = realError;
    assert.deepEqual(outcome, { imported: true });
    assert.ok(logged.some((l) => l.includes("finalize failed for t-th; importing anyway")));
    assert.equal(execFileSync("git", ["rev-parse", "smith/t-th"], { cwd: repo, encoding: "utf8" }).trim(), tip);
  } finally {
    console.error = realError;
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// dispatch() on docker, with no real docker: the security wiring itself.
// DockerRuntime's container methods are patched; a fake `docker` first on
// PATH logs its argv and serves the clone with the host's git-upload-pack
// (safe ONLY because no real container ever touched this clone); a `git`
// wrapper logs every host git process's cwd and argv.
// ---------------------------------------------------------------------------

const PR_URL = "https://github.com/acme/web/pull/1";

/** `${cwd}\n${args...}` per invocation of a logging wrapper. */
function readInvocations(log: string): { cwd: string; args: string[] }[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("--END--\n")
    .filter((r) => r.trim() !== "")
    .map((r) => {
      const [cwd = "", ...args] = r.replace(/\n$/, "").split("\n");
      return { cwd, args };
    });
}

async function dispatchOnFakeDocker(taskId: string, upload: "serve" | "hang", importTimeoutMs?: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "disp-wire-")));
  const repo = makeGitRepo(join(root, "repo"));
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", origin]);
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: repo });
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: repo });
  const clonePath = taskClonePath(join(root, "state"), taskId);
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

  const bin = join(root, "fake-bin");
  const dockerLog = join(root, "docker.log");
  const gitLog = join(root, "git.log");
  const pidFile = join(root, "upload.pid");
  execFileSync("mkdir", ["-p", bin]);
  const logArgv = (log: string) => `{ pwd -P; printf '%s\\n' "$@"; echo --END--; } >> '${log}'`;
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/bash\n${logArgv(dockerLog)}\n${upload === "serve" ? 'for last in "$@"; do :; done; exec git-upload-pack "$last"' : `echo $$ > '${pidFile}'; exec sleep 30`}\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "git"), `#!/bin/bash\n${logArgv(gitLog)}\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const delegate = join(root, "smith-delegate");
  writeFileSync(delegate, "#!/bin/sh\n", { mode: 0o755 });

  const proto = DockerRuntime.prototype as unknown as Record<string, unknown>;
  const patched = ["launch", "waitFor", "runOnce", "captureOutput", "killPattern", "removeContainer"] as const;
  const saved = Object.fromEntries(patched.map((m) => [m, proto[m]]));
  const savedPath = process.env.PATH;
  const runCalls: { cmd: string; args: string[]; cwd?: string }[] = [];
  const runOnceCalls: unknown[][] = [];
  const removed: string[] = [];
  let runCallsAtLaunch = -1;
  try {
    proto.launch = async (_name: string, _command: string, cwd: string) => {
      // The agent's work. Host git on the clone is safe ONLY because no real
      // container ever touched it; the wrapper is bypassed, so it is not logged.
      writeFileSync(join(cwd, "work.txt"), "agent work\n");
      execFileSync(realGit, ["add", "work.txt"], { cwd });
      execFileSync(realGit, ["-c", "user.name=a", "-c", "user.email=a@b", "commit", "-q", "-m", "feat: agent work"], {
        cwd,
      });
      writeFileSync(gitLog, "LAUNCHED\n--END--\n", { flag: "a" });
      runCallsAtLaunch = runCalls.length;
    };
    proto.waitFor = async () => 0;
    proto.runOnce = async (...args: unknown[]) => {
      runOnceCalls.push(args);
      return { exitCode: 0, output: "" };
    };
    proto.captureOutput = async () => "";
    proto.killPattern = async () => 0;
    proto.removeContainer = async (name: string) => {
      removed.push(name);
      // What `docker rm -f` does: the hung upload-pack stops.
      if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL");
    };
    process.env.PATH = `${bin}:${savedPath}`;

    const config = loadConfig({
      smithRoot: join(root, "state"),
      defaultRuntime: "docker",
      agentCommands: NO_SUCH_BINARY,
      delegateBin: delegate,
      docker: { image: "smith-agent:test", ...(importTimeoutMs ? { importTimeoutMs } : {}) },
    });
    const dispatcher = new Dispatcher(config);
    const d = dispatcher as unknown as CloneDispatcher;
    const realRun = d.run.bind(d);
    d.run = async (cmd, args, cwd) => {
      runCalls.push({ cmd, args, cwd });
      return cmd === "gh" ? PR_URL : realRun(cmd, args, cwd);
    };
    const result = await dispatcher.dispatch({
      taskId,
      agent: "claude",
      runtime: "docker",
      prompt: "do it",
      context: { files: [], repository: "", branch: "main", repoPath: repo },
      createdAt: new Date().toISOString(),
      priority: "normal",
    });
    const gitCalls = readInvocations(gitLog);
    const launchedAt = gitCalls.findIndex((c) => c.cwd === "LAUNCHED");
    return {
      root,
      repo,
      origin,
      clonePath,
      result,
      dockerCalls: readInvocations(dockerLog),
      gitAfterLaunch: launchedAt === -1 ? [] : gitCalls.slice(launchedAt + 1),
      runAfterLaunch: runCallsAtLaunch === -1 ? [] : runCalls.slice(runCallsAtLaunch),
      runOnceCalls,
      removed,
    };
  } finally {
    process.env.PATH = savedPath;
    for (const m of patched) proto[m] = saved[m];
  }
}

test("dispatch (docker wiring): the import runs the sandboxed upload-pack, no host git touches the clone after launch, and the branch comes home and is pushed", async () => {
  const taskId = "t-wire";
  const run = await dispatchOnFakeDocker(taskId, "serve");
  try {
    const { repo, origin, clonePath, result } = run;

    // The upload-pack really ran in a sandboxed container.
    assert.equal(run.dockerCalls.length, 1, "exactly one upload-pack container");
    const argv = run.dockerCalls[0].args;
    const after = (flag: string) => argv[argv.indexOf(flag) + 1];
    assert.equal(argv[0], "run");
    assert.equal(after("--network"), "none");
    assert.equal(after("--entrypoint"), "git-upload-pack");
    assert.match(after("--name") ?? "", /^smith-upload-[0-9a-f-]{36}$/);
    assert.equal(after("--memory"), "8g", "the configured limits reach the upload-pack container");
    assert.ok(argv.includes(`${clonePath}:${clonePath}:ro`), `clone mounted read-only; got ${argv.join(" ")}`);
    assert.equal(argv.at(-1), clonePath, "what it serves is the clone");

    // The finalize ran in a container, bounded by the default finalize timeout.
    assert.equal(run.runOnceCalls.length, 1);
    assert.equal(run.runOnceCalls[0][0], clonePath);
    assert.equal(run.runOnceCalls[0][3], 600_000);

    // THE RULE: after launch, every host git/gh call runs in the user's repo, never the clone.
    assert.ok(
      run.runAfterLaunch.some((c) => c.args.includes("push")),
      "openPullRequest's calls were recorded — or this proved nothing",
    );
    for (const c of run.runAfterLaunch) {
      assert.equal(c.cwd, repo, `${c.cmd} ${c.args.join(" ")} ran in ${c.cwd}`);
      assert.ok(!c.args.some((a) => a.includes(clonePath)), `${c.cmd} ${c.args.join(" ")} names the clone`);
    }
    assert.ok(
      run.gitAfterLaunch.some((c) => c.args.includes("fetch")),
      "the git wrapper saw the import's fetch — or this proved nothing",
    );
    for (const c of run.gitAfterLaunch) {
      assert.equal(c.cwd, repo, `git ${c.args.join(" ")} ran in ${c.cwd}`);
      for (const a of c.args.filter((x) => x.includes(clonePath))) {
        const isUploadPack = a.startsWith("--upload-pack=");
        const isFetchRemote = a === clonePath && c.args.includes("fetch");
        assert.ok(isUploadPack || isFetchRemote, `git ${c.args.join(" ")} names the clone outside the fetch`);
      }
    }

    // The work came home and went up.
    const clonedTip = execFileSync("git", ["rev-parse", `smith/${taskId}`], { cwd: clonePath, encoding: "utf8" });
    assert.equal(execFileSync("git", ["rev-parse", `smith/${taskId}`], { cwd: repo, encoding: "utf8" }), clonedTip);
    assert.equal(
      execFileSync("git", ["--git-dir", origin, "rev-parse", `smith/${taskId}`], { encoding: "utf8" }),
      clonedTip,
      "pushed to origin",
    );
    assert.equal(result.branch, `smith/${taskId}`);
    assert.equal(result.pullRequestUrl, PR_URL);
    assert.equal(result.importError, undefined);
    const gh = run.runAfterLaunch.find((c) => c.cmd === "gh");
    assert.ok(gh?.args.join(" ").includes(`--head smith/${taskId}`));
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("dispatch (docker wiring): a hung import times out, removes its named upload-pack container, and reports importError with no branch and no PR", async () => {
  const taskId = "t-wire-hang";
  const realError = console.error;
  console.error = () => {};
  let run: Awaited<ReturnType<typeof dispatchOnFakeDocker>> | undefined;
  try {
    const started = Date.now();
    run = await dispatchOnFakeDocker(taskId, "hang", 300);
    console.error = realError;
    assert.ok(Date.now() - started < 10_000);
    const argv = run.dockerCalls[0]?.args ?? [];
    assert.deepEqual(run.removed, [argv[argv.indexOf("--name") + 1]], "the container removed is the one started");
    assert.equal(run.result.outcome, "completed");
    assert.equal(run.result.importError, "import timed out after 300ms");
    assert.equal(run.result.branch, undefined);
    assert.equal(run.result.pullRequestUrl, undefined);
    assert.ok(!run.runAfterLaunch.some((c) => c.cmd === "gh"), "no PR for a branch that never came home");
    assert.throws(() =>
      execFileSync("git", ["rev-parse", "--verify", `refs/heads/smith/${taskId}`], { cwd: run?.repo, stdio: "ignore" }),
    );
  } finally {
    console.error = realError;
    if (run) rmSync(run.root, { recursive: true, force: true });
  }
});
