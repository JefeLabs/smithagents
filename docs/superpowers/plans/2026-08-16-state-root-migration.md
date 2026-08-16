# State Root Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the swarm's state root out of the repo checkout to `~/.smithagents`, without losing a byte and without breaking sessions that are running.

**Architecture:** `loadConfig()` defaults `smithRoot` to `resolve(".smith")` — cwd-relative, so live state sits at `swarm/.smith/` *inside the git checkout* (gitignored, which is why a repo reset can destroy it). This plan changes the default to `~/.smithagents`, adds a `SMITH_STATE_ROOT` override, fixes a spread that clobbers the resolved root, and adds a **copy-not-move** migration. The server refuses to start against an empty new root while an old one exists, so the failure mode is a loud refusal rather than a silent empty install.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `node:test` + `node:assert/strict`, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-08-16-workspace-instances-and-assignment-design.md` §1.1 and §4.2 step 1

## Two constraints that shape every task

**1. Nothing is moved. Ever.** The migration COPIES and leaves the source untouched, so rollback is "point the root back". This install has already lost data once — an install reset on 2026-08-15 destroyed boards and documents with no recoverable backup. A migration that moves files has no undo; one that copies has a free one.

**2. `worktrees/` does not migrate.** It is 276K of the 436K state root, and it holds live session working directories: tmux processes have them as their cwd, and git has them registered at absolute paths in the parent repo. Copying them would produce two divergent trees; moving them would break both the running processes and the git registrations. Existing sessions keep using the old location (their stored `cwd` is absolute and still resolves); new sessions get worktrees under the new root. This is the spec's §4.3 "drain, do not relocate" applied to directories.

`logs/` is likewise skipped — append-only diagnostic output with no value in the new root.

## Global Constraints

- Node >= 24, TypeScript ~6.0.0, biome 2.5.3.
- Run tests from `swarm/`: `node --import tsx --test --test-timeout 60000 'src/*.test.ts' 'src/**/*.test.ts'` — launches REAL tmux. Never run two suite invocations concurrently; never use an unscoped `pkill`.
- Typecheck: `swarm/node_modules/.bin/tsc --noEmit`, NEVER `npx tsc` (a decoy binary prints "This is not the tsc command you are looking for" and exits 0 without checking). **Baseline is 12 pre-existing errors — 12 is the pass condition, not 0.**
- Both tsc and the node test runner colorize even when redirected, so `grep -c 'error TS'` and `grep '^ℹ tests'` silently return nothing. Strip ANSI: `sed 's/\x1b\[[0-9;]*m//g'`, or read tsc's `Found N errors`.
- Lint requirement is that files you touch are clean: `npx biome check <files>`. The package as a whole is NOT clean (8 errors, 2 warnings pre-existing elsewhere). Never run `biome check --write` across the package.
- State paths come from `smithPaths(root)` in `swarm/src/paths.ts`. A guard test fails the suite if any source file builds a `.smith` path from `process.cwd()` — do not reintroduce that idiom.
- **No test may write to the real `~/.smithagents`.** Tests use `mkdtemp` directories and pass roots explicitly.

---

### Task 1: Root resolution — new default, env override, and the spread fix

**Files:**
- Modify: `swarm/src/config.ts:48-64` (`loadConfig`)
- Test: `swarm/src/config.test.ts` (create if absent)

**Interfaces:**
- Consumes: nothing.
- Produces, for Tasks 2–3:
  - `defaultStateRoot(): string` exported from `swarm/src/config.ts` — returns `process.env.SMITH_STATE_ROOT` when set and non-empty, else `join(homedir(), ".smithagents")`.
  - `loadConfig()` with no override resolves `smithRoot` to `defaultStateRoot()`.
  - `loadConfig({smithRoot: "x"})` resolves it to an ABSOLUTE path (the spread no longer clobbers it).

- [ ] **Step 1: Write the failing tests**

Create `swarm/src/config.test.ts` (or append if it exists):

```ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { defaultStateRoot, loadConfig } from "./config.js";

