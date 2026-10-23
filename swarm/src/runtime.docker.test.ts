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
import { chmod, copyFile, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DockerRuntime } from "./runtime.js";
import { createTaskClone, finalizeCommand, importTaskBranch, sandboxedUploadPack } from "./task-clone.js";

const execFileP = promisify(execFile);
const IMAGE = process.env.SMITH_AGENT_IMAGE;
const skip = IMAGE ? false : "set SMITH_AGENT_IMAGE=<image> to run the image contract tests (make agent-image does)";
const PREFIX = "smith-contract-";
const DELEGATE_BIN = fileURLToPath(new URL("../bin/smith-delegate", import.meta.url));

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

test("image contract: launch env reaches the command, running as uid 501", { skip }, () =>
  withContainer(async (rt, name, dir) => {
    await rt.launch(name, 'echo "v=[$SMITH_IT] rt=[$SMITH_RUNTIME] uid=[$(id -u)] home=[$HOME]"', dir, {
      SMITH_IT: "two words",
    });
    assert.equal(await rt.waitFor(name), 0);
    assert.match(await rt.captureOutput(name), /v=\[two words\] rt=\[docker\] uid=\[501\] home=\[\/home\/agent\]/);
  }),
);

test("image contract: a worktree's bin/ adds commands but cannot shadow the image's own", { skip }, () =>
  withContainer(async (rt, name, dir) => {
    // A repo can commit anything under bin/. Were it first on PATH, a planted
    // bin/tmux would hijack the entrypoint itself — before the agent has run
    // a single command, in a container holding the credential and host .git.
    await mkdir(join(dir, "bin"));
    for (const tool of ["tmux", "git"]) {
      await writeFile(join(dir, "bin", tool), "#!/bin/sh\necho HIJACKED\nexit 1\n", { mode: 0o755 });
    }
    await writeFile(join(dir, "bin", "smith-delegate"), "#!/bin/sh\necho delegate-found\n", { mode: 0o755 });

    await rt.launch(name, "git --version && smith-delegate", dir);
    const exitCode = await rt.waitFor(name);
    const output = await rt.captureOutput(name);
    assert.doesNotMatch(output, /HIJACKED/);
    assert.equal(exitCode, 0, output);
    assert.match(output, /git version/);
    assert.match(output, /delegate-found/, "the dispatcher's smith-delegate must still be found");
  }),
);

/** A repo with one empty commit on main. */
async function initRepo(repo: string): Promise<void> {
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
}

test("image contract: an agent commits inside its own clone and cannot write the user's objects", { skip }, () =>
  withContainer(async (rt, name, dir) => {
    const repo = join(dir, "repo");
    await initRepo(repo);
    const clone = await createTaskClone(repo, join(dir, "clone"), "contract", "main");

    // No identity is passed in: the image's own must be enough, or an agent
    // reaches for `git config`.
    await rt.launch(
      name,
      `echo work > f.txt && git add f.txt && git commit -q -m "agent work" && (touch ${clone.readOnlyMounts[0]}/probe 2>/dev/null && echo OBJECTS-WRITABLE || echo objects-readonly)`,
      clone.path,
      undefined,
      { readOnlyMounts: clone.readOnlyMounts },
    );
    const exitCode = await rt.waitFor(name);
    const output = await rt.captureOutput(name);
    assert.equal(exitCode, 0, output);
    assert.match(output, /objects-readonly/);
    assert.doesNotMatch(output, /OBJECTS-WRITABLE/);

    await importTaskBranch(clone, sandboxedUploadPack(IMAGE as string, clone, `${PREFIX}upload-${randomUUID()}`));
    assert.equal(
      (await run("git", "-C", repo, "log", "-1", "--format=%an <%ae>|%s", "smith/contract")).trim(),
      "smith agent <crew@smithagents.local>|agent work",
    );
  }),
);

