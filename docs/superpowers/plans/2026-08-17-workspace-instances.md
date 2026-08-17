# Workspace Instances Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a unit of work its own **workspace-instance** — a directory of git worktrees cut from the workspace's own repos — and make workspace-routed tasks run inside one.

**Architecture:** A new `swarm/src/workspace-instances.ts` creates, lists, and destroys instances at `<workspace>/.runtime/instances/<work-id>/`, holding a worktree of `config/` plus a worktree of each repo the work touches, **all on one branch name**. The dispatcher then routes workspace-routed tasks through an instance instead of the detached worktree it uses today. Non-workspace tasks keep the existing path untouched.

**Tech Stack:** TypeScript ~6.0.0 (ESM, `.js` import specifiers), Node >= 24, `node:test` + `node:assert/strict`, biome 2.5.3, `git` via `node:child_process`.

**Spec:** `docs/superpowers/specs/2026-08-16-workspace-instances-and-assignment-design.md` — §2.1 (the instance), §2.2 (lifecycle), §4.2 step 4.

## Global Constraints

- Node >= 24; TypeScript ~6.0.0; ESM with `.js` import specifiers on every relative import.
- Tests use `node:test` + `node:assert/strict`. **Every test writes to `mkdtempSync(tmpdir())`. No test may touch the real state root at `~/.smithagents`, and no test may reach the network** — build local git repos and clone/worktree from those paths.
- **Registry writes stay sequential** (`for…of` with `await`); `saveWorkspace` is unlocked read-modify-write. Never `Promise.all` / `.map(async …)` over workspaces.
- **Nothing reachable from boot may throw uncaught** — a throw there bricks startup and re-throws every boot.
- **Never destroy uncommitted work.** Instance directories are ours to remove, but a worktree holding uncommitted changes is the user's. See Task 3.
- **Git arguments derived from records or manifests are untrusted:** validate them and pass positionals after `--`. `dispatcher.ts:284` already does this for the base branch; match that discipline.
- Baselines at the start of this plan: **537 tests passing, 0 failing; tsc 12 errors** (pre-existing, in `agent-sessions.ts`, `jira-sync.test.ts`, `server.ts`); biome clean on touched files.
- Measurement traps in this repo — get these right or your numbers are meaningless:
  - Typecheck with `cd swarm && ./node_modules/.bin/tsc --noEmit`. **Never `npx tsc` from the repo root** — it resolves a decoy placeholder package.
  - tsc ANSI-colorizes so `grep -c 'error TS'` returns **0 while errors are on screen**. Strip ANSI first: `sed 's/\x1b\[[0-9;]*m//g'`. **A count of 0 means your measurement broke.**
  - `node:test` summary lines start with `ℹ`, not `#`.

## Context: what exists today

- Task worktrees are created by `dispatcher.prepareWorktree` (`dispatcher.ts:266`) at `resolve(repoRoot, this.config.worktreeDir, taskId)`. **`worktreeDir` is absolute** (`config.ts:75`, `<smithRoot>/worktrees`), so `resolve` discards `repoRoot` and every worktree lands at `~/.smithagents/worktrees/<taskId>` — outside the workspace. That is why `gitdirMount()` (`runtime.ts:288`) exists: the worktree's `.git` file points at an absolute path inside a parent that lives elsewhere, so Docker receives a dangling pointer.
- **Task worktrees are never removed.** There is no `worktree remove` in the dispatcher; they accumulate.
- A task is workspace-routed when `manifest.context.workspace` is set; `manifest.context.repoPath` is the server-resolved absolute repo path (`types.ts:81-89`).
- Plan 7 put each project repo inside its workspace and made `config/` a git repo, so both can now be worktree sources.

## Scope

**In:** the instance primitive (create / list / destroy), one branch across the repos an instance touches, and dispatcher adoption for **workspace-routed tasks only**.

**Out, deliberately:**
- **Non-workspace tasks.** The legacy path stays exactly as it is. Migrating it is its own plan.
- **Deleting `gitdirMount()`.** §2.1 says it becomes unnecessary once worktree and parent live in one directory — true for instances, but the legacy path still produces detached worktrees, so the mount must stay until that path migrates. Removing it now would break docker dispatch for non-workspace tasks.
- **Assignment.** §2.2's lifecycle begins "assigned →", but no assignment concept exists (zero `assignee`/`assignedTo` in the codebase). This plan ships the lifecycle **operations**; the trigger arrives with work items.
- **Agent cwd at the instance root.** §2.1's intent is that an assignee sees the whole project, but today's agents start at a repo root and the drivers materialize their profile there. This plan starts the agent in `<instance>/<repo>`, with `config/` and any sibling repos present alongside. Moving cwd up is a behavioural change for every agent and belongs with multi-repo work.

