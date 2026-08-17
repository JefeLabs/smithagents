# Boards Into Workspace Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store each workspace's boards inside that workspace's own `config/boards/` directory instead of one flat pile, without breaking board ids or the aggregate view.

**Architecture:** Every board except `personal` already carries a `workspaceId`, so the directory a board belongs in is derivable — no new index is needed. `boardsDirFor` resolves it; saves and deletes route through it; the loader reads the host directory AND every workspace's, merged. Because the loader reads both, old boards keep working the moment the code lands, and the migration that relocates them is a separate, reversible task.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `node:test` + `node:assert/strict`, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-08-16-workspace-instances-and-assignment-design.md` §1.2, §4.2 step 3

## What investigation established before this was written

- **Boards already carry `workspaceId`.** Verified on the live install: `proving-ground-deliver` → `proving-ground`, and `personal` → none. So a board knows its own home; nothing needs to parse it out of the id.
- **`personal` is host-level by design.** `capabilities.ts:359` says so outright: *"The single personal board. Workspace-less, so ensureWorkspaceBoards cannot cover it."* It stays in the host `work/` directory. Do not invent a workspace for it.
- **The call sites collapse to three operations** across 32 `this.workDir()` uses in `server.ts`: 15 `saveBoard`, 11 `loadBoards`, 1 `deleteBoardFile`, and 5 bare uses.
- **`ensureWorkspaceBoards(workDir, workspaceId)`** (`capabilities.ts:351`) is a fourth writer and already takes the workspace — it needs the right directory passed to it, nothing more.

## Board ids do not change — the file moves, the name does not

`boardIdFor(workspaceId, type)` returns `` `${slug(workspaceId)}-${type}` ``, the id IS the filename, and `capabilities.ts:447 repointSliceCardRef(cap, cardId, boardId)` references boards by id. So `proving-ground-deliver.json` keeps that exact name inside `<workspace>/config/boards/`. The workspace prefix becomes redundant with the directory — leave it. Renaming would break every capability that references a board, silently.

## A hazard carried from the previous plan

`slugForDir` is **lossier than the workspace name validator**: `saveWorkspace` accepts both `ab` and `ab-`, and both slug to `ab`. Nothing prevents two workspaces sharing one directory today, because `POST /workspaces` slugifies before saving — but that invariant lives in the handler, not in the type or the validator.

This plan is where it stops being theoretical: once two workspaces share a directory, they share `config/boards/`, and one workspace's boards silently overwrite the other's. **Task 1 must detect the collision rather than assume it away** — see its requirements.

## Global Constraints

- Node >= 24, TypeScript ~6.0.0, biome 2.5.3.
- Run tests from `swarm/` with the state root on a temp dir, so nothing touches the real one:
  `SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/*.test.ts' 'src/**/*.test.ts'`
  `loadConfig()` calls `ensureDirectories()`, so an unguarded run creates the real `~/.smithagents`. The suite launches REAL tmux — one invocation at a time, never an unscoped `pkill`.
- Typecheck: `swarm/node_modules/.bin/tsc --noEmit`, NEVER `npx tsc` (a decoy binary prints "This is not the tsc command you are looking for" and exits 0 without checking). **Baseline is 12 pre-existing errors — 12 is the pass condition, not 0.**
- Both tsc and the test runner colorize even when redirected: `grep -c 'error TS'` and `grep '^ℹ tests'` silently return nothing. Strip ANSI with `sed 's/\x1b\[[0-9;]*m//g'`, or read tsc's `Found N errors`.
- Lint only files you touch: `npx biome check <files>`. The package has 8 pre-existing errors and 2 warnings elsewhere; never `--write` across it.
- State paths come from `smithPaths(root)`; a guard test fails the suite if any source file builds a `.smith` path from `process.cwd()`.
- **No test may touch the real `~/.smithagents` or `swarm/.smith`.** Use `mkdtemp`.
- Existing helpers you will use: `workspaceDir(paths, ws)` and `ensureWorkspaceDir(paths, ws)` from `swarm/src/workspaces.ts`; `paths.work` is the host board directory.

---

### Task 1: Resolve a board's directory, and refuse a collision

**Files:**
- Modify: `swarm/src/workspaces.ts`
- Test: `swarm/src/workspaces.test.ts`

