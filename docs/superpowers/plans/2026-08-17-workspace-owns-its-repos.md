# The Workspace Owns Its Repos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `<workspace>/config/` a git repo, put every project repo inside the workspace directory, and record which global agents a workspace uses — so a workspace-instance can be cut as worktrees of them.

**Architecture:** A new `swarm/src/workspace-repos.ts` owns the two git operations this needs — initialising the config repo and cloning a project repo into the workspace — plus a boot migration that relocates repos recorded outside the workspace. A second small module, `swarm/src/workspace-roster.ts`, holds `config/roster.json`. Nothing deletes: a repo already checked out elsewhere gets a *fresh clone* inside the workspace and the original is left untouched. `workspaceProblems` keeps its existing contract (every repo path must already be a real git repo); the creation route simply clones **before** validating, so validation still sees real paths.

**Tech Stack:** TypeScript ~6.0.0 (ESM, `.js` import specifiers), Node >= 24, `node:test` + `node:assert/strict`, biome 2.5.3, `git` via `node:child_process`.

**Spec:** `docs/superpowers/specs/2026-08-16-workspace-instances-and-assignment-design.md` — §1.2 (workspace layout), §2.1 (why worktrees need both inside one directory), §4.2 step 3.

## Global Constraints

- Node >= 24; TypeScript ~6.0.0; ESM with `.js` import specifiers on every relative import.
- Tests use `node:test` + `node:assert/strict`. **Every test writes to `mkdtempSync(tmpdir())`. No test may touch the real state root, and no test may reach the network** — clone fixtures from a local path.
- Registry writes (`saveRegistryEntry` / `saveWorkspace`) are unlocked read-modify-write: keep them **sequential** (`for…of` with `await`). Never `Promise.all` / `.map(async …)` over workspaces.
- `saveWorkspace` throws `WorkspaceDirCollisionError` when a destination `settings.json` names a different workspace. Any new boot-path caller must catch it and continue, never let it escape and brick boot.
- **Nothing in this plan deletes or moves a user's existing checkout.** Cloning is the only acquisition path.
- Measurement traps in this repo — get these right or your numbers are meaningless:
  - Typecheck with `cd swarm && ./node_modules/.bin/tsc --noEmit`. **Never `npx tsc` from the repo root** — it resolves a decoy placeholder package that prints "This is not the tsc command you are looking for".
  - tsc ANSI-colorizes so that `grep -c 'error TS'` returns **0 while errors are on screen**. Strip ANSI first: `sed 's/\x1b\[[0-9;]*m//g'`. A count of 0 means your measurement broke.
  - `node:test` summary lines start with `ℹ`, not `#`.
  - Baselines at the start of this plan: **491 tests passing, 0 failing; tsc 12 errors** (pre-existing, in `agent-sessions.ts`, `jira-sync.test.ts`, `server.ts`); biome clean on all files this plan touches.

## Scope

**In:** `config/` as a git repo; project repos cloned into the workspace directory; migration of existing external repos; the creation route.

**Out, deliberately:**
- **`config/artifacts/` and `config/diagrams/`.** Both are *broker* documents — `broker/src/blueprints.ts:25` defines `family: "document" | "diagram" | "dashboard"` and all of them persist to `BROKER_DOCUMENTS_DIR ?? ".smith/documents"` (`broker/src/main.ts:524`), a cwd-relative path that nothing sets. The broker is one process serving every workspace, so per-workspace artifacts need per-request resolution, not the startup env-injection §4.4 proposes for `roster-state.json`/`memory.json`. That is the "does the broker become workspace-aware or stay a router" question §4.4 explicitly leaves open. It needs a design decision before it needs a plan.
- **Deleting `gitdirMount()`** (`swarm/src/runtime.ts:288`). §2.1 says it becomes unnecessary once both the worktree and its parent `.git` live inside one directory — but today's task worktrees are cut by `dispatcher.prepareWorktree`, not by an instance, and where they land is instance-plan work. Removing the mount before instances exist would break docker task dispatch. Revisit when §2.1 lands.

---

### Task 1: The config repo

`<workspace>/config/` is the versioned half of a workspace. It has to be a real git repo before an instance can cut a worktree from it.

**Files:**
- Create: `swarm/src/workspace-repos.ts`
- Create: `swarm/src/workspace-repos.test.ts`

**Interfaces:**
- Consumes: `settingsPathFor(dir: string): string` from `./workspaces.js`.
- Produces: `ensureConfigRepo(workspaceDir: string): Promise<boolean>` — returns `true` if it initialised a new repo, `false` if one was already there. Idempotent.

- [ ] **Step 1: Write the failing tests**

Create `swarm/src/workspace-repos.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureConfigRepo } from "./workspace-repos.js";

test("ensureConfigRepo: turns config/ into a git repo with the settings file committed", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cfgrepo-"));
  try {
    mkdirSync(join(ws, "config"), { recursive: true });
    writeFileSync(join(ws, "config", "settings.json"), '{"name":"pg","repos":[]}\n');

    const created = await ensureConfigRepo(ws);

    assert.equal(created, true, "reports that it created the repo");
    const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], { cwd: join(ws, "config") }).toString().trim();
    assert.ok(gitDir.length > 0, "config/ is a git repo");
    const tracked = execFileSync("git", ["ls-files"], { cwd: join(ws, "config") }).toString();
    assert.match(tracked, /settings\.json/, "the settings file is committed, not just present");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("ensureConfigRepo: is idempotent and never rewrites history", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cfgrepo-twice-"));
  try {
    mkdirSync(join(ws, "config"), { recursive: true });
    writeFileSync(join(ws, "config", "settings.json"), '{"name":"pg","repos":[]}\n');
    await ensureConfigRepo(ws);
    const first = execFileSync("git", ["rev-parse", "HEAD"], { cwd: join(ws, "config") }).toString().trim();

    const created = await ensureConfigRepo(ws);

    assert.equal(created, false, "reports that it found an existing repo");
    const second = execFileSync("git", ["rev-parse", "HEAD"], { cwd: join(ws, "config") }).toString().trim();
    assert.equal(second, first, "HEAD is unchanged — no new commit, no re-init");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("ensureConfigRepo: an existing repo with uncommitted edits is left completely alone", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cfgrepo-dirty-"));
  try {
    mkdirSync(join(ws, "config"), { recursive: true });
    writeFileSync(join(ws, "config", "settings.json"), '{"name":"pg","repos":[]}\n');
    await ensureConfigRepo(ws);
    writeFileSync(join(ws, "config", "settings.json"), '{"name":"pg","repos":[],"edited":true}\n');

    await ensureConfigRepo(ws);

    const status = execFileSync("git", ["status", "--porcelain"], { cwd: join(ws, "config") }).toString();
    assert.match(status, /settings\.json/, "the edit is still uncommitted — we did not commit on the user's behalf");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/workspace-repos.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -20
```