---

### Task 1: Instance paths and a validated work id

**Files:**
- Create: `swarm/src/workspace-instances.ts`
- Create: `swarm/src/workspace-instances.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `instancesDir(workspaceDir: string): string` — `<workspaceDir>/.runtime/instances`
  - `instanceDir(workspaceDir: string, workId: string): string`
  - `workIdProblem(workId: string): string | null` — `null` when usable, else the reason.

- [ ] **Step 1: Write the failing tests**

Create `swarm/src/workspace-instances.test.ts`:

```ts
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { instanceDir, instancesDir, workIdProblem } from "./workspace-instances.js";

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
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/workspace-instances.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -20
```

Expected: FAIL — cannot find module `./workspace-instances.js`.

- [ ] **Step 3: Implement**

Create `swarm/src/workspace-instances.ts`:

```ts
import { join } from "node:path";

/** Ephemeral instances live in the workspace's unversioned half (spec §1.2). */
export function instancesDir(workspaceDir: string): string {
  return join(workspaceDir, ".runtime", "instances");
}

/** One instance's directory. */
export function instanceDir(workspaceDir: string, workId: string): string {
  return join(instancesDir(workspaceDir), workId);
}

/**
 * Whether a work id is usable, and why not if it isn't.
 *
 * A work id becomes BOTH a directory name under `.runtime/instances/` and part
 * of a git branch name, so it is checked for two different escapes: a path
 * separator or `..`/`.` would climb out of the instances directory, and a
 * leading `-` would be read by git as a flag rather than a value.
 */
export function workIdProblem(workId: string): string | null {
  if (!workId?.trim()) return "a work id cannot be blank";
  // Surrounding whitespace is REJECTED rather than trimmed away, so the
  // validated string is identical to the raw one. Returning a canonical form
  // instead would leave every later caller free to join the unvalidated value.
  if (workId !== workId.trim()) return `"${workId}" has surrounding whitespace, which must be removed`;
  if (workId === "." || workId === "..") return `"${workId}" would resolve to the current or parent directory`;
  if (/[/\\]/.test(workId)) return `"${workId}" contains a path separator, which would escape the instances directory`;
  if (workId.startsWith("-")) return `"${workId}" starts with "-", which git would read as a flag`;
  // Final allow-list: control characters are legal in a directory name but
  // illegal in a git ref, so without this they surface as a confusing
  // `git worktree add` failure instead of a message from the validator.
  // The specific checks above run first so each says WHAT is wrong.
  if (!/^[\w.-]+$/.test(workId)) return `"${workId}" contains control characters or other forbidden characters`;
  return null;
}
```

- [ ] **Step 4: Run them to verify they pass**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/workspace-instances.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add swarm/src/workspace-instances.ts swarm/src/workspace-instances.test.ts
git commit -m "feat(swarm): instance paths and a validated work id

A work id becomes both a directory name and part of a branch name, so it is
checked for a path escape and for a leading dash git would read as a flag."
```

---

### Task 2: Create an instance

**Files:**
- Modify: `swarm/src/workspace-instances.ts`
- Test: `swarm/src/workspace-instances.test.ts`

**Interfaces:**
- Consumes: `instanceDir`, `workIdProblem` (Task 1); `type Workspace`, `type WorkspaceRepo` from `./workspaces.js`.
- Produces:
  - `interface InstanceMember { name: string; path: string; source: string }`
  - `interface Instance { workId: string; dir: string; branch: string; members: InstanceMember[] }`
  - `createInstance(workspaceDir: string, ws: Workspace, workId: string, repoNames: string[]): Promise<Instance>`

`repoNames` selects which project repos this instance touches; `config` is always included. All members are cut on the **same** branch, `smith/<workId>`.

- [ ] **Step 1: Write the failing tests**

Append to `swarm/src/workspace-instances.test.ts` (add `execFileSync` from `node:child_process`; `mkdtempSync`, `rmSync`, `statSync`, `writeFileSync`, `readFileSync` from `node:fs`; `tmpdir` from `node:os`; and `createInstance` to the import):

