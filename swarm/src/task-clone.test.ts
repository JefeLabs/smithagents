import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createTaskClone, objectStoreMounts, shellQuote } from "./task-clone.js";

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