**Interfaces:**
- Consumes: `workspaceDir(paths, ws)` and `slugForDir(name)` (already exported from this file); `SmithPaths` from `./paths.js`.
- Produces, for Tasks 2–3:
  - `boardsDirFor(paths: SmithPaths, workspaces: Workspace[], workspaceId: string | undefined): string` — `<workspaceDir>/config/boards` when `workspaceId` names a known workspace, else `paths.work`.
  - `collidingWorkspaceDirs(paths: SmithPaths, workspaces: Workspace[]): Array<{ dir: string; names: string[] }>` — every directory two or more workspaces would share. Empty array when there are none.

- [ ] **Step 1: Write the failing tests**

Append to `swarm/src/workspaces.test.ts`:

```ts
test("boardsDirFor: a workspace's boards live under its own config/", () => {
  const paths = smithPaths("/state");
  const ws = { name: "proving-ground", repos: [] } as Workspace;
  assert.equal(
    boardsDirFor(paths, [ws], "proving-ground"),
    join("/state", "workspaces", "proving-ground", "config", "boards"),
  );
});

test("boardsDirFor: a board with no workspace stays in the host work dir", () => {
  const paths = smithPaths("/state");
  // The `personal` board is workspace-less by design (capabilities.ts:359).
  assert.equal(boardsDirFor(paths, [], undefined), paths.work);
});

test("boardsDirFor: an unknown workspace id falls back to the host work dir", () => {
  const paths = smithPaths("/state");
  // An orphaned board — its workspace record was deleted — must remain
  // loadable rather than resolving to a directory that does not exist.
  assert.equal(boardsDirFor(paths, [], "deleted-workspace"), paths.work);
});

test("boardsDirFor: honours an explicit workspace dir", () => {
  const paths = smithPaths("/state");
  const ws = { name: "pg", dir: "/elsewhere/pg", repos: [] } as Workspace;
  assert.equal(boardsDirFor(paths, [ws], "pg"), join("/elsewhere/pg", "config", "boards"));
});

test("collidingWorkspaceDirs: reports two workspaces that would share one directory", () => {
  const paths = smithPaths("/state");
  // slugForDir is lossier than the name validator: "ab" and "ab-" are both
  // valid workspace names and both slug to "ab".
  const collisions = collidingWorkspaceDirs(paths, [
    { name: "ab", repos: [] } as Workspace,
    { name: "ab-", repos: [] } as Workspace,
    { name: "unique", repos: [] } as Workspace,
  ]);
  assert.equal(collisions.length, 1);
  assert.deepEqual(collisions[0].names.sort(), ["ab", "ab-"]);
  assert.equal(collisions[0].dir, join("/state", "workspaces", "ab"));
});

test("collidingWorkspaceDirs: silent when every workspace resolves uniquely", () => {
  const paths = smithPaths("/state");
  assert.deepEqual(
    collidingWorkspaceDirs(paths, [
      { name: "alpha", repos: [] } as Workspace,
      { name: "beta", repos: [] } as Workspace,
    ]),
    [],
  );
});
```

Add to the file's imports if missing:

```ts
import { boardsDirFor, collidingWorkspaceDirs } from "./workspaces.js";
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'boardsDirFor|collidingWorkspaceDirs' 'src/workspaces.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -25
```

Expected: FAIL — `boardsDirFor is not a function` / `collidingWorkspaceDirs is not a function`.

- [ ] **Step 3: Implement**

In `swarm/src/workspaces.ts`:

```ts
/**
 * Where a board's file lives. A board carrying a known `workspaceId` belongs to
 * that workspace's config; everything else — the workspace-less `personal`
 * board, and any board whose workspace record has been deleted — stays in the
 * host work directory, so an orphan remains loadable instead of pointing at a
 * directory that does not exist.
 */
export function boardsDirFor(
  paths: SmithPaths,
  workspaces: Workspace[],
  workspaceId: string | undefined,
): string {
  if (!workspaceId) return paths.work;
  const ws = workspaces.find((w) => w.name === workspaceId);
  return ws ? join(workspaceDir(paths, ws), "config", "boards") : paths.work;
}

/**
 * Workspaces whose directories collide. `slugForDir` is lossier than the name
 * validator — "ab" and "ab-" are both valid names and both slug to "ab" — so two
 * records can resolve to one directory and silently share its contents. Nothing
 * creates such a pair through the API today, because POST slugifies before
 * saving, but that invariant lives in the handler rather than in the type.
 */
export function collidingWorkspaceDirs(
  paths: SmithPaths,
  workspaces: Workspace[],
): Array<{ dir: string; names: string[] }> {
  const byDir = new Map<string, string[]>();
  for (const ws of workspaces) {
    const dir = workspaceDir(paths, ws);
    byDir.set(dir, [...(byDir.get(dir) ?? []), ws.name]);
  }
  return [...byDir.entries()].filter(([, names]) => names.length > 1).map(([dir, names]) => ({ dir, names }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'boardsDirFor|collidingWorkspaceDirs' 'src/workspaces.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Full suite, typecheck, lint**

```bash
cd swarm
SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t1-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t1-suite.txt | grep -E "^ℹ (tests|pass|fail)"
./node_modules/.bin/tsc --noEmit > /tmp/t1-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t1-tsc.txt | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+')"
npx biome check src/workspaces.ts src/workspaces.test.ts
```

Expected: all pass, `errors=12`, biome clean.

- [ ] **Step 6: Commit**

```bash
git add swarm/src/workspaces.ts swarm/src/workspaces.test.ts
git commit -m "feat(swarm): resolve which directory a board belongs in

Every board except personal already carries a workspaceId, so a board's home is
derivable — no index needed. boardsDirFor sends a workspace's boards to its own
config/boards and everything else to the host work dir, which keeps the
workspace-less personal board and any orphaned board loadable.

