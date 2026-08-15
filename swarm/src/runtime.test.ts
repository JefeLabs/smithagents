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

test("DockerRuntime.launch: a plain clone (no gitdir file) adds no extra mount", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plain-clone-"));
  await mkdir(join(dir, ".git"), { recursive: true }); // a directory, not a file

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
    await rm(dir, { recursive: true, force: true });
  }
});