```ts
/** A workspace directory whose config/ and one repo are real git repos. */
function makeWorkspace(label: string, repos: string[]): { dir: string; ws: { name: string; repos: Array<{ name: string; path: string }> } } {
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
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'createInstance' 'src/workspace-instances.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -20
```

Expected: FAIL — `createInstance is not a function`.

- [ ] **Step 3: Implement**

Add to `swarm/src/workspace-instances.ts` (imports: `execFile` from `node:child_process`, `mkdir`, `stat` from `node:fs/promises`, `promisify` from `node:util`, and `type Workspace` from `./workspaces.js`):

```ts
const run = promisify(execFile);

export interface InstanceMember {
  /** "config", or the repo's name in the workspace record. */
  name: string;
  /** The worktree, inside the instance. */
  path: string;
  /** The workspace's own clone this worktree was cut from. */
  source: string;
}

export interface Instance {
  workId: string;
  dir: string;
  branch: string;
  members: InstanceMember[];
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Whether this path is already a git worktree.
 *
 * A worktree's `.git` is a FILE (it points into the parent's `.git/worktrees/`),
 * a plain clone's is a directory — so this tests for either, and only for the
 * marker itself. Testing that the DIRECTORY exists instead would read an empty
 * leftover from a partial teardown as an existing member and skip creating its
 * worktree. Testing with `git rev-parse` would be worse still: from an empty
 * directory git walks UP and can answer about an enclosing repo.
 */
async function isWorktree(path: string): Promise<boolean> {
  try {
    await stat(join(path, ".git"));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Create the workspace-instance for `workId`: a worktree of `config/` plus one
 * of each named repo, all on the SAME branch (spec §2.1). One branch across
 * every member is what makes a coordinated cross-repo change the default rather
 * than a special case.
 *
 * Worktrees rather than clones: instances are disposable and share the
 * workspace's object store, which is also what makes the eventual rebase local.
 *
 * Idempotent — an existing member worktree is left exactly as it is, because it
 * may hold work in progress. Only missing members are added, so an instance
 * that gained a repo mid-flight can be completed by calling again.
 */
export async function createInstance(
  workspaceDir: string,
  ws: Workspace,
  workId: string,
  repoNames: string[],
): Promise<Instance> {
  const problem = workIdProblem(workId);
  if (problem) throw new Error(`Invalid work id: ${problem}`);

  const dir = instanceDir(workspaceDir, workId);
  const branch = `smith/${workId}`;

  const sources: Array<{ name: string; source: string }> = [{ name: "config", source: join(workspaceDir, "config") }];
  for (const name of repoNames) {
    const repo = ws.repos.find((r) => r.name === name);
    if (!repo) throw new Error(`Repo "${name}" is not in workspace "${ws.name}"`);
    sources.push({ name, source: repo.path });
  }

  await mkdir(dir, { recursive: true });
  const members: InstanceMember[] = [];
  for (const { name, source } of sources) {
    const path = join(dir, name);
    if (!(await isWorktree(path))) {
      // `workIdProblem` already refused a leading dash, so `branch` cannot be
      // read as a flag. The base is this source's current HEAD.
      await run("git", ["worktree", "add", "-q", path, "-b", branch], { cwd: source });
    }
    members.push({ name, path, source });
  }
  return { workId, dir, branch, members };
}
```

Note `isDir` is still used by Task 3; keep it. The reuse check deliberately tests only for the `.git` marker — see `isWorktree`'s docstring for why an empty leftover directory must NOT read as an existing member.

- [ ] **Step 4: Run them to verify they pass**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/workspace-instances.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
```

Expected: 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add swarm/src/workspace-instances.ts swarm/src/workspace-instances.test.ts
git commit -m "feat(swarm): create a workspace-instance as worktrees on one branch

config/ plus each repo the work touches, all cut on smith/<work-id>, so a
coordinated cross-repo change is the default rather than a special case. An
existing member worktree is reused, never recreated over."
```

---

### Task 3: List and destroy an instance

§2.2: the instance survives past commit — all nine PRs on the proving-ground repo are still open, so review iteration is the common case. Destruction is therefore explicit, and it must never take uncommitted work with it.

**Files:**
- Modify: `swarm/src/workspace-instances.ts`
- Test: `swarm/src/workspace-instances.test.ts`