collidingWorkspaceDirs surfaces the hazard this makes real: slugForDir is
lossier than the workspace name validator, so two records can resolve to one
directory and silently share it. Nothing reaches that state through the API
today; nothing in the type system stops it either."
```

---

### Task 2: Route saves and deletes, and load from everywhere

**Files:**
- Modify: `swarm/src/work-items.ts` (add the merged loader)
- Modify: `swarm/src/server.ts` (route the 17 write/delete sites; use the merged loader)
- Modify: `swarm/src/capabilities.ts:351` (`ensureWorkspaceBoards` takes the resolved dir)
- Test: `swarm/src/work-items.test.ts`

**Interfaces:**
- Consumes: `boardsDirFor(paths, workspaces, workspaceId)` from Task 1.
- Produces, for Task 3: `loadAllBoards(dirs: string[]): Promise<{ boards: WorkBoard[]; errors: Array<{ file: string; error: string }> }>` — every board across the given directories, later directories not overriding earlier ones on duplicate id.

Reading from BOTH the host directory and each workspace's is what makes this task
safe: boards that have not moved yet keep loading, so nothing breaks before the
migration in Task 3 runs.

- [ ] **Step 1: Write the failing test**

Append to `swarm/src/work-items.test.ts`:

```ts
test("loadAllBoards: merges boards across directories and reports each file's errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "boards-merge-"));
  try {
    const hostDir = join(root, "work");
    const wsDir = join(root, "ws", "config", "boards");
    mkdirSync(hostDir, { recursive: true });
    mkdirSync(wsDir, { recursive: true });

    await saveBoard(hostDir, createBoard("personal", "personal"));
    await saveBoard(wsDir, createBoard("deliver", "proving-ground"));
    writeFileSync(join(wsDir, "broken.json"), "{not json");

    const { boards, errors } = await loadAllBoards([hostDir, wsDir]);

    const ids = boards.map((b) => b.id).sort();
    assert.ok(ids.includes("proving-ground-deliver"), `expected the workspace board, got ${ids.join(",")}`);
    assert.equal(boards.length, 2, `expected both boards, got ${ids.join(",")}`);
    assert.equal(errors.length, 1, "the malformed file is reported, not swallowed");
    assert.match(errors[0].file, /broken\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadAllBoards: a duplicate id keeps the first directory's copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "boards-dup-"));
  try {
    const a = join(root, "a");
    const b = join(root, "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });

    const first = createBoard("deliver", "pg");
    first.title = "FIRST";
    const second = createBoard("deliver", "pg");
    second.title = "SECOND";
    await saveBoard(a, first);
    await saveBoard(b, second);

    const { boards } = await loadAllBoards([a, b]);
    assert.equal(boards.length, 1, "a duplicate id yields one board, not two");
    assert.equal(boards[0].title, "FIRST", "the first directory wins");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadAllBoards: a missing directory contributes nothing and is not an error", async () => {
  const root = mkdtempSync(join(tmpdir(), "boards-missing-"));
  try {
    const { boards, errors } = await loadAllBoards([join(root, "nope")]);
    assert.deepEqual(boards, []);
    assert.deepEqual(errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

Add any missing imports at the top of that file:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoard, loadAllBoards, saveBoard } from "./work-items.js";
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'loadAllBoards' 'src/work-items.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -20
```

Expected: FAIL — `loadAllBoards is not a function`.

- [ ] **Step 3: Implement the merged loader**

In `swarm/src/work-items.ts`, beside `loadBoards`:

```ts
/**
 * Every board across several directories — the host work dir plus each
 * workspace's config/boards. Reading both is what lets boards move gradually:
 * a board that has not been migrated yet still loads from where it is.
 *
 * On a duplicate id the FIRST directory wins, so a board that exists in both
 * places during a migration resolves to one board rather than two.
 */
export async function loadAllBoards(
  dirs: string[],
): Promise<{ boards: WorkBoard[]; errors: Array<{ file: string; error: string }> }> {
  const boards: WorkBoard[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const result = await loadBoards(dir);
    errors.push(...result.errors);
    for (const board of result.boards) {
      if (seen.has(board.id)) continue;
      seen.add(board.id);
      boards.push(board);
    }
  }
  return { boards, errors };
}
```

`loadBoards` already returns `{ boards: [], errors: [] }` for a missing directory, so the third test passes without extra handling.

- [ ] **Step 4: Run it to verify it passes**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'loadAllBoards' 'src/work-items.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Route the server's board directories**

In `swarm/src/server.ts`, add two private helpers beside `workDir()` (~line 649):

```ts
  /** Every directory boards can live in: the host dir first, then each workspace's. */
  private boardDirs(): string[] {
    return [this.paths.work, ...this.workspaces.map((w) => join(workspaceDir(this.paths, w), "config", "boards"))];
  }

  /** Where THIS board's file belongs, from its own workspaceId. */
  private boardDir(board: { workspaceId?: string }): string {
    return boardsDirFor(this.paths, this.workspaces, board.workspaceId);
  }
```

Add the imports beside the existing `./workspaces.js` import:

```ts
import { boardsDirFor, workspaceDir } from "./workspaces.js";
```

and `loadAllBoards` beside the existing `./work-items.js` imports.

Then work through `server.ts`:

| Was | Becomes |
|---|---|
| `loadBoards(this.workDir())` | `loadAllBoards(this.boardDirs())` |
| `saveBoard(this.workDir(), b)` | `saveBoard(this.boardDir(b), b)` |
| `deleteBoardFile(this.workDir(), id)` | see the note below |

For the delete site, the board must be located before its directory is known —
load it first and pass `this.boardDir(board)`. If the board cannot be found,
fall back to `this.paths.work` so a stale id still deletes its host-level file
rather than throwing.

Do NOT change `this.workDir()` itself — it stays as the host directory accessor
and is still correct for the personal board and for Task 3's migration.

Read each call site before editing; some are inside route handlers where `this`
is captured by an arrow function, and a few of the five bare `this.workDir()`
uses may not be board reads at all. Where a use is not a board directory, leave
it and note it in your report.

- [ ] **Step 6: Give `ensureWorkspaceBoards` the right directory**

`swarm/src/capabilities.ts:351` is `ensureWorkspaceBoards(workDir: string, workspaceId: string)`. Its call site (`server.ts:1806`) passes `this.workDir()`. Change the call site to pass the workspace's board directory instead:

```ts
      await ensureWorkspaceBoards(boardsDirFor(this.paths, this.workspaces, ws.name), ws.name).catch((err) => {
```

Keep the `.catch(...)` exactly as it is — a board-seeding failure is deliberately non-fatal there. Do not change `ensureWorkspaceBoards`'s signature.

One ordering hazard: this call must run AFTER the workspace exists in
`this.workspaces`, or `boardsDirFor` will not find it and will resolve to the
host directory. Check where `reloadWorkspaces()` runs relative to this call, and
if the workspace is not yet in the list, pass the directory computed directly
from the new record instead. Say which you did in your report.

- [ ] **Step 7: Full suite, typecheck, lint**

```bash
cd swarm
SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t2-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t2-suite.txt | grep -E "^ℹ (tests|pass|fail)"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t2-suite.txt | grep -E "^✖" | head
./node_modules/.bin/tsc --noEmit > /tmp/t2-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t2-tsc.txt | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+')"
npx biome check src/server.ts src/work-items.ts src/work-items.test.ts src/capabilities.ts
```

Expected: all pass, `errors=12`, biome clean on the four files. If a board test fails, report which and why before altering it — a failure here may mean a call site resolves to the wrong directory, which is exactly what this task must get right.

- [ ] **Step 8: Commit**

```bash
git add swarm/src/server.ts swarm/src/work-items.ts swarm/src/work-items.test.ts swarm/src/capabilities.ts
git commit -m "feat(swarm): boards save into their workspace, load from everywhere

saveBoard and deleteBoardFile now resolve their directory from the board's own
workspaceId, so a workspace's boards land in its config/boards and the
workspace-less personal board stays at host level.

loadAllBoards reads the host directory AND every workspace's, so boards that
have not moved yet keep loading — the relocation can happen separately and
gradually. A duplicate id resolves to the first directory's copy, so a board
present in both places during the move is one board, not two.

No files move in this commit."
```

---

### Task 3: Move the existing board files

**Files:**
- Modify: `swarm/src/migrate-state.ts` (add the board relocation)
- Test: `swarm/src/migrate-state.test.ts`

**Interfaces:**
- Consumes: `boardsDirFor` from Task 1; `ensureWorkspaceDir` from `./workspaces.js`.
- Produces: `migrateBoards(paths: SmithPaths, workspaces: Workspace[]): Promise<{ moved: Array<{ id: string; to: string }>; kept: string[] }>` — relocates each workspace-owned board out of the host directory, returns what moved and what deliberately stayed.

This is the only task that touches existing files. Like the state-root migration
before it, it **copies then removes the source only after the copy is verified**,
and it never touches a board it cannot place.

- [ ] **Step 1: Write the failing tests**

Append to `swarm/src/migrate-state.test.ts`:

```ts
test("migrateBoards: moves a workspace's board into its config, leaves personal alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-boards-"));
  try {
    const paths = smithPaths(root);
    const ws = { name: "pg", repos: [] } as Workspace;
    mkdirSync(paths.work, { recursive: true });
    await saveBoard(paths.work, createBoard("deliver", "pg"));
    await saveBoard(paths.work, createBoard("personal", "personal"));

    const result = await migrateBoards(paths, [ws]);

    const target = join(workspaceDir(paths, ws), "config", "boards", "pg-deliver.json");
    assert.ok(statSync(target).isFile(), "the workspace board moved into its config");
    assert.throws(() => statSync(join(paths.work, "pg-deliver.json")), "and is gone from the host dir");
    assert.ok(statSync(join(paths.work, "personal.json")).isFile(), "personal stayed at host level");
    assert.deepEqual(result.moved.map((m) => m.id), ["pg-deliver"]);
    assert.deepEqual(result.kept, ["personal"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateBoards: a board whose workspace no longer exists is kept, never dropped", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-orphan-"));
  try {
    const paths = smithPaths(root);
    mkdirSync(paths.work, { recursive: true });
    await saveBoard(paths.work, createBoard("deliver", "deleted-ws"));

    const result = await migrateBoards(paths, []);

    assert.ok(statSync(join(paths.work, "deleted-ws-deliver.json")).isFile(), "the orphan stays put");
    assert.deepEqual(result.moved, []);
    assert.deepEqual(result.kept, ["deleted-ws-deliver"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateBoards: is idempotent — a second run moves nothing and loses nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-twice-"));
  try {
    const paths = smithPaths(root);
    const ws = { name: "pg", repos: [] } as Workspace;
    mkdirSync(paths.work, { recursive: true });
    await saveBoard(paths.work, createBoard("deliver", "pg"));

    await migrateBoards(paths, [ws]);
    const second = await migrateBoards(paths, [ws]);

    assert.deepEqual(second.moved, [], "nothing left to move");
    const target = join(workspaceDir(paths, ws), "config", "boards", "pg-deliver.json");
    assert.ok(statSync(target).isFile(), "and the moved board is still there");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

Add any missing imports:

```ts
import { mkdirSync, statSync } from "node:fs";
import { smithPaths } from "./paths.js";
import { type Workspace, workspaceDir } from "./workspaces.js";
import { createBoard, saveBoard } from "./work-items.js";
import { migrateBoards } from "./migrate-state.js";
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'migrateBoards' 'src/migrate-state.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -20
```

Expected: FAIL — `migrateBoards is not a function`.

- [ ] **Step 3: Implement**

In `swarm/src/migrate-state.ts`:

```ts
/**
 * Relocate each workspace-owned board out of the flat host directory and into
 * its workspace's config/boards. Copy first, verify, then remove the source —
 * a board is never in neither place.
 *
 * Two kinds of board deliberately stay put: the workspace-less `personal`
 * board, and any board whose workspace record no longer exists. Dropping an
 * orphan would destroy the only copy of work that a later recreate might want.
 */
export async function migrateBoards(
  paths: SmithPaths,
  workspaces: Workspace[],
): Promise<{ moved: Array<{ id: string; to: string }>; kept: string[] }> {
  const { boards } = await loadBoards(paths.work);
  const moved: Array<{ id: string; to: string }> = [];
  const kept: string[] = [];

  for (const board of boards) {
    const ws = board.workspaceId ? workspaces.find((w) => w.name === board.workspaceId) : undefined;
    if (!ws) {
      kept.push(board.id);
      continue;
    }
    const targetDir = join(workspaceDir(paths, ws), "config", "boards");
    await mkdir(targetDir, { recursive: true });
    const from = join(paths.work, `${board.id}.json`);
    const to = join(targetDir, `${board.id}.json`);
    await cp(from, to, { preserveTimestamps: true });
    // Only once the copy is on disk does the source go.
    await stat(to);
    await rm(from);
    moved.push({ id: board.id, to });
  }
  return { moved, kept };
}
```

Add whatever is missing to this file's imports — it already imports `cp`, `mkdir`, `readdir`, and `stat` from `node:fs/promises`; you will additionally need `rm` from there, `join` from `node:path`, `loadBoards` from `./work-items.js`, and `type SmithPaths` / `type Workspace` / `workspaceDir`.

- [ ] **Step 4: Run them to verify they pass**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'migrateBoards' 'src/migrate-state.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Full suite, typecheck, lint**

```bash
cd swarm
SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t3-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t3-suite.txt | grep -E "^ℹ (tests|pass|fail)"
./node_modules/.bin/tsc --noEmit > /tmp/t3-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t3-tsc.txt | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+')"
npx biome check src/migrate-state.ts src/migrate-state.test.ts
```

Expected: all pass, `errors=12`, biome clean.

- [ ] **Step 6: Commit**

```bash
git add swarm/src/migrate-state.ts swarm/src/migrate-state.test.ts
git commit -m "feat(swarm): relocate boards into their workspace's config

Copies each workspace-owned board into its workspace's config/boards, verifies
the copy landed, and only then removes the source — a board is never in neither
place. Idempotent, so a second run moves nothing.

Two kinds stay put deliberately: the workspace-less personal board, and any
board whose workspace record no longer exists. Dropping an orphan would destroy
the only copy of work a later recreate might want, and loadAllBoards still reads
the host directory, so an orphan remains visible."
```

---

### Task 4: Verify against the live install

**Files:** none. No commit.

The live install has one real workspace (`proving-ground`) with three boards, plus
the host-level `personal` board.

- [ ] **Step 1: Record the before state**

`GET /work/boards` is the boards route — verified, not guessed. Capture both the
files on disk and the ids the API serves, because the whole point of the later
steps is that the second list never changes while the first one does:

```bash
ls -1 ~/.smithagents/work/ | sort
curl -s -m 5 http://127.0.0.1:7777/work/boards | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('  board ids:', sorted(b['id'] for b in (d.get('boards') or d)))" 2>&1 | head -3
```

Save that id list. It is the invariant for Steps 3 and 6: the same ids must be
served before the migration, and after it, from two directories instead of one.

- [ ] **Step 2: Restart on the new code**

```bash
lsof -nP -iTCP:7777 -sTCP:LISTEN     # note the PID
kill <pid>
cd swarm && nohup node --env-file=../.env --import tsx src/server.ts > /tmp/swarm.log 2>&1 &
until curl -s -m 3 http://127.0.0.1:7777/health > /dev/null; do sleep 1; done
```

- [ ] **Step 3: Confirm boards still load BEFORE migrating**

This is the point of the dual read — nothing has moved yet, and every board must
still be listed.

```bash
curl -s -m 5 http://127.0.0.1:7777/workspaces | head -c 120; echo
# and the boards route from Step 1
```

Expected: the same boards as Step 1. If any are missing, Task 2 is wrong — stop
and report rather than migrating on top of it.

- [ ] **Step 4: Run the migration**

```bash
cd swarm && node --import tsx -e "
import { loadConfig } from './src/config.js';
import { smithPaths } from './src/paths.js';
import { loadWorkspacesFromDir } from './src/workspaces.js';
import { migrateBoards } from './src/migrate-state.js';
const paths = smithPaths(loadConfig().smithRoot);
const workspaces = await loadWorkspacesFromDir(paths.workspaces);
console.log(JSON.stringify(await migrateBoards(paths, workspaces), null, 1));
"
```

Expected: the three `proving-ground-*` boards in `moved`, and `personal` in
`kept`. If `loadWorkspacesFromDir` has a different name or shape, read
`workspaces.ts`'s exports and adapt — note what you used.

- [ ] **Step 5: Confirm the move and that nothing was lost**

```bash
ls -1 ~/.smithagents/work/
ls -1 ~/.smithagents/workspaces/proving-ground/config/boards/
```

Expected: `personal.json` alone in the host dir; the three `proving-ground-*.json`
files in the workspace's config. Every board from Step 1 must be present in
exactly one of the two places.

- [ ] **Step 6: Restart and confirm the boards still serve**

```bash
lsof -nP -iTCP:7777 -sTCP:LISTEN     # note the PID
kill <pid>
cd swarm && nohup node --env-file=../.env --import tsx src/server.ts > /tmp/swarm.log 2>&1 &
until curl -s -m 3 http://127.0.0.1:7777/health > /dev/null; do sleep 1; done
curl -s -m 5 http://127.0.0.1:7777/work/boards | python3 -c "import sys,json;d=json.load(sys.stdin);print('  board ids:', sorted(b['id'] for b in (d.get('boards') or d)))"
```

Expected: the same board list as Step 1, now served from two directories.
**Missing boards here mean the migration moved files the loader cannot find** —
report immediately; the boards still exist, so this is recoverable.

- [ ] **Step 7: No commit**

This task produces none. If Step 3, 5, or 6 fails, the branch does not merge.

---

## Self-review

**Spec coverage.** §4.2 step 3 requires boards to move into per-workspace config
repos. Tasks 1–3 deliver the directory resolution, the routing, and the
relocation. `config/` is still a plain directory rather than a git repo — the
same deliberate deferral as the previous plan, since committing boards is a
separate concern from storing them. Artifacts, diagrams, and workspace settings
are NOT moved here; each is its own content type with its own consumers.

**Placeholders.** None. Every step contains literal code or commands, including
the substitution table in Task 2 Step 5.

**Type consistency.** `boardsDirFor(paths, workspaces, workspaceId)`,
`collidingWorkspaceDirs(paths, workspaces)`, `loadAllBoards(dirs)`, and
`migrateBoards(paths, workspaces)` are spelled identically in every task that
names them. All take `SmithPaths` first except `loadAllBoards`, which takes only
the directories it reads — deliberately, so it has no dependency on workspaces.

**Known residue.** `collidingWorkspaceDirs` is built in Task 1 and never called
by production code in this plan — it exists so the collision is detectable, and
wiring it into a startup warning belongs with the plan that makes workspace
directories user-settable. That is a real "unused export" and should be called
out rather than discovered later.
