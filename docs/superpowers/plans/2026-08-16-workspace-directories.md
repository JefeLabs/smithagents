# Workspace Directories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every workspace a real directory on disk — the container the config repo, project repos, and ephemeral instances will live in — without moving any existing data into it.

**Architecture:** A workspace is currently a JSON record (`~/.smithagents/workspaces/<name>.json`) whose `repos[].path` points at clones the user made by hand; the workspace itself owns no directory. This plan adds `Workspace.dir` — an absolute path, defaulting to `<stateRoot>/workspaces/<name>/` — creates `config/` and `.runtime/` inside it, and exposes it on the API. **Nothing moves.** Records stay where they are and boards stay in the flat `work/` directory.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `node:test` + `node:assert/strict`, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-08-16-workspace-instances-and-assignment-design.md` §1.2

## Why this plan moves nothing

The previous two plans established the pattern that this one follows deliberately.
Plan 2 made state paths explicit while changing nothing on disk, and was
risk-free. Plan 3 moved data and produced three defects — a guard that could
never fire, a remedy that always refused, and a reset button that bricked the
next boot — none of which any test caught. Structure-first is not ceremony; it
is what let plan 2 land untroubled while plan 3 needed two live positive
controls and a final review to shake out.

So: this plan creates directories. The plan after it moves the workspace record
into `<dir>/config/settings.json`, adds the `workspaces.json` registry, and
relocates boards.

## Two constraints discovered before writing

**1. Board ids must not change, even when their files eventually move.**
`boardIdFor(workspaceId, type)` returns `` `${slug(workspaceId)}-${type}` `` — the
workspace name is baked into the id, the id IS the filename, and other subsystems
reference boards by id (`capabilities.ts:447 repointSliceCardRef(cap, cardId,
boardId)`). When boards move in a later plan, `proving-ground-deliver.json` keeps
that exact name inside its new directory. This plan does not touch boards at all,
but the constraint is recorded here so the next plan does not "tidy" the name.

**2. `workspaces/` already holds records, and will also hold directories.**
`~/.smithagents/workspaces/proving-ground.json` is a record file; the spec's
layout wants `~/.smithagents/workspaces/proving-ground/` as that workspace's
directory. A file and a directory of those two names coexist legally, and the
spec resolves the awkwardness later by moving records into a single
`workspaces.json` registry plus per-workspace `config/settings.json`. That
consolidation is the NEXT plan. Here, both live side by side on purpose.

## Global Constraints

- Node >= 24, TypeScript ~6.0.0, biome 2.5.3.
- Run tests from `swarm/`, with the state root on a temp dir so nothing touches the real one:
  `SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/*.test.ts' 'src/**/*.test.ts'`
  `loadConfig()` calls `ensureDirectories()`, so an unguarded run creates the real `~/.smithagents` as a side effect.
- The suite launches REAL tmux. One invocation at a time; never an unscoped `pkill`.
- Typecheck: `swarm/node_modules/.bin/tsc --noEmit`, NEVER `npx tsc` (a decoy binary prints "This is not the tsc command you are looking for" and exits 0 without checking). **Baseline is 12 pre-existing errors — 12 is the pass condition, not 0.**
- Both tsc and the test runner colorize even when redirected: `grep -c 'error TS'` and `grep '^ℹ tests'` silently return nothing. Strip ANSI with `sed 's/\x1b\[[0-9;]*m//g'`, or read tsc's `Found N errors`.
- Lint only the files you touch: `npx biome check <files>`. The package has 8 pre-existing errors and 2 warnings elsewhere; never run `--write` across it.
- State paths come from `smithPaths(root)` in `swarm/src/paths.ts`. A guard test fails the suite if any source file builds a `.smith` path from `process.cwd()`.
- **No test may touch the real `~/.smithagents` or `swarm/.smith`.** Use `mkdtemp`.
- The live install is already migrated: `~/.smithagents` is authoritative, `swarm/.smith` is an untouched rollback.

---

### Task 1: `Workspace.dir` and where it defaults to

**Files:**
- Modify: `swarm/src/workspaces.ts` (the `Workspace` interface and its validator)
- Test: `swarm/src/workspaces.test.ts`

**Interfaces:**
- Consumes: `SmithPaths` from `swarm/src/paths.ts` — specifically `paths.workspaces`, which is `<root>/workspaces`.
- Produces, for Task 2:
  - `Workspace.dir?: string` — absolute path to this workspace's directory. Optional on the record; absent means "use the default".
  - `workspaceDir(paths: SmithPaths, ws: Workspace): string` — the resolved directory: `ws.dir` when set, else `join(paths.workspaces, slugForDir(ws.name))`.
  - `slugForDir(name: string): string` — the directory-safe form of a workspace name.