**Interfaces:**
- Consumes: `createInstance`, `instanceDir`, `instancesDir` (Tasks 1-2).
- Produces:
  - `listInstances(workspaceDir: string): Promise<string[]>` — work ids, sorted.
  - `instanceIsDirty(inst: Instance): Promise<string[]>` — names of members holding uncommitted changes.
  - `destroyInstance(workspaceDir: string, ws: Workspace, workId: string, repoNames: string[], opts?: { force?: boolean }): Promise<void>` — refuses when any member is dirty unless `force`.

- [ ] **Step 1: Write the failing tests**

Append to `swarm/src/workspace-instances.test.ts` (add `destroyInstance`, `instanceIsDirty`, `listInstances` to the import):

```ts
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
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'listInstances|instanceIsDirty|destroyInstance' 'src/workspace-instances.test.ts' 2>&1 \
  | sed 's/\x1b\[[0-9;]*m//g' | head -20
```

Expected: FAIL — `listInstances is not a function`.

- [ ] **Step 3: Implement**

Add to `swarm/src/workspace-instances.ts` (add `readdir`, `rm` to the `node:fs/promises` imports):

```ts
/** Work ids with an instance directory, sorted. */
export async function listInstances(workspaceDir: string): Promise<string[]> {
  try {
    const entries = await readdir(instancesDir(workspaceDir), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Members holding uncommitted changes, by name. */
export async function instanceIsDirty(inst: Instance): Promise<string[]> {
  const dirty: string[] = [];
  for (const m of inst.members) {
    if (!(await isDir(m.path))) continue;
    const { stdout } = await run("git", ["status", "--porcelain"], { cwd: m.path });
    if (stdout.trim()) dirty.push(m.name);
  }
  return dirty;
}

/**
 * Remove an instance and deregister its worktrees.
 *
 * REFUSES when any member holds uncommitted changes. §2.2 destroys an instance
 * only after the workspace clone has been fast-forwarded, so a dirty member
 * means the caller is destroying too early — and a worktree's contents exist
 * nowhere else. `force` is for a caller that has already preserved the work.
 *
 * An absent instance is a no-op: this is the tail of a lifecycle, and making it
 * idempotent is what lets a retry finish a partial teardown.
 */
export async function destroyInstance(
  workspaceDir: string,
  ws: Workspace,
  workId: string,
  repoNames: string[],
  opts: { force?: boolean } = {},
): Promise<void> {
  const problem = workIdProblem(workId);
  if (problem) throw new Error(`Invalid work id: ${problem}`);

  const dir = instanceDir(workspaceDir, workId);
  if (!(await isDir(dir))) return;

  const sources: Array<{ name: string; source: string }> = [{ name: "config", source: join(workspaceDir, "config") }];
  for (const name of repoNames) {
    const repo = ws.repos.find((r) => r.name === name);
    if (repo) sources.push({ name, source: repo.path });
  }
  const members: InstanceMember[] = sources.map(({ name, source }) => ({ name, path: join(dir, name), source }));

  if (!opts.force) {
    const dirty = await instanceIsDirty({ workId, dir, branch: `smith/${workId}`, members });
    if (dirty.length > 0) {
      throw new Error(
        `Instance "${workId}" has uncommitted changes in ${dirty.join(", ")} — commit them, or destroy with force to discard`,
      );
    }
  }

  for (const m of members) {
    if (!(await isDir(m.path))) continue;
    // --force here removes the worktree registration; the dirty check above is
    // what protects the contents, and it has already run unless the caller
    // deliberately opted out.
    await run("git", ["worktree", "remove", "--force", m.path], { cwd: m.source }).catch(() => {});
  }
  await rm(dir, { recursive: true, force: true });
}
```

- [ ] **Step 4: Run the whole file, then the suite**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/workspace-instances.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t3-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t3-suite.txt | grep -E "^ℹ (tests|pass|fail)"
```

Expected: 17 tests in the file; suite **554 pass / 0 fail**.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd swarm && ./node_modules/.bin/tsc --noEmit > /tmp/t3-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t3-tsc.txt | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+')"
npx biome check src/workspace-instances.ts src/workspace-instances.test.ts
git add swarm/src/workspace-instances.ts swarm/src/workspace-instances.test.ts
git commit -m "feat(swarm): list and destroy a workspace-instance

Destroying refuses while any member holds uncommitted changes: a worktree's
contents exist nowhere else, and §2.2 destroys only after the workspace clone
has been fast-forwarded. force is for a caller that already preserved the work."
```

