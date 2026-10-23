// Contract tests for the smith-agent image (docker/smith-agent/), driven through
// the REAL DockerRuntime — so drift between runtime.ts and the image fails here
// instead of failing a dispatched task.
//
// Opt-in, because they need Docker and a built image. `make agent-image` runs
// them against each freshly built candidate before tagging it :latest. By hand:
//   SMITH_AGENT_IMAGE=smith-agent:latest node --import tsx --test src/runtime.docker.test.ts
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { DockerRuntime } from "./runtime.js";

const execFileP = promisify(execFile);
const IMAGE = process.env.SMITH_AGENT_IMAGE;
const skip = IMAGE ? false : "set SMITH_AGENT_IMAGE=<image> to run the image contract tests (make agent-image does)";
const PREFIX = "smith-contract-";

async function run(cmd: string, ...args: string[]): Promise<string> {
  return (await execFileP(cmd, args)).stdout;
}

let savedCredentialDir: string | undefined;

before(async () => {
  if (!IMAGE) return;
  // Asked for explicitly, so a missing image is a failure, never a skip.
  await run("docker", "image", "inspect", IMAGE);
  // Never mount the real exported credential: nothing here needs auth.
  savedCredentialDir = process.env.SMITH_DOCKER_CLAUDE_DIR;
  process.env.SMITH_DOCKER_CLAUDE_DIR = join(tmpdir(), `${PREFIX}no-credential`);
});

after(async () => {
  if (!IMAGE) return;
  if (savedCredentialDir === undefined) delete process.env.SMITH_DOCKER_CLAUDE_DIR;
  else process.env.SMITH_DOCKER_CLAUDE_DIR = savedCredentialDir;
  // A timed-out test never reaches its own cleanup.
  await new DockerRuntime({ image: IMAGE }).killPattern(PREFIX);
});

/** One uniquely named container and a scratch dir per test, both always removed. */
async function withContainer(fn: (rt: DockerRuntime, name: string, dir: string) => Promise<void>): Promise<void> {
  const rt = new DockerRuntime({ image: IMAGE as string });
  const name = `${PREFIX}${randomUUID().slice(0, 8)}`;
  // realpath: macOS tmpdir() is a symlink, and git records the resolved path.
  const dir = await realpath(await mkdtemp(join(tmpdir(), PREFIX)));
  try {
    await fn(rt, name, dir);
  } finally {
    await rt.kill(name);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Poll the session output until it matches — the way a driver waits for a prompt. */
async function untilOutput(rt: DockerRuntime, name: string, pattern: RegExp): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (pattern.test(await rt.captureOutput(name))) return;
    await sleep(100);
  }
  assert.fail(`${name}: output never matched ${pattern}; got: ${await rt.captureOutput(name)}`);
}

test("image contract: the command's exit code is the container's, and its output reaches docker logs", { skip }, () =>
  withContainer(async (rt, name, dir) => {
    await rt.launch(name, "echo out-line; echo err-line >&2; exit 7", dir);
    assert.equal(await rt.waitFor(name), 7);
    const output = await rt.captureOutput(name);
    assert.match(output, /out-line/);
    // The pane is a terminal, so stderr is part of the session output — exactly
    // what TmuxRuntime's capture-pane returns on the host.
    assert.match(output, /err-line/);
  }),
);

test("image contract: the command reaches the pane verbatim — quotes, dollars and spaces survive", { skip }, () =>
  withContainer(async (rt, name, dir) => {
    await rt.launch(name, `printf '[%s]' "a b" 'c"d' '$HOME' "it's"`, dir);
    assert.equal(await rt.waitFor(name), 0);
    const output = await rt.captureOutput(name);
    assert.ok(output.includes(`[a b][c"d][$HOME][it's]`), `argv was re-parsed somewhere; got: ${output}`);
  }),
);

test("image contract: sendText types into the running program — the warm-session path", { skip }, () =>
  withContainer(async (rt, name, dir) => {
    await rt.launch(name, 'echo ready; read -r line; echo "got:$line"; exit 3', dir);
    await untilOutput(rt, name, /ready/);
    await rt.sendText(name, "hello world");
    assert.equal(await rt.waitFor(name), 3);
    assert.match(await rt.captureOutput(name), /got:hello world/);
  }),
);

test("image contract: killing session main stops the container", { skip }, () =>
  withContainer(async (rt, name, dir) => {
    await rt.launch(name, "echo started; sleep 300", dir);
    await untilOutput(rt, name, /started/);
    await run("docker", "exec", name, "tmux", "kill-session", "-t", "main");
    assert.equal(await rt.waitFor(name), 1);
  }),
);

test("image contract: launch env reaches the command, as uid 501 with /workspace/bin first on PATH", { skip }, () =>
  withContainer(async (rt, name, dir) => {
    await rt.launch(
      name,
      'echo "v=[$SMITH_IT] rt=[$SMITH_RUNTIME] uid=[$(id -u)] home=[$HOME] path0=[$(echo "$PATH" | cut -d: -f1)]"',
      dir,
      { SMITH_IT: "two words" },
    );
    assert.equal(await rt.waitFor(name), 0);
    assert.match(
      await rt.captureOutput(name),
      /v=\[two words\] rt=\[docker\] uid=\[501\] home=\[\/home\/agent\] path0=\[\/workspace\/bin\]/,
    );
  }),
);

test("image contract: an agent commits on its task branch from inside a worktree", { skip }, () =>
  withContainer(async (rt, name, dir) => {
    const repo = join(dir, "repo");
    const worktree = join(dir, "wt");
    await run("git", "init", "-q", "-b", "main", repo);
    await run(
      "git",
      "-C",
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    await run("git", "-C", repo, "worktree", "add", "-q", "-b", "smith/contract", worktree);

    // No identity is passed in: the image's own must be enough, or an agent
    // reaches for `git config`, which writes the host repo's mounted config.
    await rt.launch(name, 'echo work > f.txt && git add f.txt && git commit -q -m "agent work"', worktree);
    assert.equal(await rt.waitFor(name), 0, await rt.captureOutput(name));
    assert.equal(
      (await run("git", "-C", repo, "log", "-1", "--format=%an <%ae>|%s", "smith/contract")).trim(),
      "smith agent <crew@smithagents.local>|agent work",
    );
  }),
);

test("image contract: the agent CLI is installed and starts", { skip }, () =>
  withContainer(async (rt, name, dir) => {
    await rt.launch(name, "claude --version", dir);
    assert.equal(await rt.waitFor(name), 0);
    assert.match(await rt.captureOutput(name), /\d+\.\d+\.\d+ \(Claude Code\)/);
  }),
);
