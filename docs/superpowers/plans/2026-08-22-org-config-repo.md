# Org Config Repo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every workspace's versioned half (`settings.json`, `roster.json`, `boards/`) out of its own per-workspace `config/` git repo into ONE org config repo at `<state root>/config/` as a `workspaces/<slug>/` subtree — with every existing feature working unchanged on the new layout, instances cutting sparse worktrees of the org repo, and commits carrying the acting user as `--author`.

**Architecture:** One new path (`paths.orgRepo`) and one new resolver (`configDirFor(paths, ws)`) replace every `join(workspaceDir, "config")`. `ensureOrgRepo` replaces `ensureConfigRepo`; `commitConfigFiles` becomes path-prefixed per subtree and takes an author. A boot-time migration copies each legacy `<ws>/config/` into its subtree, commits it, and archives the old repo. `createInstance` cuts the `config` member as a sparse worktree of the org repo (`blueprints/` + `workspaces/<slug>/`). The flip from old layout to new happens in ONE commit (Task 5) that also wires the migration into boot, so no commit on `main` can boot an install empty.

**Tech Stack:** Node ≥ 24, TypeScript ~6.0 (tests run under `tsx`, which strips types — `tsc --noEmit` is the only type gate), `node:test`, git ≥ 2.25 (sparse-checkout cone; host has 2.55), biome 2.5.3, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-08-22-workspace-documents-design.md` — this plan implements §1 (org repo, layout, commits), §8.1 (sparse instance worktrees), §9.1, §9.2, §9.5 (migration). Plan 2 (documents) and Plan 3 (uploads, links, docs-in-manifest) follow.

**Base branch:** `origin/main` @ `b051375` (the spec commit). `feat/instance-provisioning` only adds `provisioning.ts`/`provision-exec.ts` and does not touch any file this plan edits; it can merge before or after.

## Deviations from the spec — recorded, decide before executing

1. **Registry shape stays `name → dir` (spec §1.3 wanted `name → { dir, configRepo }`).** The org repo resolves from the state root (`paths.orgRepo = <root>/config`). A `configRepo` field would be written by this plan and read by nothing until a second org is wanted — exactly the "shipped a dead feature" trap recorded in memory. When a second org is needed, add the field and make `configDirForName` consult it; every call site already goes through that one function.
2. **The Settings UI email field (spec §1.4) is deferred to Plan 3** (the UI plan). This plan adds `User.email`, `PUT /me` accepting it, and the `<slug>@users.smithagents` fallback, so authorship is correct from day one and the field is a one-line addition where the name field lives.
3. **Org name:** the spec says the wizard asks. Until it does, `ensureOrgRepo` uses `slugForDir(currentUser.name) || "org"`. The wizard step is Plan 3.

## Global Constraints

- Package manager is **pnpm**, one workspace at the repo root. Never `npm`.
- Tests: `cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/<file>.test.ts'`. Read exit codes by redirect (`> out 2>&1; echo $?`), never through a pipe.
- `tsc --noEmit` (`pnpm -C swarm typecheck`) must pass at every commit. `tsx` strips types, so a type error will NOT fail a test.
- biome: measure the baseline count on `main` before Task 1 and compare at the end; the baseline has drifted, so "zero" is not the target — "no new findings" is.
- **Never delete user data.** Migration archives (`rename` to `<path>-archived-<stamp>`), never `rm`.
- **The swarm never force-pushes or rewrites history** in the org repo.
- **No new absolute machine paths may be written into any file inside the org repo** (it is meant to be pushable). `settings.json`'s existing `repos[].path` and `dir` are pre-existing and out of scope — do not add more.
- Member name `config` stays reserved in instances (`repoNameProblem` / `createInstance`).
- Commit author format is `Name <email>`; the COMMITTER is always `smithagents <smithagents@localhost>`.
- Every `git` call uses `execFile` (never a shell string) with `cwd` set — see `workspace-repos.ts`'s `run`.
- Follow `git-worktree-cwd-discipline`: `git -C <path>` / `{ cwd }`, never `cd` in a compound command.

---

## File Structure

| File | Responsibility after this plan |
|---|---|
| `swarm/src/paths.ts` | + `orgRepo` — the ONE org config repo under the state root |
| `swarm/src/workspaces.ts` | + `configDirForName` / `configDirFor`; `settingsPathFor(configDir)`; `ensureWorkspaceDir` creates `.runtime/` only; `saveWorkspace` writes into the org subtree; `boardsDirFor` under the subtree |
| `swarm/src/workspace-repos.ts` | `ensureOrgRepo` (replaces `ensureConfigRepo`), path-prefixed `commitConfigFiles(paths, slug, { author, message })`, `workspaceConfigPaths(slug)`; repo clone/migration unchanged except roster + commit paths |
| `swarm/src/workspace-roster.ts` | takes the config dir (subtree), not the workspace dir |
| `swarm/src/workspace-instances.ts` | `createInstance`/`destroyInstance` take `opts.orgRepo`; the `config` member is a sparse worktree |
| `swarm/src/migrate-state.ts` | + `migrateConfigIntoOrgRepo(paths, stamp)`; `migrateBoards`/`migrateWorkspaceRecords` target the subtree |
| `swarm/src/git-author.ts` | NEW — `GitAuthor`, `userAuthor(user)` |
| `swarm/src/users.ts` | + `User.email` |
| `swarm/src/server.ts` | boot: `ensureOrgRepo` → `migrateConfigIntoOrgRepo` before every other workspace migration; every `"config"` join → `configDirFor`; route commits carry the user author; `PUT /me` accepts `email` |
| `swarm/src/dispatcher.ts` | passes `orgRepo` to `createInstance` |
| `swarm/src/org-repo.fixture.ts` | NEW, test-only — `makeOrgRepo(root, slugs)`, `makeGitRepo(path)`, `gitCommitAll(cwd, msg)` |

Tests touched: `paths.test.ts`, `workspaces.test.ts`, `workspace-repos.test.ts`, `workspace-roster.test.ts`, `workspace-instances.test.ts`, `dispatcher.test.ts`, `migrate-state.test.ts`, `groups.test.ts`, `server.test.ts`, new `git-author.test.ts`.

---

### Task 0: Baseline measurements (no code)

- [ ] **Step 1: Record the biome and test baselines on the base commit**

```bash
cd swarm && pnpm lint > /tmp/biome-before.txt 2>&1; echo "biome exit $?"; tail -3 /tmp/biome-before.txt
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) pnpm test > /tmp/tests-before.txt 2>&1; echo "tests exit $?"; grep -E '^# (pass|fail)' /tmp/tests-before.txt
```

Write the two numbers (biome finding count, `# pass` count) at the top of your task notes. Every later "no new findings" claim compares against these.

---

### Task 1: `paths.orgRepo` and `configDirFor`

**Files:**
- Modify: `swarm/src/paths.ts:15-70`
- Modify: `swarm/src/workspaces.ts:505-512` (after `slugForDir`)
- Test: `swarm/src/paths.test.ts`, `swarm/src/workspaces.test.ts`

**Interfaces:**
- Produces: `SmithPaths.orgRepo: string` (= `<root>/config`); `configDirForName(paths: SmithPaths, name: string): string` (= `<orgRepo>/workspaces/<slugForDir(name)>`, throws when the slug is empty); `configDirFor(paths: SmithPaths, ws: Workspace): string`.

- [ ] **Step 1: Write the failing tests**

Append to `swarm/src/paths.test.ts`:

```ts
test("smithPaths: the org config repo is ONE directory under the root, named config", () => {
  const paths = smithPaths("/state");
  assert.equal(paths.orgRepo, join("/state", "config"));
});
```

Append to `swarm/src/workspaces.test.ts` (add `configDirFor, configDirForName` to the existing `./workspaces.js` import):

```ts
test("configDirForName: a workspace's versioned half is its subtree of the org repo, never its own repo", () => {
  const paths = smithPaths("/state");
  assert.equal(configDirForName(paths, "proving-ground"), join("/state", "config", "workspaces", "proving-ground"));
  assert.equal(configDirForName(paths, "Proving Ground"), join("/state", "config", "workspaces", "proving-ground"), "slugged like the runtime dir");
});

test("configDirFor: independent of ws.dir — the runtime folder can live anywhere, the subtree never leaves the org repo", () => {
  const paths = smithPaths("/state");
  const ws = { name: "pg", repos: [], dir: "/Users/me/code/pg" } as Workspace;
  assert.equal(configDirFor(paths, ws), join("/state", "config", "workspaces", "pg"));
});

test("configDirForName: refuses a name that slugs to nothing rather than naming the shared workspaces/ parent", () => {
  assert.throws(() => configDirForName(smithPaths("/state"), "..."), /"\.\.\."/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/paths.test.ts' 'src/workspaces.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E '^not ok|# (pass|fail)'`
Expected: the three new tests `not ok` (`orgRepo` undefined; `configDirForName is not a function`).

- [ ] **Step 3: Implement**

In `swarm/src/paths.ts`, add to the interface after `workspaces`:

```ts
  /**
   * The org config repo: ONE git repo holding every workspace's versioned
   * half as a `workspaces/<slug>/` subtree (spec 2026-08-22 §1). A company by
   * default, a department where an enterprise justifies it; a solo user is
   * an org of one. There is no per-workspace mode.
   */
  readonly orgRepo: string;
```

and to the frozen object after `workspaces: …`:

```ts
    orgRepo: join(resolvedRoot, "config"),
```

In `swarm/src/workspaces.ts`, directly after `slugForDir`:

```ts
/**
 * Where a workspace's VERSIONED half lives: its subtree of the org config
 * repo (spec 2026-08-22 §1.1). Every workspace is a `workspaces/<slug>/`
 * subtree of ONE repo — there is no per-workspace mode, so this never
 * consults `ws.dir`: the runtime folder can live anywhere, the subtree never
 * leaves the org repo.
 *
 * Throws on a name that slugs to nothing, for the reason ensureWorkspaceDir
 * refuses the same name: the result would be the shared `workspaces/` parent
 * itself, and a write there would land on every workspace at once.
 */
export function configDirForName(paths: SmithPaths, name: string): string {
  const slug = slugForDir(name);
  if (!slug) {
    throw new Error(`Workspace name "${name}" has no characters usable in a directory name — it has no config subtree`);
  }
  return join(paths.orgRepo, "workspaces", slug);
}

export function configDirFor(paths: SmithPaths, ws: Workspace): string {
  return configDirForName(paths, ws.name);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: the Step 2 command. Expected: the three new tests `ok`; pass count up by 3, no failures.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm -C swarm typecheck
git add swarm/src/paths.ts swarm/src/paths.test.ts swarm/src/workspaces.ts swarm/src/workspaces.test.ts
git commit -m "feat(swarm): name the org config repo and each workspace's subtree in it

paths.orgRepo is the ONE repo under the state root; configDirFor resolves a
workspace's versioned half to workspaces/<slug>/ inside it, independent of
where the runtime folder lives. No caller switches yet."
```

---

### Task 2: `ensureOrgRepo` and path-prefixed `commitConfigFiles` with an author

**Files:**
- Modify: `swarm/src/workspace-repos.ts:18-124` (`AUTHOR`, `ensureConfigRepo`, `SYSTEM_OWNED_CONFIG_PATHS`, `commitConfigFiles`)
- Create: `swarm/src/git-author.ts`
- Test: `swarm/src/workspace-repos.test.ts`, `swarm/src/git-author.test.ts`

**Interfaces:**
- Consumes: `paths.orgRepo` (Task 1).
- Produces:
  - `interface GitAuthor { name: string; email: string }` (in `git-author.ts`)
  - `userAuthor(user: User | null): GitAuthor`
  - `ensureOrgRepo(paths: SmithPaths, org: { name: string }): Promise<boolean>` — creates the repo + `settings.json` + one commit; `false` if a commit already existed.
  - `workspaceConfigPaths(slug: string): string[]` — allowlisted paths relative to the org repo root.
  - `commitConfigFiles(paths: SmithPaths, slug: string, opts?: { author?: GitAuthor; message?: string }): Promise<boolean>` — stages only allowlisted paths for `slug` (plus the org-level `settings.json`/`blueprints`), commits with the smithagents committer and the given author; `false` if nothing changed.
  - The old `ensureConfigRepo(workspaceDir)` and the old `commitConfigFiles(workspaceDir)` are REMOVED in Task 5, not here — this task only adds.

- [ ] **Step 1: Write the failing tests**

Create `swarm/src/git-author.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { userAuthor } from "./git-author.js";

test("userAuthor: a user with an email is themselves", () => {
  assert.deepEqual(userAuthor({ id: "me", name: "Edwin Cruz", email: "e@example.com" } as never), {
    name: "Edwin Cruz",
    email: "e@example.com",
  });
});

test("userAuthor: no email → a deterministic address under users.smithagents, so blame still names a person", () => {
  assert.deepEqual(userAuthor({ id: "me", name: "Edwin Cruz" } as never), {
    name: "Edwin Cruz",
    email: "edwin-cruz@users.smithagents",
  });
});

test("userAuthor: no user at all → the tool itself, never a fabricated person", () => {
  assert.deepEqual(userAuthor(null), { name: "smithagents", email: "smithagents@localhost" });
});
```

Append to `swarm/src/workspace-repos.test.ts` (add `ensureOrgRepo`, `workspaceConfigPaths` to its `./workspace-repos.js` import; `commitConfigFiles` is already imported):

```ts
test("ensureOrgRepo: creates the org repo with settings.json committed; a second call is a no-op", async () => {
  const root = mkdtempSync(join(tmpdir(), "orgrepo-"));
  try {
    const paths = smithPaths(root);
    assert.equal(await ensureOrgRepo(paths, { name: "acme" }), true);
    assert.deepEqual(JSON.parse(readFileSync(join(paths.orgRepo, "settings.json"), "utf8")), { name: "acme" });
    const tracked = execFileSync("git", ["ls-files"], { cwd: paths.orgRepo }).toString();
    assert.match(tracked, /^settings\.json$/m, "the org record is in HEAD");
    const first = execFileSync("git", ["rev-parse", "HEAD"], { cwd: paths.orgRepo }).toString().trim();

    assert.equal(await ensureOrgRepo(paths, { name: "acme" }), false);
    const second = execFileSync("git", ["rev-parse", "HEAD"], { cwd: paths.orgRepo }).toString().trim();
    assert.equal(first, second, "never a second commit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureOrgRepo: heals a repo that was git-init'd but never committed", async () => {
  const root = mkdtempSync(join(tmpdir(), "orgrepo-heal-"));
  try {
    const paths = smithPaths(root);
    mkdirSync(paths.orgRepo, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: paths.orgRepo });
    assert.equal(await ensureOrgRepo(paths, { name: "acme" }), true);
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: paths.orgRepo });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspaceConfigPaths: every allowlisted path is under the workspace's own subtree", () => {
  for (const p of workspaceConfigPaths("pg")) assert.ok(p.startsWith("workspaces/pg/"), p);
  assert.ok(workspaceConfigPaths("pg").includes("workspaces/pg/settings.json"));
  assert.ok(workspaceConfigPaths("pg").includes("workspaces/pg/boards"));
  assert.ok(workspaceConfigPaths("pg").includes("workspaces/pg/roster.json"));
});

test("commitConfigFiles: stages ONLY the allowlisted paths of ONE subtree — a stray file and a sibling workspace are never committed", async () => {
  const root = mkdtempSync(join(tmpdir(), "orgcommit-"));
  try {
    const paths = smithPaths(root);
    await ensureOrgRepo(paths, { name: "acme" });
    const pg = join(paths.orgRepo, "workspaces", "pg");
    const other = join(paths.orgRepo, "workspaces", "other");
    mkdirSync(join(pg, "boards"), { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(join(pg, "settings.json"), '{"name":"pg","repos":[]}\n');
    writeFileSync(join(pg, "boards", "pg-plan.json"), '{"id":"pg-plan"}\n');
    writeFileSync(join(pg, "scratch.txt"), "dropped in by hand\n");
    writeFileSync(join(other, "settings.json"), '{"name":"other","repos":[]}\n');

    assert.equal(await commitConfigFiles(paths, "pg"), true);

    const tree = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: paths.orgRepo }).toString();
    assert.match(tree, /^workspaces\/pg\/settings\.json$/m);
    assert.match(tree, /^workspaces\/pg\/boards\/pg-plan\.json$/m);
    assert.doesNotMatch(tree, /scratch\.txt/, "a hand-dropped file is never staged on the user's behalf");
    assert.doesNotMatch(tree, /workspaces\/other/, "another workspace's subtree is not this commit's business");
    assert.equal(await commitConfigFiles(paths, "pg"), false, "nothing changed → no commit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commitConfigFiles: the AUTHOR is whoever acted, the COMMITTER is always the tool", async () => {
  const root = mkdtempSync(join(tmpdir(), "orgauthor-"));
  try {
    const paths = smithPaths(root);
    await ensureOrgRepo(paths, { name: "acme" });
    const pg = join(paths.orgRepo, "workspaces", "pg");
    mkdirSync(pg, { recursive: true });
    writeFileSync(join(pg, "settings.json"), '{"name":"pg","repos":[]}\n');

    await commitConfigFiles(paths, "pg", {
      author: { name: "Edwin Cruz", email: "e@example.com" },
      message: "config(pg): create",
    });

    const line = execFileSync("git", ["log", "-1", "--format=%an <%ae>|%cn <%ce>|%s"], { cwd: paths.orgRepo })
      .toString()
      .trim();
    assert.equal(line, "Edwin Cruz <e@example.com>|smithagents <smithagents@localhost>|config(pg): create");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commitConfigFiles: refuses a slug that is not a slug — a path could otherwise escape the subtree", async () => {
  const paths = smithPaths(mkdtempSync(join(tmpdir(), "orgslug-")));
  await assert.rejects(() => commitConfigFiles(paths, "../escape"), /slug/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/git-author.test.ts' 'src/workspace-repos.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E '^not ok|# (pass|fail)'`
Expected: `git-author.test.ts` fails to load (module missing); the new `workspace-repos` tests `not ok` (`ensureOrgRepo is not a function`; the existing `commitConfigFiles(ws)` signature treats `paths` as a directory string).

Note: the existing `commitConfigFiles` tests still call `commitConfigFiles(ws)` with a workspace dir. They are replaced in Task 5; until then, keep BOTH signatures working by the overload in Step 3.

- [ ] **Step 3: Implement**

Create `swarm/src/git-author.ts`:

```ts
// Who a commit into the org config repo is BY (spec 2026-08-22 §1.4).
//
// There is no author in filenames or frontmatter: git is the authorship
// record, and a document can change hands. That only works if every commit
// names the person or agent who acted — the tool itself is the committer.
import type { User } from "./users.js";
import { slugForDir } from "./workspaces.js";

export interface GitAuthor {
  name: string;
  email: string;
}

/** The tool's own identity — the COMMITTER on every org-repo commit, and the author when nobody in particular acted (boot-time healing). */
export const SMITH_IDENTITY: GitAuthor = { name: "smithagents", email: "smithagents@localhost" };

/**
 * The acting user as a git author. A user without an email gets a
 * deterministic address under `users.smithagents`, so `git blame` still
 * names a person rather than the tool.
 */
export function userAuthor(user: User | null): GitAuthor {
  if (!user) return SMITH_IDENTITY;
  const name = user.name.trim() || user.id;
  const email = user.email?.trim() || `${slugForDir(name) || user.id}@users.smithagents`;
  return { name, email };
}
```