Expected: `errors=12`; biome clean.

---

### Task 4: Workspace-routed tasks run in an instance

**Files:**
- Modify: `swarm/src/dispatcher.ts` — `prepareWorktree` (`:266`)
- Test: `swarm/src/dispatcher.test.ts`

**Interfaces:**
- Consumes: `createInstance` (Task 2); `workspaceDir`, `loadWorkspaces` from `./workspaces.js`; `smithPaths` from `./paths.js`.
- Produces: no new exports. `prepareWorktree` returns the same `string` — the directory the agent runs in — so every downstream consumer of `worktreePath` is unchanged.

**Context the implementer needs:** a task is workspace-routed when `manifest.context.workspace` is set. `manifest.context.repoPath` is the server-resolved absolute repo path. Today `prepareWorktree` computes `resolve(repoRoot, this.config.worktreeDir, manifest.taskId)`, and because `worktreeDir` is absolute that lands at `~/.smithagents/worktrees/<taskId>`, outside the workspace.

- [ ] **Step 1: Write the failing test**

Append to `swarm/src/dispatcher.test.ts`:

```ts
test("prepareWorktree: a workspace-routed task runs inside a workspace-instance", async () => {
  const root = mkdtempSync(join(tmpdir(), "disp-inst-"));
  try {
    const paths = smithPaths(root);
    const { dir, ws } = makeWorkspaceFixture(root, "app");   // see Step 1b
    await saveWorkspace(paths, ws);

    const dispatcher = makeDispatcher(root);                  // see Step 1b
    const manifest = makeManifest({
      taskId: "t-1",
      context: { workspace: ws.name, repo: "app", repoPath: ws.repos[0].path, branch: "main", files: [], repository: "" },
    });

    const worktree = await dispatcher.prepareWorktreeForTest(manifest);

    assert.equal(worktree, join(dir, ".runtime", "instances", "t-1", "app"), "runs in the instance's repo worktree");
    assert.ok(statSync(join(dir, ".runtime", "instances", "t-1", "config")).isDirectory(), "config/ is alongside it");
    assert.ok(
      !worktree.startsWith(paths.worktrees ?? join(root, "worktrees")),
      "NOT in the detached worktrees directory",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareWorktree: a non-workspace task keeps the legacy detached worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "disp-legacy-"));
  try {
    const repo = makeGitRepo(join(root, "solo"));            // see Step 1b
    const dispatcher = makeDispatcher(root);
    const manifest = makeManifest({
      taskId: "t-2",
      context: { repoPath: repo, branch: "main", files: [], repository: "" },  // no workspace
    });

    const worktree = await dispatcher.prepareWorktreeForTest(manifest);

    assert.match(worktree, /worktrees[/\\]t-2$/, "legacy path unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 1b: Give the test what it needs**

`prepareWorktree` is private and does more than create a worktree (it copies `smith-delegate` and materializes the agent profile). Rather than booting a dispatcher, **extract the path decision** into a testable function and test that:

```ts
/**
 * Where this task's agent runs.
 *
 * A workspace-routed task gets a workspace-instance (spec §2.1): worktrees of
 * config/ and the routed repo, on one branch, inside the workspace. The agent
 * starts in the repo's worktree, with config/ alongside it.
 *
 * Everything else keeps the legacy detached worktree under the state root.
 * That path is unchanged by design — migrating it is a separate plan, and
 * gitdirMount() still exists for it.
 */
export async function resolveTaskWorktree(
  manifest: TaskManifest,
  config: { worktreeDir: string; smithRoot: string },
): Promise<string> { … }
```

Export it from `dispatcher.ts`, have `prepareWorktree` call it in place of its current path computation, and point the two tests above at `resolveTaskWorktree` instead of a `prepareWorktreeForTest` shim. Build the fixtures with the same `execFileSync("git", ["init", …])` pattern `workspace-instances.test.ts` uses.

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'prepareWorktree|resolveTaskWorktree' 'src/dispatcher.test.ts' 2>&1 \
  | sed 's/\x1b\[[0-9;]*m//g' | head -20
```

Expected: FAIL — `resolveTaskWorktree is not a function`.

- [ ] **Step 3: Implement**

