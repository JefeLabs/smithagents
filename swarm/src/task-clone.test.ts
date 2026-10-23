import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  autoCommitMessage,
  createTaskClone,
  finalizeCommand,
  importTaskBranch,
  objectStoreMounts,
  sandboxedUploadPack,
  shellQuote,
  stripUrlCredentials,
  type TaskClone,
} from "./task-clone.js";

const exec = promisify(execFile);

async function sh(cmd: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec(cmd, args, { cwd });
  return stdout.trim();
}

const GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];

async function makeRepo(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  await sh("git", ["init", "-q", "-b", "main"], path);
  await sh("git", [...GIT_ID, "commit", "-q", "--allow-empty", "-m", "init"], path);
  return path;
}

async function fixture(): Promise<{ dir: string; repo: string }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "task-clone-")));
  return { dir, repo: await makeRepo(join(dir, "repo")) };
}

test("createTaskClone: a fresh clone on smith/<taskId> at the base commit, borrowing the user's objects", async () => {
  const { dir, repo } = await fixture();
  const clone = await createTaskClone(repo, join(dir, "clones", "t1"), "t1", "main");
  assert.equal(clone.branch, "smith/t1");
  assert.equal(clone.baseSha, await sh("git", ["rev-parse", "main"], repo));
  assert.equal(await sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], clone.path), "smith/t1");
  assert.equal(await sh("git", ["rev-parse", "HEAD"], clone.path), clone.baseSha);
  assert.ok((await lstat(join(clone.path, ".git"))).isDirectory(), "a clone, not a worktree");
  assert.ok(
    (await lstat(join(clone.path, ".git", "smith-task-clone"))).isFile(),
    "the marker DockerRuntime allowlists",
  );
  assert.equal(
    (await readFile(join(clone.path, ".git/objects/info/alternates"), "utf8")).trim(),
    clone.readOnlyMounts[0],
  );
  assert.equal(clone.readOnlyMounts[0], join(await realpath(repo), ".git", "objects"));
  await assert.rejects(
    sh("git", ["rev-parse", "--verify", "refs/heads/smith/t1"], repo),
    "the user's repo gains no branch at launch",
  );
});

test("createTaskClone: a base that exists only as origin/<base> starts at origin's commit", async () => {
  const { dir, repo } = await fixture();
  const work = join(dir, "work");
  await sh("git", ["clone", "-q", repo, work], dir);
  await sh("git", ["checkout", "-q", "--detach"], work);
  await sh("git", ["branch", "-D", "main"], work);
  const clone = await createTaskClone(work, join(dir, "clones", "t1"), "t1", "main");
  assert.equal(clone.baseSha, await sh("git", ["rev-parse", "origin/main"], work));
  assert.equal(await sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], clone.path), "smith/t1");
  assert.equal(await sh("git", ["rev-parse", "HEAD"], clone.path), clone.baseSha);
});

test("createTaskClone: the clone's origin is the user's origin URL — never the host path", async () => {
  const { dir, repo } = await fixture();
  const url = "https://github.com/acme/web.git";
  await sh("git", ["remote", "add", "origin", url], repo);
  const withOrigin = await createTaskClone(repo, join(dir, "clones", "t1"), "t1", "main");
  assert.equal(await sh("git", ["remote", "get-url", "origin"], withOrigin.path), url);

  const bare = await makeRepo(join(dir, "noorigin"));
  const without = await createTaskClone(bare, join(dir, "clones", "t2"), "t2", "main");
  assert.equal(await sh("git", ["remote"], without.path), "");
});

test("createTaskClone: credentials embedded in the user's origin URL never reach the clone", async () => {
  const { dir, repo } = await fixture();
  await sh("git", ["remote", "add", "origin", "https://x-access-token:s3cret@github.com/acme/web.git"], repo);
  const clone = await createTaskClone(repo, join(dir, "clones", "t1"), "t1", "main");
  assert.equal(await sh("git", ["remote", "get-url", "origin"], clone.path), "https://github.com/acme/web.git");
  assert.ok(!(await readFile(join(clone.path, ".git/config"), "utf8")).includes("s3cret"));
});