- [ ] **Step 1: Write the failing tests**

Append to `swarm/src/workspaces.test.ts`:

```ts
test("workspaceDir: defaults under the state root's workspaces directory", () => {
  const paths = smithPaths("/state");
  assert.equal(
    workspaceDir(paths, { name: "proving-ground", repos: [] } as Workspace),
    join("/state", "workspaces", "proving-ground"),
  );
});

test("workspaceDir: an explicit dir wins, so a workspace can live anywhere", () => {
  const paths = smithPaths("/state");
  assert.equal(
    workspaceDir(paths, { name: "proving-ground", dir: "/Users/me/Development/pg", repos: [] } as Workspace),
    "/Users/me/Development/pg",
  );
});

test("workspaceDir: a relative explicit dir is resolved, never left relative", () => {
  const paths = smithPaths("/state");
  const got = workspaceDir(paths, { name: "pg", dir: "some/where", repos: [] } as Workspace);
  assert.ok(isAbsolute(got), `expected an absolute path, got ${got}`);
});

test("slugForDir: a workspace name becomes a safe directory name", () => {
  assert.equal(slugForDir("proving-ground"), "proving-ground");
  assert.equal(slugForDir("My Client / Q3"), "my-client-q3");
  assert.equal(slugForDir("  spaced  "), "spaced");
});

test("slugForDir: refuses a name that would escape its parent", () => {
  // A workspace named "../../etc" must never resolve outside the state root.
  const paths = smithPaths("/state");
  const got = workspaceDir(paths, { name: "../../etc", repos: [] } as Workspace);
  assert.ok(
    got.startsWith(join("/state", "workspaces") + "/"),
    `a traversal-shaped name must stay inside the workspaces dir; got ${got}`,
  );
});
```

Add these imports at the top of the file if not already present:

```ts
import { isAbsolute, join } from "node:path";
import { smithPaths } from "./paths.js";
import { type Workspace, slugForDir, workspaceDir } from "./workspaces.js";
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'workspaceDir|slugForDir' 'src/workspaces.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -25
```

Expected: FAIL — `workspaceDir is not a function` / `slugForDir is not a function`.

- [ ] **Step 3: Implement**

In `swarm/src/workspaces.ts`, add `dir` to the `Workspace` interface, beside `repos`:

```ts
  /**
   * Absolute path to this workspace's own directory — the container for its
   * config repo, project repos, and ephemeral instances. Absent means the
   * default under the state root; set explicitly to keep a workspace where the
   * user keeps code.
   */
  dir?: string;
```

Add these two exported functions:

```ts
/**
 * A workspace name reduced to a safe directory name. Lowercased, non-alphanumerics
 * collapsed to single dashes, edges trimmed — so a name can never contain a path
 * separator or a `..` segment and escape its parent.
 */
export function slugForDir(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Where this workspace's directory is. An explicit `dir` wins and is resolved to
 * absolute; otherwise it defaults under the state root, named from the slug.
 */
export function workspaceDir(paths: SmithPaths, ws: Workspace): string {
  return ws.dir ? resolve(ws.dir) : join(paths.workspaces, slugForDir(ws.name));
}
```

Add the imports this needs at the top of the file:

```ts
import { resolve } from "node:path";
import type { SmithPaths } from "./paths.js";
```

Note `join` is already imported there; add only what is missing.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'workspaceDir|slugForDir' 'src/workspaces.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Full suite, typecheck, lint**

```bash
cd swarm
SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t1-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t1-suite.txt | grep -E "^ℹ (tests|pass|fail)"
./node_modules/.bin/tsc --noEmit > /tmp/t1-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t1-tsc.txt | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+')"
npx biome check src/workspaces.ts src/workspaces.test.ts
```

Expected: all pass, `errors=12`, biome clean on both files.

Note: adding an OPTIONAL field to `Workspace` must not break its validator. If any
workspace-loading test now fails, the validator is rejecting unknown or new
fields — report which test and why before changing anything.

- [ ] **Step 6: Commit**

```bash
git add swarm/src/workspaces.ts swarm/src/workspaces.test.ts
git commit -m "feat(swarm): a workspace knows its own directory

A workspace has been a record whose repos[].path points at clones the user made
by hand; the workspace itself owned nothing on disk. Workspace.dir names the
container its config repo, project repos, and instances will live in.

Defaults under the state root, but an explicit dir wins so a workspace can sit
where the user actually keeps code. slugForDir collapses non-alphanumerics, so a
traversal-shaped name cannot escape its parent.

Nothing moves yet — this only names the location."
```

---

### Task 2: Create the directory, and tell the API about it

**Files:**
- Modify: `swarm/src/workspaces.ts` (add the creation helper)
- Modify: `swarm/src/server.ts` (call it where workspaces are created/loaded; include `dir` in the workspace listing response)
- Test: `swarm/src/workspaces.test.ts`