In `swarm/src/dispatcher.ts`:

```ts
export async function resolveTaskWorktree(
  manifest: TaskManifest,
  config: { worktreeDir: string; smithRoot: string },
): Promise<string> {
  const repoPath = manifest.context.repoPath;
  const workspaceName = manifest.context.workspace;
  const repoName = manifest.context.repo;

  if (workspaceName && repoName) {
    const paths = smithPaths(config.smithRoot);
    const ws = (await loadWorkspaces(paths)).find((w) => w.name === workspaceName);
    if (ws) {
      const inst = await createInstance(workspaceDir(paths, ws), ws, manifest.taskId, [repoName]);
      const member = inst.members.find((m) => m.name === repoName);
      if (member) return member.path;
    }
  }

  // Legacy: a detached worktree under the state root. Unchanged by design.
  return repoPath
    ? resolve(repoPath, config.worktreeDir, manifest.taskId)
    : resolve(config.worktreeDir, manifest.taskId);
}
```

Then replace `prepareWorktree`'s path computation with `const worktreePath = await resolveTaskWorktree(manifest, this.config);` and **delete the now-duplicated `git worktree add` call** — `createInstance` already created it for the instance path. For the legacy path the `worktree add` must still run, so keep it guarded: run it only when the returned path is not already a git worktree. The simplest correct shape is to have `resolveTaskWorktree` return `{ path, created: boolean }` and skip the `worktree add` when `created` is true; adjust the tests to the shape you choose and say which in your report.

**Do not change** the base-branch validation at `:284`, the `smith-delegate` injection, the profile materialization, or the local-exclude step — they apply to both paths.

- [ ] **Step 4: Verify**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t4-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t4-suite.txt | grep -E "^ℹ (tests|pass|fail)"
cd swarm && ./node_modules/.bin/tsc --noEmit > /tmp/t4-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t4-tsc.txt | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+')"
npx biome check src/dispatcher.ts src/dispatcher.test.ts
```

Expected: **556 pass / 0 fail**; `errors=12`; biome clean.

- [ ] **Step 5: Commit**

```bash
git add swarm/src/dispatcher.ts swarm/src/dispatcher.test.ts
git commit -m "feat(swarm): workspace-routed tasks run in a workspace-instance

