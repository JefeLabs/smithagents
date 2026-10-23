// End-to-end proof, through the REAL Dispatcher.dispatch(), that a docker task
// runs in a disposable clone, its leftovers are committed in a throwaway
// container, its branch comes home by sandboxed fetch, and nothing the agent
// planted in the clone ever runs on the host.
//
// Opt-in, because it needs Docker and a built image. By hand:
//   SMITH_AGENT_IMAGE=smith-agent:latest SMITH_STATE_ROOT=$(mktemp -d) \
//     node --import tsx --test --test-timeout 120000 src/dispatcher.docker.test.ts
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { Dispatcher, taskClonePath } from "./dispatcher.js";
import { DockerRuntime } from "./runtime.js";
import type { TaskManifest } from "./types.js";

const execFileP = promisify(execFile);
const IMAGE = process.env.SMITH_AGENT_IMAGE;
const skip = IMAGE ? false : "set SMITH_AGENT_IMAGE=<image> to run the dispatcher docker test";

// A binary guaranteed not to resolve on PATH (as in dispatcher.test.ts), so
// no real installed CLI is ever probed.
const NO_SUCH_BINARY: Record<TaskManifest["agent"], string> = {
  agy: "definitely-not-a-real-binary-xyz",
  claude: "definitely-not-a-real-binary-xyz",
  codex: "definitely-not-a-real-binary-xyz",
  opencode: "definitely-not-a-real-binary-xyz",
  copilot: "definitely-not-a-real-binary-xyz",
};

async function git(...args: string[]): Promise<string> {
  return (await execFileP("git", args)).stdout;
}

let savedCredentialDir: string | undefined;

before(async () => {
  if (!IMAGE) return;
  await execFileP("docker", ["image", "inspect", IMAGE]);
  // Never mount the real exported credential: nothing here needs auth.
  savedCredentialDir = process.env.SMITH_DOCKER_CLAUDE_DIR;
  process.env.SMITH_DOCKER_CLAUDE_DIR = join(tmpdir(), "smith-dispatch-docker-no-credential");
});

after(() => {
  if (!IMAGE) return;
  if (savedCredentialDir === undefined) delete process.env.SMITH_DOCKER_CLAUDE_DIR;
  else process.env.SMITH_DOCKER_CLAUDE_DIR = savedCredentialDir;
});