(`User.email` does not exist until Task 6; add `email?: string;` to the `User` interface in `swarm/src/users.ts` NOW, after `name`, with the doc comment `/** Git author email for commits made on this user's behalf (spec 2026-08-22 §1.4). Absent → <slug>@users.smithagents. */` — Task 6 wires the route.)

In `swarm/src/workspace-repos.ts`:

Replace the `AUTHOR` constant and its comment (lines 18-24) with:

```ts
import { type GitAuthor, SMITH_IDENTITY } from "./git-author.js";

/**
 * Commit identity for commits this code makes. The tool is always the
 * COMMITTER; the AUTHOR is whoever acted (spec 2026-08-22 §1.4), passed per
 * call. A machine with no global git identity therefore never fails to
 * commit, and `git blame` still names the person.
 */
const SMITH_COMMITTER = ["-c", `user.name=${SMITH_IDENTITY.name}`, "-c", `user.email=${SMITH_IDENTITY.email}`];
const AUTHOR = SMITH_COMMITTER; // legacy alias — removed with ensureConfigRepo in the cutover task
```

Add after `ensureConfigRepo` (keep `ensureConfigRepo` untouched for now):

```ts
/**
 * Make `paths.orgRepo` a git repo holding the org record, committing once.
 * Same contract as the per-workspace `ensureConfigRepo` it replaces: an
 * existing repo with a commit is never re-initialised and never gets a new
 * commit here — subsequent content reaches HEAD through `commitConfigFiles`.
 * Self-healing: a `.git` with no commits (a prior partial init) is completed.
 *
 * `org.name` is only written when no settings.json exists yet; an org record
 * the user has edited is never overwritten.
 */
export async function ensureOrgRepo(paths: SmithPaths, org: { name: string }): Promise<boolean> {
  const dir = paths.orgRepo;
  await mkdir(dir, { recursive: true });
  if (await hasCommit(dir)) return false;

  if (!(await exists(join(dir, ".git")))) {
    await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
  }
  if (!(await exists(join(dir, "settings.json")))) {
    await writeFile(join(dir, "settings.json"), `${JSON.stringify({ name: org.name }, null, 2)}\n`);
  }
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", [...SMITH_COMMITTER, "commit", "-q", "--allow-empty", "-m", "Org config"], { cwd: dir });
  return true;
}

/**
 * The only paths this codebase ever commits for ONE workspace, relative to
 * the org repo root. `specs`, `plans`, `dashboards`, `blueprints` are written
 * by later plans; listing them now costs nothing (absent paths are skipped)
 * and means the allowlist matches the spec's §1.4 in one place.
 */
export function workspaceConfigPaths(slug: string): string[] {
  return ["settings.json", "roster.json", "boards", "blueprints", "specs", "plans", "dashboards"].map(
    (p) => `workspaces/${slug}/${p}`,
  );
}

/** Org-level paths this codebase commits. */
const ORG_CONFIG_PATHS = ["settings.json", "blueprints"];

/**
 * Commit whichever allowlisted paths of `slug`'s subtree (plus the org-level
 * record) currently have uncommitted changes, inside the org repo.
 *
 * Stages ONLY these explicit paths — never `-A` — so a file the user drops
 * into the repo by hand is never staged or committed on their behalf. `git
 * add` with a pathspec that matches nothing fails the whole call, so each
 * candidate is checked with `exists()` first. A path that was DELETED on
 * disk (an archived boards/ dir) is therefore not staged either; its
 * deletion reaches HEAD only when something else under it is next committed.
 *
 * `opts.author` is whoever acted; absent means the tool healed something on
 * its own (boot). Returns whether it made a commit.
 */
export async function commitConfigFiles(
  paths: SmithPaths,
  slug: string,
  opts: { author?: GitAuthor; message?: string } = {},
): Promise<boolean> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`"${slug}" is not a workspace slug — refusing to build a commit pathspec from it`);
  }
  const dir = paths.orgRepo;
  const present: string[] = [];
  for (const path of [...ORG_CONFIG_PATHS, ...workspaceConfigPaths(slug)]) {
    if (await exists(join(dir, path))) present.push(path);
  }
  if (present.length === 0) return false;

  await run("git", ["add", "--", ...present], { cwd: dir });
  try {
    // Exit 0 means nothing is staged; a non-zero exit (thrown by execFile)
    // means there is a staged diff to commit.
    await run("git", ["diff", "--cached", "--quiet"], { cwd: dir });
    return false;
  } catch {
    /* fall through to commit below */
  }
  const author = opts.author ?? SMITH_IDENTITY;
  await run(
    "git",
    [...SMITH_COMMITTER, "commit", "-q", "-m", opts.message ?? `config(${slug}): update`, `--author=${author.name} <${author.email}>`],
    { cwd: dir },
  );
  return true;
}
```

The OLD `commitConfigFiles(workspaceDir: string)` (lines 105-124) must keep working until Task 5. Rename it to `commitLegacyConfigFiles` and update its two existing callers (`server.ts:2033` and `workspace-repos.ts:408`) and its existing tests to the new name. Task 5 deletes it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the Step 2 command. Expected: all new tests `ok`; every pre-existing test still `ok`.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm -C swarm typecheck
git add swarm/src/git-author.ts swarm/src/git-author.test.ts swarm/src/users.ts swarm/src/workspace-repos.ts swarm/src/workspace-repos.test.ts swarm/src/server.ts
git commit -m "feat(swarm): org repo init and subtree-scoped config commits with an author

ensureOrgRepo creates ONE repo under the state root; commitConfigFiles stages
only one workspace's allowlisted subtree paths and commits as the acting user
with smithagents as committer. The per-workspace functions survive, renamed,
until the cutover."
```

---

### Task 3: Migration — import each legacy `<ws>/config/` into its subtree

**Files:**
- Modify: `swarm/src/migrate-state.ts` (imports at top; new function after `migrateWorkspaceRecords`)
- Test: `swarm/src/migrate-state.test.ts`

**Interfaces:**
- Consumes: `loadRegistry` (registry stays `name → dir`), `configDirForName`, `slugForDir`, `probeSettings` (workspaces.ts), `commitConfigFiles(paths, slug, { message })` (Task 2), `paths.orgRepo`.
- Produces: `migrateConfigIntoOrgRepo(paths: SmithPaths, stamp: string): Promise<{ imported: string[]; notes: string[] }>`. Requires `ensureOrgRepo` to have run (caller's job — it needs the org name).

Written against BOTH layouts on purpose: it reads the legacy location by literal `join(dir, "config")` (which no other code will know after Task 5) and writes to `configDirForName`.

- [ ] **Step 1: Write the failing tests**

Append to `swarm/src/migrate-state.test.ts` (add `migrateConfigIntoOrgRepo` to the `./migrate-state.js` import, `ensureOrgRepo` from `./workspace-repos.js`, `saveRegistryEntry` from `./workspace-registry.js`, `configDirForName` from `./workspaces.js`, `execFileSync` from `node:child_process`):

```ts
/** A legacy per-workspace config repo at <dir>/config, committed, with boards and a roster. */
function makeLegacyConfig(dir: string, name: string): string {
  const cfg = join(dir, "config");
  mkdirSync(join(cfg, "boards"), { recursive: true });
  writeFileSync(join(cfg, "settings.json"), `${JSON.stringify({ name, repos: [] })}\n`);
  writeFileSync(join(cfg, "roster.json"), '{"agents":["anderson"],"squads":[]}\n');
  writeFileSync(join(cfg, "boards", `${name}-plan.json`), `{"id":"${name}-plan"}\n`);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: cfg });
  execFileSync("git", ["add", "-A"], { cwd: cfg });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "legacy"], { cwd: cfg });
  return cfg;
}