test("image contract: nothing a container plants runs on the host — finalize and import stay sandboxed", { skip }, () =>
  withContainer(async (rt, name, dir) => {
    const repo = join(dir, "repo");
    await initRepo(repo);
    const clone = await createTaskClone(repo, join(dir, "clone"), "contract", "main");
    // A HOST path that no container mounts: only a trap running on the host can create it.
    const markers = join(dir, "markers");
    const hooks = ["pre-commit", "post-commit", "post-index-change", "reference-transaction", "post-checkout"];
    const plant = [
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
      "echo leftover > leftover.txt",
    ].join(" && ");

    await rt.launch(name, plant, clone.path, undefined, { readOnlyMounts: clone.readOnlyMounts });
    assert.equal(await rt.waitFor(name), 0, await rt.captureOutput(name));

    const finalized = await rt.runOnce(clone.path, finalizeCommand("contract", "t", true), clone.readOnlyMounts);
    assert.equal(finalized.exitCode, 0, finalized.output);
    await importTaskBranch(clone, sandboxedUploadPack(IMAGE as string, clone, `${PREFIX}upload-${randomUUID()}`));
    assert.equal((await run("git", "-C", repo, "show", "smith/contract:leftover.txt")).trim(), "leftover");

    const fired = await readdir(markers).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [] as string[];
      throw e;
    });
    assert.deepEqual(fired, [], `a planted trap ran on the host: ${fired.join(", ")}`);

    // POSITIVE CONTROL: plain host git in the same clone must fire a trap. If it
    // does not, the traps were never armed and the assertion above proved nothing.
    await execFileP("git", ["status"], { cwd: clone.path }).catch(() => {});
    const control = await readdir(markers).catch(() => [] as string[]);
    console.log(`host control fired: ${control.join(", ")}`);
    assert.ok(control.length > 0, "control failed — this test proved nothing");
    // The traps hooksPath=/dev/null alone would not stop are armed too.
    assert.ok(
      control.includes("fsmonitor-trap") || control.includes("filter-trap"),
      `only hooks fired (${control.join(", ")}): the fsmonitor and filter traps were never armed`,
    );
  }),
);

test("image contract: runOnce's timeout stops and removes the container", { skip }, () =>
  withContainer(async (rt, _name, dir) => {
    const started = Date.now();
    let message = "";
    await assert.rejects(rt.runOnce(dir, "sleep 30", [], 2000), (e: Error) => {
      message = e.message;
      return /timed out after 2000ms/.test(e.message);
    });
    const elapsed = Date.now() - started;
    console.log(`runOnce timeout measured ${elapsed}ms`);
    assert.ok(elapsed < 10_000, `took ${elapsed}ms`);
    const name = /container (smith-once-[0-9a-f-]+)/.exec(message)?.[1];
    assert.ok(name, `no container name in: ${message}`);
    assert.equal((await run("docker", "ps", "-a", "--filter", `name=${name}`, "--format", "{{.Names}}")).trim(), "");
  }),
);

test("image contract: the agent CLI is installed and starts", { skip }, () =>
  withContainer(async (rt, name, dir) => {
    await rt.launch(name, "claude --version", dir);
    assert.equal(await rt.waitFor(name), 0);
    assert.match(await rt.captureOutput(name), /\d+\.\d+\.\d+ \(Claude Code\)/);
  }),
);

test("image contract: smith-delegate reaches the swarm on the host, aimed at the parent's repo", { skip }, () =>
  withContainer(async (rt, name, dir) => {
    // A stand-in swarm bound to LOOPBACK ONLY, so this proves the container
    // gets through (carrying its own delegation token) without the swarm being
    // exposed any wider.
    const received: { url?: string; authorization?: string; body: string }[] = [];
    const swarm = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        received.push({ url: req.url, authorization: req.headers.authorization, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"taskId":"sub-1"}');
      });
    });
    await new Promise<void>((resolve) => swarm.listen(0, "127.0.0.1", resolve));
    const { port } = swarm.address() as AddressInfo;
    try {
      // Where the dispatcher puts it: the worktree's bin/, i.e. /workspace/bin.
      await mkdir(join(dir, "bin"));
      await copyFile(DELEGATE_BIN, join(dir, "bin", "smith-delegate"));
      await chmod(join(dir, "bin", "smith-delegate"), 0o755);

      // The env exactly as the dispatcher hands it over: the LOOPBACK url.
      await rt.launch(name, 'smith-delegate claude "write the sub-task"', dir, {
        SMITH_URL: `http://127.0.0.1:${port}`,
        SMITH_WORKSPACE: "acme",
        SMITH_REPO: "web",
        SMITH_BRANCH: "main",
        SMITH_DELEGATE_TOKEN: "sdt1.contract",
      });
      assert.equal(await rt.waitFor(name), 0, await rt.captureOutput(name));
      assert.equal(received.length, 1, "the delegation never reached the swarm");
      assert.equal(received[0].url, "/tasks");
      assert.equal(received[0].authorization, "Bearer sdt1.contract");
      const body = JSON.parse(received[0].body);
      assert.equal(body.prompt, "write the sub-task");
      assert.deepEqual(body.context, { files: [], repository: "", branch: "main", workspace: "acme", repo: "web" });
    } finally {
      swarm.close();
    }
  }),
);
