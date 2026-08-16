import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkerPool } from "./remote-runtime.js";
import { createRuntime, DockerRuntime, TmuxRuntime } from "./runtime.js";

test("TmuxRuntime.launch: env vars are exported inside the wrapped command, not interpolated into it", async () => {
  const runtime = new TmuxRuntime();
  const sessionName = `test-env-${Date.now()}`;
  const dir = await mkdtemp(join(tmpdir(), "launch-env-"));
  const outFile = join(dir, "out.txt");
  try {
    await runtime.launch(sessionName, `echo "$SMITH_TEST_TOKEN" > ${outFile}`, dir, {
      SMITH_TEST_TOKEN: "super-secret",
    });
    await runtime.waitFor(sessionName);
    const content = await readFile(outFile, "utf8");
    assert.equal(content.trim(), "super-secret");
  } finally {
    await runtime.kill(sessionName).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * sendText must actually DELIVER. A test asserting the tmux argv passes happily
 * while the keystrokes never reach the program — which is exactly how bracketed
 * paste (`paste-buffer -p`) stayed broken against Claude Code v2.1.233: every
 * warm-session send was a silent 4-minute no-op. So this launches a real reader
 * and checks what it actually received.
 */
test("TmuxRuntime.sendText: the text reaches the program reading the pane, verbatim", async () => {
  const runtime = new TmuxRuntime();
  const sessionName = `test-sendtext-${Date.now()}`;
  const dir = await mkdtemp(join(tmpdir(), "sendtext-"));
  const outFile = join(dir, "got.txt");
  try {
    await runtime.launch(sessionName, `read -r line; printf '%s' "$line" > ${outFile}`, dir);
    // Let the shell reach `read` before typing at it.
    await new Promise((r) => setTimeout(r, 500));

    await runtime.sendText(sessionName, "hello-from-sendtext");
    await runtime.waitFor(sessionName);

    assert.equal(await readFile(outFile, "utf8"), "hello-from-sendtext");
  } finally {
    await runtime.kill(sessionName).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * The image's /entrypoint.sh already runs the command inside a tmux session
 * named "main". Wrapping it in a second `tmux new-session -d -s main` here
 * collides with that session and every docker task exits 1 in ~500ms — a
 * failure invisible to any test that stops at "launch resolved".
 */
test("DockerRuntime.launch: passes the command raw — the entrypoint owns the tmux wrapping", async () => {
  const runtime = new DockerRuntime({ image: "smith-agent:latest" });
  let captured: string[] = [];
  (runtime as unknown as { docker: (args: string[]) => Promise<unknown> }).docker = async (args) => {
    captured = args;
    return { stdout: "", stderr: "" };
  };

  await runtime.launch("task-abc", "claude --print 'hi there'", "/repo");

  assert.deepEqual(captured.slice(-3), ["/bin/bash", "-c", "claude --print 'hi there'"]);
  assert.ok(
    !captured.some((a) => a.includes("new-session")),
    `launch must not wrap in tmux itself; got: ${captured.join(" ")}`,
  );
});

test("createRuntime: remote without a WorkerPool throws; with one, returns the RemoteRuntime adapter", () => {
  assert.throws(() => createRuntime("remote"), /WorkerPool is required/);
  const adapter = createRuntime("remote", undefined, new WorkerPool());
  assert.equal(adapter.constructor.name, "RemoteRuntime");
});

test("createRuntime maps remote-tmux and remote-docker to kind-filtered RemoteRuntime", () => {
  const pool = new WorkerPool();
  assert.ok(createRuntime("remote-tmux", undefined, pool));
  assert.ok(createRuntime("remote-docker", undefined, pool));
  assert.throws(() => createRuntime("remote-tmux"), /WorkerPool is required/);
});

/**
 * A task worktree's `.git` is a FILE holding an absolute host path. Mounting
 * only the worktree leaves that pointer dangling inside the container, so
 * every git command fails with "not a git repository" and the agent cannot
 * commit — the work is built and then lost. The parent .git must be mounted
 * at its own host path so the pointer resolves.
 */
test("DockerRuntime.launch: mounts the parent .git so a worktree's gitdir pointer resolves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gitdir-mount-"));
  const repoGit = join(dir, "repo", ".git");
  const worktree = join(dir, "wt");
  await mkdir(join(repoGit, "worktrees", "task-1"), { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(join(worktree, ".git"), `gitdir: ${join(repoGit, "worktrees", "task-1")}\n`);

  const runtime = new DockerRuntime({ image: "smith-agent:real" });
  let captured: string[] = [];
  (runtime as unknown as { docker: (a: string[]) => Promise<unknown> }).docker = async (a) => {
    captured = a;
    return { stdout: "", stderr: "" };
  };

  try {
    await runtime.launch("task-1", "echo hi", worktree);
    // The parent .git is mounted at the SAME absolute path on both sides —
    // anything else leaves the gitdir pointer dangling.
    assert.ok(
      captured.includes(`${repoGit}:${repoGit}`),
      `expected a ${repoGit}:${repoGit} mount; got: ${captured.join(" ")}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * macOS keeps Claude credentials in the Keychain, which no container can read;
 * Linux keeps them in $HOME/.claude/.credentials.json. Exporting the Keychain's
 * claudeAiOauth object into that file is what carries a subscription across the
 * boundary. The mount must be the DIRECTORY and must be writable: the token
 * expires within hours and the CLI rewrites it in place, so a read-only file
 * mount passes today and fails overnight looking like a dead subscription.
 */
test("DockerRuntime.launch: mounts the exported credential dir read-write as the agent's ~/.claude", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cred-mount-"));
  const credDir = join(dir, "docker-auth");
  await mkdir(credDir, { recursive: true });
  await writeFile(join(credDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "x" } }));
  process.env.SMITH_DOCKER_CLAUDE_DIR = credDir;

  const runtime = new DockerRuntime({ image: "smith-agent:real" });
  let captured: string[] = [];
  (runtime as unknown as { docker: (a: string[]) => Promise<unknown> }).docker = async (a) => {
    captured = a;
    return { stdout: "", stderr: "" };
  };

  try {
    await runtime.launch("task-cred", "echo hi", dir);
    assert.ok(
      captured.includes(`${credDir}:/home/agent/.claude`),
      `expected a writable ${credDir}:/home/agent/.claude mount; got: ${captured.join(" ")}`,
    );
    assert.ok(
      !captured.some((a) => a === `${credDir}:/home/agent/.claude:ro`),
      "the credential mount must not be read-only — token refresh rewrites the file",
    );
  } finally {
    delete process.env.SMITH_DOCKER_CLAUDE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test("DockerRuntime.launch: no exported credential adds no mount (docker keeps working unauthenticated)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cred-absent-"));
  process.env.SMITH_DOCKER_CLAUDE_DIR = join(dir, "nope");

  const runtime = new DockerRuntime({ image: "smith-agent:real" });
  let captured: string[] = [];
  (runtime as unknown as { docker: (a: string[]) => Promise<unknown> }).docker = async (a) => {
    captured = a;
    return { stdout: "", stderr: "" };
  };

  try {
    await runtime.launch("task-nocred", "echo hi", dir);
    assert.ok(
      !captured.some((a) => a.includes("/home/agent/.claude")),
      `expected no credential mount; got: ${captured.join(" ")}`,
    );
  } finally {
    delete process.env.SMITH_DOCKER_CLAUDE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test("DockerRuntime.launch: a plain clone (no gitdir file) adds no extra mount", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plain-clone-"));
  await mkdir(join(dir, ".git"), { recursive: true }); // a directory, not a file
  // Pin the credential dir away from the real one: this asserts the mount list
  // EXACTLY, so a developer who has exported a credential would otherwise see
  // it fail for a reason that has nothing to do with gitdir handling.
  process.env.SMITH_DOCKER_CLAUDE_DIR = join(dir, "no-credential-here");

  const runtime = new DockerRuntime({ image: "smith-agent:real" });
  let captured: string[] = [];
  (runtime as unknown as { docker: (a: string[]) => Promise<unknown> }).docker = async (a) => {
    captured = a;
    return { stdout: "", stderr: "" };
  };

  try {
    await runtime.launch("task-2", "echo hi", dir);
    const mounts = captured.filter((a, i) => captured[i - 1] === "-v");
    assert.deepEqual(mounts, [`${dir}:/workspace`], "only the worktree mount should be present");
  } finally {
    delete process.env.SMITH_DOCKER_CLAUDE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});