test("migrateConfigIntoOrgRepo: copies a legacy config/ into workspaces/<slug>/, commits it, and ARCHIVES the old repo", async () => {
  const root = mkdtempSync(join(tmpdir(), "orgmig-"));
  try {
    const paths = smithPaths(root);
    await ensureOrgRepo(paths, { name: "acme" });
    const dir = join(paths.workspaces, "pg");
    makeLegacyConfig(dir, "pg");
    await saveRegistryEntry(paths, "pg", dir);

    const result = await migrateConfigIntoOrgRepo(paths, "20260822T120000");

    assert.deepEqual(result.imported, ["pg"]);
    const target = configDirForName(paths, "pg");
    assert.equal(JSON.parse(readFileSync(join(target, "settings.json"), "utf8")).name, "pg");
    assert.ok(statSync(join(target, "roster.json")).isFile());
    assert.ok(statSync(join(target, "boards", "pg-plan.json")).isFile());
    assert.throws(() => statSync(join(target, ".git")), "the legacy repo's .git is NOT copied into the org repo");
    const tree = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: paths.orgRepo }).toString();
    assert.match(tree, /^workspaces\/pg\/settings\.json$/m, "imported content is in the org repo's HEAD");
    assert.match(tree, /^workspaces\/pg\/boards\/pg-plan\.json$/m);
    const subject = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: paths.orgRepo }).toString().trim();
    assert.equal(subject, "Import workspace pg");
    assert.ok(statSync(join(dir, "config-archived-20260822T120000", ".git")).isDirectory(), "old repo archived, not deleted");
    assert.throws(() => statSync(join(dir, "config")), "nothing is left at the old location to be read by mistake");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateConfigIntoOrgRepo: a second run is a no-op, and a legacy dir that reappears beside an imported subtree is archived, never re-imported over it", async () => {
  const root = mkdtempSync(join(tmpdir(), "orgmig-twice-"));
  try {
    const paths = smithPaths(root);
    await ensureOrgRepo(paths, { name: "acme" });
    const dir = join(paths.workspaces, "pg");
    makeLegacyConfig(dir, "pg");
    await saveRegistryEntry(paths, "pg", dir);
    await migrateConfigIntoOrgRepo(paths, "20260822T120000");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: paths.orgRepo }).toString().trim();

    const again = await migrateConfigIntoOrgRepo(paths, "20260822T120100");
    assert.deepEqual(again.imported, []);
    assert.deepEqual(again.notes, []);
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: paths.orgRepo }).toString().trim(), head);

    // A stale legacy copy shows up again (restored from a backup, say).
    // The imported subtree is authoritative — writes have been landing there.
    writeFileSync(join(configDirForName(paths, "pg"), "settings.json"), '{"name":"pg","repos":[],"description":"NEWER"}\n');
    makeLegacyConfig(dir, "pg");
    const third = await migrateConfigIntoOrgRepo(paths, "20260822T120200");
    assert.deepEqual(third.imported, []);
    assert.equal(
      JSON.parse(readFileSync(join(configDirForName(paths, "pg"), "settings.json"), "utf8")).description,
      "NEWER",
      "never overwritten",
    );
    assert.ok(statSync(join(dir, "config-archived-20260822T120200")).isDirectory(), "the stale copy is archived");
    assert.ok(third.notes.some((n) => n.includes("archived")), third.notes.join(" | "));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateConfigIntoOrgRepo: a registered workspace with config in NEITHER place is reported, not silently skipped", async () => {
  const root = mkdtempSync(join(tmpdir(), "orgmig-none-"));
  try {
    const paths = smithPaths(root);
    await ensureOrgRepo(paths, { name: "acme" });
    await saveRegistryEntry(paths, "ghost", join(paths.workspaces, "ghost"));
    const result = await migrateConfigIntoOrgRepo(paths, "20260822T120000");
    assert.deepEqual(result.imported, []);
    assert.ok(result.notes.some((n) => n.includes("ghost") && n.includes("no settings.json")), result.notes.join(" | "));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateConfigIntoOrgRepo: one bad workspace never stops the others — it is noted and the loop continues", async () => {
  const root = mkdtempSync(join(tmpdir(), "orgmig-isolate-"));
  try {
    const paths = smithPaths(root);
    await ensureOrgRepo(paths, { name: "acme" });
    const bad = join(paths.workspaces, "bad");
    mkdirSync(join(bad, "config"), { recursive: true });
    writeFileSync(join(bad, "config", "settings.json"), "{ not json");
    await saveRegistryEntry(paths, "bad", bad);
    const good = join(paths.workspaces, "good");
    makeLegacyConfig(good, "good");
    await saveRegistryEntry(paths, "good", good);

    const result = await migrateConfigIntoOrgRepo(paths, "20260822T120000");

    assert.deepEqual(result.imported, ["good"]);
    assert.ok(result.notes.some((n) => n.includes("bad")), result.notes.join(" | "));
    assert.ok(statSync(join(bad, "config", "settings.json")).isFile(), "the unverifiable legacy copy is left in place");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/migrate-state.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E '^not ok|# (pass|fail)'`
Expected: the four new tests `not ok` — `migrateConfigIntoOrgRepo is not a function`.

- [ ] **Step 3: Implement**

In `swarm/src/migrate-state.ts`, extend the imports:

```ts
import { cp, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { loadRegistry, registryPath, saveRegistryEntry } from "./workspace-registry.js";
import { commitConfigFiles } from "./workspace-repos.js";
import {
  configDirForName,
  ensureWorkspaceDir,
  loadWorkspaceFilesFromDir,
  probeSettings,
  settingsPathFor,
  slugForDir,
  type Workspace,
  workspaceDir,
} from "./workspaces.js";
```

Add after `migrateWorkspaceRecords`:

```ts
/**
 * ONE-WAY migration (spec 2026-08-22 §9.2): each workspace's own `config/`
 * git repo becomes the `workspaces/<slug>/` subtree of the org repo.
 *
 * Reads the legacy location by its literal name — after the cutover no other
 * code knows `<dir>/config` ever existed — and writes through
 * `configDirForName`, so this is the one place both layouts meet.
 *
 * Copy, verify, commit, THEN archive: the legacy repo is renamed to
 * `config-archived-<stamp>` beside the workspace only after its content is
 * verified readable in the subtree and in the org repo's HEAD. Nothing is
 * ever deleted. History is not rewritten into the org repo — a single-user
 * install has a handful of "Update workspace config" commits, and a
 * filter-repo pass is not worth its risk; the archived repo keeps it.
 *
 * Idempotent: an already-imported workspace is skipped. A legacy copy found
 * beside an imported subtree (restored from a backup) is archived, never
 * re-imported — the subtree is where writes have been landing, so it is the
 * newer one. A registered workspace with config in neither place is noted:
 * that install would otherwise boot owning a workspace it cannot load.
 *
 * One workspace's failure never stops the others — this runs at boot.
 */
export async function migrateConfigIntoOrgRepo(
  paths: SmithPaths,
  stamp: string,
): Promise<{ imported: string[]; notes: string[] }> {
  const imported: string[] = [];
  const notes: string[] = [];

  for (const [name, dir] of Object.entries(await loadRegistry(paths))) {
    try {
      const legacy = join(dir, "config");
      const target = configDirForName(paths, name);
      const slug = slugForDir(name);
      const hasLegacy = await exists(join(legacy, "settings.json"));

      if (await exists(join(target, "settings.json"))) {
        if (hasLegacy) {
          const archived = `${legacy}-archived-${stamp}`;
          await rename(legacy, archived);
          notes.push(`[org-migration] ${name}: already imported — archived a stale legacy config at ${archived}`);
        }
        continue;
      }
      if (!hasLegacy) {
        notes.push(
          `[org-migration] ${name}: no settings.json at ${legacy} or ${target} — the workspace is registered but has ` +
            `no config anywhere; re-create it, or remove it from ${registryPath(paths)}`,
        );
        continue;
      }

      await mkdir(target, { recursive: true });
      // The legacy repo's own .git must not come along: the subtree belongs to
      // the ORG repo's history from here on, and a nested .git would make git
      // treat the subtree as an embedded repository and refuse to track it.
      await cp(legacy, target, { recursive: true, filter: (src) => basename(src) !== ".git" });

      const probe = await probeSettings(join(target, "settings.json"));
      if (probe.kind !== "parsed") {
        notes.push(
          `[org-migration] ${name}: copied config does not verify at ${join(target, "settings.json")} — ` +
            `leaving ${legacy} in place; fix the record so this can complete`,
        );
        continue;
      }
      await commitConfigFiles(paths, slug, { message: `Import workspace ${slug}` });
      await rename(legacy, `${legacy}-archived-${stamp}`);
      imported.push(name);
    } catch (err) {
      notes.push(`[org-migration] ${name}: could not be imported — ${(err as Error).message}`);
    }
  }
  return { imported, notes };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: the Step 2 command. Expected: the four new tests `ok`, nothing else changed.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm -C swarm typecheck
git add swarm/src/migrate-state.ts swarm/src/migrate-state.test.ts
git commit -m "feat(swarm): boot migration importing each workspace's config repo into the org repo

Copy, verify, commit as 'Import workspace <slug>', then archive the legacy
repo beside the workspace. Idempotent, isolated per workspace, never deletes.
Not wired into boot yet — that lands with the cutover."
```

---

### Task 4: Instances cut the `config` member as a sparse worktree of the org repo

**Files:**
- Modify: `swarm/src/workspace-instances.ts:128-235` (`createInstance`), `:427-445` (`destroyInstance`)
- Modify: `swarm/src/dispatcher.ts:66`, `swarm/src/server.ts:3816`
- Create: `swarm/src/org-repo.fixture.ts`
- Test: `swarm/src/workspace-instances.test.ts`, `swarm/src/dispatcher.test.ts`

**Interfaces:**
- Consumes: `slugForDir` (workspaces.ts), `paths.orgRepo`.
- Produces:
  - `createInstance(workspaceDir, ws, workId, repoNames, opts: { orgRepo: string; base?: string })` — `opts.orgRepo` is REQUIRED (tsc enforces every caller).
  - `destroyInstance(workspaceDir, ws, workId, repoNames, opts: { orgRepo: string; force?: boolean })`.
  - Test fixture: `makeOrgRepo(root: string, slugs: string[]): string` (returns the repo path `<root>/config`), `makeGitRepo(path: string): string`, `gitCommitAll(cwd: string, msg: string): void`.

- [ ] **Step 1: Create the shared fixture**

Create `swarm/src/org-repo.fixture.ts` (the test glob is `src/*.test.ts`, so this is never run as a test):

```ts
// Test-only fixtures for the org config repo layout (spec 2026-08-22 §1.1).
// Not a test file: the suite's glob is `src/*.test.ts`.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function gitCommitAll(cwd: string, msg: string): void {
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", msg], { cwd });
}

/** An org config repo at `<root>/config` with one committed `workspaces/<slug>/settings.json` per slug. */
export function makeOrgRepo(root: string, slugs: string[]): string {
  const repo = join(root, "config");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "settings.json"), '{"name":"test-org"}\n');
  for (const slug of slugs) {
    mkdirSync(join(repo, "workspaces", slug), { recursive: true });
    writeFileSync(join(repo, "workspaces", slug, "settings.json"), `${JSON.stringify({ name: slug, repos: [] })}\n`);
  }
  gitCommitAll(repo, "org");
  return repo;
}

/** A project repo with one committed README. */
export function makeGitRepo(path: string): string {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  writeFileSync(join(path, "README.md"), `${path}\n`);
  gitCommitAll(path, "init");
  return path;
}
```

- [ ] **Step 2: Rewrite the instance tests' fixture and add the sparse tests**

In `swarm/src/workspace-instances.test.ts`, replace the `makeWorkspace` helper (lines 58-80) with:

```ts
import { makeGitRepo, makeOrgRepo } from "./org-repo.fixture.js";

/**
 * A workspace runtime dir plus an org repo holding its subtree AND a sibling
 * workspace's — so every test can assert the sibling is NOT in the instance.
 */
function makeWorkspace(
  label: string,
  repos: string[],
): { dir: string; orgRepo: string; ws: { name: string; repos: Array<{ name: string; path: string }> } } {
  const root = mkdtempSync(join(tmpdir(), `wsinst-${label}-`));
  const orgRepo = makeOrgRepo(root, ["pg", "sibling"]);
  const dir = join(root, "workspaces", "pg");
  const made: Array<{ name: string; path: string }> = [];
  for (const name of repos) made.push({ name, path: makeGitRepo(join(dir, name)) });
  return { dir, orgRepo, ws: { name: "pg", repos: made } };
}
```

Then in EVERY existing `createInstance(...)` / `destroyInstance(...)` call in this file, add `orgRepo` to the opts object — e.g. `createInstance(dir, ws as never, "work-42", ["app"])` becomes `createInstance(dir, ws as never, "work-42", ["app"], { orgRepo })`, and `createInstance(dir, ws as never, "w", ["app"], { base: "main" })` becomes `{ base: "main", orgRepo }`. Destructure `orgRepo` from `makeWorkspace(...)` wherever `dir, ws` are. Every `rmSync(dir, …)` cleanup becomes `rmSync(join(dir, "..", ".."), …)` — the temp root is two levels up now (or capture `root` from the fixture; either is fine, be consistent).

Update the first test's assertion `statSync(join(inst.dir, "config", "settings.json"))` to `statSync(join(inst.dir, "config", "workspaces", "pg", "settings.json"))` — the config member is the org repo's root with the subtree checked out.

Add:

```ts
test("createInstance: the config member is a SPARSE worktree — this workspace's subtree and blueprints/, never a sibling workspace", async () => {
  const { dir, orgRepo, ws } = makeWorkspace("sparse", ["app"]);
  try {
    const inst = await createInstance(dir, ws as never, "work-9", ["app"], { orgRepo });
    const cfg = join(inst.dir, "config");
    assert.ok(statSync(join(cfg, "workspaces", "pg", "settings.json")).isFile(), "own subtree present");
    assert.ok(statSync(join(cfg, "settings.json")).isFile(), "root-level files (the org record) are always in a cone checkout");
    assert.throws(() => statSync(join(cfg, "workspaces", "sibling")), "the sibling workspace is NOT checked out");
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: cfg }).toString().trim();
    assert.equal(branch, "smith/work-9");
    const sparse = execFileSync("git", ["sparse-checkout", "list"], { cwd: cfg }).toString();
    assert.match(sparse, /^workspaces\/pg$/m);
    assert.match(sparse, /^blueprints$/m);
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: cfg }).toString();
    assert.equal(status, "", "a fresh sparse worktree is clean — nothing shows as deleted");
  } finally {
    rmSync(join(dir, "..", ".."), { recursive: true, force: true });
  }
});

