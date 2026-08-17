import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  addMemberWorktrees,
  createInstance,
  destroyInstance,
  instanceDir,
  instanceIsDirty,
  instancesDir,
  listInstances,
  workIdProblem,
} from "./workspace-instances.js";

test("instancesDir/instanceDir: instances live in the unversioned half", () => {
  assert.equal(instancesDir("/ws"), join("/ws", ".runtime", "instances"));
  assert.equal(instanceDir("/ws", "work-42"), join("/ws", ".runtime", "instances", "work-42"));
});

test("workIdProblem: accepts ordinary ids", () => {
  for (const id of ["work-42", "PROJ-1234", "a", "a_b.c", "0"]) {
    assert.equal(workIdProblem(id), null, `${id} should be usable`);
  }
});

test("workIdProblem: rejects anything that could escape the instances directory", () => {
  for (const id of ["../escape", "a/b", "a\\b", "..", ".", "", "   "]) {
    assert.ok(workIdProblem(id), `${id} must be rejected`);
  }
});

test("workIdProblem: rejects a leading dash so it cannot be read as a git flag", () => {
  assert.ok(workIdProblem("-upload-pack=x"), "a work id becomes a branch name and a path");
});

test("workIdProblem: the empty case says what is wrong, not something else", () => {
  const problem = workIdProblem("  ");
  assert.ok(problem);
  assert.doesNotMatch(problem, /separator/, "a blank id is not a separator problem");
});

test("workIdProblem: rejects surrounding whitespace so the id matches its path", () => {
  for (const id of ["  work-42", "work-42  ", "  work-42  "]) {
    assert.ok(workIdProblem(id), `${id} must be rejected`);
  }
});

test("workIdProblem: rejects control characters that break git refs", () => {
  for (const id of ["foo\nbar", "a\tb", "work\x00id"]) {
    assert.ok(workIdProblem(id), `${id} must be rejected`);
  }
});

/** A workspace directory whose config/ and one repo are real git repos. */
function makeWorkspace(
  label: string,
  repos: string[],
): { dir: string; ws: { name: string; repos: Array<{ name: string; path: string }> } } {
  const dir = mkdtempSync(join(tmpdir(), `wsinst-${label}-`));
  const commit = (cwd: string, msg: string) => {
    execFileSync("git", ["add", "-A"], { cwd });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg], { cwd });
  };
  const cfg = join(dir, "config");
  execFileSync("git", ["init", "-q", "-b", "main", cfg]);
  writeFileSync(join(cfg, "settings.json"), '{"name":"pg","repos":[]}\n');
  commit(cfg, "config");
  const made: Array<{ name: string; path: string }> = [];
  for (const name of repos) {
    const p = join(dir, name);
    execFileSync("git", ["init", "-q", "-b", "main", p]);
    writeFileSync(join(p, "README.md"), `${name}\n`);
    commit(p, "init");
    made.push({ name, path: p });
  }
  return { dir, ws: { name: "pg", repos: made } };
}