test("stripUrlCredentials: strips userinfo for every scheme and fails closed", () => {
  const table: Array<[string, string | undefined]> = [
    ["https://x-access-token:s3cret@github.com/acme/web.git", "https://github.com/acme/web.git"],
    ["https://github.com/acme/web.git", "https://github.com/acme/web.git"],
    ["git://u:p@host/r.git", "git://host/r.git"],
    ["ftp://u:p@host/r.git", "ftp://host/r.git"],
    ["git+ssh://git:pw@host/r.git", "git+ssh://host/r.git"],
    ["ssh://git@github.com/acme/web.git", "ssh://github.com/acme/web.git"],
    ["https://user:pa/ss@host/r.git", undefined],
    ["git@github.com:acme/web.git", "git@github.com:acme/web.git"],
    ["/srv/repos/web.git", "/srv/repos/web.git"],
  ];
  for (const [input, expected] of table) assert.equal(stripUrlCredentials(input), expected, input);
});

test("createTaskClone: an origin that cannot be sanitised gives the clone no origin", async () => {
  const { dir, repo } = await fixture();
  await sh("git", ["remote", "add", "origin", "https://user:pa/ss@host/r.git"], repo);
  const clone = await createTaskClone(repo, join(dir, "clones", "t1"), "t1", "main");
  assert.equal(await sh("git", ["remote"], clone.path), "");
  assert.ok(!(await readFile(join(clone.path, ".git/config"), "utf8")).includes("pa/ss"));
});

test("createTaskClone: refuses a path that already exists — a container may have written to it", async () => {
  const { dir, repo } = await fixture();
  await mkdir(join(dir, "clones", "t1"), { recursive: true });
  await assert.rejects(createTaskClone(repo, join(dir, "clones", "t1"), "t1", "main"), /already exists/);
});

test("createTaskClone: a repo reached through a symlink still names a mountable objects path", async () => {
  const { dir, repo } = await fixture();
  await symlink(repo, join(dir, "link"));
  const clone = await createTaskClone(join(dir, "link"), join(dir, "clones", "t1"), "t1", "main");
  const objects = join(await realpath(repo), ".git", "objects");
  assert.equal((await readFile(join(clone.path, ".git/objects/info/alternates"), "utf8")).trim(), objects);
  assert.equal(clone.readOnlyMounts[0], objects);
  assert.equal(clone.repoPath, await realpath(repo));
});

test("objectStoreMounts: follows chained alternates, relative and absolute", async () => {
  const { dir, repo: a } = await fixture();
  const b = await makeRepo(join(dir, "B"));
  const c = await makeRepo(join(dir, "C"));
  const aObjects = join(a, ".git", "objects");
  const cObjects = join(c, ".git", "objects");
  await mkdir(join(aObjects, "info"), { recursive: true });
  await writeFile(join(aObjects, "info", "alternates"), `# comment\n../../../B/.git/objects\n\n${cObjects}\n`);
  assert.deepEqual(await objectStoreMounts(a), [aObjects, resolve(aObjects, "../../../B/.git/objects"), cObjects]);
  assert.ok(b);
});

test("objectStoreMounts: refuses an alternates entry that is not a git object store", async () => {
  const { dir, repo } = await fixture();
  const alternates = join(repo, ".git", "objects", "info", "alternates");
  await mkdir(join(repo, ".git", "objects", "info"), { recursive: true });
  await writeFile(alternates, `${dir}\n`);
  await assert.rejects(objectStoreMounts(repo), /not a git object store/);

  const plain = join(dir, "plain");
  await mkdir(plain);
  await symlink(plain, join(dir, "objects"));
  await writeFile(alternates, `${join(dir, "objects")}\n`);
  await assert.rejects(objectStoreMounts(repo), /not a git object store/);
});

test("shellQuote: survives a shell round-trip, spaces and quotes included", async () => {
  const { dir } = await fixture();
  const words = ["plain", "a b", "it's", "--upload-pack=x"];
  const out = await sh("sh", ["-c", `printf '%s\\n' ${words.map(shellQuote).join(" ")}`], dir);
  assert.deepEqual(out.split("\n"), words);
});

test("sandboxedUploadPack: clone and object stores read-only, no network, named, limited, the image's entrypoint bypassed", async () => {
  const { dir } = await fixture();
  const clone = { path: "/c lone", readOnlyMounts: ["/o"] } as TaskClone;
  const words = async (cmd: string) => (await sh("sh", ["-c", `printf '%s\\n' ${cmd}`], dir)).split("\n");
  assert.deepEqual(
    await words(sandboxedUploadPack("smith-agent:latest", clone, "smith-upload-1", { cpus: "1.5", memory: "4g" })),
    [
      "docker",
      "run",
      "--rm",
      "--init",
      "-i",
      "--network",
      "none",
      "--name",
      "smith-upload-1",
      "--cpus",
      "1.5",
      "--memory",
      "4g",
      "--entrypoint",
      "git-upload-pack",
      "-v",
      "/c lone:/c lone:ro",
      "-v",
      "/o:/o:ro",
      "smith-agent:latest",
    ],
  );
  assert.deepEqual(await words(sandboxedUploadPack("img", clone, "it's")), [
    "docker",
    "run",
    "--rm",
    "--init",
    "-i",
    "--network",
    "none",
    "--name",
    "it's",
    "--entrypoint",
    "git-upload-pack",
    "-v",
    "/c lone:/c lone:ro",
    "-v",
    "/o:/o:ro",
    "img",
  ]);
});