test("createInstance: a commit in the sparse config worktree lands on smith/<workId> in the ORG repo", async () => {
  const { dir, orgRepo, ws } = makeWorkspace("commit", ["app"]);
  try {
    const inst = await createInstance(dir, ws as never, "work-10", ["app"], { orgRepo });
    const cfg = join(inst.dir, "config");
    writeFileSync(join(cfg, "workspaces", "pg", "roster.json"), '{"agents":[],"squads":[]}\n');
    execFileSync("git", ["add", "-A"], { cwd: cfg });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "roster"], { cwd: cfg });
    const tree = execFileSync("git", ["ls-tree", "-r", "--name-only", "smith/work-10"], { cwd: orgRepo }).toString();
    assert.match(tree, /^workspaces\/pg\/roster\.json$/m, "visible from the org repo by branch, no push needed");
    assert.match(tree, /^workspaces\/sibling\/settings\.json$/m, "the sibling's files survive on the branch — sparse hides, it does not delete");
  } finally {
    rmSync(join(dir, "..", ".."), { recursive: true, force: true });
  }
});

test("destroyInstance: removes the sparse config worktree and deregisters it from the org repo", async () => {
  const { dir, orgRepo, ws } = makeWorkspace("destroy", ["app"]);
  try {
    await createInstance(dir, ws as never, "work-11", ["app"], { orgRepo });
    await destroyInstance(dir, ws as never, "work-11", ["app"], { orgRepo });
    assert.throws(() => statSync(instanceDir(dir, "work-11")));
    const list = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: orgRepo }).toString();
    assert.doesNotMatch(list, /work-11/, "no stale registration");
  } finally {
    rmSync(join(dir, "..", ".."), { recursive: true, force: true });
  }
});
```

In `swarm/src/dispatcher.test.ts`, replace `makeWorkspaceFixture` (lines 352-367) with:

```ts
import { makeGitRepo, makeOrgRepo } from "./org-repo.fixture.js";

/**
 * A workspace whose subtree lives in an org repo under `root/config` and whose
 * named repo is a real git repo. `ws.dir` is pinned so workspaceDir() resolves
 * to it directly rather than the default under the state root.
 */
function makeWorkspaceFixture(root: string, repoName: string): { dir: string; ws: Workspace } {
  makeOrgRepo(root, ["proj"]);
  const dir = mkdtempSync(join(root, "ws-"));
  const repoPath = makeGitRepo(join(dir, repoName));
  const ws: Workspace = { name: "proj", repos: [{ name: repoName, path: repoPath }], dir };
  return { dir, ws };
}
```

(`root` is already the `smithRoot` those tests pass, so `makeOrgRepo(root, …)` IS `paths.orgRepo`.) Update the assertion on line 395 to `statSync(join(dir, ".runtime", "instances", "t-1", "config", "workspaces", "proj")).isDirectory()`.

- [ ] **Step 3: Run them to verify they fail**

Run: `cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/workspace-instances.test.ts' 'src/dispatcher.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E '^not ok|# (pass|fail)'`
Expected: every instance test that touches the config member fails (`createInstance` still looks for `<dir>/config`, which no longer exists in the fixture).

- [ ] **Step 4: Implement**

In `swarm/src/workspace-instances.ts`:

Add `import { slugForDir, type Workspace } from "./workspaces.js";` (replace the existing type-only import).

Change `createInstance`'s signature and the config source:

```ts
export async function createInstance(
  workspaceDir: string,
  ws: Workspace,
  workId: string,
  repoNames: string[],
  opts: { orgRepo: string; base?: string },
): Promise<Instance> {
  const problem = workIdProblem(workId);
  if (problem) throw new Error(`Invalid work id: ${problem}`);

  const dir = instanceDir(workspaceDir, workId);
  const branch = `smith/${workId}`;

  // The config member is a SPARSE worktree of the org repo (spec 2026-08-22
  // §8): this workspace's subtree plus the shared blueprints/, never a
  // sibling workspace's material. `sparse` is the cone-mode directory list.
  const sources: Array<{ name: string; source: string; sparse?: string[] }> = [
    { name: "config", source: opts.orgRepo, sparse: ["blueprints", `workspaces/${slugForDir(ws.name)}`] },
  ];
```

Keep the repo-name loop as is. In the member loop, replace the three `worktree add` branches with one that handles sparse:

```ts
  await mkdir(dir, { recursive: true });
  const members: InstanceMember[] = [];
  for (const { name, source, sparse } of sources) {
    const path = join(dir, name);
    if (!(await isWorktree(path))) {
      // Prune stale worktree registrations in the source repo; a removed worktree
      // directory that still appears in .git/worktrees/ would make `worktree add`
      // refuse the path.
      await run("git", ["worktree", "prune"], { cwd: source });

      // Check if the branch already exists (e.g., the worktree was removed but
      // the branch commits remain). If so, attach to it; if not, create it.
      // `workIdProblem` already refused a leading dash, so `branch` cannot be
      // read as a flag.
      let branchExists = false;
      try {
        await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: source });
        branchExists = true;
      } catch {
        // Branch does not exist.
      }

      // Which ref the worktree starts on. Reattaching to an existing branch
      // takes no start-point; a repo member with a base starts there (see
      // resolveStartPoint); the config member has no base-branch concept and
      // is cut from the org repo's own HEAD.
      let refArgs: string[];
      if (branchExists) {
        refArgs = [branch];
      } else if (!sparse && opts.base) {
        const startPoint = await resolveStartPoint(source, opts.base);
        refArgs = ["-b", branch, "--", startPoint];
      } else {
        refArgs = ["-b", branch];
      }

      try {
        if (sparse) {
          // --no-checkout, set the cone, THEN populate: checking out the whole
          // org repo first and narrowing afterwards would briefly materialise
          // every workspace's files in this instance.
          await run("git", ["worktree", "add", "-q", "--no-checkout", path, ...refArgs], { cwd: source });
          await run("git", ["sparse-checkout", "set", "--cone", ...sparse], { cwd: path });
          await run("git", ["checkout", "-q", branch], { cwd: path });
        } else {
          await run("git", ["worktree", "add", "-q", path, ...refArgs], { cwd: source });
        }
      } catch (err) {
        throw new Error(
          `Member "${name}": could not create a worktree${opts.base && !sparse ? ` from base "${opts.base}"` : ""} — ${(err as Error).message}`,
        );
      }
    }
    members.push({ name, path, source });
  }
  return { workId, dir, branch, members };