test("defaultStateRoot: ~/.smithagents unless SMITH_STATE_ROOT overrides it", () => {
  const saved = process.env.SMITH_STATE_ROOT;
  try {
    delete process.env.SMITH_STATE_ROOT;
    assert.equal(defaultStateRoot(), join(homedir(), ".smithagents"));

    process.env.SMITH_STATE_ROOT = "/custom/root";
    assert.equal(defaultStateRoot(), "/custom/root");

    // An empty value is not an override — it is an unset variable spelled badly.
    process.env.SMITH_STATE_ROOT = "";
    assert.equal(defaultStateRoot(), join(homedir(), ".smithagents"));
  } finally {
    if (saved === undefined) delete process.env.SMITH_STATE_ROOT;
    else process.env.SMITH_STATE_ROOT = saved;
  }
});

test("loadConfig: a relative smithRoot override is resolved, not passed through raw", () => {
  // Regression: the `...overrides` spread used to re-apply the caller's raw
  // string over the resolved value, so smithRoot came back relative while
  // queueDir/worktreeDir/logsDir stayed absolute — split-brain state.
  const dir = mkdtempSync(join(tmpdir(), "smith-cfg-"));
  try {
    const cfg = loadConfig({ smithRoot: join(dir, "relative-check") });
    assert.ok(isAbsolute(cfg.smithRoot), `smithRoot must be absolute, got ${cfg.smithRoot}`);
    assert.equal(cfg.queueDir, join(cfg.smithRoot, "queue"));
    assert.equal(cfg.worktreeDir, join(cfg.smithRoot, "worktrees"));
    assert.equal(cfg.logsDir, join(cfg.smithRoot, "logs"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd swarm && node --import tsx --test --test-timeout 60000 'src/config.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -25
```

Expected: FAIL. The first errors on `defaultStateRoot is not a function`; the second fails because `loadConfig` currently defaults to `.smith` and the spread returns the raw override.

- [ ] **Step 3: Implement**

In `swarm/src/config.ts`, add the import for `homedir` alongside the existing `node:path` imports:

```ts
import { homedir } from "node:os";
```

Add this exported function above `loadConfig`:

```ts
/**
 * Where state lives when the caller does not say. `~/.smithagents` keeps it out
 * of the repo checkout — the previous default, `.smith`, resolved against the
 * process's cwd and put live state inside the working tree, where a repo reset
 * destroys it. `SMITH_STATE_ROOT` overrides for tests and alternate installs.
 */
export function defaultStateRoot(): string {
  const fromEnv = process.env.SMITH_STATE_ROOT;
  return fromEnv && fromEnv.trim() !== "" ? fromEnv : join(homedir(), ".smithagents");
}
```

Then change `loadConfig`'s first line and move `smithRoot` AFTER the spread so it cannot be clobbered:

```ts
export function loadConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  const smithRoot = resolve(overrides?.smithRoot ?? defaultStateRoot());

  const config: OrchestratorConfig = {
    smithRoot,
    queueDir: resolve(smithRoot, "queue"),
    worktreeDir: resolve(smithRoot, "worktrees"),
    logsDir: resolve(smithRoot, "logs"),
    delegateBin: resolve("bin", "smith-delegate"),
    tmuxPrefix: "task",
    agentCommands: { ...DEFAULT_AGENT_COMMANDS },
    teardownTimeoutMs: 30_000,
    defaultRuntime: "tmux",
    docker: { ...DEFAULT_DOCKER_CONFIG, ...overrides?.docker },
    ...overrides,
    // These four derive from smithRoot and must survive the spread: a caller
    // passing a relative smithRoot would otherwise get a relative root paired
    // with absolute subdirectories.
    smithRoot,
    queueDir: resolve(smithRoot, "queue"),
    worktreeDir: resolve(smithRoot, "worktrees"),
    logsDir: resolve(smithRoot, "logs"),
    // Re-apply docker merge so partial docker overrides don't clobber defaults
    ...(overrides ? { docker: { ...DEFAULT_DOCKER_CONFIG, ...overrides.docker } } : {}),
  };
```

Note: this means an explicit `queueDir`/`worktreeDir`/`logsDir` override **passed to `loadConfig`** is no longer honored. I checked before writing this, so you do not have to re-litigate the grep results:

- `agent-sessions.test.ts` sets `worktreeDir: ".smith/worktrees"` in **eight** places. Those are `AgentSessionConfig`, a *different type* that never goes through `loadConfig`. **Not affected — do not "fix" them.**
- `quarantine.ts:49` takes `logsDir` as a constructor parameter, not a config override. Not affected.
- `dispatcher.test.ts:284` calls `loadConfig({ smithRoot, agentCommands })` with an absolute `mkdtemp` root — this is the one real `loadConfig` override in the codebase, and it passes `smithRoot`, not a derived dir. It keeps working, and Task 1's second test covers exactly this shape.

So no caller is broken. If you find a NEW one that passes `queueDir`, `worktreeDir`, or `logsDir` to `loadConfig` specifically, STOP and report rather than silently breaking it.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd swarm && node --import tsx --test --test-timeout 60000 'src/config.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Run the full suite — expect breakage, and read it carefully**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t1-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t1-suite.txt | grep -E "^ℹ (tests|pass|fail)"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t1-suite.txt | grep -E "^✖" | head -10
```

`SMITH_STATE_ROOT` is set to a temp dir so the suite cannot touch the real
`~/.smithagents`. If tests fail, report which and why **before** changing them —
a test that assumed the `.smith` default is telling you about a real coupling,
and the fix may belong in the test or may reveal a caller this plan must handle.

- [ ] **Step 6: Typecheck and lint**

```bash
cd swarm
./node_modules/.bin/tsc --noEmit > /tmp/t1-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t1-tsc.txt | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+')"
npx biome check src/config.ts src/config.test.ts
```

Expected: `errors=12` (baseline), biome clean on both files.

- [ ] **Step 7: Commit**

```bash
git add swarm/src/config.ts swarm/src/config.test.ts
git commit -m "feat(swarm): default the state root to ~/.smithagents

The old default, resolve('.smith'), put live state inside the repo checkout —
gitignored, and destroyed by a repo reset. It also resolved against the
process's cwd, so the same install had different state depending on where it
was started from.

Also fixes a spread that clobbered the resolved root: loadConfig({smithRoot:'x'})
returned 'x' raw while queueDir/worktreeDir/logsDir stayed absolute. Nothing
passes that override today, but the migration is about to."
```

---

### Task 2: The migration — copy, never move

**Files:**
- Create: `swarm/src/migrate-state.ts`
- Test: `swarm/src/migrate-state.test.ts`

**Interfaces:**
- Consumes: `defaultStateRoot()` from Task 1.
- Produces, for Task 3:
  - `SKIPPED_ENTRIES: readonly string[]` — `["worktrees", "logs"]`
  - `legacyStateRoots(cwd: string): string[]` — candidate old roots, most likely first
  - `migrateState(from: string, to: string): Promise<{copied: string[]; skipped: string[]}>`
  - `needsMigration(to: string, candidates: string[]): Promise<string | null>` — the old root to migrate from, or `null` when nothing is needed

- [ ] **Step 1: Write the failing tests**

Create `swarm/src/migrate-state.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { migrateState, needsMigration, SKIPPED_ENTRIES } from "./migrate-state.js";

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "smith-mig-"));
  mkdirSync(join(dir, "old", "agents"), { recursive: true });
  mkdirSync(join(dir, "old", "worktrees", "session-abc"), { recursive: true });
  mkdirSync(join(dir, "old", "logs"), { recursive: true });
  writeFileSync(join(dir, "old", "agents", "ignacio.json"), '{"id":"ignacio"}');
  writeFileSync(join(dir, "old", "cli-tools.json"), '{"version":1}');
  writeFileSync(join(dir, "old", "worktrees", "session-abc", "f.txt"), "live");
  writeFileSync(join(dir, "old", "logs", "a.log"), "noise");
  return dir;
}

test("migrateState: copies state and leaves the source completely untouched", async () => {
  const dir = fixture();
  try {
    const result = await migrateState(join(dir, "old"), join(dir, "new"));

    assert.equal(readFileSync(join(dir, "new", "agents", "ignacio.json"), "utf8"), '{"id":"ignacio"}');
    assert.equal(readFileSync(join(dir, "new", "cli-tools.json"), "utf8"), '{"version":1}');
    // The source must still be intact — rollback is "point the root back".
    assert.equal(readFileSync(join(dir, "old", "agents", "ignacio.json"), "utf8"), '{"id":"ignacio"}');
    assert.ok(result.copied.includes("agents"));
    assert.ok(result.copied.includes("cli-tools.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migrateState: never copies worktrees or logs", async () => {
  const dir = fixture();
  try {
    const result = await migrateState(join(dir, "old"), join(dir, "new"));

    for (const skipped of SKIPPED_ENTRIES) {
      assert.throws(
        () => readFileSync(join(dir, "new", skipped, "x")),
        `${skipped} must not be copied — live worktrees are bound to their absolute paths`,
      );
      assert.ok(result.skipped.includes(skipped));
    }
    // …and the originals are still there for the running sessions.
    assert.equal(readFileSync(join(dir, "old", "worktrees", "session-abc", "f.txt"), "utf8"), "live");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migrateState: refuses to overwrite an entry that already exists in the target", async () => {
  const dir = fixture();
  try {
    mkdirSync(join(dir, "new"), { recursive: true });
    writeFileSync(join(dir, "new", "cli-tools.json"), '{"version":"PRECIOUS"}');

    await assert.rejects(
      () => migrateState(join(dir, "old"), join(dir, "new")),
      /cli-tools\.json/,
      "must name the colliding entry rather than silently overwriting it",
    );
    assert.equal(readFileSync(join(dir, "new", "cli-tools.json"), "utf8"), '{"version":"PRECIOUS"}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("needsMigration: null when the target already has state, else the source to copy from", async () => {
  const dir = fixture();
  try {
    assert.equal(await needsMigration(join(dir, "new"), [join(dir, "old")]), join(dir, "old"));

    mkdirSync(join(dir, "new", "agents"), { recursive: true });
    assert.equal(await needsMigration(join(dir, "new"), [join(dir, "old")]), null);

    assert.equal(await needsMigration(join(dir, "empty-target"), [join(dir, "no-such-old")]), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd swarm && node --import tsx --test --test-timeout 60000 'src/migrate-state.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -20
```

Expected: FAIL — `Cannot find module './migrate-state.js'`.

- [ ] **Step 3: Implement**

Create `swarm/src/migrate-state.ts`:

```ts
// One-time copy of a legacy state root into the current one.
//
// COPY, never move. The source stays intact so rollback is "point the root
// back" rather than "restore from a backup you may not have" — this install
// lost boards and documents to an irreversible reset once already.
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Never migrated. `worktrees` holds live session working directories: tmux
 * processes hold them as cwd and git has registered them at absolute paths, so
 * a copy produces two divergent trees and a move breaks both. Existing sessions
 * keep the old location; new ones are created under the new root. `logs` is
 * append-only diagnostics with no value in a new root.
 */
export const SKIPPED_ENTRIES: readonly string[] = ["worktrees", "logs"];

/** Candidate legacy roots, most likely first. */
export function legacyStateRoots(cwd: string): string[] {
  return [resolve(cwd, ".smith"), resolve(cwd, "swarm", ".smith")];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The legacy root to migrate from, or null when nothing should happen —
 * either the target already holds state, or no candidate source exists.
 */
export async function needsMigration(to: string, candidates: string[]): Promise<string | null> {
  let targetEntries: string[] = [];
  try {
    targetEntries = await readdir(to);
  } catch {
    targetEntries = []; // absent target is an empty one
  }
  if (targetEntries.length > 0) return null;

  for (const candidate of candidates) {
    if (!(await exists(candidate))) continue;
    const entries = (await readdir(candidate)).filter((e) => !SKIPPED_ENTRIES.includes(e));
    if (entries.length > 0) return candidate;
  }
  return null;
}

/**
 * Copy every migratable entry from `from` into `to`. Throws — before copying
 * anything — if an entry already exists in the target, so a half-populated
 * target is never silently merged into.
 */
export async function migrateState(from: string, to: string): Promise<{ copied: string[]; skipped: string[] }> {
  const entries = await readdir(from);
  const migratable = entries.filter((e) => !SKIPPED_ENTRIES.includes(e));
  const skipped = entries.filter((e) => SKIPPED_ENTRIES.includes(e));

  // Check every collision first: a partial copy is worse than a refusal.
  const collisions: string[] = [];
  for (const entry of migratable) {
    if (await exists(join(to, entry))) collisions.push(entry);
  }
  if (collisions.length > 0) {
    throw new Error(
      `refusing to migrate into ${to} — these already exist: ${collisions.join(", ")}. ` +
        `Move them aside and retry; nothing has been copied.`,
    );
  }

  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const entry of migratable) {
    await cp(join(from, entry), join(to, entry), { recursive: true, preserveTimestamps: true });
  }
  return { copied: migratable, skipped };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd swarm && node --import tsx --test --test-timeout 60000 'src/migrate-state.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck and lint**

```bash
cd swarm
./node_modules/.bin/tsc --noEmit > /tmp/t2-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t2-tsc.txt | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+')"
npx biome check src/migrate-state.ts src/migrate-state.test.ts
```

Expected: `errors=12`, biome clean on both.

- [ ] **Step 6: Commit**

```bash
git add swarm/src/migrate-state.ts swarm/src/migrate-state.test.ts
git commit -m "feat(swarm): copy-only migration for the state root

Copies a legacy .smith root into the new one and leaves the source untouched,
so rollback is repointing the root rather than restoring a backup.

Refuses up front if any entry already exists in the target — a partial copy is
worse than a refusal.

worktrees/ and logs/ are never migrated. worktrees holds live session working
directories that tmux holds as cwd and git has registered at absolute paths:
copying gives two divergent trees, moving breaks both. Existing sessions keep
the old location; new ones land under the new root."
```

---

### Task 3: Refuse to start silently empty, and migrate this install

**Files:**
- Modify: `swarm/src/server.ts` (startup, near where `orchConfig` is assigned)
- Test: `swarm/src/migrate-state.test.ts` (add the guard test)

**Interfaces:**
- Consumes: `needsMigration`, `legacyStateRoots` from Task 2; `defaultStateRoot` from Task 1.
- Produces: nothing later tasks depend on.

The dangerous moment is a server that starts against a brand-new empty root while
the user's real state sits in the old one — it comes up looking like a fresh
install, with no agents, no workspaces, no boards. That must be a loud refusal.

- [ ] **Step 1: Write the failing test**

Append to `swarm/src/migrate-state.test.ts`:

```ts
test("needsMigration is the startup gate: it reports the source instead of letting a server come up empty", async () => {
  const dir = fixture();
  try {
    // A fresh root with the user's real state still in the legacy location.
    const source = await needsMigration(join(dir, "new"), [join(dir, "old")]);
    assert.equal(source, join(dir, "old"), "must surface the legacy root rather than returning null");

    // After migrating, the gate goes quiet — startup proceeds on later boots.
    await migrateState(join(dir, "old"), join(dir, "new"));
    assert.equal(await needsMigration(join(dir, "new"), [join(dir, "old")]), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it**

```bash
cd swarm && node --import tsx --test --test-timeout 60000 --test-name-pattern 'startup gate' 'src/migrate-state.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
```

This test may PASS immediately — `needsMigration` from Task 2 already provides
the behavior. That is correct for a characterization test: it pins the contract
the server's guard depends on. Note it in your report rather than manufacturing
a failure. To confirm it is meaningful, temporarily make `needsMigration` return
`null` unconditionally, watch this test fail, then restore it — and report that
output.

- [ ] **Step 3: Add the startup guard**

In `swarm/src/server.ts`, add the import beside the other local imports:

```ts
import { legacyStateRoots, needsMigration } from "./migrate-state.js";
```

In the server's `start()` method, before it begins listening, add:

```ts
    // A brand-new root while real state sits in a legacy one means this install
    // would come up looking fresh — no agents, no workspaces, no boards. Refuse
    // loudly instead; the copy is one command and it does not touch the source.
    const legacy = await needsMigration(this.paths.root, legacyStateRoots(process.cwd()));
    if (legacy) {
      throw new Error(
        `State root ${this.paths.root} is empty but state exists at ${legacy}.\n` +
          `Run:  cd swarm && node --import tsx -e "import{migrateState}from'./src/migrate-state.js';` +
          `migrateState('${legacy}','${this.paths.root}').then(r=>console.log(r))"\n` +
          `It copies; ${legacy} is left untouched.`,
      );
    }
```

Place it as the first statement in `start()`. If `start()` is not async or the
`paths` field is named differently, adapt — but do not move the check later than
the first listen, and do not make it a warning.

- [ ] **Step 4: Run the full suite**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t3-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t3-suite.txt | grep -E "^ℹ (tests|pass|fail)"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t3-suite.txt | grep -E "^✖" | head
```

Expected: all pass. If a server test now trips the guard, that test needs its own
`SMITH_STATE_ROOT` or an explicit `smithRoot` — report which before changing it.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd swarm
./node_modules/.bin/tsc --noEmit > /tmp/t3-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t3-tsc.txt | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+')"
npx biome check src/server.ts src/migrate-state.test.ts
git add swarm/src/server.ts swarm/src/migrate-state.test.ts
git commit -m "feat(swarm): refuse to start against an empty root when legacy state exists

Starting on a fresh ~/.smithagents while the user's real state sits in
swarm/.smith would come up looking like a first-run install — no agents, no
workspaces, no boards, and no error. The guard makes that a startup failure
naming both paths and the copy command."
```

---

### Task 4: Migrate this machine, live

**Files:** none. No commit.

This is the only step that touches real data. Everything before it was tested
against temp directories.

- [ ] **Step 1: Stop the running swarm by exact PID**

```bash
lsof -nP -iTCP:7777 -sTCP:LISTEN     # note the PID
kill <pid>
```

Never an unscoped pattern kill — other agents' processes run on this machine.

- [ ] **Step 2: Record what exists now, so the comparison afterwards is real**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents
ls -1 swarm/.smith/ | sort > /tmp/state-before.txt
cat /tmp/state-before.txt
curl -s -m 3 http://127.0.0.1:7777/health || echo "  (stopped, as expected)"
```

- [ ] **Step 3: Run the migration**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/swarm
node --import tsx -e "
import { migrateState } from './src/migrate-state.js';
import { defaultStateRoot } from './src/config.js';
const to = defaultStateRoot();
migrateState('.smith', to).then(r => console.log(JSON.stringify({ to, ...r }, null, 2)));
"
```

Expected: JSON naming the new root, `copied` listing everything except
`worktrees` and `logs`, and `skipped` listing exactly those two.

- [ ] **Step 4: Prove the source survived**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents
ls -1 swarm/.smith/ | sort > /tmp/state-after.txt
diff /tmp/state-before.txt /tmp/state-after.txt && echo "SOURCE UNCHANGED"
ls -1 ~/.smithagents/ | sort
```

Expected: `SOURCE UNCHANGED`, and the new root holding everything except
`worktrees`/`logs`. If the source changed at all, STOP — the migration was
supposed to be a copy.

- [ ] **Step 5: Restart and verify the install is not empty**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/swarm
nohup node --env-file=../.env --import tsx src/server.ts > /tmp/swarm-migrated.log 2>&1 &
until curl -s -m 3 http://127.0.0.1:7777/health > /dev/null; do sleep 1; done
for ep in /agents/registry /workspaces /squads /api-keys /cli-tools; do
  printf '%-18s %s\n' "$ep" "$(curl -s -m 5 "http://127.0.0.1:7777$ep" | head -c 100)"
done
```

Expected: every route returns real data. **Empty arrays mean the migration did
not take** — stop and report; the rollback is to unset nothing and simply start
with `SMITH_STATE_ROOT=$(pwd)/.smith`, since the source is untouched.

- [ ] **Step 6: Confirm existing sessions still reconcile**

```bash
curl -s -m 5 http://127.0.0.1:7777/agent-sessions | head -c 300
```

Expected: the previously-running sessions are listed. Their stored `cwd` values
point into the OLD `swarm/.smith/worktrees/`, which still exists — that is why
`worktrees` was never migrated.

- [ ] **Step 7: No commit**

This task produces none. Leave `swarm/.smith/` in place as the rollback; deleting
it is a separate decision for the user, not part of this plan.

---

## Self-review

**Spec coverage.** §1.1 requires `~/.smithagents` as the host root — Task 1. §4.2
step 1 requires host paths to move there — Tasks 2–4, by copy. The spec also
places `master.key` in the new root (it currently lives at `~/.smith/master.key`);
**that is deliberately NOT in this plan** — it is a credential with its own
encryption-at-rest concerns, `~/.smith` is a different legacy root than
`swarm/.smith`, and bundling a secret move into a bulk copy is how secrets get
lost. It gets its own change.

The registry (`workspaces.json` mapping name → absolute path, §1.1) is likewise
excluded: this plan relocates the root, and the registry is a new feature on top.

**Placeholders.** None. Every step contains the literal command or code.

**Type consistency.** `defaultStateRoot()`, `legacyStateRoots(cwd)`,
`needsMigration(to, candidates)`, `migrateState(from, to)`, and
`SKIPPED_ENTRIES` are spelled identically in every task that names them. The
`{copied, skipped}` shape is asserted in Task 2's tests and consumed in Task 4's
expectations.

**Known residue.** After Task 4 the same state exists in two places. That is the
intended end state of this plan — the old copy is the rollback. Deleting
`swarm/.smith` is a user decision, and should not happen until at least one
session has been created and completed against the new root.
