import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkerPool } from "./remote-runtime.js";
import { containerReachableUrl, createRuntime, DockerRuntime, exposedSecrets, TmuxRuntime } from "./runtime.js";
import { secretPaths } from "./secret-file.js";

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

  const dir = await mkdtemp(join(tmpdir(), "launch-raw-"));
  await runtime.launch("task-abc", "claude --print 'hi there'", dir);
  await rm(dir, { recursive: true, force: true });

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
 * A worktree's `.git` is a FILE pointing at the user's real repository.
 * Mounting that repo's .git read-write (the old behaviour) let a container plant
 * hooks/fsmonitor that later ran on the host. The runtime now refuses outright.
 */
test("DockerRuntime.launch: refuses a git worktree — its .git would hand the container the host repository", async () => {
  const dir = await mkdtemp(join(tmpdir(), "refuse-wt-"));
  await writeFile(join(dir, ".git"), "gitdir: /x/.git/worktrees/t\n");
  const runtime = new DockerRuntime({ image: "smith-agent:real" });
  let called = false;
  (runtime as unknown as { docker: (a: string[]) => Promise<unknown> }).docker = async () => {
    called = true;
    return { stdout: "", stderr: "" };
  };
  try {
    await assert.rejects(runtime.launch("task-wt", "echo hi", dir), /it is a git worktree/);
    await assert.rejects(runtime.runOnce(dir, "true", []), /it is a git worktree/);
    assert.equal(called, false, "docker must never be called for a worktree");
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

test("DockerRuntime.launch: a clone mounts only itself and the read-only object stores it is given", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plain-clone-"));
  await mkdir(join(dir, ".git"), { recursive: true }); // a directory, not a file
  await writeFile(join(dir, ".git", "smith-task-clone"), "");
  // Pin the credential dir away from the real one: this asserts the mount list
  // EXACTLY, so a developer who has exported a credential would otherwise see
  // it fail for a reason that has nothing to do with the object stores.
  process.env.SMITH_DOCKER_CLAUDE_DIR = join(dir, "no-credential-here");

  const runtime = new DockerRuntime({ image: "smith-agent:real" });
  let captured: string[] = [];
  (runtime as unknown as { docker: (a: string[]) => Promise<unknown> }).docker = async (a) => {
    captured = a;
    return { stdout: "", stderr: "" };
  };

  try {
    await runtime.launch("task-2", "true", dir, undefined, { readOnlyMounts: ["/o1", "/o2"] });
    const mounts = captured.filter((_a, i) => captured[i - 1] === "-v");
    assert.deepEqual(mounts, [`${dir}:/workspace`, "/o1:/o1:ro", "/o2:/o2:ro"]);
  } finally {
    delete process.env.SMITH_DOCKER_CLAUDE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test("DockerRuntime guard: refuses a .git symlink and a non-clone repo; allows a marked clone and a non-git dir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "guard-"));
  const runtime = new DockerRuntime({ image: "smith-agent:real" });
  let calls = 0;
  (runtime as unknown as { docker: (a: string[]) => Promise<unknown> }).docker = async () => {
    calls++;
    return { stdout: "", stderr: "" };
  };
  try {
    const link = join(dir, "link");
    await mkdir(link);
    await symlink("/somewhere", join(link, ".git"));
    const plain = join(dir, "plain");
    await mkdir(join(plain, ".git"), { recursive: true });
    for (const cwd of [link, plain]) {
      await assert.rejects(runtime.launch("g", "true", cwd), /refusing to start a container/);
      await assert.rejects(runtime.runOnce(cwd, "true", []), /refusing to start a container/);
    }
    await assert.rejects(runtime.runOnce(plain, "true", []), /not a smith task clone/);
    assert.equal(calls, 0, "docker never called for a refused cwd");

    const marked = join(dir, "marked");
    await mkdir(join(marked, ".git"), { recursive: true });
    await writeFile(join(marked, ".git", "smith-task-clone"), "");
    const nogit = join(dir, "nogit");
    await mkdir(nogit);
    for (const cwd of [marked, nogit]) {
      await runtime.launch("g", "true", cwd);
      await runtime.runOnce(cwd, "true", []);
    }
    assert.equal(calls, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("DockerRuntime guard: a cwd that does not exist, or is not a directory, is refused before docker runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "guard-cwd-"));
  const runtime = new DockerRuntime({ image: "smith-agent:real" });
  let calls = 0;
  (runtime as unknown as { docker: (a: string[]) => Promise<unknown> }).docker = async () => {
    calls++;
    return { stdout: "", stderr: "" };
  };
  try {
    const missing = join(dir, "nope");
    const file = join(dir, "file");
    await writeFile(file, "");
    for (const [cwd, why] of [
      [missing, "it does not exist"],
      [file, "it is not a directory"],
    ]) {
      const expected = (e: Error) => e.message === `refusing to start a container in ${cwd}: ${why}`;
      await assert.rejects(runtime.launch("g", "true", cwd), expected);
      await assert.rejects(runtime.runOnce(cwd, "true", []), expected);
    }
    assert.equal(calls, 0, "docker never called for a refused cwd");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("DockerRuntime.runOnce: a throwaway, offline container with no credentials and no env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "run-once-"));
  const credDir = join(dir, "docker-auth");
  await mkdir(credDir, { recursive: true });
  await writeFile(join(credDir, ".credentials.json"), "{}");
  process.env.SMITH_DOCKER_CLAUDE_DIR = credDir;

  const runtime = new DockerRuntime({ image: "smith-agent:real", extraEnv: { SECRET: "x" }, extraMounts: ["/a:/a"] });
  let captured: string[] = [];
  (runtime as unknown as { docker: (a: string[]) => Promise<unknown> }).docker = async (a) => {
    captured = a;
    return { stdout: "fine", stderr: "" };
  };

  try {
    const result = await runtime.runOnce(dir, "git status", ["/o"]);
    assert.deepEqual(result, { exitCode: 0, output: "fine" });
    assert.ok(captured.includes("--rm"));
    assert.ok(captured.includes("--init"), "bash is PID 1 without tini; --init lets signals through");
    assert.match(captured[captured.indexOf("--name") + 1] ?? "", /^smith-once-[0-9a-f-]{36}$/);
    const at = (flag: string) => captured.indexOf(flag);
    assert.deepEqual(captured.slice(at("--network"), at("--network") + 2), ["--network", "none"]);
    assert.deepEqual(captured.slice(at("--entrypoint"), at("--entrypoint") + 2), ["--entrypoint", "/bin/bash"]);
    const mounts = captured.filter((_a, i) => captured[i - 1] === "-v");
    assert.deepEqual(mounts, [`${dir}:/workspace`, "/o:/o:ro"]);
    assert.ok(!captured.includes("-e"), `no env may reach a one-shot container; got: ${captured.join(" ")}`);
    assert.ok(!captured.some((a) => a.includes("/home/agent/.claude")), "no credential mount");
    assert.deepEqual(captured.slice(-3), ["smith-agent:real", "-c", "git status"]);
  } finally {
    delete process.env.SMITH_DOCKER_CLAUDE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test("DockerRuntime.runOnce: on timeout it removes the container by name and rejects", async () => {
  const runtime = new DockerRuntime({ image: "smith-agent:real" });
  const calls: string[][] = [];
  (runtime as unknown as { docker: (a: string[]) => Promise<unknown> }).docker = (a) => {
    calls.push(a);
    return a[0] === "run" ? new Promise(() => {}) : Promise.resolve({ stdout: "", stderr: "" });
  };
  const dir = await mkdtemp(join(tmpdir(), "run-once-timeout-"));
  try {
    await assert.rejects(runtime.runOnce(dir, "sleep 99", [], 50), /runOnce timed out after 50ms/);
    const name = calls[0][calls[0].indexOf("--name") + 1];
    assert.deepEqual(calls[1], ["rm", "-f", name]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("DockerRuntime.runOnce: a failed removal is surfaced in the timeout error, not swallowed", async () => {
  const runtime = new DockerRuntime({ image: "smith-agent:real" });
  (runtime as unknown as { docker: (a: string[]) => Promise<unknown> }).docker = (a) =>
    a[0] === "run" ? new Promise(() => {}) : Promise.reject(new Error("No such container"));
  const dir = await mkdtemp(join(tmpdir(), "run-once-rmfail-"));
  try {
    await assert.rejects(
      runtime.runOnce(dir, "sleep 99", [], 50),
      /timed out after 50ms.*removing it failed: No such container/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const rmFails of [false, true]) {
  test(`DockerRuntime.runOnce: a run that dies while its timed-out container is being removed still reports the timeout${rmFails ? " (rm fails too)" : ""}`, async () => {
    const runtime = new DockerRuntime({ image: "smith-agent:real" });
    (runtime as unknown as { docker: (a: string[]) => Promise<unknown> }).docker = (a) => {
      if (a[0] === "run") {
        // dies a tick after the timer fires, before rm settles
        return new Promise((_, reject) =>
          setTimeout(() => reject(Object.assign(new Error("killed"), { code: 137, stdout: "", stderr: "" })), 40),
        );
      }
      return new Promise((resolve, reject) =>
        setTimeout(() => (rmFails ? reject(new Error("daemon hiccup")) : resolve({ stdout: "", stderr: "" })), 120),
      );
    };
    const dir = await mkdtemp(join(tmpdir(), "run-once-race-"));
    try {
      await assert.rejects(runtime.runOnce(dir, "sleep 99", [], 20), (e: Error) => {
        assert.match(e.message, /timed out after \d+ms \(container smith-once-/);
        if (rmFails) assert.match(e.message, /removing it failed: daemon hiccup/);
        return true;
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("DockerRuntime.removeContainer: a failed rm counts only once the container is verifiably gone", async () => {
  const stub = (rm: () => Promise<unknown>, ps: () => Promise<unknown>) => {
    const runtime = new DockerRuntime({ image: "smith-agent:real" });
    const calls: string[][] = [];
    (runtime as unknown as { docker: (a: string[]) => Promise<unknown> }).docker = (a) => {
      calls.push(a);
      return a[0] === "rm" ? rm() : ps();
    };
    return { runtime, calls };
  };
  const inProgress = () => Promise.reject(new Error("removal of container x is already in progress"));

  // Its own --rm got there first: gone, so removed.
  const raced = stub(inProgress, async () => ({ stdout: "\n", stderr: "" }));
  await raced.runtime.removeContainer("smith-upload-1", 200);
  assert.deepEqual(raced.calls, [
    ["rm", "-f", "smith-upload-1"],
    ["ps", "-a", "-q", "--filter", "name=^smith-upload-1$"],
  ]);

  // Still there after the grace: the rm failure stands.
  const stuck = stub(inProgress, async () => ({ stdout: "abc123\n", stderr: "" }));
  await assert.rejects(stuck.runtime.removeContainer("smith-upload-2", 200), /already in progress/);
  assert.ok(stuck.calls.filter((c) => c[0] === "ps").length >= 2, "it looked more than once");

  // Cannot even look: the rm failure stands, at once.
  const blind = stub(
    () => Promise.reject(new Error("Cannot connect to the Docker daemon")),
    () => Promise.reject(new Error("still cannot connect")),
  );
  await assert.rejects(blind.runtime.removeContainer("smith-upload-3", 60_000), /Cannot connect to the Docker daemon/);
});

test("DockerRuntime.runOnce: rejects a nonsense timeout before touching docker", async () => {
  const runtime = new DockerRuntime({ image: "smith-agent:real" });
  let called = false;
  (runtime as unknown as { docker: (a: string[]) => Promise<unknown> }).docker = async () => {
    called = true;
    return { stdout: "", stderr: "" };
  };
  const dir = await mkdtemp(join(tmpdir(), "run-once-badtimeout-"));
  try {
    for (const bad of [0, -1, Number.NaN, 2 ** 31]) {
      await assert.rejects(
        runtime.runOnce(dir, "true", [], bad),
        new RegExp(`timeoutMs must be a positive number of milliseconds up to 2147483647, got ${bad}`),
      );
    }
    assert.equal(called, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("DockerRuntime.runOnce: reports a non-zero exit instead of throwing", async () => {
  const runtime = new DockerRuntime({ image: "smith-agent:real" });
  (runtime as unknown as { docker: (a: string[]) => Promise<unknown> }).docker = async () => {
    throw Object.assign(new Error("exit 3"), { code: 3, stdout: "a", stderr: "b" });
  };
  const dir = await mkdtemp(join(tmpdir(), "run-once-fail-"));
  try {
    assert.deepEqual(await runtime.runOnce(dir, "false", []), { exitCode: 3, output: "ab" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * smith-delegate inside a container calls the swarm back at SMITH_URL. The
 * dispatcher hands every session the swarm's LOOPBACK url — correct on the
 * host, but inside a container 127.0.0.1 is the container itself, so every
 * docker delegation went nowhere.
 */
test("DockerRuntime.launch: a loopback SMITH_URL is rewritten to reach the host, and the host name is mapped", async () => {
  const runtime = new DockerRuntime({ image: "smith-agent:latest" });
  let captured: string[] = [];
  (runtime as unknown as { docker: (args: string[]) => Promise<unknown> }).docker = async (args) => {
    captured = args;
    return { stdout: "", stderr: "" };
  };

  const dir = await mkdtemp(join(tmpdir(), "launch-url-"));
  await runtime.launch("task-url", "true", dir, { SMITH_URL: "http://127.0.0.1:7777", SMITH_REPO: "web" });
  await rm(dir, { recursive: true, force: true });

  assert.ok(captured.includes("SMITH_URL=http://host.docker.internal:7777"), `got: ${captured.join(" ")}`);
  assert.ok(captured.includes("SMITH_REPO=web"), "other env passes through untouched");
  const at = captured.indexOf("--add-host");
  assert.equal(captured[at + 1], "host.docker.internal:host-gateway", "Linux engines don't define the name");
});

test("containerReachableUrl: only loopback hosts change; ports and paths survive, no slash is added", () => {
  assert.equal(containerReachableUrl("http://127.0.0.1:7777"), "http://host.docker.internal:7777");
  assert.equal(containerReachableUrl("http://localhost:7777/api"), "http://host.docker.internal:7777/api");
  assert.equal(containerReachableUrl("http://[::1]:7777"), "http://host.docker.internal:7777");
  assert.equal(containerReachableUrl("http://10.0.0.5:7777"), "http://10.0.0.5:7777");
  assert.equal(containerReachableUrl("not a url"), "not a url");
});

test("exposedSecrets: a mount of a secret's directory or any ancestor exposes it; a sibling does not", () => {
  const secrets = secretPaths("/h");
  assert.deepEqual(exposedSecrets(["/h/.smith/docker-auth", "/h/.smithx", "/w/repo/.git"], secrets), []);
  assert.equal(exposedSecrets(["/h/.smith"], secrets).length, 3);
  assert.equal(exposedSecrets(["/h"], secrets).length, 3);
});

test("DockerRuntime.launch: refuses a mount that would expose ~/.smith, before docker runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "secret-mount-"));
  process.env.SMITH_DOCKER_CLAUDE_DIR = join(dir, "no-credential-here");
  const runtime = new DockerRuntime({ image: "smith-agent:real", extraMounts: [`${homedir()}/.smith:/x`] });
  let calls = 0;
  (runtime as unknown as { docker: (a: string[]) => Promise<unknown> }).docker = async () => {
    calls++;
    return { stdout: "", stderr: "" };
  };
  try {
    await assert.rejects(runtime.launch("task-s", "true", dir), /refusing to start container: mount .* would expose/);
    assert.equal(calls, 0);
  } finally {
    delete process.env.SMITH_DOCKER_CLAUDE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test("DockerRuntime.runOnce: refuses a read-only mount that would expose ~/.smith, before docker runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "secret-once-"));
  const runtime = new DockerRuntime({ image: "smith-agent:real" });
  let calls = 0;
  (runtime as unknown as { docker: (a: string[]) => Promise<unknown> }).docker = async () => {
    calls++;
    return { stdout: "", stderr: "" };
  };
  try {
    await assert.rejects(
      runtime.runOnce(dir, "true", [join(homedir(), ".smith")]),
      /refusing to start container: mount .* would expose/,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Runs `fn` with HOME pointed at `<scratch>/home`, so the mount guard's secret
 * paths (secretPaths() reads homedir() on every call) live in a throwaway dir,
 * never the real ~/.smith. `work` is an empty, mountable cwd; docker is faked
 * and every call is recorded.
 */
async function withFakeHome(
  fn: (ctx: {
    scratch: string;
    home: string;
    work: string;
    calls: string[][];
    runtime: (extraMounts?: string[]) => DockerRuntime;
  }) => Promise<void>,
): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "mount-realpath-"));
  const home = join(scratch, "home");
  const work = join(scratch, "work");
  await mkdir(home);
  await mkdir(work);
  const saved = { HOME: process.env.HOME, SMITH_DOCKER_CLAUDE_DIR: process.env.SMITH_DOCKER_CLAUDE_DIR };
  process.env.HOME = home;
  process.env.SMITH_DOCKER_CLAUDE_DIR = join(scratch, "no-credential-here");
  const calls: string[][] = [];
  const runtime = (extraMounts?: string[]) => {
    const r = new DockerRuntime({ image: "smith-agent:real", extraMounts });
    (r as unknown as { docker: (a: string[]) => Promise<unknown> }).docker = async (a) => {
      calls.push(a);
      return { stdout: "0\n", stderr: "" };
    };
    return r;
  };
  try {
    assert.equal(homedir(), home, "HOME override must reach os.homedir(), or this test guards the real ~/.smith");
    await fn({ scratch, home, work, calls, runtime });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

test("DockerRuntime.launch: a symlink to ~/.smith or to an ancestor of it is refused; a symlink elsewhere still launches", async () => {
  await withFakeHome(async ({ scratch, home, work, calls, runtime }) => {
    await mkdir(join(home, ".smith"));
    await mkdir(join(scratch, "elsewhere"));
    await symlink(join(home, ".smith"), join(scratch, "to-smith"));
    await symlink(home, join(scratch, "to-home"));
    await symlink(join(scratch, "elsewhere"), join(scratch, "to-elsewhere"));

    for (const link of ["to-smith", "to-home"]) {
      await assert.rejects(
        runtime([`${join(scratch, link)}:/x`]).launch("task-l", "true", work),
        /refusing to start container: mount .* would expose/,
        link,
      );
    }
    assert.equal(calls.length, 0);

    // Positive control: resolving links must not refuse every symlinked mount.
    await runtime([`${join(scratch, "to-elsewhere")}:/x`]).launch("task-ok", "true", work);
    assert.equal(calls.length, 1);
  });
});

test("DockerRuntime.launch: when ~/.smith is itself a symlink, mounting its target is refused; its credential dir still mounts", async () => {
  await withFakeHome(async ({ scratch, home, work, calls, runtime }) => {
    await mkdir(join(scratch, "real-smith", "docker-auth"), { recursive: true });
    await symlink(join(scratch, "real-smith"), join(home, ".smith"));
    await assert.rejects(
      runtime([`${join(scratch, "real-smith")}:/x`]).launch("task-t", "true", work),
      /refusing to start container: mount .* would expose/,
    );
    assert.equal(calls.length, 0);

    // Positive control: the default credential mount, ~/.smith/docker-auth, is
    // a sibling of the secrets and must still launch once links are resolved.
    delete process.env.SMITH_DOCKER_CLAUDE_DIR;
    await writeFile(join(scratch, "real-smith", "docker-auth", ".credentials.json"), "{}");
    await runtime().launch("task-c", "true", work);
    assert.equal(calls.length, 1);
    assert.ok(
      calls[0]?.includes(`${join(home, ".smith", "docker-auth")}:/home/agent/.claude`),
      "credential dir mounted",
    );
  });
});

test("DockerRuntime.launch: on a case-insensitive disk, any spelling the disk folds to a missing ~/.smith is refused", async (t) => {
  await withFakeHome(async ({ home, work, calls, runtime }) => {
    // The swarm would later create ~/.smith, which IS ~/.Smith on such a disk.
    // APFS also folds U+017F (long s) to "s", which JS toLowerCase() does not.
    await mkdir(join(home, "sprobe"));
    const sameDir = (name: string) =>
      stat(join(home, name)).then(
        () => true,
        () => false,
      );
    if (!(await sameDir("SPROBE"))) return t.skip("this disk is case-sensitive: ~/.Smith is a different directory");
    const variants = [".Smith", ...((await sameDir("ſprobe")) ? [".ſmith"] : [])];
    assert.ok(process.platform !== "darwin" || variants.length === 2, "APFS folds the long s; the probe must see it");
    for (const name of variants) {
      await assert.rejects(
        runtime([`${join(home, name)}:/x`]).launch("task-case", "true", work),
        /refusing to start container: mount .* would expose/,
        name,
      );
    }
    assert.equal(calls.length, 0);
    // The guard creates ~/.smith itself (so realpath can name it), private like boot does.
    assert.equal((await stat(join(home, ".smith"))).mode & 0o777, 0o700);
  });
});

test("DockerRuntime.launch: a missing mount source is resolved through its existing symlinked parent", async () => {
  await withFakeHome(async ({ scratch, home, work, calls, runtime }) => {
    // The token does not exist yet; docker would create it (as a directory the
    // container owns) through the link, where the swarm later expects its token.
    await mkdir(join(home, ".smith"));
    await symlink(home, join(scratch, "to-home"));
    for (const source of [join(scratch, "to-home", ".smith"), join(scratch, "to-home", ".smith", "api-token")]) {
      await assert.rejects(
        runtime([`${source}:/x`]).launch("task-m", "true", work),
        /refusing to start container: mount .* would expose/,
        source,
      );
    }
    assert.equal(calls.length, 0);
  });
});

test("DockerRuntime.launch: a missing mount source inside ~/.smith is refused; an existing one still mounts", async () => {
  await withFakeHome(async ({ home, work, calls, runtime }) => {
    // No token exists yet. Docker would create the source as a container-owned
    // directory, and API-TOKEN is api-token on a case-insensitive disk.
    await mkdir(join(home, ".smith", "docker-auth"), { recursive: true });
    for (const name of ["API-TOKEN", "new-dir", join("new-dir", "deeper")]) {
      await assert.rejects(
        runtime([`${join(home, ".smith", name)}:/x`]).launch("task-n", "true", work),
        /refusing to start container: mount .* does not exist, and docker would create it inside .*\.smith/,
        name,
      );
    }
    assert.equal(calls.length, 0);

    // Positive control: an existing non-secret dir in ~/.smith (the credential dir) mounts.
    await runtime([`${join(home, ".smith", "docker-auth")}:/x`]).launch("task-e", "true", work);
    assert.equal(calls.length, 1);
  });
});

test("DockerRuntime.launch: a dangling symlink mount source is refused", async () => {
  await withFakeHome(async ({ scratch, work, calls, runtime }) => {
    await symlink(join(scratch, "nowhere"), join(scratch, "dangling"));
    await assert.rejects(
      runtime([`${join(scratch, "dangling")}:/x`]).launch("task-d", "true", work),
      /refusing to start container: cannot resolve mount .*dangling/,
    );
    assert.equal(calls.length, 0);
  });
});

test("DockerRuntime.runOnce: a read-only mount that is a symlink to ~/.smith is refused before docker runs", async () => {
  await withFakeHome(async ({ scratch, home, work, calls, runtime }) => {
    await mkdir(join(home, ".smith"));
    await symlink(join(home, ".smith"), join(scratch, "to-smith"));
    await assert.rejects(
      runtime().runOnce(work, "true", [join(scratch, "to-smith")]),
      /refusing to start container: mount .* would expose/,
    );
    assert.equal(calls.length, 0);
  });
});

test("DockerRuntime.launch: ~/.smith under a name realpath keeps (a macOS firmlink) is refused; a sibling still mounts", async (t) => {
  await withFakeHome(async ({ scratch, home, work, calls, runtime }) => {
    await mkdir(join(home, ".smith"));
    await writeFile(join(home, ".smith", "api-token"), "fake\n");
    await mkdir(join(scratch, "elsewhere"));
    // /System/Volumes/Data/<path> is <path> on disk: a firmlink, not a symlink.
    const realScratch = await realpath(scratch);
    const alias = (p: string) => join("/System/Volumes/Data", realScratch, p);
    const id = (p: string) =>
      stat(p, { bigint: true }).then(
        (s) => `${s.dev}:${s.ino}`,
        () => "missing",
      );
    if ((await id(alias("home"))) !== (await id(home)))
      return t.skip("no /System/Volumes/Data firmlink on this system");
    assert.equal(await realpath(alias("home")), alias("home"), "realpath keeps the alias, so only identity can see it");

    for (const source of [
      alias("home/.smith"),
      alias("home/.smith/api-token"),
      alias("home"),
      alias(""),
      "/System/Volumes/Data",
    ]) {
      await assert.rejects(
        runtime([`${source}:/x`]).launch("task-f", "true", work),
        /refusing to start container: mount .* would expose/,
        source,
      );
    }
    // Missing under the alias: docker would create it inside ~/.smith.
    await assert.rejects(
      runtime([`${alias("home/.smith/new-dir")}:/x`]).launch("task-f", "true", work),
      /refusing to start container: mount .* does not exist, and docker would create it inside/,
    );
    assert.equal(calls.length, 0);

    // Positive control: the alias of a dir that does not hold ~/.smith mounts.
    await runtime([`${alias("elsewhere")}:/x`]).launch("task-ok", "true", work);
    assert.equal(calls.length, 1);
  });
});

test("DockerRuntime.launch: a secret with a second hard link refuses every launch, wherever the link is", async () => {
  await withFakeHome(async ({ scratch, home, work, calls, runtime }) => {
    await mkdir(join(home, ".smith"));
    await writeFile(join(home, ".smith", "master.key"), "fake\n");
    await mkdir(join(scratch, "elsewhere"));
    // Positive control: a secret with one name blocks nothing.
    await runtime([`${join(scratch, "elsewhere")}:/x`]).launch("task-1", "true", work);
    assert.equal(calls.length, 1);

    // A hard link is the secret itself under any name, in any directory. The
    // guard cannot find it (here it hides in a harmless-looking mount), so it
    // refuses every launch, even one that mounts only the cwd.
    await link(join(home, ".smith", "master.key"), join(scratch, "elsewhere", "notes.txt"));
    for (const extra of [[`${join(scratch, "elsewhere")}:/x`], undefined]) {
      await assert.rejects(
        runtime(extra).launch("task-2", "true", work),
        /refusing to start container: .*master\.key has 2 hard links/,
        String(extra),
      );
    }
    assert.equal(calls.length, 1);
  });
});

test('DockerRuntime: network "host" is refused by launch and runOnce before docker runs; any other network passes', async () => {
  const dir = await mkdtemp(join(tmpdir(), "host-net-"));
  process.env.SMITH_DOCKER_CLAUDE_DIR = join(dir, "no-credential-here");
  const fakeDocker = (runtime: DockerRuntime) => {
    const calls: string[][] = [];
    (runtime as unknown as { docker: (a: string[]) => Promise<unknown> }).docker = async (a) => {
      calls.push(a);
      return { stdout: "0\n", stderr: "" };
    };
    return calls;
  };
  const refusal = /refusing to start container: network "host" would put the container on the host's loopback/;
  try {
    const host = new DockerRuntime({ image: "smith-agent:real", network: "host" });
    const hostCalls = fakeDocker(host);
    await assert.rejects(host.launch("task-h", "true", dir), refusal);
    await assert.rejects(host.runOnce(dir, "true", []), refusal);
    assert.equal(hostCalls.length, 0);

    const bridge = new DockerRuntime({ image: "smith-agent:real", network: "bridge" });
    const bridgeCalls = fakeDocker(bridge);
    await bridge.launch("task-b", "true", dir);
    const run = bridgeCalls[0] ?? [];
    assert.equal(run[run.indexOf("--network") + 1], "bridge");
  } finally {
    delete process.env.SMITH_DOCKER_CLAUDE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});