```

(The previous code threw a wrapped error only for the base-branch case and let other failures propagate raw; the message above covers all three. No existing test asserts on that text — verified with `grep -n 'could not create' src/*.test.ts`.)

Change `destroyInstance`'s signature and config source:

```ts
export async function destroyInstance(
  workspaceDir: string,
  ws: Workspace,
  workId: string,
  repoNames: string[],
  opts: { orgRepo: string; force?: boolean },
): Promise<void> {
  …
  const sources: Array<{ name: string; source: string }> = [{ name: "config", source: opts.orgRepo }];
```

Update the docblock of `createInstance` (lines 128-149): replace the sentence about `config/` never taking a start-point with: "The config member is a sparse worktree of the ORG repo (`opts.orgRepo`) showing `blueprints/` and this workspace's `workspaces/<slug>/`; it has no base-branch concept and is cut from the org repo's own HEAD."

`swarm/src/dispatcher.ts:66`:

```ts
      const inst = await createInstance(workspaceDir(paths, ws), ws, manifest.taskId, [repoName], {
        base: manifest.context.branch,
        orgRepo: paths.orgRepo,
      });
```

`swarm/src/server.ts:3816`:

```ts
  const instance = await createInstance(dir, ws, taskId, [repo.name], { base: repo.branch, orgRepo: paths.orgRepo });
```

Run `pnpm -C swarm typecheck`. `createInstance` has exactly these two production callers and `destroyInstance` has none outside tests (verified: `grep -rn 'createInstance(\|destroyInstance(' src/*.ts | grep -v test`), so tsc should report only test files still missing `orgRepo`. Do not stop until tsc is clean.

- [ ] **Step 5: Run the tests to verify they pass**

Run: the Step 3 command. Expected: all `ok`. If the sparse test fails with the subtree absent after `git checkout -q <branch>`, replace that line with `await run("git", ["read-tree", "-mu", "HEAD"], { cwd: path });` and re-run — both populate a `--no-checkout` worktree under sparse patterns; verify which one your git does with the test, and keep that one.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm -C swarm typecheck
git add swarm/src/org-repo.fixture.ts swarm/src/workspace-instances.ts swarm/src/workspace-instances.test.ts swarm/src/dispatcher.ts swarm/src/dispatcher.test.ts swarm/src/server.ts
git commit -m "feat(swarm): instances cut the config member as a sparse worktree of the org repo

blueprints/ plus this workspace's workspaces/<slug>/ — never a sibling
workspace's material. Callers pass opts.orgRepo; tsc enforces it."
```

---

### Task 5: Cut over — every `config/` path goes through `configDirFor`, boot runs the migration

This is the one commit where the on-disk layout changes. Everything before it adds; everything after it is cleanup. Do not split it: a commit with the flip and without the boot migration could boot an existing install empty.

**Files:**
- Modify: `swarm/src/workspaces.ts` (`settingsPathFor`, `loadWorkspaces`, `assertNoWorkspaceDirCollision`, `saveWorkspace`, `ensureWorkspaceDir`, `boardsDirFor`)
- Modify: `swarm/src/workspace-roster.ts` (both path helpers)
- Modify: `swarm/src/workspace-repos.ts` (delete `ensureConfigRepo`, `commitLegacyConfigFiles`, `AUTHOR` alias; `materializeRepos`; `migrateReposIntoWorkspace`)
- Modify: `swarm/src/migrate-state.ts` (`migrateBoards`, `migrateWorkspaceRecords`)
- Modify: `swarm/src/server.ts` (boot block ~455-520; `boardDirs` 735; POST /workspaces 2016-2038; roster 2150; `archiveWorkspaceBoards` 3863)
- Test: `workspaces.test.ts`, `workspace-roster.test.ts`, `workspace-repos.test.ts`, `migrate-state.test.ts`, `groups.test.ts:171`, `server.test.ts:502`

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Changes: `settingsPathFor(configDir: string)` now takes the CONFIG dir (subtree) and returns `<configDir>/settings.json`; `rosterPathFor(configDir)`, `loadRoster(configDir)`, `saveRoster(configDir, roster)` likewise; `ensureWorkspaceDir` creates only `.runtime/`.
- Removes: `ensureConfigRepo`, `commitLegacyConfigFiles`.

- [ ] **Step 1: Update the tests first — they define the new layout**

`swarm/src/workspaces.test.ts` — the `ensureWorkspaceDir` test at line 279:

```ts
test("ensureWorkspaceDir: creates .runtime/ only — the versioned half lives in the org repo — and is idempotent", async () => {
  const root = mkdtempSync(join(tmpdir(), "wsdir-"));
  try {
    const paths = smithPaths(root);
    const ws = { name: "pg", repos: [] } as Workspace;
    const dir = await ensureWorkspaceDir(paths, ws);
    assert.equal(dir, join(paths.workspaces, "pg"));
    assert.ok(statSync(join(dir, ".runtime")).isDirectory());
    assert.throws(() => statSync(join(dir, "config")), "no per-workspace config dir is created any more");
    await ensureWorkspaceDir(paths, ws);
    assert.ok(statSync(join(dir, ".runtime")).isDirectory(), "idempotent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

Add next to it:

```ts
test("saveWorkspace: the record lands in the org repo subtree, not under the runtime dir", async () => {
  const root = mkdtempSync(join(tmpdir(), "wssave-"));
  try {
    const paths = smithPaths(root);
    await saveWorkspace(paths, { name: "pg", repos: [] } as Workspace);
    const settings = join(paths.orgRepo, "workspaces", "pg", "settings.json");
    assert.equal(JSON.parse(readFileSync(settings, "utf8")).name, "pg");
    assert.throws(() => statSync(join(paths.workspaces, "pg", "config")));
    assert.deepEqual((await loadWorkspaces(paths)).map((w) => w.name), ["pg"], "and loads back through the registry");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

Everywhere else in the test files, apply these substitutions — each is a mechanical rewrite of one pattern:

| Old pattern | New |
|---|---|
| `mkdirSync(join(dir, "config"), { recursive: true }); … settingsPathFor(dir)` (migrate-state.test 381, 411, 502, 641) | `const cfg = configDirForName(paths, "<name>"); mkdirSync(cfg, { recursive: true }); … settingsPathFor(cfg)` |
| `join(workspaceDir(paths, ws), "config", "boards", …)` (migrate-state.test 258, 301, 322; server.test 502) | `join(configDirFor(paths, ws), "boards", …)` |
| `statSync(join(paths.workspaces, "squad", "config", "settings.json"))` (migrate-state.test 727) | `statSync(join(configDirForName(paths, "squad"), "settings.json"))` |
| groups.test 171-172: `await mkdir(join(fooDir, "config"), …); await writeFile(settingsPathFor(fooDir), …)` | `const fooCfg = configDirForName(paths, "foo"); await mkdir(fooCfg, { recursive: true }); await writeFile(settingsPathFor(fooCfg), …)` |
| workspace-roster.test: every `loadRoster(ws)` / `saveRoster(ws, …)` / `rosterPathFor(ws)` where `ws` is a temp dir | unchanged call shape — the argument is now understood as the config dir; update the assertion `rosterPathFor(ws) === join(ws, "config", "roster.json")` to `join(ws, "roster.json")` |
| workspace-repos.test: the `ensureConfigRepo` tests (lines 22-100) | DELETE — `ensureOrgRepo` tests from Task 2 replace them |
| workspace-repos.test: the `commitLegacyConfigFiles` tests (640-680) | DELETE — the Task 2 `commitConfigFiles` tests replace them |
| workspace-repos.test 296-297 (`materializeRepos` test): `const cfg = join(paths.workspaces, "pg", "config"); assert.ok(statSync(join(cfg, ".git")).isDirectory(), "config/ is a repo after creation")` | DELETE those two lines; `materializeRepos` no longer creates any repo. Assert the clone instead: `assert.ok(statSync(join(paths.workspaces, "pg", "app", ".git")).isDirectory(), "the project repo was cloned into the workspace")` |
| workspace-repos.test 485-486 (`migrateReposIntoWorkspace` first-commit test): `const cfg = join(paths.workspaces, "pg", "config"); const committed = execFileSync("git", ["show", "HEAD:settings.json"], { cwd: cfg })` | add `await ensureOrgRepo(paths, { name: "t" });` right after `const paths = smithPaths(root);` (boot does this before the migration runs), then `const committed = execFileSync("git", ["show", "HEAD:workspaces/pg/settings.json"], { cwd: paths.orgRepo })` — the assertion on the repointed path is unchanged |
| workspace-repos.test 536-537: a fake `.git` FILE at `<dir>/config/.git` to break `ensureConfigRepo` | DELETE the test — there is no per-workspace repo to break; the org-repo equivalent ("a `.git` with no commits is healed") is covered by Task 2 |

Add to `workspace-repos.test.ts` (`migrateReposIntoWorkspace` section):

```ts
test("migrateReposIntoWorkspace: seeds the roster in the org subtree and commits it there", async () => {
  const root = mkdtempSync(join(tmpdir(), "repomig-roster-"));
  try {
    const paths = smithPaths(root);
    await ensureOrgRepo(paths, { name: "t" });
    await saveWorkspace(paths, { name: "pg", repos: [] } as never);

    await migrateReposIntoWorkspace(paths, ["anderson"], ["alpha"]);

    assert.deepEqual(await loadRoster(configDirForName(paths, "pg")), { agents: ["anderson"], squads: ["alpha"] });
    const tree = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: paths.orgRepo }).toString();
    assert.match(tree, /^workspaces\/pg\/roster\.json$/m);
    assert.match(tree, /^workspaces\/pg\/settings\.json$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the whole swarm suite to see the failures**

Run: `cd swarm && SMITH_STATE_ROOT=$(mktemp -d) pnpm test > /tmp/t5-red.txt 2>&1; echo "exit $?"; grep -E '^not ok' /tmp/t5-red.txt | head -40`
Expected: failures across `workspaces`, `workspace-roster`, `workspace-repos`, `migrate-state`, `groups`, `server` tests — every one about a `config/` path.

- [ ] **Step 3: Implement — library modules**

`swarm/src/workspaces.ts`:

```ts
/** A workspace's own record, inside its org-repo subtree (see configDirFor). */
export function settingsPathFor(configDir: string): string {
  return join(configDir, "settings.json");
}
```

In `loadWorkspaces`, the registry loop:

```ts
  const registry = await loadRegistry(paths);
  for (const name of Object.keys(registry)) {
    try {
      const settings = settingsPathFor(configDirForName(paths, name));
      const raw = await readFile(settings, "utf8");
      const ws = assertContext(settings, JSON.parse(raw));
```

(the rest of the loop body unchanged). The registry's VALUE (the runtime dir) is no longer needed to find the record; it still matters to `workspaceDir` via `ws.dir` and to the migration.

`assertNoWorkspaceDirCollision`:

```ts
export async function assertNoWorkspaceDirCollision(paths: SmithPaths, ws: Workspace): Promise<void> {
  const configDir = configDirFor(paths, ws);
  const existing = await probeSettings(settingsPathFor(configDir));
  if (existing.kind === "parsed" && existing.value.name !== ws.name) {
    throw new WorkspaceDirCollisionError(ws.name, existing.value.name, configDir);
  }
}
```

`saveWorkspace`:

```ts
  await assertNoWorkspaceDirCollision(paths, ws);
  const dir = await ensureWorkspaceDir(paths, ws);
  const configDir = configDirFor(paths, ws);
  await mkdir(configDir, { recursive: true });
  await writeFile(settingsPathFor(configDir), `${JSON.stringify(ws, null, 2)}\n`);
  await saveRegistryEntry(paths, ws.name, dir);
```

`ensureWorkspaceDir`: delete the `mkdir(join(dir, "config"), …)` line; update its docblock: "Create this workspace's runtime directory and its `.runtime/` child. The versioned half is NOT here — it is the workspace's subtree of the org repo (`configDirFor`), created by `saveWorkspace`."

`boardsDirFor`: `return ws ? join(configDirFor(paths, ws), "boards") : paths.work;`

`swarm/src/workspace-roster.ts`:

```ts
/** A workspace's roster, inside its org-repo subtree (`configDirFor`). */
export function rosterPathFor(configDir: string): string {
  return join(configDir, "roster.json");
}
…
export async function loadRoster(configDir: string): Promise<WorkspaceRoster | null> {
  const file = rosterPathFor(configDir);
…
export async function saveRoster(configDir: string, roster: WorkspaceRoster): Promise<void> {
  const file = rosterPathFor(configDir);
  await mkdir(configDir, { recursive: true });
```

`swarm/src/workspace-repos.ts`:
- Delete `ensureConfigRepo`, `commitLegacyConfigFiles`, the `AUTHOR` alias line, and the now-unused `SYSTEM_OWNED_CONFIG_PATHS`.
- Import `configDirFor, slugForDir` from `./workspaces.js`.
- `materializeRepos`: remove the `await ensureConfigRepo(dir);` line (the org repo is ensured at boot).
- `migrateReposIntoWorkspace`: delete the `ensureConfigRepo(dir)` try/catch block; change the roster block to use the subtree and the commit block to the new signature:

```ts
      const configDir = configDirFor(paths, ws);
      try {
        if (globalAgentIds !== null && globalAgentIds.length > 0 && (await loadRoster(configDir)) === null) {
          await saveRoster(configDir, { agents: globalAgentIds, squads: globalSquadIds });
        }
      } catch (err) {
        notes.push(`[repo-migration] ${ws.name}'s roster could not be recorded — ${(err as Error).message}`);
      }

      try {
        await commitConfigFiles(paths, slugForDir(ws.name));
      } catch (err) {
        notes.push(`[repo-migration] ${ws.name}'s config files did not get committed — ${(err as Error).message}`);
      }
```

Update the surrounding comments: the healing commit now heals the subtree in the org repo; there is no per-workspace repo to become.

`swarm/src/migrate-state.ts`:
- `migrateBoards`: `const targetDir = join(configDirFor(paths, ws), "boards");`
- `migrateWorkspaceRecords`: replace `const dir = await ensureWorkspaceDir(paths, ws); const settings = settingsPathFor(dir);` with:

```ts
      const dir = await ensureWorkspaceDir(paths, ws);
      const configDir = configDirFor(paths, ws);
      await mkdir(configDir, { recursive: true });
      const settings = settingsPathFor(configDir);
```

`dir` stays bound: the later `saveRegistryEntry(paths, ws.name, dir)` must keep registering the RUNTIME dir. In the "both slug to" note, `${dir}` becomes `${configDir}` — that note is about the record's location, which is now the subtree.

- [ ] **Step 4: Implement — server.ts**

Imports: add `configDirFor, slugForDir` to the `./workspaces.js` import; replace `commitConfigFiles, materializeRepos, migrateReposIntoWorkspace, repoNameProblem` with `commitConfigFiles, ensureOrgRepo, materializeRepos, migrateReposIntoWorkspace, repoNameProblem`; add `migrateConfigIntoOrgRepo` to the `./migrate-state.js` import; `loadUsersFromDir, resolveCurrentUser` are already imported for `/me`.

Boot — insert immediately BEFORE the `migrateGroupsDir` loop (line ~475), after `reconcileSessions()`:

```ts
    // The org config repo (spec 2026-08-22 §1): ONE repo holding every
    // workspace's versioned half as workspaces/<slug>/. Must exist before any
    // migration below writes a subtree into it, and the legacy per-workspace
    // config repos must be imported before anything reads a record through
    // configDirFor — otherwise this boot would see no workspaces and come up
    // owning nothing, which is the failure the state-root guard above exists
    // to prevent.
    {
      let orgName = "org";
      try {
        const me = resolveCurrentUser(await loadUsersFromDir(this.paths.users));
        orgName = slugForDir(me?.name ?? "") || "org";
      } catch (err) {
        this.app.log.warn(`[org-repo] could not read the user record for the org name — using "org": ${(err as Error).message}`);
      }
      if (await ensureOrgRepo(this.paths, { name: orgName })) {
        this.app.log.info(`[org-repo] created ${this.paths.orgRepo}`);
      }
      const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
      const { imported, notes } = await migrateConfigIntoOrgRepo(this.paths, stamp);
      if (imported.length > 0) this.app.log.info(`[org-migration] imported: ${imported.join(", ")}`);
      for (const note of notes) this.app.log.warn(note);
    }
```

`boardDirs` (735):

```ts
    return [...this.workspaces.map((w) => join(configDirFor(this.paths, w), "boards")), this.paths.work];
```

POST /workspaces (2016-2038): delete `const newWorkspaceDir = workspaceDir(this.paths, record);` if nothing else uses it; `const newWorkspaceBoardsDir = join(configDirFor(this.paths, record), "boards");`; the commit:

```ts
      await commitConfigFiles(this.paths, slugForDir(record.name), { message: `config(${slugForDir(record.name)}): create` }).catch((err) => {
        this.app.log.warn(
          `Could not commit config files for workspace "${record.name}": ${String((err as Error).message)}`,
        );
      });
```

(Task 6 adds the author.) Rewrite the comment above it: the org repo was ensured at boot; this commit gets the new subtree into HEAD now rather than at the next boot's healing pass.

Roster route (2150): `const roster = await loadRoster(configDirFor(this.paths, ws));`

`archiveWorkspaceBoards` (3863): `const dir = join(configDirFor(paths, ws), "boards");`

Run `pnpm -C swarm typecheck`. It will name every remaining `"config"` join and every caller of a removed function. Fix all of them; `grep -rn '"config"' swarm/src --include='*.ts' | grep -v test | grep -v 'workspace-instances.ts' | grep -v config.ts` must print NOTHING except `migrate-state.ts`'s legacy `join(dir, "config")` in `migrateConfigIntoOrgRepo`.

- [ ] **Step 5: Run the whole swarm suite**

Run: `cd swarm && SMITH_STATE_ROOT=$(mktemp -d) pnpm test > /tmp/t5-green.txt 2>&1; echo "exit $?"; grep -E '^# (pass|fail)' /tmp/t5-green.txt; grep -E '^not ok' /tmp/t5-green.txt`
Expected: `exit 0`, `# fail 0`, pass count ≥ the Task 0 baseline (old per-workspace tests were removed, new ones added — compare honestly and list the delta in your notes).

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm -C swarm typecheck
cd swarm && pnpm lint > /tmp/biome-t5.txt 2>&1; tail -3 /tmp/biome-t5.txt   # compare with /tmp/biome-before.txt — no NEW findings
git add swarm/src
git commit -m "feat(swarm): cut over to the org config repo

Every workspace's versioned half is now workspaces/<slug>/ in ONE repo under
the state root; per-workspace config/ repos are imported at boot, committed,
and archived beside the workspace. Roster, boards, records, and the healing
commit all resolve through configDirFor. ensureConfigRepo is gone."
```

---

### Task 6: `User.email`, `PUT /me`, and the acting user as commit author on the workspace routes

**Files:**
- Modify: `swarm/src/server.ts` (`buildUserUpdate` ~4159, `redactUser` ~4065, `PUT /me` ~2284, POST /workspaces commit, PUT /workspaces)
- Test: `swarm/src/server.test.ts`

**Interfaces:**
- Consumes: `userAuthor` (Task 2), `commitConfigFiles(paths, slug, { author, message })`.
- Changes: `buildUserUpdate(existing, body: { name?: string; email?: string; setup?: User["setup"] })`; `redactUser` returns `email`; `PUT /me` 400s on a malformed email; POST and PUT `/workspaces` commit as the current user.

- [ ] **Step 1: Write the failing tests**

Append to `swarm/src/server.test.ts` (it already imports `buildUserUpdate`, `redactUser`):

```ts
test("buildUserUpdate: sets, keeps, and clears the email — an empty string clears, absence keeps", () => {
  const set = buildUserUpdate({ id: "me", name: "Edwin" } as never, { email: " e@example.com " });
  assert.equal(set.email, "e@example.com");
  const kept = buildUserUpdate(set, { name: "Edwin C" });
  assert.equal(kept.email, "e@example.com", "absent means unchanged — same merge rule as every other field");
  const cleared = buildUserUpdate(set, { email: "" });
  assert.equal(cleared.email, undefined);
});

test("redactUser: the email is not a secret — it is returned so Settings can show what commits will say", () => {
  const real = redactUser({ id: "me", name: "Edwin", email: "e@example.com" } as never);
  assert.equal(real.email, "e@example.com");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/server.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E '^not ok|# (pass|fail)'`
Expected: both new tests `not ok` (`email` undefined).

- [ ] **Step 3: Implement**

`buildUserUpdate`:

```ts
export function buildUserUpdate(
  existing: User | null,
  body: { name?: string; email?: string; setup?: User["setup"] },
): User {
  const base: User = {
    ...(existing ?? {}),
    id: existing?.id ?? "me",
    name: body.name?.trim() || existing?.name || "You",
    default: true,
    ...(body.setup !== undefined ? { setup: { ...existing?.setup, ...body.setup } } : {}),
  };
  if (body.email === undefined) return base;
  const email = body.email.trim();
  if (!email) {
    const { email: _cleared, ...rest } = base;
    return rest;
  }
  return { ...base, email };
}
```

`redactUser`: add `email: u?.email,` after `name`.

`PUT /me`:

```ts
    this.app.put("/me", async (req, reply) => {
      const b = req.body as { name?: string; email?: string; setup?: User["setup"] };
      if (b.email !== undefined && b.email.trim() !== "" && !/^[^\s@]+@[^\s@]+$/.test(b.email.trim())) {
        return reply.status(400).send({ error: `"${b.email}" is not an email address` });
      }
```

(rest unchanged.)

POST /workspaces commit — replace the Task 5 call with:

```ts
      const author = userAuthor(resolveCurrentUser(await loadUsersFromDir(this.paths.users).catch(() => [])));
      const slug = slugForDir(record.name);
      await commitConfigFiles(this.paths, slug, { author, message: `config(${slug}): create` }).catch((err) => {
        this.app.log.warn(
          `Could not commit config files for workspace "${record.name}": ${String((err as Error).message)}`,
        );
      });
```

PUT /workspaces — after its `saveWorkspace(…)` succeeds and before `reloadWorkspaces()`, add the same block with message `config(${slug}): update`. Import `userAuthor` from `./git-author.js`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the Step 2 command. Expected: both `ok`.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm -C swarm typecheck
git add swarm/src/server.ts swarm/src/server.test.ts
git commit -m "feat(swarm): commits into the org repo name the acting user

User.email (PUT /me) feeds the git author on workspace create/update;
absent email falls back to <slug>@users.smithagents so blame names a person."
```

---

### Task 7: Verification gates and the live smoke

**Files:** none modified — evidence only. Record every output in the task notes.

- [ ] **Step 1: Full gates on the committed state**

Per `merge-at-task-boundaries`: verify the COMMITTED tree, not the working tree.

```bash
git worktree add --detach /tmp/org-verify HEAD
ln -s "$(pwd)/node_modules" /tmp/org-verify/node_modules
ln -s "$(pwd)/swarm/node_modules" /tmp/org-verify/swarm/node_modules
cd /tmp/org-verify/swarm && pnpm typecheck > /tmp/v-tsc.txt 2>&1; echo "tsc $?"
cd /tmp/org-verify/swarm && SMITH_STATE_ROOT=$(mktemp -d) pnpm test > /tmp/v-test.txt 2>&1; echo "test $?"; grep -E '^# (pass|fail)' /tmp/v-test.txt
cd /tmp/org-verify/swarm && pnpm lint > /tmp/v-biome.txt 2>&1; tail -3 /tmp/v-biome.txt; tail -3 /tmp/biome-before.txt
pnpm -C /tmp/org-verify/broker typecheck > /tmp/v-broker.txt 2>&1; echo "broker tsc $?"
git worktree remove --force /tmp/org-verify
```

Expected: `tsc 0`, `test 0` with `# fail 0`, biome finding count ≤ baseline, broker tsc unchanged from baseline (this plan does not touch the broker; a change there is a regression).

- [ ] **Step 2: Live smoke against a COPY of the real state — never the live root**

```bash
SMOKE=$(mktemp -d)/state && cp -R ~/.smithagents "$SMOKE"
ls "$SMOKE/workspaces/proving-ground"                     # expect: config  smith-agent-proving-ground  .runtime
cd swarm && SMITH_STATE_ROOT="$SMOKE" node --import tsx src/server.ts --port 7781 > /tmp/smoke-boot.txt 2>&1 &
SWARM_PID=$!; sleep 8
grep -E 'org-repo|org-migration' /tmp/smoke-boot.txt       # expect: "[org-repo] created …/config" and "[org-migration] imported: proving-ground"
git -C "$SMOKE/config" log --oneline                        # expect: "Import workspace proving-ground" above "Org config"
git -C "$SMOKE/config" ls-tree -r --name-only HEAD          # expect: settings.json, workspaces/proving-ground/{settings.json,roster.json,boards/*.json}
ls "$SMOKE/workspaces/proving-ground"                     # expect: config-archived-<stamp>  smith-agent-proving-ground  .runtime  — NO config/
curl -s localhost:7781/workspaces | head -c 300             # expect: proving-ground listed
curl -s localhost:7781/work/boards | grep -o 'proving-ground-[a-z]*' | sort -u   # expect: the three boards
curl -s localhost:7781/workspaces/proving-ground/roster    # expect: recorded: true
kill $SWARM_PID
```

Then boot again on the same copy and confirm idempotence:

```bash
cd swarm && SMITH_STATE_ROOT="$SMOKE" node --import tsx src/server.ts --port 7781 > /tmp/smoke-boot2.txt 2>&1 &
SWARM_PID=$!; sleep 8; grep -c 'org-migration\] imported' /tmp/smoke-boot2.txt   # expect: 0
git -C "$SMOKE/config" log --oneline | wc -l                         # expect: same count as before
kill $SWARM_PID
```

- [ ] **Step 3: Positive control**

Break something on purpose and watch the gate catch it, so a gate that silently stopped running cannot pass as clean:

```bash
cd swarm && sed -i '' 's/workspaces\/${slug}\/settings.json/workspaces\/${slug}\/settings.jsn/' src/workspace-repos.ts
SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/workspace-repos.test.ts' > /tmp/pc.txt 2>&1; echo "exit $? (expect non-zero)"
git checkout -- src/workspace-repos.ts
```

- [ ] **Step 4: Update the memory and hand off**

Update `workspace-documents-spec-shipped.md` in the memory dir: Plan 1 shipped @ `<sha>`, the three deviations (registry shape, Settings email UI, org name), and any trap found while executing. Then merge per `merge-at-task-boundaries` (`git fetch . <branch>:main`, push with the `ecruz165` account) and hand off to Plan 2.

---

## Self-review

**Spec coverage (this plan's share):**
- §1.1 layout — Tasks 1, 4, 5. The `files →` symlink, `specs/`, `plans/`, `dashboards/` are Plans 2-3; the allowlist already names them (Task 2).
- §1.2 — branch namespaces: instance branches unchanged (Task 4); proposal branches are Plan 2.
- §1.3 registry — DEVIATION 1, recorded above.
- §1.4 commits — Task 2 (allowlist, committer, author), Task 6 (user author on routes). Per-mutation document commits are Plan 2. Boot-time healing commits are authored by the tool (`SMITH_IDENTITY`) — spec says "absent means the tool healed something", consistent.
- §8.1 sparse worktree — Task 4. §8.2 files symlink and §8.3 manifest docs — Plan 3.
- §9.1 org repo creation — Task 5 boot block (blueprints from `broker/.smith/blueprints` move in Plan 2, with the blueprint code). §9.2 import + archive — Task 3. §9.5 registry rewrite — not needed under Deviation 1. §10 migration tests — Task 3 (twice, archives, nothing deleted, missing reported), sparse worktree tests — Task 4, authorship — Task 2, allowlist — Task 2, positive control — Task 7.

**Placeholder scan:** no TBD/TODO; every code step has code; the test-substitution table in Task 5 gives the exact before/after per site rather than "similar to".

**Type consistency:** `configDirFor(paths, ws)` / `configDirForName(paths, name)` used identically in Tasks 1, 3, 4, 5; `commitConfigFiles(paths, slug, opts)` in Tasks 2, 3, 5, 6; `createInstance(…, { orgRepo, base? })` in Tasks 4 and 5; `GitAuthor`/`userAuthor`/`SMITH_IDENTITY` defined in Task 2 and consumed in Tasks 2, 6; `settingsPathFor(configDir)` changed in Task 5 and every caller listed there.