The agent starts in the instance's repo worktree with config/ alongside,
inside the workspace instead of a detached directory under the state root.
Non-workspace tasks keep the legacy path untouched."
```

---

### Task 5: Verify against the live install

**Files:** none. **No commit.**

- [ ] **Step 1: Back up**

```bash
B=$(mktemp -d)/smithagents-preplan8
mkdir -p "$B" && cp -a ~/.smithagents/workspaces "$B/workspaces"
echo "backup at $B"
```

- [ ] **Step 2: Restart on the new code and confirm nothing regressed**

```bash
PID=$(lsof -nP -iTCP:7777 -sTCP:LISTEN -t | head -1); kill "$PID"
until ! lsof -nP -iTCP:7777 -sTCP:LISTEN >/dev/null 2>&1; do sleep 1; done
cd swarm && nohup node --env-file=../.env --import tsx src/server.ts > /tmp/swarm-p8.log 2>&1 &
until curl -s -m 3 http://127.0.0.1:7777/health > /dev/null; do sleep 1; done
curl -s -m 5 http://127.0.0.1:7777/workspaces | python3 -c "
import sys,json; print('  names:', [w['name'] for w in json.load(sys.stdin)['workspaces']])"
curl -s -m 5 http://127.0.0.1:7777/work/boards | python3 -c "
import sys,json
d=json.load(sys.stdin); b=d.get('boards') or d
print('  boards:', sorted(x['id'] for x in b))"
```

Expected: `['proving-ground']` and the same four board ids. Instances change dispatch, not boot.

- [ ] **Step 3: Create an instance against the real workspace**

```bash
cd swarm && node --import tsx -e "
import { loadConfig } from './src/config.js';
import { smithPaths } from './src/paths.js';
import { loadWorkspaces, workspaceDir } from './src/workspaces.js';
import { createInstance, listInstances } from './src/workspace-instances.js';
const paths = smithPaths(loadConfig().smithRoot);
const ws = (await loadWorkspaces(paths)).find(w => w.name === 'proving-ground');
const dir = workspaceDir(paths, ws);
const inst = await createInstance(dir, ws, 'probe-1', [ws.repos[0].name]);
console.log(JSON.stringify({ dir: inst.dir, branch: inst.branch, members: inst.members.map(m => m.name) }, null, 1));
console.log('instances:', await listInstances(dir));
"
ls -1 ~/.smithagents/workspaces/proving-ground/.runtime/instances/probe-1/
git -C ~/.smithagents/workspaces/proving-ground/.runtime/instances/probe-1/config rev-parse --abbrev-ref HEAD
```

Expected: `config` and the repo name; both on `smith/probe-1`; content present in each.

- [ ] **Step 4: Confirm `.git` resolves without a bind-mount**

This is the §2.1 claim that `gitdirMount()` becomes unnecessary for instances.

```bash
I=~/.smithagents/workspaces/proving-ground/.runtime/instances/probe-1
cat "$I/config/.git"
git -C "$I/config" status --porcelain && echo "  git resolves inside the workspace"
```

Expected: the `gitdir:` pointer names a path **inside** `~/.smithagents/workspaces/proving-ground`, so one mount of the workspace directory would satisfy it.

- [ ] **Step 5: Destroy it, and confirm it refuses to discard work first**

```bash
I=~/.smithagents/workspaces/proving-ground/.runtime/instances/probe-1
echo "scratch" > "$I/config/UNSAVED.md"
cd swarm && node --import tsx -e "
import { loadConfig } from './src/config.js';
import { smithPaths } from './src/paths.js';
import { loadWorkspaces, workspaceDir } from './src/workspaces.js';
import { destroyInstance, listInstances } from './src/workspace-instances.js';
const paths = smithPaths(loadConfig().smithRoot);
const ws = (await loadWorkspaces(paths)).find(w => w.name === 'proving-ground');
const dir = workspaceDir(paths, ws);
try { await destroyInstance(dir, ws, 'probe-1', [ws.repos[0].name]); console.log('DESTROYED — WRONG, it had uncommitted work'); }
catch (e) { console.log('refused as designed:', e.message); }
await destroyInstance(dir, ws, 'probe-1', [ws.repos[0].name], { force: true });
console.log('after force, instances:', await listInstances(dir));
"
git -C ~/.smithagents/workspaces/proving-ground/config worktree list
```

Expected: the first call refuses naming `config`; the forced call removes it; `worktree list` shows only the workspace clone. **If the first call destroys the instance, the branch does not merge.**

- [ ] **Step 6: No commit**

This task produces none. If Step 3 or 5 fails, the branch does not merge.

---

## Self-review

**Spec coverage.** §2.1's instance shape (`config/` + per-repo worktrees, one branch, worktrees not clones) is Tasks 1-3. §2.2's "the instance survives past commit" is why destruction is explicit and refuses dirty members (Task 3). §4.2 step 4 ("instances last, only after paths are explicit") is satisfied — Plans 2-7 made paths explicit and put the repos inside the workspace. §2.2's *trigger* ("assigned →") is out of scope with a stated reason: no assignment concept exists. §2.3's swarm shapes and §2.1's `gitdirMount()` deletion are out of scope with reasons in **Scope**.

**Placeholders.** None, with one deliberate exception: Task 4 Step 3 names two possible shapes for the created/not-created signal and requires the implementer to state which it chose. That is a real choice between two correct designs, not an unfilled blank — the surrounding code and both tests are given.

**Type consistency.** `instancesDir`, `instanceDir`, `workIdProblem`, `InstanceMember`, `Instance`, `createInstance`, `listInstances`, `instanceIsDirty`, `destroyInstance`, `resolveTaskWorktree` are spelled identically everywhere. `createInstance` and `destroyInstance` take the same `(workspaceDir, ws, workId, repoNames)` prefix so a caller can pair them without reshaping arguments.

**Known risks, stated plainly.**
1. **Task 4 changes where every workspace-routed task runs.** Non-workspace tasks are untouched, which bounds it, but this is the hot path. Task 5 Step 3 is the gate.
2. **`git worktree add` fails if the branch already exists.** A retried task id would collide. Task 2's idempotency covers the instance directory, not a stale branch left by a destroyed instance — worth watching in review.
3. **Instances accumulate.** Nothing destroys them automatically, by design (§2.2: the instance survives past commit). Today's detached worktrees accumulate too, so this is not a regression, but the disk cost moves inside the workspace.