Expected: FAIL — cannot find module `./workspace-repos.js`.

- [ ] **Step 3: Implement**

Create `swarm/src/workspace-repos.ts`:

```ts
import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Commit identity for repos this code creates on the user's behalf. Their own
 * commits use their own identity; this only labels the initial import so a
 * machine with no global git identity does not fail to initialise a workspace.
 */
const AUTHOR = ["-c", "user.name=smithagents", "-c", "user.email=smithagents@localhost"];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Whether this directory is a git repo with at least one commit. */
async function hasCommit(dir: string): Promise<boolean> {
  try {
    await run("git", ["rev-parse", "--verify", "HEAD"], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

/**
 * Make `<workspaceDir>/config` a git repo, committing whatever is already in it
 * (settings.json, boards/). Returns true if it made the repo usable, false if it
 * already was.
 *
 * "Already a repo" means HEAD RESOLVES, not that `.git` exists. The three git
 * calls below have no rollback, so a failure after `init` leaves a `.git` with
 * zero commits — and a `.git`-exists check would then return false forever, with
 * no recovery. Worse, `git worktree add` against a commit-less repo does not
 * error: git infers `--orphan` and hands back an EMPTY worktree, so an instance
 * cut from it would silently have no settings.json and no boards/. Checking HEAD
 * makes the function self-healing instead.
 *
 * Idempotent in the strong sense: a repo that already has a commit is never
 * re-initialised and never gets a new one, so uncommitted edits the user is
 * holding stay uncommitted. Committing on their behalf would put half-finished
 * work into history they did not ask for.
 */
export async function ensureConfigRepo(workspaceDir: string): Promise<boolean> {
  const dir = join(workspaceDir, "config");
  await mkdir(dir, { recursive: true });
  if (await hasCommit(dir)) return false;

  if (!(await exists(join(dir, ".git")))) {
    await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
  }
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", [...AUTHOR, "commit", "-q", "--allow-empty", "-m", "Workspace config"], { cwd: dir });
  return true;
}
```

A fourth test covers the recovery path — a `config/` where `git init` ran but no commit exists:

```ts
test("ensureConfigRepo: completes a repo that was initialised but never committed", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cfgrepo-halfinit-"));
  try {
    mkdirSync(join(ws, "config"), { recursive: true });
    writeFileSync(join(ws, "config", "settings.json"), '{"name":"pg","repos":[]}\n');
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: join(ws, "config") });

    const created = await ensureConfigRepo(ws);

    assert.equal(created, true, "a commit-less repo is not 'already there'");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: join(ws, "config") }).toString().trim();
    assert.ok(head.length > 0, "HEAD resolves — a worktree cut from this will not be an empty orphan");
    assert.match(execFileSync("git", ["ls-files"], { cwd: join(ws, "config") }).toString(), /settings\.json/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Run them to verify they pass**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/workspace-repos.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add swarm/src/workspace-repos.ts swarm/src/workspace-repos.test.ts
git commit -m "feat(swarm): a workspace's config/ is a git repo

An instance is a worktree of <workspace>/config, so config/ has to be a real
repo before instances can exist. Initialising never touches an existing repo
and never commits on the user's behalf."
```

---

### Task 2: Clone a project repo into the workspace

**Files:**
- Modify: `swarm/src/workspace-repos.ts`
- Test: `swarm/src/workspace-repos.test.ts`

**Interfaces:**
- Consumes: `WorkspaceRepo` from `./workspaces.js` — `{ name: string; path: string; repository?: string; branch?: string; github?: { owner: string; repo: string; connectorId?: string } }`.
- Produces:
  - `repoDirFor(workspaceDir: string, repo: WorkspaceRepo): string` — `join(workspaceDir, repo.name)`.
  - `cloneRepoInto(workspaceDir: string, repo: WorkspaceRepo): Promise<string>` — returns the absolute path of the in-workspace clone. No-op returning that path if it is already a git repo. Throws if `repo.repository` is absent.

- [ ] **Step 1: Write the failing tests**

Append to `swarm/src/workspace-repos.test.ts` (add `cloneRepoInto`, `repoDirFor` to the existing import from `./workspace-repos.js`, and `readFileSync`, `statSync` to the `node:fs` import):