test("dispatch (docker): the agent's commit and its leftovers land on smith/<taskId> in the user's repo, and nothing it planted runs on the host", {
  skip,
}, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "smith-dispatch-docker-")));
  const taskId = "t-docker";
  try {
    const repo = join(dir, "repo");
    const smithRoot = join(dir, "state");
    const markers = join(dir, "markers");
    await mkdir(smithRoot);
    await git("init", "-q", "-b", "main", repo);
    await git("-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");

    // The fake agent: commit, leave a leftover, then arm every trap. The
    // traps write into a HOST path no container mounts.
    const hooks = ["pre-commit", "post-commit", "post-index-change", "reference-transaction", "post-checkout"];
    const agent = join(dir, "fake-agent.sh");
    await writeFile(
      agent,
      [
        "#!/bin/sh",
        "set -e",
        "echo work > work.txt",
        "git add work.txt",
        'git commit -q -m "feat: agent work"',
        "echo leftover > leftover.txt",
        `printf '#!/bin/sh\\nmkdir -p ${markers} && touch ${markers}/$(basename $0)\\nexit 0\\n' > .git/trap`,
        "chmod +x .git/trap",
        ...hooks.map((h) => `cp .git/trap .git/hooks/${h}`),
        // Relative, so it resolves in the container AND on the host.
        "cp .git/trap .git/fsmonitor-trap",
        "git config core.fsmonitor .git/fsmonitor-trap",
        // A filter driver: survives hooksPath=/dev/null and fsmonitor=false. The
        // trailing `cat` passes content through, so the finalize keeps it intact.
        "cp .git/trap .git/filter-trap",
        "echo '* filter=trap' >> .git/info/attributes",
        "git config filter.trap.clean '.git/filter-trap ; cat'",
        "",
      ].join("\n"),
    );
    await chmod(agent, 0o755);

    const config = loadConfig({
      smithRoot,
      defaultRuntime: "docker",
      delegateBin: agent,
      agentCommands: { ...NO_SUCH_BINARY, claude: "smith-delegate" },
      docker: { image: IMAGE as string },
    });
    const result = await new Dispatcher(config).dispatch({
      taskId,
      agent: "claude",
      runtime: "docker",
      prompt: "do it",
      context: { files: [], repository: "", branch: "main", repoPath: repo },
      createdAt: new Date().toISOString(),
      priority: "normal",
    });

    assert.equal(result.outcome, "completed", JSON.stringify(result));
    assert.deepEqual((await git("-C", repo, "log", "--format=%s", `main..smith/${taskId}`)).trim().split("\n"), [
      `task: claude — ${taskId}`,
      "feat: agent work",
    ]);
    assert.equal((await git("-C", repo, "show", `smith/${taskId}:leftover.txt`)).trim(), "leftover");

    const fired = await readdir(markers).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [] as string[];
      throw e;
    });
    assert.deepEqual(fired, [], `a planted trap ran on the host: ${fired.join(", ")}`);

    // POSITIVE CONTROL, last: plain host git in the same clone must fire a
    // trap, or the traps were never armed and the assertion above proved nothing.
    await execFileP("git", ["status"], { cwd: taskClonePath(smithRoot, taskId) }).catch(() => {});
    const control = await readdir(markers).catch(() => [] as string[]);
    console.log(`host control fired: ${control.join(", ")}`);
    assert.ok(control.length > 0, "control failed — this test proved nothing");
    // The traps hooksPath=/dev/null alone would not stop are armed too.
    assert.ok(
      control.includes("fsmonitor-trap") || control.includes("filter-trap"),
      `only hooks fired (${control.join(", ")}): the fsmonitor and filter traps were never armed`,
    );
  } finally {
    const rt = new DockerRuntime({ image: IMAGE as string });
    await rt.killPattern("sub-").catch(() => {});
    await rt.killPattern(`task-${taskId}`).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("dispatch (docker): a clone whose config wedges upload-pack times out — dispatch resolves with no branch, an importError, and no upload-pack container left", {
  skip,
  timeout: 180_000,
}, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "smith-dispatch-docker-")));
  const taskId = "t-docker-wedge";
  try {
    const repo = join(dir, "repo");
    const smithRoot = join(dir, "state");
    await mkdir(smithRoot);
    await git("init", "-q", "-b", "main", repo);
    await git("-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");

    // The fake agent's last act: point the clone's config at stdin. upload-pack,
    // run with -i, then reads its config from the protocol pipe while the host
    // fetch waits for its ref advertisement — a deadlock only a timeout breaks.
    const agent = join(dir, "fake-agent.sh");
    await writeFile(
      agent,
      [
        "#!/bin/sh",
        "set -e",
        "echo work > work.txt",
        "git add work.txt",
        'git commit -q -m "feat: agent work"',
        "ln -sf /dev/stdin .git/config",
        "",
      ].join("\n"),
    );
    await chmod(agent, 0o755);

    const config = loadConfig({
      smithRoot,
      defaultRuntime: "docker",
      delegateBin: agent,
      agentCommands: { ...NO_SUCH_BINARY, claude: "smith-delegate" },
      docker: { image: IMAGE as string, importTimeoutMs: 5000 },
    });
    const result = await new Dispatcher(config).dispatch({
      taskId,
      agent: "claude",
      runtime: "docker",
      prompt: "do it",
      context: { files: [], repository: "", branch: "main", repoPath: repo },
      createdAt: new Date().toISOString(),
      priority: "normal",
    });

    assert.equal(result.outcome, "completed", JSON.stringify(result));
    assert.equal(result.branch, undefined, "no branch is named that the user's repo does not have");
    assert.equal(result.importError, "import timed out after 5000ms", JSON.stringify(result));
    assert.equal(result.pullRequestUrl, undefined);
    await assert.rejects(git("-C", repo, "rev-parse", "--verify", `refs/heads/smith/${taskId}`));
    const left = (
      await execFileP("docker", ["ps", "-a", "--filter", "name=smith-upload-", "--format", "{{.Names}}"])
    ).stdout.trim();
    assert.equal(left, "", `upload-pack container(s) left behind: ${left}`);
  } finally {
    const rt = new DockerRuntime({ image: IMAGE as string });
    await rt.killPattern("sub-").catch(() => {});
    await rt.killPattern(`task-${taskId}`).catch(() => {});
    await rt.killPattern("smith-upload-").catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