**Interfaces:**
- Consumes: `workspaceDir(paths, ws)` and `slugForDir(name)` from Task 1.
- Produces: `ensureWorkspaceDir(paths: SmithPaths, ws: Workspace): Promise<string>` — creates `<dir>/config/` and `<dir>/.runtime/`, returns the resolved dir. Idempotent.

- [ ] **Step 1: Write the failing test**

Append to `swarm/src/workspaces.test.ts`:

```ts
test("ensureWorkspaceDir: creates config/ and .runtime/, and is idempotent", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-dir-"));
  try {
    const paths = smithPaths(root);
    const ws = { name: "proving-ground", repos: [] } as Workspace;

    const dir = await ensureWorkspaceDir(paths, ws);
    assert.equal(dir, join(root, "workspaces", "proving-ground"));
    assert.ok(statSync(join(dir, "config")).isDirectory(), "config/ exists");
    assert.ok(statSync(join(dir, ".runtime")).isDirectory(), ".runtime/ exists");

    // Running twice must not throw and must not disturb existing contents.
    writeFileSync(join(dir, "config", "keep.txt"), "kept");
    await ensureWorkspaceDir(paths, ws);
    assert.equal(readFileSync(join(dir, "config", "keep.txt"), "utf8"), "kept");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureWorkspaceDir: honours an explicit dir outside the state root", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-root-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "ws-elsewhere-"));
  try {
    const paths = smithPaths(root);
    const target = join(elsewhere, "my-project");
    const dir = await ensureWorkspaceDir(paths, { name: "pg", dir: target, repos: [] } as Workspace);

    assert.equal(dir, target);
    assert.ok(statSync(join(target, "config")).isDirectory(), "config/ created at the explicit dir");
    assert.throws(() => statSync(join(root, "workspaces", "pg")), "nothing created under the state root");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});
```

Add any missing imports at the top of the file:

```ts
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ensureWorkspaceDir } from "./workspaces.js";
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'ensureWorkspaceDir' 'src/workspaces.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -20
```

Expected: FAIL — `ensureWorkspaceDir is not a function`.

- [ ] **Step 3: Implement the helper**

In `swarm/src/workspaces.ts`:

```ts
/**
 * Create this workspace's directory and its two fixed children, and return the
 * resolved path. `config/` is the versioned half (settings, boards, artifacts);
 * `.runtime/` is the unversioned half (instances, logs, local caches). Both are
 * created empty here — filling them is later work.
 *
 * Idempotent: `mkdir -p` semantics, existing contents untouched.
 */
export async function ensureWorkspaceDir(paths: SmithPaths, ws: Workspace): Promise<string> {
  const dir = workspaceDir(paths, ws);
  await mkdir(join(dir, "config"), { recursive: true });
  await mkdir(join(dir, ".runtime"), { recursive: true });
  return dir;
}
```

`mkdir` is already imported in this file from `node:fs/promises`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'ensureWorkspaceDir' 'src/workspaces.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Wire it into the server**

Two edits in `swarm/src/server.ts`:

1. **On workspace creation.** Find the `POST /workspaces` handler (search for `this.app.post("/workspaces"`). After the workspace is saved with `saveWorkspace(...)`, add:

```ts
      await ensureWorkspaceDir(this.paths, ws);
```

using whatever local variable holds the new workspace record.

2. **In the workspace listing.** Find the `GET /workspaces` handler (search for `this.app.get("/workspaces"`). Include the resolved directory on each returned workspace so the control plane can show where a workspace lives:

```ts
        dir: workspaceDir(this.paths, w),
```

Add the import at the top, beside the other `./workspaces.js` imports:

```ts
import { ensureWorkspaceDir, workspaceDir } from "./workspaces.js";
```

Read the existing handlers before editing — if the listing already maps workspaces
through a helper, add the field there rather than restructuring the handler.

- [ ] **Step 6: Full suite, typecheck, lint**

```bash
cd swarm
SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t2-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t2-suite.txt | grep -E "^ℹ (tests|pass|fail)"
./node_modules/.bin/tsc --noEmit > /tmp/t2-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t2-tsc.txt | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+')"
npx biome check src/workspaces.ts src/workspaces.test.ts src/server.ts
```

Expected: all pass, `errors=12`, biome clean on the three files.

- [ ] **Step 7: Commit**

```bash
git add swarm/src/workspaces.ts swarm/src/workspaces.test.ts swarm/src/server.ts
git commit -m "feat(swarm): create a workspace's directory and report it

ensureWorkspaceDir makes <workspace>/config/ and <workspace>/.runtime/ — the
versioned and unversioned halves of a workspace — and is idempotent, so calling
it on every create is safe.

GET /workspaces now reports each workspace's resolved dir, so the control plane
can show where a workspace actually lives rather than inferring it.

Still no data movement: the directories are created empty."
```