```ts
/** A real local git repo to clone from — never the network. */
function makeOrigin(label: string): string {
  const origin = mkdtempSync(join(tmpdir(), `origin-${label}-`));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: origin });
  writeFileSync(join(origin, "README.md"), "origin content\n");
  execFileSync("git", ["add", "-A"], { cwd: origin });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: origin });
  return origin;
}

test("cloneRepoInto: clones into <workspace>/<repo name> and returns that path", async () => {
  const ws = mkdtempSync(join(tmpdir(), "clone-"));
  const origin = makeOrigin("a");
  try {
    const path = await cloneRepoInto(ws, { name: "app", path: "", repository: origin });

    assert.equal(path, join(ws, "app"), "returns the in-workspace path");
    assert.ok(statSync(join(ws, "app", ".git")).isDirectory(), "it is a real clone");
    assert.equal(readFileSync(join(ws, "app", "README.md"), "utf8"), "origin content\n");
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("cloneRepoInto: an existing clone is reused, not re-cloned over", async () => {
  const ws = mkdtempSync(join(tmpdir(), "clone-twice-"));
  const origin = makeOrigin("b");
  try {
    await cloneRepoInto(ws, { name: "app", path: "", repository: origin });
    writeFileSync(join(ws, "app", "LOCAL.md"), "local work\n");

    const path = await cloneRepoInto(ws, { name: "app", path: "", repository: origin });

    assert.equal(path, join(ws, "app"));
    assert.equal(
      readFileSync(join(ws, "app", "LOCAL.md"), "utf8"),
      "local work\n",
      "local work in an existing clone survives — we did not clone over it",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("cloneRepoInto: refuses a repo with no remote to clone from", async () => {
  const ws = mkdtempSync(join(tmpdir(), "clone-norepo-"));
  try {
    await assert.rejects(
      () => cloneRepoInto(ws, { name: "app", path: "/somewhere/else" }),
      /no repository URL/i,
      "says why it cannot be cloned",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("cloneRepoInto: checks out the recorded branch", async () => {
  const ws = mkdtempSync(join(tmpdir(), "clone-branch-"));
  const origin = makeOrigin("c");
  try {
    execFileSync("git", ["checkout", "-q", "-b", "develop"], { cwd: origin });
    writeFileSync(join(origin, "ON_DEVELOP.md"), "yes\n");
    execFileSync("git", ["add", "-A"], { cwd: origin });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "dev"], { cwd: origin });
    execFileSync("git", ["checkout", "-q", "main"], { cwd: origin });

    await cloneRepoInto(ws, { name: "app", path: "", repository: origin, branch: "develop" });

    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: join(ws, "app") }).toString().trim();
    assert.equal(branch, "develop");
    assert.ok(statSync(join(ws, "app", "ON_DEVELOP.md")).isFile());
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'cloneRepoInto' 'src/workspace-repos.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -20
```

Expected: FAIL — `cloneRepoInto is not a function`.

- [ ] **Step 3: Implement**

Add to `swarm/src/workspace-repos.ts` (extend the `./workspaces.js` import with `type WorkspaceRepo` and `isGitRepo`):

```ts
/** Where a project repo lives inside its workspace. */
export function repoDirFor(workspaceDir: string, repo: WorkspaceRepo): string {
  return join(workspaceDir, repo.name);
}

/**
 * Clone a project repo into its workspace and return the absolute path.
 *
 * An existing clone is REUSED, never cloned over: it may hold the user's
 * uncommitted work, and re-cloning would destroy it. Callers that want a fresh
 * copy delete the directory first, deliberately.
 *
 * Requires `repository`. A repo recorded only as a local path has nothing to
 * clone from, and inventing a remote from its path would silently bind the
 * workspace to a checkout it does not own.
 */
export async function cloneRepoInto(workspaceDir: string, repo: WorkspaceRepo): Promise<string> {
  const dir = repoDirFor(workspaceDir, repo);
  if (await isGitRepo(dir)) return dir;
  if (!repo.repository) {
    throw new Error(
      `Repo "${repo.name}" has no repository URL, so it cannot be cloned into ${workspaceDir} — ` +
        `add a remote to the workspace record, or leave the repo where it is`,
    );
  }
  await mkdir(workspaceDir, { recursive: true });
  const branch = repo.branch ? ["--branch", repo.branch] : [];
  await run("git", ["clone", "-q", ...branch, repo.repository, dir]);
  return dir;
}
```

- [ ] **Step 4: Run them to verify they pass, then the whole file**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/workspace-repos.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add swarm/src/workspace-repos.ts swarm/src/workspace-repos.test.ts
git commit -m "feat(swarm): clone a project repo into its workspace