/** Live processes whose command line contains `needle`, as [pid, command]. */
async function processesWith(needle: string): Promise<Array<[number, string]>> {
  const { stdout } = await exec("ps", ["-axo", "pid=,command="]);
  return stdout
    .split("\n")
    .filter((line) => line.includes(needle))
    .map((line) => {
      const [, pid = "0", command = ""] = /^\s*(\d+)\s+(.*)$/.exec(line) ?? [];
      return [Number(pid), command];
    });
}

/** Resolves once `pid` is gone; rejects if it outlives `ms`. */
async function gone(pid: number, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
      throw err;
    }
    if (Date.now() > deadline) throw new Error(`process ${pid} is still alive`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Starts an import whose upload-pack hangs — the stand-in for a wedged
 * container — and returns the hung git's pid once it is seen running.
 */
async function hungImport(onTimeoutFails: boolean, timeoutMs: number) {
  const { dir, repo } = await fixture();
  const clone = await createTaskClone(repo, join(dir, "clones", "t1"), "t1", "main");
  const pidFile = join(dir, "upload-pack.pid");
  let removals = 0;
  const started = Date.now();
  const importing = importTaskBranch(clone, `echo $$ > ${shellQuote(pidFile)}; exec sleep 30;`, {
    timeoutMs,
    onTimeout: async () => {
      removals++;
      // What `docker rm -f` does to the real container.
      process.kill(Number((await readFile(pidFile, "utf8")).trim()), "SIGKILL");
      if (onTimeoutFails) throw new Error("Cannot connect to the Docker daemon");
    },
  });
  // Swallow until awaited below, so a positive-control failure is not reported as unhandled.
  importing.catch(() => {});
  let gitPid: number | undefined;
  while (gitPid === undefined && Date.now() - started < timeoutMs - 100) {
    gitPid = (await processesWith(pidFile)).find(([, cmd]) => / fetch /.test(cmd))?.[0];
  }
  assert.ok(gitPid, "never saw the hung git fetch running — this test proved nothing");
  return { importing, gitPid, pidFile, started, removals: () => removals };
}

test("importTaskBranch: a hung upload-pack times out — git is killed, its container removed, and the import rejects", async () => {
  const { importing, gitPid, pidFile, started, removals } = await hungImport(false, 500);
  await assert.rejects(importing, (e: Error) => {
    assert.equal(e.message, "import timed out after 500ms");
    return true;
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5_000, `took ${elapsed}ms`);
  assert.equal(removals(), 1, "onTimeout runs exactly once");
  await gone(gitPid, 2_000);
  assert.deepEqual(await processesWith(pidFile), [], "no process of this import is left");
});

test("importTaskBranch: a timed-out import whose container removal fails says so", async () => {
  const { importing, gitPid, started, removals } = await hungImport(true, 500);
  await assert.rejects(
    importing,
    /^Error: import timed out after 500ms; removing its container failed: Cannot connect to the Docker daemon$/,
  );
  assert.ok(Date.now() - started < 5_000);
  assert.equal(removals(), 1);
  await gone(gitPid, 2_000);
});

test("importTaskBranch: rejects a nonsense timeout before any fetch", async () => {
  const { dir, repo } = await fixture();
  const clone = await createTaskClone(repo, join(dir, "clones", "t1"), "t1", "main");
  const probe = join(dir, "probe");
  for (const bad of [0, -1, Number.NaN, 2 ** 31]) {
    await assert.rejects(
      importTaskBranch(clone, `touch ${shellQuote(probe)}; git-upload-pack`, { timeoutMs: bad }),
      /timeoutMs must be a positive number/,
    );
  }
  await assert.rejects(lstat(probe), "no fetch ran");
});

test("importTaskBranch: the clone's task branch lands in the user's repo; the user repo's hooks stay off", async () => {
  const { dir, repo } = await fixture();
  const clone = await createTaskClone(repo, join(dir, "clones", "t1"), "t1", "main");
  await sh("git", [...GIT_ID, "commit", "-q", "--allow-empty", "-m", "agent work"], clone.path);
  const marker = join(dir, "hook-marker");
  await mkdir(join(repo, ".git", "hooks"), { recursive: true });
  await writeFile(join(repo, ".git", "hooks", "reference-transaction"), `#!/bin/sh\ntouch '${marker}'\n`, {
    mode: 0o755,
  });
  const tip = await importTaskBranch(clone, "git-upload-pack");
  assert.equal(tip, await sh("git", ["rev-parse", "HEAD"], clone.path));
  assert.equal(await sh("git", ["log", "-1", "--format=%s", "smith/t1"], repo), "agent work");
  await assert.rejects(lstat(marker), "the user repo's hook did not run");
});

test("importTaskBranch: an object fsck rejects is refused", async () => {
  const { dir, repo } = await fixture();
  const clone = await createTaskClone(repo, join(dir, "clones", "t1"), "t1", "main");
  const blobSha = await sh("sh", ["-c", "printf x | git hash-object -w --stdin"], clone.path);
  const treeBytes = Buffer.concat([Buffer.from("100644 .git\0"), Buffer.from(blobSha, "hex")]);
  const treeSha = await new Promise<string>((ok, bad) => {
    const p = execFile(
      "git",
      ["hash-object", "-w", "--literally", "-t", "tree", "--stdin"],
      { cwd: clone.path },
      (e, out) => (e ? bad(e) : ok(out.trim())),
    );
    p.stdin?.end(treeBytes);
  });
  const commit = await sh("git", [...GIT_ID, "commit-tree", treeSha, "-p", clone.baseSha, "-m", "evil"], clone.path);
  await sh("git", ["update-ref", "refs/heads/smith/t1", commit], clone.path);
  await assert.rejects(importTaskBranch(clone, "git-upload-pack"), /hasDotgit|fsck/);
  await assert.rejects(sh("git", ["rev-parse", "--verify", "refs/heads/smith/t1"], repo));
});

test("importTaskBranch: a clone with no task branch fails cleanly", async () => {
  const { dir, repo } = await fixture();
  const clone = await createTaskClone(repo, join(dir, "clones", "t1"), "t1", "main");
  await sh("git", ["checkout", "-q", "--detach"], clone.path);
  await sh("git", ["branch", "-D", "smith/t1"], clone.path);
  const before = await sh("git", ["for-each-ref"], repo);
  await assert.rejects(importTaskBranch(clone, "git-upload-pack"), /couldn.t find remote ref/);
  assert.equal(await sh("git", ["for-each-ref"], repo), before);
});

test("finalizeCommand: commits leftovers as the agent with today's message; does nothing when clean", async () => {
  const { dir } = await fixture();
  const scratch = await makeRepo(join(dir, "scratch"));
  await writeFile(join(scratch, "f.txt"), "leftover\n");
  const cmd = finalizeCommand("O'Brien", "t-1", false);
  await sh("sh", ["-c", cmd], scratch);
  const expected = `O'Brien (smith)|crew@smithagents.local|${autoCommitMessage("O'Brien", "t-1", false)}`;
  assert.equal(await sh("git", ["log", "-1", "--format=%an|%ae|%B"], scratch), expected);
  const count = await sh("git", ["rev-list", "--count", "HEAD"], scratch);
  await sh("sh", ["-c", cmd], scratch);
  assert.equal(await sh("git", ["rev-list", "--count", "HEAD"], scratch), count);
});

test("importTaskBranch: the fetch's server side is the uploadPack command it is given — never the host default", async () => {
  const { dir, repo } = await fixture();
  const clone = await createTaskClone(repo, join(dir, "clones", "t1"), "t1", "main");
  await sh("git", [...GIT_ID, "commit", "-q", "--allow-empty", "-m", "agent work"], clone.path);
  const probe = join(dir, "probe");
  await importTaskBranch(clone, `touch ${shellQuote(probe)}; git-upload-pack`);
  await lstat(probe);
  assert.equal(await sh("git", ["log", "-1", "--format=%s", "smith/t1"], repo), "agent work");

  const clone2 = await createTaskClone(repo, join(dir, "clones", "t2"), "t2", "main");
  await sh("git", [...GIT_ID, "commit", "-q", "--allow-empty", "-m", "more"], clone2.path);
  await assert.rejects(importTaskBranch(clone2, "false"));
  await assert.rejects(sh("git", ["rev-parse", "--verify", "refs/heads/smith/t2"], repo));
});