---

### Task 3: Verify against the live install

**Files:** none. No commit.

The live install is already on `~/.smithagents` with one real workspace
(`proving-ground`). This confirms the directory appears for it without disturbing
anything that already works.

- [ ] **Step 1: Restart the swarm on the new code**

Stop it by exact PID — never an unscoped pattern kill, other agents run on this machine:

```bash
lsof -nP -iTCP:7777 -sTCP:LISTEN     # note the PID
kill <pid>
cd swarm && nohup node --env-file=../.env --import tsx src/server.ts > /tmp/swarm.log 2>&1 &
until curl -s -m 3 http://127.0.0.1:7777/health > /dev/null; do sleep 1; done
```

- [ ] **Step 2: Confirm the listing now reports a directory**

```bash
curl -s -m 5 http://127.0.0.1:7777/workspaces | python3 -m json.tool | grep -E '"name"|"dir"'
```

Expected: `proving-ground` with a `dir` of `/Users/edwincruz/.smithagents/workspaces/proving-ground`.

The directory itself may not exist yet — `ensureWorkspaceDir` runs on CREATE, and
this workspace already existed. That is expected and correct for this plan; the
next plan creates directories for existing workspaces as part of moving records
into them.

- [ ] **Step 3: Confirm creating a workspace makes its directory**

A plain workspace requires at least one repo with an ABSOLUTE path —
`workspaces.ts` validates `o.repos.length > 0` and `isAbsolute(r.path)` — so an
empty `repos: []` is rejected. It does not check that the path exists, so a
throwaway directory is enough:

```bash
mkdir -p /tmp/dir-probe-repo
curl -s -m 10 -X POST http://127.0.0.1:7777/workspaces \
  -H 'Content-Type: application/json' \
  -d '{"name":"dir-probe","description":"throwaway, verifies directory creation","repos":[{"name":"probe","path":"/tmp/dir-probe-repo"}]}' | head -c 250
echo
ls -la ~/.smithagents/workspaces/dir-probe/
```

Expected: `config/` and `.runtime/` both present.

If the POST is rejected for a different reason, read the handler's validation and
report what it required rather than guessing at a shape.

- [ ] **Step 4: Remove the probe workspace**

```bash
curl -s -m 10 -X DELETE http://127.0.0.1:7777/workspaces/dir-probe | head -c 120
echo
ls -d ~/.smithagents/workspaces/dir-probe 2>/dev/null && echo "  directory remains (expected — delete removes the record, not the dir)" || echo "  directory removed too"
rm -rf ~/.smithagents/workspaces/dir-probe /tmp/dir-probe-repo
```

Whether DELETE removes the directory is worth knowing either way — report which
happened. Removing a workspace's directory is a data-deleting operation and this
plan does not implement it; if the API already does, that is a finding.

- [ ] **Step 5: Confirm the real workspace is undisturbed**

```bash
curl -s -m 5 http://127.0.0.1:7777/workspaces | head -c 200; echo
curl -s -m 5 http://127.0.0.1:7777/agents/registry | head -c 80
```

Expected: `proving-ground` still listed with its repo intact, agents still served.

- [ ] **Step 6: No commit**

This task produces none. If Step 3 or 5 fails, Tasks 1–2 are wrong and the branch
does not merge.

---

## Self-review

**Spec coverage.** §1.2 defines the workspace folder as an unversioned container
holding `config/` (versioned), project repos, and `.runtime/` (unversioned).
Tasks 1–2 create that container and its two fixed children. The project repos
inside it are NOT created here — a workspace currently points at clones the user
made by hand, and relocating or re-cloning them is a separate concern with its
own failure modes. `config/` is created as a plain directory, not a git repo;
`git init` belongs with the plan that puts content in it, since an empty repo
with no commit is a state the next plan would have to handle anyway.

**Placeholders.** None. Every step contains literal code or commands.

**Type consistency.** `workspaceDir(paths, ws)`, `slugForDir(name)`, and
`ensureWorkspaceDir(paths, ws)` are spelled identically in Task 1's interface
block, Task 1's implementation, Task 2's tests, and Task 2's server wiring. All
three take `SmithPaths` as their first argument, matching `paths.ts`'s existing
convention.

**Known residue.** After this plan, `~/.smithagents/workspaces/` contains both
`proving-ground.json` (the record) and, once created, `proving-ground/` (the
directory). That coexistence is deliberate and temporary — the next plan
consolidates records into a `workspaces.json` registry plus per-workspace
`config/settings.json`, at which point the stray `.json` files disappear.