An existing clone is reused rather than cloned over — it may hold uncommitted
work. A repo with no remote cannot be cloned and says so."
```

---

### Task 3: Creating a workspace clones its repos

Today `POST /workspaces` requires every repo to already be a git repo on disk (`workspaceProblems`, `server.ts:3586-3593`). This task clones first, so validation still sees real paths and its contract is unchanged.

**Files:**
- Modify: `swarm/src/workspace-repos.ts`
- Modify: `swarm/src/server.ts` — the `POST /workspaces` handler
- Test: `swarm/src/workspace-repos.test.ts`

**Interfaces:**
- Consumes: `cloneRepoInto`, `repoDirFor`, `ensureConfigRepo` (Tasks 1-2); `ensureWorkspaceDir(paths: SmithPaths, ws: Workspace): Promise<string>`, `isGitRepo(path: string): Promise<boolean>`, `type Workspace`, `type SmithPaths` from `./workspaces.js` / `./paths.js`.
- Produces: `materializeRepos(paths: SmithPaths, ws: Workspace): Promise<Workspace>` — ensures the workspace directory and its config repo, clones every repo that is not already a usable local git repo, and returns a **copy** of `ws` whose `repos[].path` point at the in-workspace clones. Repos already at a valid local path are left exactly as recorded.

- [ ] **Step 1: Write the failing tests**

Append to `swarm/src/workspace-repos.test.ts` (add `materializeRepos` to the import, plus `smithPaths` from `./paths.js`):

```ts
test("materializeRepos: clones a URL-only repo and repoints its path inside the workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "mat-"));
  const origin = makeOrigin("d");
  try {
    const paths = smithPaths(root);
    const ws = { name: "pg", repos: [{ name: "app", path: "", repository: origin }] };

    const out = await materializeRepos(paths, ws);

    const expected = join(paths.workspaces, "pg", "app");
    assert.equal(out.repos[0].path, expected, "path now points inside the workspace");
    assert.ok(statSync(join(expected, ".git")).isDirectory(), "and there is a real clone there");
    assert.equal(ws.repos[0].path, "", "the input record was not mutated");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("materializeRepos: a repo already at a valid local path is left where it is", async () => {
  const root = mkdtempSync(join(tmpdir(), "mat-keep-"));
  const origin = makeOrigin("e");
  try {
    const paths = smithPaths(root);
    const ws = { name: "pg", repos: [{ name: "app", path: origin, repository: origin }] };

    const out = await materializeRepos(paths, ws);

    assert.equal(out.repos[0].path, origin, "an existing valid checkout is not relocated during creation");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("materializeRepos: also makes config/ a git repo", async () => {
  const root = mkdtempSync(join(tmpdir(), "mat-cfg-"));
  const origin = makeOrigin("f");
  try {
    const paths = smithPaths(root);

    await materializeRepos(smithPaths(root), { name: "pg", repos: [{ name: "app", path: "", repository: origin }] });

    const cfg = join(paths.workspaces, "pg", "config");
    assert.ok(statSync(join(cfg, ".git")).isDirectory(), "config/ is a repo after creation");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'materializeRepos' 'src/workspace-repos.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -20
```

Expected: FAIL — `materializeRepos is not a function`.

- [ ] **Step 3: Implement `materializeRepos`**

Add to `swarm/src/workspace-repos.ts`:

```ts
/**
 * Give a workspace the shape §1.2 requires before it is saved: its own
 * directory, a git config repo, and every project repo present locally.
 *
 * A repo already at a valid local git path is LEFT THERE. Creation is not the
 * moment to relocate someone's existing checkout — the boot migration handles
 * that deliberately, and non-destructively.
 *
 * Returns a copy; the caller's record is never mutated.
 */
export async function materializeRepos(paths: SmithPaths, ws: Workspace): Promise<Workspace> {
  const dir = await ensureWorkspaceDir(paths, ws);
  await ensureConfigRepo(dir);
  const repos: WorkspaceRepo[] = [];
  for (const repo of ws.repos) {
    if (repo.path && (await isGitRepo(repo.path))) {
      repos.push(repo);
      continue;
    }
    repos.push({ ...repo, path: await cloneRepoInto(dir, repo) });
  }
  return { ...ws, repos };
}
```

- [ ] **Step 4: Run them to verify they pass**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/workspace-repos.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
```

Expected: 10 tests pass.

- [ ] **Step 5: Wire it into `POST /workspaces`**

Read `swarm/src/server.ts:1815-1876` before editing. The handler's real order is:

1. `:1817` `gitInitRequestedRepos(b.repos)` — pre-existing, git-inits an **empty local path** for any repo sent with `initGit: true`. **Leave it exactly as it is.** It is complementary to cloning: it runs first, so a repo it initialises is already a git repo by the time `materializeRepos` looks at it, and gets left alone.
2. `:1819` `workspaceProblems(b)` — runs against the **raw request body**, before `ws` exists.
3. `:1832` the name is slugified.
4. `:1848` the `ws: Workspace` record is built.
5. `:1864` a `try` block: `ensureWorkspaceDir` → `assertNoWorkspaceDirCollision` → demote → `saveWorkspace`.

`materializeRepos(paths, ws)` needs a `Workspace` with its final name, so it cannot run before step 2. And `workspaceProblems` rejects any repo whose path is not already a git repo (`:3592`), which would reject a URL-only repo before it could ever be cloned. So make these three changes:

**(a)** Give `workspaceProblems` an options parameter, defaulting to the current strict behaviour so the `PUT` call at `:1935` is unchanged:

```ts
export async function workspaceProblems(
  b: Partial<Workspace>,
  opts: { requireLocalRepos?: boolean } = {},
): Promise<string | null> {
```

and guard only the on-disk check at `:3592` with it:

```ts
    if (opts.requireLocalRepos !== false && !(await isGitRepo(r.path))) {
      return `Repo "${r.name}": ${r.path} is not a git repository`;
    }
```

Leave every other check — name, absolute path, GitHub fields, links, Atlassian — running in both modes. Note the path check at `:3591` still requires an absolute path, so a URL-only repo must be submitted with `path: ""`; that is why the pre-clone call also relaxes nothing else.

**(b)** At `:1819`, relax only the pre-clone pass:

```ts
      // Pre-clone: a repo may be a remote URL with no local checkout yet, so
      // the on-disk check cannot run until materializeRepos has cloned it.
      // Everything else about the payload is still validated here.
      const problem = await workspaceProblems(b, { requireLocalRepos: false });
```

**(c)** Inside the existing `try` at `:1864`, clone before anything is written, then re-validate strictly. Import `materializeRepos` from `./workspace-repos.js`:

```ts
      let record = ws;
      try {
        // Clone first: the strict validation below is the invariant every
        // saved record must satisfy, and it can only be checked once the
        // repos actually exist on disk.
        record = await materializeRepos(this.paths, ws);
        const settled = await workspaceProblems(record);
        if (settled) return reply.status(400).send({ error: settled });
        await ensureWorkspaceDir(this.paths, record);
        await assertNoWorkspaceDirCollision(this.paths, record);
        ...
```

and use `record` in place of `ws` for the rest of the block (the demote loop's `saveWorkspace(this.paths, record)` and the response). A clone failure is a bad payload, not a server fault, so the existing `catch` should return its message as a 400 — which it already does for non-collision errors.

The saved-record contract is unchanged: `workspaceProblems` still guarantees every persisted repo path is an absolute, real git repo. It simply now runs on the post-clone record.

- [ ] **Step 6: Verify the whole suite, typecheck, lint**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t3-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t3-suite.txt | grep -E "^ℹ (tests|pass|fail)"
cd swarm && ./node_modules/.bin/tsc --noEmit > /tmp/t3-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t3-tsc.txt | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+')"
npx biome check src/workspace-repos.ts src/workspace-repos.test.ts src/server.ts
```

Expected: 501 pass / 0 fail; `errors=12`; biome clean.

- [ ] **Step 7: Commit**

```bash
git add swarm/src/workspace-repos.ts swarm/src/workspace-repos.test.ts swarm/src/server.ts
git commit -m "feat(swarm): creating a workspace clones its repos into it

materializeRepos runs before workspaceProblems, so validation still sees real
git paths and keeps its contract. An existing valid checkout is left where it
is — creation is not the moment to relocate someone's working copy."
```

---

### Task 4: Migrate repos recorded outside their workspace

The live install records `proving-ground`'s repo at `~/Development/Workspaces/proving-ground/smith-agent-proving-ground` — outside the workspace. **Decision (Edwin, 2026-08-17): clone a fresh copy inside; leave the original untouched.**

**Files:**
- Modify: `swarm/src/workspace-repos.ts`
- Modify: `swarm/src/server.ts` — boot, beside the existing workspace-record migration
- Test: `swarm/src/workspace-repos.test.ts`

**Interfaces:**
- Consumes: `loadWorkspaces(paths: SmithPaths): Promise<Workspace[]>`, `saveWorkspace(paths: SmithPaths, ws: Workspace): Promise<void>`, `workspaceDir(paths: SmithPaths, ws: Workspace): string`, `WorkspaceDirCollisionError` from `./workspaces.js`.
- Produces: `migrateReposIntoWorkspace(paths: SmithPaths): Promise<{ cloned: string[]; skipped: string[]; notes: string[] }>` — entries are `"<workspace>/<repo>"`.

- [ ] **Step 1: Write the failing tests**

Append to `swarm/src/workspace-repos.test.ts` (add `migrateReposIntoWorkspace` to the import, plus `loadWorkspaces`, `saveWorkspace` from `./workspaces.js`):

```ts
test("migrateReposIntoWorkspace: clones an external repo inside and repoints the record", async () => {
  const root = mkdtempSync(join(tmpdir(), "migrepo-"));
  const origin = makeOrigin("g");
  try {
    const paths = smithPaths(root);
    await saveWorkspace(paths, { name: "pg", repos: [{ name: "app", path: origin, repository: origin }] });

    const result = await migrateReposIntoWorkspace(paths);

    assert.deepEqual(result.cloned, ["pg/app"]);
    const [ws] = await loadWorkspaces(paths);
    assert.equal(ws.repos[0].path, join(paths.workspaces, "pg", "app"), "record points inside the workspace");
    assert.ok(statSync(join(origin, ".git")).isDirectory(), "THE ORIGINAL CHECKOUT IS UNTOUCHED");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("migrateReposIntoWorkspace: an external repo with no remote is left alone, with a note", async () => {
  const root = mkdtempSync(join(tmpdir(), "migrepo-nourl-"));
  const origin = makeOrigin("h");
  try {
    const paths = smithPaths(root);
    await saveWorkspace(paths, { name: "pg", repos: [{ name: "app", path: origin }] });

    const result = await migrateReposIntoWorkspace(paths);

    assert.deepEqual(result.cloned, []);
    assert.deepEqual(result.skipped, ["pg/app"]);
    assert.equal((await loadWorkspaces(paths))[0].repos[0].path, origin, "record unchanged");
    assert.ok(
      result.notes.some((n) => n.includes("pg/app") && /repository URL/i.test(n)),
      "the note says what is missing",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("migrateReposIntoWorkspace: is idempotent — a second run moves nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "migrepo-twice-"));
  const origin = makeOrigin("i");
  try {
    const paths = smithPaths(root);
    await saveWorkspace(paths, { name: "pg", repos: [{ name: "app", path: origin, repository: origin }] });
    await migrateReposIntoWorkspace(paths);

    const second = await migrateReposIntoWorkspace(paths);

    assert.deepEqual(second.cloned, [], "nothing left to clone");
    assert.deepEqual(second.skipped, [], "and nothing is reported as a problem");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("migrateReposIntoWorkspace: one bad workspace does not stop the others", async () => {
  const root = mkdtempSync(join(tmpdir(), "migrepo-isolate-"));
  const origin = makeOrigin("j");
  try {
    const paths = smithPaths(root);
    await saveWorkspace(paths, { name: "bad", repos: [{ name: "app", path: "/nope", repository: "/does/not/exist" }] });
    await saveWorkspace(paths, { name: "good", repos: [{ name: "app", path: origin, repository: origin }] });

    const result = await migrateReposIntoWorkspace(paths);

    assert.ok(result.cloned.includes("good/app"), "the healthy workspace still migrated");
    assert.ok(result.skipped.includes("bad/app"), "the broken one is reported, not thrown");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'migrateReposIntoWorkspace' 'src/workspace-repos.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -20
```

Expected: FAIL — `migrateReposIntoWorkspace is not a function`.

- [ ] **Step 3: Implement**

Add to `swarm/src/workspace-repos.ts`:

```ts
/**
 * Relocate project repos recorded OUTSIDE their workspace to a clone inside it.
 *
 * Non-destructive by decision (Edwin, 2026-08-17): the external checkout is
 * never moved or deleted, only cloned from its remote. The consequence is real
 * and worth stating — the fresh clone does NOT carry uncommitted work from the
 * old checkout, so anything unstaged there stays there, in a directory the
 * workspace no longer points at.
 *
 * A repo with no `repository` cannot be cloned; it keeps its external path and
 * is reported in `skipped`. That workspace cannot host an instance until it is
 * given a remote — which is what the note says.
 *
 * Runs at boot. One bad workspace is isolated, never fatal: a throw here would
 * brick every subsequent start.
 */
export async function migrateReposIntoWorkspace(
  paths: SmithPaths,
): Promise<{ cloned: string[]; skipped: string[]; notes: string[] }> {
  const cloned: string[] = [];
  const skipped: string[] = [];
  const notes: string[] = [];

  for (const ws of await loadWorkspaces(paths)) {
    const dir = workspaceDir(paths, ws);
    const repos: WorkspaceRepo[] = [];
    let changed = false;

    for (const repo of ws.repos) {
      const label = `${ws.name}/${repo.name}`;
      const inside = repoDirFor(dir, repo);
      if (repo.path === inside) {
        repos.push(repo);
        continue;
      }
      if (!repo.repository) {
        skipped.push(label);
        notes.push(
          `[repo-migration] ${label} lives outside its workspace at ${repo.path} and has no repository URL to ` +
            `clone from — add a remote to the workspace record, or leave it where it is; until then this ` +
            `workspace cannot host an instance`,
        );
        repos.push(repo);
        continue;
      }
      try {
        repos.push({ ...repo, path: await cloneRepoInto(dir, repo) });
        cloned.push(label);
        changed = true;
      } catch (err) {
        skipped.push(label);
        notes.push(`[repo-migration] ${label} could not be cloned into ${dir} — ${(err as Error).message}`);
        repos.push(repo);
      }
    }

    if (!changed) continue;
    try {
      await ensureConfigRepo(dir);
      await saveWorkspace(paths, { ...ws, repos });
    } catch (err) {
      notes.push(`[repo-migration] cloned ${ws.name}'s repos but could not save the record — ${(err as Error).message}`);
    }
  }
  return { cloned, skipped, notes };
}
```

- [ ] **Step 4: Run them to verify they pass**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/workspace-repos.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
```

Expected: 14 tests pass.

- [ ] **Step 5: Wire it into boot**

In `swarm/src/server.ts`, immediately after the existing `migrateWorkspaceRecords` block and still **before** `reloadWorkspaces()` — records must be in their final location before repos are resolved from them:

```ts
    {
      const repos = await migrateReposIntoWorkspace(this.paths);
      if (repos.cloned.length > 0) this.app.log.info(`[repo-migration] cloned: ${repos.cloned.join(", ")}`);
      for (const note of repos.notes) this.app.log.warn(note);
    }
```

Import `migrateReposIntoWorkspace` from `./workspace-repos.js`. Log `cloned` at info even though `notes` covers problems — a silent successful migration is exactly what left the previous plan's live verification with nothing to confirm.

- [ ] **Step 6: Verify, typecheck, lint**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t4-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t4-suite.txt | grep -E "^ℹ (tests|pass|fail)"
cd swarm && ./node_modules/.bin/tsc --noEmit > /tmp/t4-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t4-tsc.txt | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+')"
npx biome check src/workspace-repos.ts src/workspace-repos.test.ts src/server.ts
```

Expected: 505 pass / 0 fail; `errors=12`; biome clean.

- [ ] **Step 7: Commit**

```bash
git add swarm/src/workspace-repos.ts swarm/src/workspace-repos.test.ts swarm/src/server.ts
git commit -m "feat(swarm): relocate external project repos into their workspace

Clones from the remote and repoints the record; the original checkout is never
moved or deleted. A repo with no remote keeps its external path and gets a note
saying it cannot host an instance until it has one."
```

---

### Task 5: `config/roster.json`

§4.1: *"Definitions are global; assignments are per workspace."* `agents`, `squads`, `avatars` and `blueprints` stay at the host root; a workspace records which it uses here.

**This task ships the file WITH a reader.** A record nothing consumes is the exact shape that produced two findings in the previous plan — `migrateWorkspaceRecords` landed with no caller, and `collidingWorkspaceDirs` sat uncalled while the collision it detects went unguarded. So the endpoint lands in the same task as the file.

**Behaviour must not change.** Today every agent is available in every workspace. This task records that fact; it does **not** start gating on it. Gating is §2.3's job, when instances need to generate member definitions. Hence the absent/empty distinction below — get it wrong and a missing file silently means "this workspace has no agents."

**Files:**
- Create: `swarm/src/workspace-roster.ts`
- Create: `swarm/src/workspace-roster.test.ts`
- Modify: `swarm/src/server.ts` — one route, plus seeding in the boot migration

**Interfaces:**
- Consumes: `ensureConfigRepo` (Task 1); `workspaceDir`, `loadWorkspaces`, `type SmithPaths` from `./workspaces.js` / `./paths.js`.
- Produces:
  - `interface WorkspaceRoster { agents: string[]; squads: string[] }`
  - `rosterPathFor(workspaceDir: string): string`
  - `loadRoster(workspaceDir: string): Promise<WorkspaceRoster | null>` — **`null` when the file is absent** (never recorded), a roster when present, and **throws** when present but malformed.
  - `saveRoster(workspaceDir: string, roster: WorkspaceRoster): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `swarm/src/workspace-roster.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadRoster, rosterPathFor, saveRoster } from "./workspace-roster.js";

test("loadRoster: an absent roster is null, NOT an empty one", async () => {
  const ws = mkdtempSync(join(tmpdir(), "roster-absent-"));
  try {
    const roster = await loadRoster(ws);
    assert.equal(roster, null, "absent means 'never recorded', which callers must not read as 'no agents'");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("loadRoster: an empty roster is a real, distinct value", async () => {
  const ws = mkdtempSync(join(tmpdir(), "roster-empty-"));
  try {
    await saveRoster(ws, { agents: [], squads: [] });
    const roster = await loadRoster(ws);
    assert.deepEqual(roster, { agents: [], squads: [] }, "deliberately empty is not the same as absent");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("loadRoster: a malformed roster throws rather than looking unrecorded", async () => {
  const ws = mkdtempSync(join(tmpdir(), "roster-bad-"));
  try {
    mkdirSync(join(ws, "config"), { recursive: true });
    writeFileSync(rosterPathFor(ws), "{not json");
    await assert.rejects(() => loadRoster(ws), /roster/i, "a corrupt roster must never read as a fresh workspace");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("loadRoster: a roster missing its arrays is malformed, not partially valid", async () => {
  const ws = mkdtempSync(join(tmpdir(), "roster-shape-"));
  try {
    mkdirSync(join(ws, "config"), { recursive: true });
    writeFileSync(rosterPathFor(ws), '{"agents":"fabian"}');
    await assert.rejects(() => loadRoster(ws), /roster/i);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("saveRoster: round-trips and lands inside config/", async () => {
  const ws = mkdtempSync(join(tmpdir(), "roster-rt-"));
  try {
    await saveRoster(ws, { agents: ["fabian"], squads: ["core"] });
    assert.equal(rosterPathFor(ws), join(ws, "config", "roster.json"));
    assert.deepEqual(await loadRoster(ws), { agents: ["fabian"], squads: ["core"] });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/workspace-roster.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -20
```

Expected: FAIL — cannot find module `./workspace-roster.js`.

- [ ] **Step 3: Implement**

Create `swarm/src/workspace-roster.ts`:

```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Which GLOBAL agents and squads this workspace uses. Definitions live at the
 * host root (§4.1: definitions are global, assignments are per workspace);
 * this records only the assignment.
 */
export interface WorkspaceRoster {
  agents: string[];
  squads: string[];
}

/** A workspace's roster, inside its config repo. */
export function rosterPathFor(workspaceDir: string): string {
  return join(workspaceDir, "config", "roster.json");
}

function assertRoster(file: string, value: unknown): WorkspaceRoster {
  const o = value as Partial<WorkspaceRoster> | null;
  const ok =
    o &&
    typeof o === "object" &&
    Array.isArray(o.agents) &&
    Array.isArray(o.squads) &&
    o.agents.every((a) => typeof a === "string") &&
    o.squads.every((s) => typeof s === "string");
  if (!ok) throw new Error(`Invalid roster file ${file}: requires agents[] and squads[] of strings`);
  return o as WorkspaceRoster;
}

/**
 * This workspace's roster, or `null` if it has never had one.
 *
 * The absent/empty distinction is load-bearing and callers must respect it:
 * `null` means "not recorded, every global agent applies" — today's behaviour —
 * while `{agents: [], squads: []}` means someone deliberately assigned nothing.
 * Collapsing them would turn a missing file into a workspace with no agents.
 *
 * A malformed roster THROWS. Returning null on a parse failure would make a
 * corrupt file indistinguishable from a workspace that never had a roster.
 */
export async function loadRoster(workspaceDir: string): Promise<WorkspaceRoster | null> {
  const file = rosterPathFor(workspaceDir);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return assertRoster(file, JSON.parse(raw));
}

export async function saveRoster(workspaceDir: string, roster: WorkspaceRoster): Promise<void> {
  const file = rosterPathFor(workspaceDir);
  await mkdir(join(workspaceDir, "config"), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(roster, null, 2)}\n`);
  await rename(tmp, file);
}
```

- [ ] **Step 4: Run them to verify they pass**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/workspace-roster.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
```

Expected: 5 tests pass.

- [ ] **Step 5: Give it a reader — `GET /workspaces/:name/roster`**

In `swarm/src/server.ts`, beside the other `/workspaces/:name` routes. Import `loadRoster` from `./workspace-roster.js` and `workspaceDir` from `./workspaces.js`:

```ts
    this.app.get<{ Params: { name: string } }>("/workspaces/:name/roster", async (req, reply) => {
      const all = await loadWorkspaces(this.paths);
      const ws = all.find((w) => w.name === req.params.name);
      if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
      const roster = await loadRoster(workspaceDir(this.paths, ws));
      // `recorded: false` is the honest answer for a workspace that has never
      // had a roster: every global agent applies, which is today's behaviour.
      // Returning empty arrays would claim it was assigned nothing.
      return roster ? { recorded: true, ...roster } : { recorded: false, agents: [], squads: [] };
    });
```

- [ ] **Step 6: Seed it during the boot migration**

In `migrateReposIntoWorkspace`'s per-workspace body in `swarm/src/workspace-repos.ts`, after `ensureConfigRepo(dir)`, record the roster if it has never been recorded. Import `loadRoster`, `saveRoster` from `./workspace-roster.js`:

```ts
    // Record today's assignment — every global agent and squad — so the file
    // exists and is committed with the config repo. This preserves current
    // behaviour exactly; it does not start gating on the roster.
    if ((await loadRoster(dir)) === null) {
      await saveRoster(dir, { agents: globalAgentIds, squads: globalSquadIds });
    }
```

`migrateReposIntoWorkspace` gains two parameters for this — change its signature to `migrateReposIntoWorkspace(paths: SmithPaths, globalAgentIds: string[], globalSquadIds: string[])` and update its Task 4 tests to pass `[]`, `[]`. At the boot call site, pass the ids the server already has in hand from its agent registry and `SQUAD_ROSTER`.

- [ ] **Step 7: Verify, typecheck, lint**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t5-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t5-suite.txt | grep -E "^ℹ (tests|pass|fail)"
cd swarm && ./node_modules/.bin/tsc --noEmit > /tmp/t5-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t5-tsc.txt | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+')"
npx biome check src/workspace-roster.ts src/workspace-roster.test.ts src/workspace-repos.ts src/server.ts
```

Expected: 510 pass / 0 fail; `errors=12`; biome clean.

- [ ] **Step 8: Commit**

```bash
git add swarm/src/workspace-roster.ts swarm/src/workspace-roster.test.ts swarm/src/workspace-repos.ts swarm/src/server.ts
git commit -m "feat(swarm): a workspace records which global agents it uses

config/roster.json per §4.1 — definitions are global, assignments are per
workspace. Absent means 'never recorded, every agent applies' and is distinct
from a deliberately empty roster; malformed throws. Seeded with today's full
set, so behaviour is unchanged: this records the assignment, it does not gate
on it. Gating belongs to §2.3."
```

---

### Task 6: Verify against the live install

**Files:** none. **No commit.**

The install has one workspace, `proving-ground`, whose repo is recorded at `/Users/edwincruz/Development/Workspaces/proving-ground/smith-agent-proving-ground` — outside the workspace — with `repository: https://github.com/ecruz165/smith-agent-proving-ground.git`.

- [ ] **Step 1: Back up first**

```bash
B=$(mktemp -d)/smithagents-preplan7
mkdir -p "$B" && cp -a ~/.smithagents/workspaces "$B/workspaces"
echo "backup at $B"
```

- [ ] **Step 2: Record the before state**

```bash
cat ~/.smithagents/workspaces/proving-ground/config/settings.json | python3 -c "
import sys,json
w=json.load(sys.stdin); print('  repos:', [(r['name'], r['path']) for r in w['repos']])"
ls -1 ~/.smithagents/workspaces/proving-ground/
curl -s -m 5 http://127.0.0.1:7777/workspaces | python3 -c "
import sys,json; print('  names:', [w['name'] for w in json.load(sys.stdin)['workspaces']])"
```

Save the workspace name list — it is the invariant for Step 4.

- [ ] **Step 3: Restart on the new code**

```bash
PID=$(lsof -nP -iTCP:7777 -sTCP:LISTEN -t | head -1); kill "$PID"
until ! lsof -nP -iTCP:7777 -sTCP:LISTEN >/dev/null 2>&1; do sleep 1; done
cd swarm && nohup node --env-file=../.env --import tsx src/server.ts > /tmp/swarm-p7.log 2>&1 &
until curl -s -m 3 http://127.0.0.1:7777/health > /dev/null; do sleep 1; done
grep -E "repo-migration" /tmp/swarm-p7.log
```

Expected: `[repo-migration] cloned: proving-ground/smith-agent-proving-ground`. **This clones from GitHub — the one place in this plan that touches the network.**

- [ ] **Step 4: Confirm the shape and the invariant**

```bash
ls -1 ~/.smithagents/workspaces/proving-ground/
git -C ~/.smithagents/workspaces/proving-ground/config rev-parse --git-dir
git -C ~/.smithagents/workspaces/proving-ground/smith-agent-proving-ground rev-parse --abbrev-ref HEAD
cat ~/.smithagents/workspaces/proving-ground/config/settings.json | python3 -c "
import sys,json
w=json.load(sys.stdin); print('  repos:', [(r['name'], r['path']) for r in w['repos']])"
ls -d /Users/edwincruz/Development/Workspaces/proving-ground/smith-agent-proving-ground
cat ~/.smithagents/workspaces/proving-ground/config/roster.json
curl -s -m 5 http://127.0.0.1:7777/workspaces/proving-ground/roster | head -c 200; echo
curl -s -m 5 http://127.0.0.1:7777/workspaces | python3 -c "
import sys,json; print('  names:', [w['name'] for w in json.load(sys.stdin)['workspaces']])"
curl -s -m 5 http://127.0.0.1:7777/work/boards | python3 -c "
import sys,json
d=json.load(sys.stdin); b=d.get('boards') or d
print('  boards:', sorted(x['id'] for x in b))"
```

Expected: the workspace directory now holds `config/` (a git repo) and `smith-agent-proving-ground/` on `main`; the record's path points inside the workspace; **the original external checkout still exists**; `roster.json` lists the agents the install actually has and the endpoint returns `recorded: true`; the same workspace names and the same four board ids as Step 2.

- [ ] **Step 5: Restart again and confirm idempotency**

```bash
PID=$(lsof -nP -iTCP:7777 -sTCP:LISTEN -t | head -1); kill "$PID"
until ! lsof -nP -iTCP:7777 -sTCP:LISTEN >/dev/null 2>&1; do sleep 1; done
cd swarm && nohup node --env-file=../.env --import tsx src/server.ts > /tmp/swarm-p7b.log 2>&1 &
until curl -s -m 3 http://127.0.0.1:7777/health > /dev/null; do sleep 1; done
grep -c "repo-migration" /tmp/swarm-p7b.log || echo "  0 — nothing left to migrate"
```

Expected: no `repo-migration` lines. A second boot must not re-clone.

- [ ] **Step 6: Dispatch still works from the new path**

The dispatcher worktrees from `repos[].path`, which just changed. Confirm a task can still cut a worktree:

```bash
curl -s -m 5 http://127.0.0.1:7777/workspaces | python3 -c "
import sys,json
w=json.load(sys.stdin)['workspaces'][0]
print('  dispatcher will worktree from:', w['repos'][0]['path'])"
git -C ~/.smithagents/workspaces/proving-ground/smith-agent-proving-ground worktree list
```

Expected: the path is inside the workspace and `git worktree list` succeeds against it. **If it fails, Task 4 is wrong and the branch does not merge.**

- [ ] **Step 7: No commit**

This task produces none. If Step 4 or 6 fails, the branch does not merge.

---

## Self-review

**Spec coverage.** §1.2's `config/ ← git` is Task 1; `<repo-a>/ ← git  project repos, cloned by the workspace` is Tasks 2-4; `config/roster.json` is Task 5, implementing §4.1's "definitions are global; assignments are per workspace"; `config/boards/` shipped in the previous plan; `config/settings.json` shipped in the plan before that. §1.2's `artifacts/` and `diagrams/` are explicitly out of scope with reasons stated in **Scope** — both are broker documents blocked on §4.4's open question. §4.2 step 3's "boards **and artifacts** into config repos" is therefore only half-covered by the end of this plan, which is deliberate and recorded. §2.1's `gitdirMount()` deletion is out of scope and explains why.

**Type consistency, roster.** `WorkspaceRoster`, `rosterPathFor`, `loadRoster`, `saveRoster` are spelled identically in Task 5 and its wiring. `loadRoster` returns `WorkspaceRoster | null`, and every caller in this plan handles `null` explicitly rather than defaulting it to empty arrays — the route reports `recorded: false`, the seeder treats it as "never recorded". Note that `migrateReposIntoWorkspace`'s signature grows two parameters in Task 5 Step 6; Task 4's tests must be updated to `migrateReposIntoWorkspace(paths, [], [])` at that point, which is called out in that step.

**Placeholders.** None. Every step contains literal code or literal commands.

**Type consistency.** `ensureConfigRepo(workspaceDir: string): Promise<boolean>`, `repoDirFor(workspaceDir: string, repo: WorkspaceRepo): string`, `cloneRepoInto(workspaceDir: string, repo: WorkspaceRepo): Promise<string>`, `materializeRepos(paths: SmithPaths, ws: Workspace): Promise<Workspace>`, and `migrateReposIntoWorkspace(paths: SmithPaths): Promise<{cloned, skipped, notes}>` are spelled identically everywhere they appear. `cloneRepoInto` and `repoDirFor` take a **workspace directory**, while `materializeRepos` and `migrateReposIntoWorkspace` take **`SmithPaths`** and derive the directory themselves — that asymmetry is deliberate (the first two are pure git operations with no knowledge of the state root) and is why `repoDirFor(dir, repo)` is called with `workspaceDir(paths, ws)` in Task 4.

**Known risks, stated plainly.**
1. **The fresh clone does not carry uncommitted work** from the external checkout. That is the direct consequence of the non-destructive decision, it is silent by nature, and the migration note is the only thing that tells the user. If `proving-ground`'s external checkout has unstaged work, it stays there.
2. **Task 4 changes `repos[].path` on live records**, which is what the dispatcher worktrees from — hence Step 6, which is the real gate on this plan.
3. `materializeRepos` runs before `workspaceProblems`, so a failed create can leave a workspace directory and a partial clone behind. This matches the DELETE route's existing documented behaviour of leaving the directory on disk.