test("createInstance: worktrees config/ and the named repo on one branch", async () => {
  const { dir, ws } = makeWorkspace("one", ["app"]);
  try {
    const inst = await createInstance(dir, ws as never, "work-42", ["app"]);

    assert.equal(inst.branch, "smith/work-42");
    assert.deepEqual(inst.members.map((m) => m.name).sort(), ["app", "config"]);
    assert.ok(statSync(join(inst.dir, "config", "settings.json")).isFile(), "config content is present");
    assert.ok(statSync(join(inst.dir, "app", "README.md")).isFile(), "repo content is present");
    for (const m of inst.members) {
      const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: m.path }).toString().trim();
      assert.equal(branch, "smith/work-42", `${m.name} is on the shared branch`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createInstance: two repos get the SAME branch name, so cross-repo work is one branch", async () => {
  const { dir, ws } = makeWorkspace("two", ["api", "web"]);
  try {
    const inst = await createInstance(dir, ws as never, "work-7", ["api", "web"]);

    const branches = inst.members.map((m) =>
      execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: m.path }).toString().trim(),
    );
    assert.deepEqual(new Set(branches), new Set(["smith/work-7"]), "one branch across every member");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createInstance: only the named repos are worktreed", async () => {
  const { dir, ws } = makeWorkspace("subset", ["api", "web"]);
  try {
    const inst = await createInstance(dir, ws as never, "work-8", ["api"]);

    assert.deepEqual(inst.members.map((m) => m.name).sort(), ["api", "config"]);
    assert.throws(() => statSync(join(inst.dir, "web")), "an untouched repo gets no worktree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createInstance: is idempotent — a second call returns the same instance", async () => {
  const { dir, ws } = makeWorkspace("twice", ["app"]);
  try {
    const first = await createInstance(dir, ws as never, "work-9", ["app"]);
    writeFileSync(join(first.dir, "app", "LOCAL.md"), "work in progress\n");

    const second = await createInstance(dir, ws as never, "work-9", ["app"]);

    assert.equal(second.dir, first.dir);
    assert.equal(
      readFileSync(join(second.dir, "app", "LOCAL.md"), "utf8"),
      "work in progress\n",
      "an existing instance is reused, not recreated over",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createInstance: refuses a work id that would escape", async () => {
  const { dir, ws } = makeWorkspace("escape", ["app"]);
  try {
    await assert.rejects(() => createInstance(dir, ws as never, "../../pwned", ["app"]), /work id/i);
    assert.throws(() => statSync(join(dir, "..", "..", "pwned")), "nothing created outside the workspace");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createInstance: names a repo that is not in the workspace", async () => {
  const { dir, ws } = makeWorkspace("missing", ["app"]);
  try {
    await assert.rejects(() => createInstance(dir, ws as never, "work-10", ["nope"]), /nope/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createInstance: reattaches a worktree whose directory was removed but branch remains", async () => {
  const { dir, ws } = makeWorkspace("reattach", ["app"]);
  try {
    const first = await createInstance(dir, ws as never, "work-11", ["app"]);
    writeFileSync(join(first.dir, "app", "WORK.md"), "committed work\n");
    execFileSync("git", ["add", "WORK.md"], { cwd: join(first.dir, "app") });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "work"], {
      cwd: join(first.dir, "app"),
    });

    // Remove the worktree directory while leaving the branch in the source repo.
    rmSync(join(first.dir, "app"), { recursive: true, force: true });

    // Call again — should reattach and restore the committed work.
    const second = await createInstance(dir, ws as never, "work-11", ["app"]);

    assert.equal(second.dir, first.dir);
    assert.ok(statSync(join(second.dir, "app", "WORK.md")).isFile(), "committed work is back");
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: join(second.dir, "app") })
      .toString()
      .trim();
    assert.equal(branch, "smith/work-11", "reattached worktree is on the right branch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createInstance: a repo member starts from opts.base, not wherever the clone's HEAD sits", async () => {
  const { dir, ws } = makeWorkspace("base", ["app"]);
  try {
    const repoPath = ws.repos[0].path;
    // The user's real clone is mid-work on a feature branch, ahead of main —
    // entirely normal, and exactly what an instance must NOT inherit.
    execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: repoPath });
    writeFileSync(join(repoPath, "FEATURE.md"), "wip\n");
    execFileSync("git", ["add", "-A"], { cwd: repoPath });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "feature work"], {
      cwd: repoPath,
    });

    const inst = await createInstance(dir, ws as never, "work-base", ["app"], { base: "main" });
    const member = inst.members.find((m) => m.name === "app");
    assert.ok(member);

    const ahead = execFileSync("git", ["rev-list", "--count", "main..HEAD"], { cwd: member?.path }).toString().trim();
    assert.equal(ahead, "0", "the member is cut from the task's base branch, not the clone's current HEAD");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createInstance: config/ ignores opts.base — no base-branch concept, always cut from its own HEAD", async () => {
  const { dir, ws } = makeWorkspace("base-config", ["app"]);
  try {
    const inst = await createInstance(dir, ws as never, "work-base-cfg", ["app"], { base: "main" });
    const config = inst.members.find((m) => m.name === "config");
    assert.ok(config);
    assert.ok(statSync(join(config?.path ?? "", "settings.json")).isFile());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createInstance: a base branch that exists only as a remote-tracking ref still gets the requested branch name (git worktree-add's DWIM otherwise discards -b)", async () => {
  const root = mkdtempSync(join(tmpdir(), "wsinst-dwim-"));
  try {
    // A real remote + clone, so "main" can exist ONLY as origin/main in the clone —
    // the scenario that trips git's DWIM (see resolveStartPoint's doc comment).
    const origin = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "-b", "main", origin]);
    writeFileSync(join(origin, "README.md"), "hi\n");
    execFileSync("git", ["add", "-A"], { cwd: origin });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: origin });

    const clone = join(root, "clone");
    execFileSync("git", ["clone", "-q", origin, clone]);
    // Move off main and delete the local branch — only origin/main remains.
    execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: clone });
    execFileSync("git", ["branch", "-D", "main"], { cwd: clone });

    const cfg = join(root, "config");
    execFileSync("git", ["init", "-q", "-b", "main", cfg]);
    writeFileSync(join(cfg, "settings.json"), "{}\n");
    execFileSync("git", ["add", "-A"], { cwd: cfg });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "config"], { cwd: cfg });

    const ws = { name: "pg", repos: [{ name: "app", path: clone }] };
    const inst = await createInstance(root, ws as never, "work-dwim", ["app"], { base: "main" });
    const member = inst.members.find((m) => m.name === "app");
    assert.ok(member);

    const actualBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: member?.path })
      .toString()
      .trim();
    assert.equal(actualBranch, "smith/work-dwim", "the requested branch name is honored, not overridden by git's DWIM");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createInstance: rejects a repo named 'config' because it collides with the workspace config member", async () => {
  const { dir, ws } = makeWorkspace("config-collision", ["app", "config"]);
  try {
    await assert.rejects(() => createInstance(dir, ws as never, "work-12", ["app", "config"]), /config.*collides/i);
    assert.throws(() => statSync(join(dir, ".runtime")), "nothing created under the instance directory");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createInstance: rejects a repo whose name would escape the instance directory", async () => {
  const { dir, ws } = makeWorkspace("path-escape", ["app"]);
  try {
    // Create a bogus workspace record with an invalid repo name (it won't exist on disk).
    const evilWs = { ...ws, repos: [...ws.repos, { name: "../sibling", path: join(dir, "../sibling") }] };
    await assert.rejects(
      () => createInstance(dir, evilWs as never, "work-13", ["app", "../sibling"]),
      /sibling.*escape/i,
    );
    // Verify the instance directory was not created.
    assert.throws(() => statSync(join(dir, ".runtime")), "instance directory was not created on validation error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listInstances: empty when there are none, sorted when there are", async () => {
  const { dir, ws } = makeWorkspace("list", ["app"]);
  try {
    assert.deepEqual(await listInstances(dir), []);
    await createInstance(dir, ws as never, "b-2", ["app"]);
    await createInstance(dir, ws as never, "a-1", ["app"]);
    assert.deepEqual(await listInstances(dir), ["a-1", "b-2"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("instanceIsDirty: names the members holding uncommitted work", async () => {
  const { dir, ws } = makeWorkspace("dirty", ["app"]);
  try {
    const inst = await createInstance(dir, ws as never, "work-1", ["app"]);
    assert.deepEqual(await instanceIsDirty(inst), [], "a fresh instance is clean");

    writeFileSync(join(inst.dir, "app", "NEW.md"), "unsaved\n");
    assert.deepEqual(await instanceIsDirty(inst), ["app"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("destroyInstance: REFUSES to discard uncommitted work", async () => {
  const { dir, ws } = makeWorkspace("refuse", ["app"]);
  try {
    const inst = await createInstance(dir, ws as never, "work-2", ["app"]);
    writeFileSync(join(inst.dir, "app", "PRECIOUS.md"), "not committed\n");

    await assert.rejects(() => destroyInstance(dir, ws as never, "work-2", ["app"]), /uncommitted/i);

    assert.ok(statSync(join(inst.dir, "app", "PRECIOUS.md")).isFile(), "THE WORK SURVIVES");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("destroyInstance: removes a clean instance and deregisters its worktrees", async () => {
  const { dir, ws } = makeWorkspace("clean", ["app"]);
  try {
    const inst = await createInstance(dir, ws as never, "work-3", ["app"]);

    await destroyInstance(dir, ws as never, "work-3", ["app"]);

    assert.throws(() => statSync(inst.dir), "the instance directory is gone");
    const listed = execFileSync("git", ["worktree", "list"], { cwd: ws.repos[0].path }).toString();
    assert.doesNotMatch(listed, /work-3/, "git no longer lists the worktree");
    assert.deepEqual(await listInstances(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("destroyInstance: force discards, but only when asked", async () => {
  const { dir, ws } = makeWorkspace("force", ["app"]);
  try {
    const inst = await createInstance(dir, ws as never, "work-4", ["app"]);
    writeFileSync(join(inst.dir, "app", "SCRATCH.md"), "throwaway\n");

    await destroyInstance(dir, ws as never, "work-4", ["app"], { force: true });

    assert.throws(() => statSync(inst.dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("destroyInstance: an absent instance is a no-op, not an error", async () => {
  const { dir, ws } = makeWorkspace("absent", ["app"]);
  try {
    await destroyInstance(dir, ws as never, "never-existed", ["app"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("instanceIsDirty: detects ignored files with real content", async () => {
  const { dir, ws } = makeWorkspace("ignored", ["app"]);
  try {
    const inst = await createInstance(dir, ws as never, "work-5", ["app"]);

    // Add .gitignore to exclude .env, then write a real .env file
    writeFileSync(join(inst.dir, "app", ".gitignore"), ".env\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: join(inst.dir, "app") });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add gitignore"], {
      cwd: join(inst.dir, "app"),
    });

    writeFileSync(join(inst.dir, "app", ".env"), "SECRET=xyz\n");
    assert.deepEqual(await instanceIsDirty(inst), ["app"], "ignored file with content counts as dirty");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("destroyInstance: REFUSES to discard ignored content and says so clearly", async () => {
  const { dir, ws } = makeWorkspace("ignored-refuse", ["app"]);
  try {
    const inst = await createInstance(dir, ws as never, "work-6", ["app"]);

    // Set up gitignore with a real .env file
    writeFileSync(join(inst.dir, "app", ".gitignore"), ".env\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: join(inst.dir, "app") });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add gitignore"], {
      cwd: join(inst.dir, "app"),
    });
    writeFileSync(join(inst.dir, "app", ".env"), "SECRET=xyz\n");

    // Destroy should refuse with a message that mentions ignored content
    let errMessage = "";
    try {
      await destroyInstance(dir, ws as never, "work-6", ["app"]);
      assert.fail("should have rejected");
    } catch (e) {
      errMessage = (e as Error).message;
    }
    assert.match(errMessage, /ignored/, "error message mentions ignored content");

    // The file must survive
    assert.ok(statSync(join(inst.dir, "app", ".env")).isFile(), "THE IGNORED FILE SURVIVES");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("destroyInstance: force discards ignored content too", async () => {
  const { dir, ws } = makeWorkspace("ignored-force", ["app"]);
  try {
    const inst = await createInstance(dir, ws as never, "work-7", ["app"]);

    // Set up gitignore with real content
    writeFileSync(join(inst.dir, "app", ".gitignore"), ".env\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: join(inst.dir, "app") });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add gitignore"], {
      cwd: join(inst.dir, "app"),
    });
    writeFileSync(join(inst.dir, "app", ".env"), "SECRET=xyz\n");

    await destroyInstance(dir, ws as never, "work-7", ["app"], { force: true });

    assert.throws(() => statSync(inst.dir), "the instance directory is gone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addMemberWorktrees: each member gets its own worktree on its own branch", async () => {
  const { dir, ws } = makeWorkspace("mem", ["app"]);
  try {
    const inst = await createInstance(dir, ws as never, "w-1", ["app"]);
    const repo = inst.members.find((m) => m.name === "app");

    const members = await addMemberWorktrees(inst.dir, repo!.source, "w-1", ["fabian", "santiago"]);

    assert.deepEqual(members.map((m) => m.name).sort(), ["fabian", "santiago"]);
    for (const m of members) {
      const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: m.path }).toString().trim();
      assert.equal(branch, `smith/members/w-1/${m.name}`, "a branch per member");
      assert.ok(statSync(join(m.path, "README.md")).isFile(), "real content");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addMemberWorktrees: members are isolated — one's edit is invisible to the other", async () => {
  const { dir, ws } = makeWorkspace("iso", ["app"]);
  try {
    const inst = await createInstance(dir, ws as never, "w-2", ["app"]);
    const repo = inst.members.find((m) => m.name === "app");
    const [a, b] = await addMemberWorktrees(inst.dir, repo!.source, "w-2", ["fabian", "santiago"]);

    writeFileSync(join(a.path, "DRAFT.md"), "fabian's uncommitted work\n");

    assert.throws(() => statSync(join(b.path, "DRAFT.md")), "uncommitted work does not leak between members");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addMemberWorktrees: a peer's COMMIT is instantly visible, with no push", async () => {
  const { dir, ws } = makeWorkspace("share", ["app"]);
  try {
    const inst = await createInstance(dir, ws as never, "w-3", ["app"]);
    const repo = inst.members.find((m) => m.name === "app");
    const [a, b] = await addMemberWorktrees(inst.dir, repo!.source, "w-3", ["fabian", "santiago"]);

    writeFileSync(join(a.path, "IFACE.md"), "the interface\n");
    execFileSync("git", ["add", "-A"], { cwd: a.path });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "iface"], { cwd: a.path });

    const seen = execFileSync("git", ["show", "smith/members/w-3/fabian:IFACE.md"], { cwd: b.path }).toString();

    assert.match(seen, /the interface/, "peers share one object store — commit is the handoff");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addMemberWorktrees: is idempotent", async () => {
  const { dir, ws } = makeWorkspace("mem2", ["app"]);
  try {
    const inst = await createInstance(dir, ws as never, "w-4", ["app"]);
    const repo = inst.members.find((m) => m.name === "app");
    const first = await addMemberWorktrees(inst.dir, repo!.source, "w-4", ["fabian"]);
    writeFileSync(join(first[0].path, "WIP.md"), "in progress\n");

    const again = await addMemberWorktrees(inst.dir, repo!.source, "w-4", ["fabian"]);

    assert.equal(again[0].path, first[0].path);
    assert.ok(statSync(join(again[0].path, "WIP.md")).isFile(), "existing work untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addMemberWorktrees: refuses a member name that would escape", async () => {
  const { dir, ws } = makeWorkspace("mem-esc", ["app"]);
  try {
    const inst = await createInstance(dir, ws as never, "w-5", ["app"]);
    const repo = inst.members.find((m) => m.name === "app");
    await assert.rejects(() => addMemberWorktrees(inst.dir, repo!.source, "w-5", ["../evil"]), /name/i);
    assert.throws(() => statSync(join(inst.dir, "..", "evil")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("destroyInstance: refuses when a MEMBER worktree holds uncommitted work", async () => {
  const { dir, ws } = makeWorkspace("mem-dirty", ["app"]);
  try {
    const inst = await createInstance(dir, ws as never, "w-6", ["app"]);
    const repo = inst.members.find((m) => m.name === "app");
    const [fabian] = await addMemberWorktrees(inst.dir, repo!.source, "w-6", ["fabian"]);
    writeFileSync(join(fabian.path, "PRECIOUS.md"), "work that exists nowhere else\n");

    await assert.rejects(
      () => destroyInstance(dir, ws as never, "w-6", ["app"]),
      /fabian/i,
      "the refusal names the member holding the work",
    );
    assert.ok(statSync(join(fabian.path, "PRECIOUS.md")).isFile(), "the work survives the refusal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("destroyInstance: force removes member worktrees and leaves no stale registration", async () => {
  const { dir, ws } = makeWorkspace("mem-force", ["app"]);
  try {
    const inst = await createInstance(dir, ws as never, "w-7", ["app"]);
    const repo = inst.members.find((m) => m.name === "app");
    await addMemberWorktrees(inst.dir, repo!.source, "w-7", ["fabian"]);

    await destroyInstance(dir, ws as never, "w-7", ["app"], { force: true });

    assert.throws(() => statSync(inst.dir), "the instance directory is gone");
    const list = execFileSync("git", ["worktree", "list"], { cwd: repo!.source }).toString();
    assert.doesNotMatch(list, /members\/fabian/, "no stale worktree registration is left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
