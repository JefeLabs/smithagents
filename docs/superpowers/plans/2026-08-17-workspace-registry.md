# Workspace Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move each workspace's record into its own `config/settings.json`, found through a `workspaces.json` registry, so a workspace directory carries its own definition.

**Architecture:** Records live at `<stateRoot>/workspaces/<name>.json` today, and every reader/writer goes through three functions in `swarm/src/workspaces.ts`. The registry — `<stateRoot>/workspaces.json`, mapping name → absolute directory — solves the bootstrap problem: you cannot read a record inside a workspace directory without first knowing where that directory is. Readers consult the registry, then each `<dir>/config/settings.json`, and **fall back to the flat files** for anything not yet migrated. Because the read is dual-sourced, the relocation is a separate reversible task.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `node:test` + `node:assert/strict`, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-08-16-workspace-instances-and-assignment-design.md` §1.1, §1.2

## What investigation established

- **Three functions are the only door**: `loadWorkspacesFromDir(dir)`, `saveWorkspace(dir, ws)`, `removeWorkspaceFile(dir, name)` — all in `swarm/src/workspaces.ts`. ~21 call sites, all inside `swarm` (`server.ts` 17, `dispatcher.ts` 2, `users.ts` 1, `source-migration.ts` 1).
- **No broker or control-plane code reads records from disk.** The `saveWorkspace*` hits in `broker/src` are `saveWorkspaceChannels`, an unrelated HTTP client method. Everything outside swarm goes through the HTTP API.
- **No registry exists yet** — `workspaces.json` appears nowhere in the codebase.
- Current paths: read `join(dir, file)` over `*.json`; write `join(dir, \`${ws.name}.json\`)`; delete the same.

## The lesson this plan is built around

Plan 5 moved boards and put a live defect on the user's install. The dual-read design was sound; what failed was **three call sites left reading a single stale directory** — including one read-modify-write that, pointed at the wrong place, found nothing, wrote nothing, and raised no error.

Here the exposure is smaller because all access funnels through three functions. **Task 2's job is to prove that claim rather than assume it** — see its requirements. If a fourth path to workspace records exists, it must be found before the migration, not after.

## Global Constraints

- Node >= 24, TypeScript ~6.0.0, biome 2.5.3.
- Run tests from `swarm/` with the state root on a temp dir:
  `SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/*.test.ts' 'src/**/*.test.ts'`
  `loadConfig()` calls `ensureDirectories()`, so an unguarded run creates the real `~/.smithagents`. The suite launches REAL tmux — one invocation at a time, never an unscoped `pkill`.
- Typecheck: `swarm/node_modules/.bin/tsc --noEmit`, NEVER `npx tsc` (a decoy binary prints "This is not the tsc command you are looking for" and exits 0 without checking). **Baseline is 12 pre-existing errors — 12 is the pass condition, not 0.**
- Both tsc and the test runner colorize even when redirected: strip ANSI with `sed 's/\x1b\[[0-9;]*m//g'`, or read tsc's `Found N errors`.
- Lint only files you touch: `npx biome check <files>`. The package has 8 pre-existing errors and 2 warnings elsewhere; never `--write` across it.
- **No test may touch the real `~/.smithagents` or `swarm/.smith`.** Use `mkdtemp`.
- Existing helpers: `workspaceDir(paths, ws)`, `ensureWorkspaceDir(paths, ws)`, `slugForDir(name)`, `boardsDirFor(paths, workspaces, workspaceId)` — all in `swarm/src/workspaces.ts`. `paths.workspaces` is `<root>/workspaces`.
- `Workspace` records are validated on load and the validator has no allowlist — it checks named fields and returns `o as Workspace`. Adding fields is safe; removing one is not.

---

### Task 1: The registry file

**Files:**
- Create: `swarm/src/workspace-registry.ts`
- Test: `swarm/src/workspace-registry.test.ts`

**Interfaces:**
- Consumes: `SmithPaths` from `./paths.js`.
- Produces, for Tasks 2–3:
  - `registryPath(paths: SmithPaths): string` — `<root>/workspaces.json`
  - `loadRegistry(paths: SmithPaths): Promise<Record<string, string>>` — name → absolute directory; `{}` when absent
  - `saveRegistryEntry(paths: SmithPaths, name: string, dir: string): Promise<void>` — add or update one entry, preserving the rest
  - `removeRegistryEntry(paths: SmithPaths, name: string): Promise<void>` — remove one entry; a missing name is not an error

- [ ] **Step 1: Write the failing tests**

Create `swarm/src/workspace-registry.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { smithPaths } from "./paths.js";
import { loadRegistry, registryPath, removeRegistryEntry, saveRegistryEntry } from "./workspace-registry.js";

test("registryPath: workspaces.json sits at the state root, beside the workspaces dir", () => {
  const paths = smithPaths("/state");
  assert.equal(registryPath(paths), join("/state", "workspaces.json"));
});

test("loadRegistry: an absent registry is an empty one, not an error", async () => {
  const root = mkdtempSync(join(tmpdir(), "reg-absent-"));
  try {
    assert.deepEqual(await loadRegistry(smithPaths(root)), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saveRegistryEntry: adds an entry without disturbing the others", async () => {
  const root = mkdtempSync(join(tmpdir(), "reg-add-"));
  try {
    const paths = smithPaths(root);
    await saveRegistryEntry(paths, "alpha", "/dirs/alpha");
    await saveRegistryEntry(paths, "beta", "/dirs/beta");
    await saveRegistryEntry(paths, "alpha", "/dirs/alpha-moved");

    assert.deepEqual(await loadRegistry(paths), {
      alpha: "/dirs/alpha-moved",
      beta: "/dirs/beta",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removeRegistryEntry: drops one entry, and a missing name is a no-op", async () => {
  const root = mkdtempSync(join(tmpdir(), "reg-rm-"));
  try {
    const paths = smithPaths(root);
    await saveRegistryEntry(paths, "alpha", "/dirs/alpha");
    await saveRegistryEntry(paths, "beta", "/dirs/beta");

    await removeRegistryEntry(paths, "alpha");
    assert.deepEqual(await loadRegistry(paths), { beta: "/dirs/beta" });

    await removeRegistryEntry(paths, "never-existed");
    assert.deepEqual(await loadRegistry(paths), { beta: "/dirs/beta" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadRegistry: a malformed registry throws rather than silently reporting no workspaces", async () => {
  const root = mkdtempSync(join(tmpdir(), "reg-bad-"));
  try {
    const paths = smithPaths(root);
    writeFileSync(registryPath(paths), "{not json");
    // Returning {} here would look exactly like a fresh install and would let
    // the server come up owning nothing. It must fail loudly instead.
    await assert.rejects(() => loadRegistry(paths));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/workspace-registry.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -20
```

Expected: FAIL — `Cannot find module './workspace-registry.js'`.

- [ ] **Step 3: Implement**

Create `swarm/src/workspace-registry.ts`:

```ts
// The workspace registry: name -> absolute directory.
//
// It exists to solve a bootstrap problem. A workspace's record is moving into
// its own directory (<dir>/config/settings.json), so the directory has to be
// known BEFORE the record can be read. The registry is the one thing findable
// without knowing anything else.
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SmithPaths } from "./paths.js";

export function registryPath(paths: SmithPaths): string {
  return join(paths.root, "workspaces.json");
}

/**
 * name -> absolute workspace directory. An ABSENT registry is an empty one —
 * that is a fresh install. A MALFORMED one throws: reporting no workspaces
 * because the file could not be parsed would look identical to a fresh install
 * and would let the server come up owning nothing.
 */
export async function loadRegistry(paths: SmithPaths): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(registryPath(paths), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  return JSON.parse(raw) as Record<string, string>;
}

async function writeRegistry(paths: SmithPaths, entries: Record<string, string>): Promise<void> {
  // Write-and-rename: a torn registry is unrecoverable without it, since the
  // registry is how every workspace is found.
  const target = registryPath(paths);
  const tmp = `${target}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`);
  await rename(tmp, target);
}

export async function saveRegistryEntry(paths: SmithPaths, name: string, dir: string): Promise<void> {
  const entries = await loadRegistry(paths);
  entries[name] = dir;
  await writeRegistry(paths, entries);
}

export async function removeRegistryEntry(paths: SmithPaths, name: string): Promise<void> {
  const entries = await loadRegistry(paths);
  if (!(name in entries)) return;
  delete entries[name];
  await writeRegistry(paths, entries);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/workspace-registry.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Full suite, typecheck, lint**

```bash
cd swarm
SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t1-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t1-suite.txt | grep -E "^ℹ (tests|pass|fail)"
./node_modules/.bin/tsc --noEmit > /tmp/t1-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t1-tsc.txt | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+')"
npx biome check src/workspace-registry.ts src/workspace-registry.test.ts
```

Expected: all pass, `errors=12`, biome clean.

- [ ] **Step 6: Commit**

```bash
git add swarm/src/workspace-registry.ts swarm/src/workspace-registry.test.ts
git commit -m "feat(swarm): a registry mapping workspace name to directory

Workspace records are moving into each workspace's own directory, which creates
a bootstrap problem: the directory must be known before the record inside it can
be read. workspaces.json is the one thing findable without knowing anything
else.

An absent registry is an empty one — a fresh install. A malformed one THROWS,
because reporting no workspaces on a parse failure looks exactly like a fresh
install and would let the server come up owning nothing.

Write-and-rename, since a torn registry loses every workspace. No consumers yet."
```

---

### Task 2: Read from both places, write to both

**Files:**
- Modify: `swarm/src/workspaces.ts` (the three access functions)
- Test: `swarm/src/workspaces.test.ts`

**Interfaces:**
- Consumes: `loadRegistry`, `saveRegistryEntry`, `removeRegistryEntry` from Task 1; `workspaceDir`, `ensureWorkspaceDir` from this file.
- Produces, for Task 3:
  - `settingsPathFor(dir: string): string` — `<dir>/config/settings.json`
  - `loadWorkspaces(paths: SmithPaths): Promise<Workspace[]>` — registry-and-settings first, flat files as fallback, deduped by name with the settings copy winning.
  - `saveWorkspace` and `removeWorkspaceFile` keep their names but take `paths` instead of a bare directory.

**Before writing any code, do this and report the result:** confirm the three functions really are the only path to workspace records. Run

```bash
grep -rn "workspaces" swarm/src --include=*.ts | grep -vE "\.test\.|workspace-registry|loadWorkspacesFromDir|saveWorkspace|removeWorkspaceFile" | grep -E "readFile|readdir|writeFile|rm\(|join\(" | head -20
```

and read what it finds. Plan 5's Critical was a call site nobody knew about. **If you find a fourth path that touches record files directly, STOP and report it** — the migration in Task 3 is unsafe until every reader is accounted for.

- [ ] **Step 1: Report the audit, then write the failing tests**

Append to `swarm/src/workspaces.test.ts`:

```ts
test("loadWorkspaces: reads a record from the workspace's own settings.json", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-settings-"));
  try {
    const paths = smithPaths(root);
    const dir = join(root, "elsewhere", "pg");
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(
      settingsPathFor(dir),
      JSON.stringify({ name: "pg", repos: [{ name: "r", path: "/abs/r" }] }),
    );
    await saveRegistryEntry(paths, "pg", dir);

    const all = await loadWorkspaces(paths);
    assert.deepEqual(all.map((w) => w.name), ["pg"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadWorkspaces: still reads a flat record that has not been migrated", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-flat-"));
  try {
    const paths = smithPaths(root);
    mkdirSync(paths.workspaces, { recursive: true });
    writeFileSync(
      join(paths.workspaces, "legacy.json"),
      JSON.stringify({ name: "legacy", repos: [{ name: "r", path: "/abs/r" }] }),
    );

    const all = await loadWorkspaces(paths);
    assert.deepEqual(all.map((w) => w.name), ["legacy"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadWorkspaces: when a record exists in both places, settings.json wins", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-both-"));
  try {
    const paths = smithPaths(root);
    const dir = join(root, "workspaces", "dup");
    mkdirSync(join(dir, "config"), { recursive: true });
    mkdirSync(paths.workspaces, { recursive: true });
    writeFileSync(
      settingsPathFor(dir),
      JSON.stringify({ name: "dup", description: "NEW", repos: [{ name: "r", path: "/abs/r" }] }),
    );
    writeFileSync(
      join(paths.workspaces, "dup.json"),
      JSON.stringify({ name: "dup", description: "STALE", repos: [{ name: "r", path: "/abs/r" }] }),
    );
    await saveRegistryEntry(paths, "dup", dir);

    const all = await loadWorkspaces(paths);
    assert.equal(all.length, 1, "one workspace, not two");
    assert.equal(all[0].description, "NEW", "the settings.json copy is authoritative");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saveWorkspace: writes settings.json and registers the directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-save-"));
  try {
    const paths = smithPaths(root);
    const ws = { name: "fresh", repos: [{ name: "r", path: "/abs/r" }] } as Workspace;

    await saveWorkspace(paths, ws);

    const dir = workspaceDir(paths, ws);
    assert.ok(statSync(settingsPathFor(dir)).isFile(), "settings.json written");
    assert.deepEqual(await loadRegistry(paths), { fresh: dir }, "and registered");
    assert.deepEqual((await loadWorkspaces(paths)).map((w) => w.name), ["fresh"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removeWorkspaceFile: deregisters and removes the flat record, leaving the directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-del-"));
  try {
    const paths = smithPaths(root);
    const ws = { name: "gone", repos: [{ name: "r", path: "/abs/r" }] } as Workspace;
    await saveWorkspace(paths, ws);

    await removeWorkspaceFile(paths, "gone");

    assert.deepEqual(await loadRegistry(paths), {}, "deregistered");
    assert.deepEqual(await loadWorkspaces(paths), [], "no longer loaded");
    // The directory itself is deliberately left — this plan deletes no data.
    assert.ok(statSync(workspaceDir(paths, ws)).isDirectory(), "directory remains");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

Add any missing imports: `mkdirSync`, `statSync`, `writeFileSync` from `node:fs`; `loadRegistry`, `saveRegistryEntry` from `./workspace-registry.js`; `loadWorkspaces`, `settingsPathFor` from `./workspaces.js`.

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'loadWorkspaces|saveWorkspace:|removeWorkspaceFile:' 'src/workspaces.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -20
```

Expected: FAIL — `loadWorkspaces is not a function` / `settingsPathFor is not a function`.

- [ ] **Step 3: Implement the dual-source access**

In `swarm/src/workspaces.ts`:

```ts
/** A workspace's own record, inside its directory. */
export function settingsPathFor(dir: string): string {
  return join(dir, "config", "settings.json");
}

/**
 * Every workspace: those registered with their own settings.json, plus any flat
 * record under paths.workspaces that has not migrated yet. Reading both is what
 * lets the relocation happen separately — an unmigrated workspace still loads.
 *
 * On a duplicate name the settings.json copy wins: it is where writes go, so it
 * is the newer of the two.
 */
export async function loadWorkspaces(paths: SmithPaths): Promise<Workspace[]> {
  const out: Workspace[] = [];
  const seen = new Set<string>();

  const registry = await loadRegistry(paths);
  for (const [name, dir] of Object.entries(registry)) {
    try {
      const raw = await readFile(settingsPathFor(dir), "utf8");
      const ws = assertContext(settingsPathFor(dir), JSON.parse(raw));
      seen.add(ws.name);
      out.push(ws);
    } catch (err) {
      // A registered workspace whose settings file is missing is not fatal —
      // the flat record below may still cover it during the transition.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  for (const ws of await loadWorkspacesFromDir(paths.workspaces)) {
    if (seen.has(ws.name)) continue;
    seen.add(ws.name);
    out.push(ws);
  }
  return out;
}
```

`assertContext` is this file's existing validator — reuse it rather than writing a second one. Keep `loadWorkspacesFromDir(dir)` exported and unchanged; it is the flat-file reader `loadWorkspaces` builds on, and Task 3's migration needs it.

Then change the two writers to take `paths` and write the new shape:

```ts
export async function saveWorkspace(paths: SmithPaths, ws: Workspace): Promise<void> {
  const dir = await ensureWorkspaceDir(paths, ws);
  await writeFile(settingsPathFor(dir), `${JSON.stringify(ws, null, 2)}\n`);
  await saveRegistryEntry(paths, ws.name, dir);
}

export async function removeWorkspaceFile(paths: SmithPaths, name: string): Promise<void> {
  await removeRegistryEntry(paths, name);
  // The flat record may still exist if this workspace never migrated.
  await rm(join(paths.workspaces, `${name}.json`), { force: true });
}
```

`rm(..., { force: true })` makes a missing flat record a no-op rather than an error.

- [ ] **Step 4: Update every caller**

The signature change from `(dir, …)` to `(paths, …)` reaches ~21 call sites. Find them:

```bash
grep -rn "loadWorkspacesFromDir(\|saveWorkspace(\|removeWorkspaceFile(" swarm/src --include=*.ts | grep -v "src/workspaces.ts"
```

For each:

| Was | Becomes |
|---|---|
| `loadWorkspacesFromDir(this.paths.workspaces)` | `loadWorkspaces(this.paths)` |
| `loadWorkspacesFromDir(resolve(root, ".smith/workspaces"))` | `loadWorkspaces(paths)` — the caller already has or can take `paths` |
| `saveWorkspace(this.paths.workspaces, ws)` | `saveWorkspace(this.paths, ws)` |
| `removeWorkspaceFile(this.paths.workspaces, name)` | `removeWorkspaceFile(this.paths, name)` |

Two callers are not in `server.ts` and may not have `paths` in scope — `dispatcher.ts` and `users.ts`/`source-migration.ts`. Read each before editing. If one has no access to `paths`, thread it in as a parameter rather than reconstructing a root; reconstructing is how the cwd-relative bug this codebase already removed would come back.

Leave `loadWorkspacesFromDir` calls that are deliberately reading ONLY the flat directory — Task 3's migration is one. If you find such a case, note it in your report.

- [ ] **Step 5: Run them to verify they pass, then the full suite**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'loadWorkspaces|saveWorkspace:|removeWorkspaceFile:' 'src/workspaces.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t2-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t2-suite.txt | grep -E "^ℹ (tests|pass|fail)"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t2-suite.txt | grep -E "^✖" | head
```

Expected: the five new tests pass and the full suite is green. A workspace test failing here likely means a caller still reads the flat directory — report which before changing it.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
cd swarm
./node_modules/.bin/tsc --noEmit > /tmp/t2-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t2-tsc.txt | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+')"
npx biome check src/workspaces.ts src/workspaces.test.ts src/server.ts src/dispatcher.ts
git add -A swarm/src
git commit -m "feat(swarm): workspaces load from settings.json, fall back to flat records

A workspace's record now lives at <dir>/config/settings.json, found through the
registry. Reads consult both that and the legacy flat directory, so a workspace
that has not migrated still loads and the relocation can happen separately.

On a duplicate name the settings.json copy wins — it is where writes go, so it
is the newer one.

saveWorkspace and removeWorkspaceFile now take paths rather than a bare
directory, because they must update the registry as well as the record."
```

---

### Task 3: Move the existing records

**Files:**
- Modify: `swarm/src/migrate-state.ts`
- Test: `swarm/src/migrate-state.test.ts`

**Interfaces:**
- Consumes: `loadWorkspacesFromDir`, `settingsPathFor`, `ensureWorkspaceDir`, `workspaceDir` from `./workspaces.js`; `saveRegistryEntry` from `./workspace-registry.js`.
- Produces: `migrateWorkspaceRecords(paths: SmithPaths): Promise<{ moved: string[]; skipped: string[] }>`

- [ ] **Step 1: Write the failing tests**

Append to `swarm/src/migrate-state.test.ts`:

```ts
test("migrateWorkspaceRecords: writes settings.json, registers the dir, removes the flat record", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-rec-"));
  try {
    const paths = smithPaths(root);
    mkdirSync(paths.workspaces, { recursive: true });
    writeFileSync(
      join(paths.workspaces, "pg.json"),
      JSON.stringify({ name: "pg", description: "REAL", repos: [{ name: "r", path: "/abs/r" }] }),
    );

    const result = await migrateWorkspaceRecords(paths);

    const dir = join(paths.workspaces, "pg");
    assert.ok(statSync(settingsPathFor(dir)).isFile(), "settings.json written");
    assert.deepEqual(await loadRegistry(paths), { pg: dir }, "registered");
    assert.throws(() => statSync(join(paths.workspaces, "pg.json")), "flat record removed");
    assert.deepEqual(result.moved, ["pg"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateWorkspaceRecords: never overwrites an existing settings.json", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-keep-"));
  try {
    const paths = smithPaths(root);
    const dir = join(paths.workspaces, "pg");
    mkdirSync(join(dir, "config"), { recursive: true });
    mkdirSync(paths.workspaces, { recursive: true });
    writeFileSync(
      settingsPathFor(dir),
      JSON.stringify({ name: "pg", description: "NEWER", repos: [{ name: "r", path: "/abs/r" }] }),
    );
    writeFileSync(
      join(paths.workspaces, "pg.json"),
      JSON.stringify({ name: "pg", description: "STALE", repos: [{ name: "r", path: "/abs/r" }] }),
    );

    await migrateWorkspaceRecords(paths);

    const kept = JSON.parse(readFileSync(settingsPathFor(dir), "utf8"));
    assert.equal(kept.description, "NEWER", "the existing settings.json is authoritative");
    assert.throws(() => statSync(join(paths.workspaces, "pg.json")), "stale flat record still removed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateWorkspaceRecords: is idempotent", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-twice-"));
  try {
    const paths = smithPaths(root);
    mkdirSync(paths.workspaces, { recursive: true });
    writeFileSync(
      join(paths.workspaces, "pg.json"),
      JSON.stringify({ name: "pg", repos: [{ name: "r", path: "/abs/r" }] }),
    );

    await migrateWorkspaceRecords(paths);
    const second = await migrateWorkspaceRecords(paths);

    assert.deepEqual(second.moved, [], "nothing left to move");
    assert.ok(statSync(settingsPathFor(join(paths.workspaces, "pg"))).isFile(), "and the record survives");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

Add `readFileSync` to the `node:fs` imports if missing, plus `settingsPathFor` from `./workspaces.js`, `loadRegistry` from `./workspace-registry.js`, and `migrateWorkspaceRecords` from `./migrate-state.js`.

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'migrateWorkspaceRecords' 'src/migrate-state.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -20
```

Expected: FAIL — `migrateWorkspaceRecords is not a function`.

- [ ] **Step 3: Implement**

In `swarm/src/migrate-state.ts`:

```ts
/**
 * Move each flat workspace record into its own directory as config/settings.json
 * and register the directory. Write first, register, then remove the flat file —
 * a record is never in neither place.
 *
 * An existing settings.json is NEVER overwritten. Since writes have been going
 * there since the registry landed, it is the newer copy; the flat file is a
 * stale leftover and is removed either way.
 */
export async function migrateWorkspaceRecords(
  paths: SmithPaths,
): Promise<{ moved: string[]; skipped: string[] }> {
  const moved: string[] = [];
  const skipped: string[] = [];

  for (const ws of await loadWorkspacesFromDir(paths.workspaces)) {
    const dir = await ensureWorkspaceDir(paths, ws);
    const settings = settingsPathFor(dir);
    let exists = true;
    try {
      await stat(settings);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      exists = false;
    }
    if (!exists) {
      await writeFile(settings, `${JSON.stringify(ws, null, 2)}\n`);
      moved.push(ws.name);
    } else {
      skipped.push(ws.name);
    }
    await saveRegistryEntry(paths, ws.name, dir);
    await stat(settings); // the record is on disk before the flat file goes
    await rm(join(paths.workspaces, `${ws.name}.json`), { force: true });
  }
  return { moved, skipped };
}
```

Add whatever imports are missing — this file already has `cp`, `mkdir`, `readdir`, `rm`, `stat` from `node:fs/promises`; you will also need `writeFile`, `join`, and the workspaces/registry helpers named above.

- [ ] **Step 4: Run them to verify they pass, then the full suite**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'migrateWorkspaceRecords' 'src/migrate-state.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t3-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t3-suite.txt | grep -E "^ℹ (tests|pass|fail)"
```

Expected: 3 new tests pass, suite green.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd swarm
./node_modules/.bin/tsc --noEmit > /tmp/t3-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t3-tsc.txt | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+')"
npx biome check src/migrate-state.ts src/migrate-state.test.ts
git add swarm/src/migrate-state.ts swarm/src/migrate-state.test.ts
git commit -m "feat(swarm): relocate workspace records into their own directories

Each flat record becomes <dir>/config/settings.json and the directory is
registered. Write, register, verify, then remove the flat file — a record is
never in neither place.

An existing settings.json is never overwritten: writes have gone there since the
registry landed, so it is the newer copy and the flat file is a stale leftover.
Removed either way, which makes a second run a no-op."
```

---

### Task 4: Verify against the live install

**Files:** none. No commit.

The install has one workspace (`proving-ground`) whose record is still a flat file, and whose boards already live in its directory.

- [ ] **Step 1: Record the before state**

```bash
ls -1 ~/.smithagents/workspaces/
cat ~/.smithagents/workspaces.json 2>/dev/null || echo "  (no registry yet — expected)"
curl -s -m 5 http://127.0.0.1:7777/workspaces | python3 -c "
import sys,json
print('  names:', [w['name'] for w in json.load(sys.stdin)['workspaces']])"
```

Save the name list — it is the invariant for Steps 3 and 5.

- [ ] **Step 2: Restart on the new code**

```bash
lsof -nP -iTCP:7777 -sTCP:LISTEN     # note the PID
kill <pid>
cd swarm && nohup node --env-file=../.env --import tsx src/server.ts > /tmp/swarm.log 2>&1 &
until curl -s -m 3 http://127.0.0.1:7777/health > /dev/null; do sleep 1; done
```

- [ ] **Step 3: Confirm the fallback works BEFORE migrating**

Nothing has moved; the record is still a flat file and there is no registry. Every workspace must still load.

```bash
curl -s -m 5 http://127.0.0.1:7777/workspaces | python3 -c "
import sys,json
print('  names:', [w['name'] for w in json.load(sys.stdin)['workspaces']])"
curl -s -m 5 http://127.0.0.1:7777/work/boards | python3 -c "
import sys,json
d=json.load(sys.stdin); b=d.get('boards') or d
print('  boards:', sorted(x['id'] for x in b))"
```

Expected: the same names as Step 1, and all four board ids. **A missing workspace here means Task 2 is wrong — stop and report rather than migrating on top of it.** Boards matter too: `boardsDirFor` resolves through the workspace list, so a workspace that fails to load takes its boards with it.

- [ ] **Step 4: Migrate**

```bash
cd swarm && node --import tsx -e "
import { loadConfig } from './src/config.js';
import { smithPaths } from './src/paths.js';
import { migrateWorkspaceRecords } from './src/migrate-state.js';
const paths = smithPaths(loadConfig().smithRoot);
console.log(JSON.stringify(await migrateWorkspaceRecords(paths), null, 1));
"
ls -1 ~/.smithagents/workspaces/
cat ~/.smithagents/workspaces.json
cat ~/.smithagents/workspaces/proving-ground/config/settings.json | head -5
```

Expected: `proving-ground` in `moved`; the flat `proving-ground.json` gone; the registry naming its directory; `settings.json` holding the record.

- [ ] **Step 5: Restart and confirm the invariant**

```bash
lsof -nP -iTCP:7777 -sTCP:LISTEN     # note the PID
kill <pid>
cd swarm && nohup node --env-file=../.env --import tsx src/server.ts > /tmp/swarm.log 2>&1 &
until curl -s -m 3 http://127.0.0.1:7777/health > /dev/null; do sleep 1; done
curl -s -m 5 http://127.0.0.1:7777/workspaces | python3 -c "
import sys,json
print('  names:', [w['name'] for w in json.load(sys.stdin)['workspaces']])"
curl -s -m 5 http://127.0.0.1:7777/work/boards | python3 -c "
import sys,json
d=json.load(sys.stdin); b=d.get('boards') or d
print('  boards:', sorted(x['id'] for x in b))"
curl -s -m 5 http://127.0.0.1:7777/agents/registry | head -c 60
```

Expected: the same workspace names, the same four board ids, agents unaffected. **Missing boards here mean the workspace list did not survive the move**, since board directories are derived from it.

- [ ] **Step 6: No commit**

This task produces none. If Step 3 or 5 fails, the branch does not merge.

---

## Self-review

**Spec coverage.** §1.1 requires `workspaces.json` as a registry of name → absolute path — Task 1, written by Task 2's `saveWorkspace` and Task 3's migration. §1.2 requires the workspace record to live in `config/settings.json` — Tasks 2–3. The spec's other `config/` contents (artifacts, diagrams) are separate content types with their own consumers and are not in scope.

**Placeholders.** None. Every step contains literal code or commands.

**Type consistency.** `registryPath(paths)`, `loadRegistry(paths)`, `saveRegistryEntry(paths, name, dir)`, `removeRegistryEntry(paths, name)`, `settingsPathFor(dir)`, `loadWorkspaces(paths)`, and `migrateWorkspaceRecords(paths)` are spelled identically everywhere they appear. `saveWorkspace` and `removeWorkspaceFile` keep their names while changing their first parameter from a directory to `SmithPaths` — that is a deliberate breaking change, and Task 2 Step 4 updates every caller.

**Known risk, stated plainly.** This is the largest of the plumbing plans and the one with the most call sites changed by a signature break. Task 2's pre-work audit exists because Plan 5's Critical was a call site nobody had enumerated; if that audit finds a fourth path to record files, the migration is unsafe until it is handled.
