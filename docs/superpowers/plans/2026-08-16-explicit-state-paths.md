# Explicit State Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every `.smith` state path from one place instead of from `process.cwd()` at 91 call sites, with **no change in where anything lands on disk**.

**Architecture:** `swarm/src/server.ts` builds state paths inline — `resolve(process.cwd(), ".smith/users")` and 90 siblings — even though `loadConfig()` already computes a `smithRoot` the server ignores. A new `swarm/src/paths.ts` turns that root into one frozen object of named paths, and the server consumes it. A guard test then makes the old idiom un-reintroducible. This is a pure refactor: the root still resolves exactly where it does today.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `node:test` + `node:assert/strict`, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-08-16-workspace-instances-and-assignment-design.md` §1.3 and §4.2

## Why this reverses the spec's step order

The spec lists "state root" (§4.2 step 1) before "explicit paths" (step 2). That
order is wrong and this plan inverts it.

Step 1 as written inherited the packaged-runtime spec's mechanism —
`process.chdir(stateRoot)` at startup, which leaves all 91 sites cwd-relative and
merely changes what cwd means. §1.3 of this spec **rejects** chdir, because a
process-global cwd can only ever name one workspace. Without chdir, you cannot
move the root while 91 sites hardcode `process.cwd()`. Explicit paths are the
enabler, not the follow-up.

**This plan therefore does NOT move the state root.** Pointing it at
`~/.smithagents` and migrating existing data is its own plan, and it becomes a
one-line change once this one lands.

## Global Constraints

- Node >= 24, TypeScript ~6.0.0, biome 2.5.3.
- Run tests from `swarm/`: `node --import tsx --test --test-timeout 60000 'src/*.test.ts' 'src/**/*.test.ts'`
- The suite launches REAL tmux sessions. Never run two suite invocations concurrently; never use an unscoped `pkill`.
- Typecheck with the workspace binary, never `npx`: `swarm/node_modules/.bin/tsc --noEmit`. **Baseline is 12 pre-existing errors — 12 is the pass condition, not 0.** `npx tsc` resolves a decoy that prints "This is not the tsc command you are looking for" and exits 0 without checking.
- Read counts from tsc's own `Found N errors` line. **Both tsc and the node test runner colorize even when redirected**, so `grep -c 'error TS'` and `grep '^ℹ tests'` silently return nothing. Strip ANSI first: `sed 's/\x1b\[[0-9;]*m//g'`.
- `biome check` for the whole swarm package is NOT clean (8 errors, 2 warnings, all pre-existing in files this plan does not touch). The requirement is that **files this plan touches have zero diagnostics**: `npx biome check src/paths.ts src/server.ts`.
- Behavior must not change. No file may move on disk, and no route may return different data. This is a refactor.

---

### Task 1: The paths module

**Files:**
- Create: `swarm/src/paths.ts`
- Test: `swarm/src/paths.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, for Task 2:
  - `smithPaths(root: string): SmithPaths`
  - `SmithPaths` with string members: `root`, `users`, `workspaces`, `agents`, `cliTools`, `apiKeys`, `containers`, `devices`, `channels`, `avatars`, `sessions`, `apiSessions`, `work`, `workCapabilities`, `squads`, `groups`, `legacyProjectFile`, `legacyProjectsDir`
  - and one method: `archived(kind: "work" | "squads" | "avatars" | "agents", stamp: string): string`

- [ ] **Step 1: Write the failing tests**

Create `swarm/src/paths.test.ts`:

```ts
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { smithPaths } from "./paths.js";

test("smithPaths: every state path hangs off the given root", () => {
  const p = smithPaths("/state");
  assert.equal(p.root, "/state");
  assert.equal(p.users, join("/state", "users"));
  assert.equal(p.workspaces, join("/state", "workspaces"));
  assert.equal(p.agents, join("/state", "agents"));
  assert.equal(p.cliTools, join("/state", "cli-tools.json"));
  assert.equal(p.apiKeys, join("/state", "api-keys.json"));
  assert.equal(p.containers, join("/state", "containers.json"));
  assert.equal(p.devices, join("/state", "devices.json"));
  assert.equal(p.channels, join("/state", "channels"));
  assert.equal(p.avatars, join("/state", "avatars"));
  assert.equal(p.sessions, join("/state", "sessions"));
  assert.equal(p.apiSessions, join("/state", "api-sessions"));
  assert.equal(p.work, join("/state", "work"));
  assert.equal(p.workCapabilities, join("/state", "work", "capabilities"));
  assert.equal(p.squads, join("/state", "squads"));
  assert.equal(p.groups, join("/state", "groups"));
});

test("smithPaths: legacy project markers keep their exact names", () => {
  const p = smithPaths("/state");
  assert.equal(p.legacyProjectFile, join("/state", "project.json"));
  assert.equal(p.legacyProjectsDir, join("/state", "projects"));
});

test("smithPaths.archived: timestamped sibling of the live directory", () => {
  const p = smithPaths("/state");
  assert.equal(p.archived("work", "20260816T120000"), join("/state", "work-archived-20260816T120000"));
  assert.equal(p.archived("squads", "S"), join("/state", "squads-archived-S"));
  assert.equal(p.archived("avatars", "S"), join("/state", "avatars-archived-S"));
  assert.equal(p.archived("agents", "S"), join("/state", "agents-archived-S"));
});

test("smithPaths: the returned object is frozen — callers cannot repoint state at runtime", () => {
  const p = smithPaths("/state");
  assert.throws(() => {
    (p as unknown as Record<string, string>).users = "/tmp/hijacked";
  }, TypeError);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd swarm && node --import tsx --test --test-timeout 60000 'src/paths.test.ts'
```

Expected: FAIL — `Cannot find module './paths.js'`.

- [ ] **Step 3: Implement the module**

Create `swarm/src/paths.ts`:

```ts
// Every `.smith` state path, resolved once from a single root.
//
// server.ts previously built these inline as `resolve(process.cwd(), ".smith/x")`
// at 91 call sites. That idiom has two defects: it re-derives the root on every
// call, and it can only ever name ONE location — so a process serving several
// workspaces has no way to say which one it means. Naming the paths here makes
// the root a parameter instead of an ambient fact.
//
// This module does NOT decide where the root is. Callers pass it in.
import { join } from "node:path";

/** Directories that get archived to a timestamped sibling rather than deleted. */
export type ArchivableKind = "work" | "squads" | "avatars" | "agents";

export interface SmithPaths {
  readonly root: string;
  readonly users: string;
  readonly workspaces: string;
  readonly agents: string;
  readonly cliTools: string;
  readonly apiKeys: string;
  readonly containers: string;
  readonly devices: string;
  readonly channels: string;
  readonly avatars: string;
  readonly sessions: string;
  readonly apiSessions: string;
  readonly work: string;
  readonly workCapabilities: string;
  readonly squads: string;
  readonly groups: string;
  /** Legacy markers: present only to warn that projects were replaced by workspaces. */
  readonly legacyProjectFile: string;
  readonly legacyProjectsDir: string;
  /** Timestamped archive sibling, e.g. work-archived-20260816T120000. */
  archived(kind: ArchivableKind, stamp: string): string;
}

export function smithPaths(root: string): SmithPaths {
  return Object.freeze({
    root,
    users: join(root, "users"),
    workspaces: join(root, "workspaces"),
    agents: join(root, "agents"),
    cliTools: join(root, "cli-tools.json"),
    apiKeys: join(root, "api-keys.json"),
    containers: join(root, "containers.json"),
    devices: join(root, "devices.json"),
    channels: join(root, "channels"),
    avatars: join(root, "avatars"),
    sessions: join(root, "sessions"),
    apiSessions: join(root, "api-sessions"),
    work: join(root, "work"),
    workCapabilities: join(root, "work", "capabilities"),
    squads: join(root, "squads"),
    groups: join(root, "groups"),
    legacyProjectFile: join(root, "project.json"),
    legacyProjectsDir: join(root, "projects"),
    archived(kind: ArchivableKind, stamp: string): string {
      return join(root, `${kind}-archived-${stamp}`);
    },
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd swarm && node --import tsx --test --test-timeout 60000 'src/paths.test.ts'
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck and lint the new file**

```bash
cd swarm
./node_modules/.bin/tsc --noEmit > /tmp/t1-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t1-tsc.txt | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+')"
npx biome check src/paths.ts src/paths.test.ts
```

Expected: `errors=12` (baseline), and biome reports no diagnostics for those two files.

- [ ] **Step 6: Commit**

```bash
git add swarm/src/paths.ts swarm/src/paths.test.ts
git commit -m "feat(swarm): name every .smith state path in one module

server.ts builds state paths inline as resolve(process.cwd(), '.smith/x') at 91
call sites. That re-derives the root per call and can only ever name one
location, so a process serving several workspaces cannot say which it means.

smithPaths(root) names them once and takes the root as a parameter. Frozen, so
nothing can repoint state at runtime. No consumers yet."
```

---

### Task 2: Sweep `server.ts` onto the module, and make the old idiom un-reintroducible

**Files:**
- Modify: `swarm/src/server.ts` (91 call sites; add one field near `orchConfig` at :252 and its assignment after :291)
- Test: `swarm/src/paths.test.ts` (add the guard test)

**Interfaces:**
- Consumes: `smithPaths(root)` and every `SmithPaths` member from Task 1.
- Produces: `SmithOrchestratorServer` holds `private readonly paths: SmithPaths`.

The guard test comes first and will report 91 violations. That failure IS the
task's specification: the list it prints is exactly the work.

- [ ] **Step 1: Write the guard test — it will fail with 91 violations**

Append to `swarm/src/paths.test.ts`:

```ts
import { readdir, readFile } from "node:fs/promises";

/**
 * The refactor this guards is easy to undo one line at a time: the next feature
 * that needs a state path will reach for resolve(process.cwd(), ".smith/…")
 * because that is what the surrounding code used to look like. This test fails
 * the moment that happens, and names the file and line.
 */
test("no source file builds a .smith path from process.cwd()", async () => {
  const entries = await readdir("src", { recursive: true });
  const offenders: string[] = [];
  for (const entry of entries) {
    const rel = String(entry);
    if (!rel.endsWith(".ts")) continue;
    const content = await readFile(join("src", rel), "utf8");
    content.split("\n").forEach((line, i) => {
      if (/resolve\(\s*process\.cwd\(\)\s*,\s*["'`]\.smith/.test(line)) {
        offenders.push(`src/${rel}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `state paths must come from smithPaths(), not process.cwd():\n${offenders.join("\n")}`,
  );
});
```

- [ ] **Step 2: Run it and record the violation list**

```bash
cd swarm && node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'process.cwd' 'src/paths.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -40
```

Expected: FAIL, listing ~91 `src/server.ts:<line>` entries. Save that list — it is your worklist.

- [ ] **Step 3: Give the server a paths field**

In `swarm/src/server.ts`, beside the existing `private readonly orchConfig: OrchestratorConfig;` declaration (~:252), add:

```ts
  private readonly paths: SmithPaths;
```

Add the import at the top of the file, alongside the other local imports:

```ts
import { type SmithPaths, smithPaths } from "./paths.js";
```

And immediately after `this.orchConfig = loadConfig(this.config.orchestrator);` (~:291), add:

```ts
    // Resolved once from the config's root. Previously every state path was
    // re-derived from process.cwd() at each call site.
    this.paths = smithPaths(this.orchConfig.smithRoot);
```

`loadConfig()` already sets `smithRoot = resolve(overrides?.smithRoot ?? ".smith")`, which is the same absolute path the inline calls produced. **That equivalence is what makes this a no-op on disk** — verified in Step 6.

- [ ] **Step 4: Replace every call site**

Work through the list from Step 2. Each replacement is mechanical:

| Was | Becomes |
|---|---|
| `resolve(process.cwd(), ".smith/users")` | `this.paths.users` |
| `resolve(process.cwd(), ".smith/workspaces")` | `this.paths.workspaces` |
| `resolve(process.cwd(), ".smith/agents")` | `this.paths.agents` |
| `resolve(process.cwd(), ".smith/cli-tools.json")` | `this.paths.cliTools` |
| `resolve(process.cwd(), ".smith/api-keys.json")` | `this.paths.apiKeys` |
| `resolve(process.cwd(), ".smith/containers.json")` | `this.paths.containers` |
| `resolve(process.cwd(), ".smith/devices.json")` | `this.paths.devices` |
| `resolve(process.cwd(), ".smith/channels")` | `this.paths.channels` |
| `resolve(process.cwd(), ".smith/avatars")` | `this.paths.avatars` |
| `resolve(process.cwd(), ".smith/sessions")` | `this.paths.sessions` |
| `resolve(process.cwd(), ".smith/api-sessions")` | `this.paths.apiSessions` |
| `resolve(process.cwd(), ".smith/work")` | `this.paths.work` |
| `resolve(process.cwd(), ".smith/work/capabilities")` | `this.paths.workCapabilities` |
| `resolve(process.cwd(), ".smith/squads")` | `this.paths.squads` |
| `resolve(process.cwd(), ".smith/groups")` | `this.paths.groups` |
| `resolve(process.cwd(), ".smith/project.json")` | `this.paths.legacyProjectFile` |
| `resolve(process.cwd(), ".smith/projects")` | `this.paths.legacyProjectsDir` |
| ``resolve(process.cwd(), `.smith/work-archived-${stamp}`)`` | `this.paths.archived("work", stamp)` |
| ``resolve(process.cwd(), `.smith/squads-archived-${stamp}`)`` | `this.paths.archived("squads", stamp)` |
| ``resolve(process.cwd(), `.smith/avatars-archived-${stamp}`)`` | `this.paths.archived("avatars", stamp)` |
| ``resolve(process.cwd(), `.smith/agents-archived-${stamp}`)`` | `this.paths.archived("agents", stamp)` |

Four things to watch:

1. **Three local closures already exist** — `cliToolsPath` (~:2213), `containersPath` (~:2249), `apiKeysPath` (~:2277), each `const xPath = () => resolve(process.cwd(), ".smith/…")`. Delete the closure and replace its call sites (`cliToolsPath()` → `this.paths.cliTools`). Do not leave a closure that just returns the field.
2. **`this` must be in scope.** Some call sites are inside arrow functions passed to Fastify route handlers, which capture `this` correctly; a few may be inside plain `function` callbacks, which do not. If `this` is unavailable at a site, capture `const paths = this.paths;` in the enclosing method rather than converting callbacks or reaching for `process.cwd()` again.
3. **One string literal is a glob, not a path:** `` `.smith/workspaces/*.json` `` appears in a message or pattern, not a `resolve(...)` call. Leave any non-`resolve` occurrence alone — the guard regex only matches `resolve(process.cwd(), ".smith…`, so if the guard passes, you have not missed one.
4. **Do not "improve" anything else.** No renames, no reordering, no touching the 8 pre-existing biome errors in other files.

- [ ] **Step 5: Run the guard and the full suite**

```bash
cd swarm
node --import tsx --test --test-timeout 60000 --test-name-pattern 'process.cwd' 'src/paths.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -20
node --import tsx --test --test-timeout 60000 'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t2-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t2-suite.txt | grep -E "^ℹ (tests|pass|fail)"
```

Expected: the guard passes with zero offenders, and the full suite is green with the same test count as before your changes plus Task 1's 4 and this task's 1.

- [ ] **Step 6: Prove nothing moved on disk**

This is the check that makes "pure refactor" a claim rather than a hope. The
resolved paths must be byte-identical to what the old idiom produced:

```bash
cd swarm && node --import tsx -e '
import { resolve } from "node:path";
import { loadConfig } from "./src/config.js";
import { smithPaths } from "./src/paths.js";
const p = smithPaths(loadConfig().smithRoot);
const cases = [
  ["users", p.users], ["workspaces", p.workspaces], ["agents", p.agents],
  ["cli-tools.json", p.cliTools], ["api-keys.json", p.apiKeys],
  ["containers.json", p.containers], ["devices.json", p.devices],
  ["channels", p.channels], ["avatars", p.avatars], ["sessions", p.sessions],
  ["api-sessions", p.apiSessions], ["work", p.work],
  ["work/capabilities", p.workCapabilities], ["squads", p.squads],
  ["groups", p.groups], ["project.json", p.legacyProjectFile],
  ["projects", p.legacyProjectsDir],
];
let bad = 0;
for (const [suffix, got] of cases) {
  const want = resolve(process.cwd(), ".smith/" + suffix);
  if (got !== want) { console.log("MISMATCH", suffix, got, "!=", want); bad++; }
}
console.log(bad === 0 ? "ALL PATHS IDENTICAL TO PRE-REFACTOR" : bad + " MISMATCHES");
'
```

Expected: `ALL PATHS IDENTICAL TO PRE-REFACTOR`. Any mismatch means state would
move on disk — stop and report rather than committing.

- [ ] **Step 7: Typecheck and lint**

```bash
cd swarm
./node_modules/.bin/tsc --noEmit > /tmp/t2-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t2-tsc.txt | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+')"
npx biome check src/paths.ts src/paths.test.ts src/server.ts
```

Expected: `errors=12` (baseline), no diagnostics in those three files. Do not run
`biome check --write` across the package — 8 unrelated errors live elsewhere.

- [ ] **Step 8: Commit**

```bash
git add swarm/src/server.ts swarm/src/paths.test.ts
git commit -m "refactor(swarm): resolve state paths from smithPaths, not process.cwd()

Replaces 91 inline resolve(process.cwd(), '.smith/x') calls in server.ts with a
single resolved paths object, and deletes the three local closures that wrapped
the same idiom.

Pure refactor — verified the resolved paths are byte-identical to what the old
calls produced, so nothing moves on disk.

The guard test is the durable half: the next feature that reaches for
process.cwd() to find state fails the suite with a file:line, instead of
quietly adding a 92nd site."
```

---

### Task 3: Verify the running server against the live state

**Files:** none. No commit.

The suite exercises the module and the guard, but every route in `server.ts` reads
real state from disk. This confirms the sweep did not silently repoint a route at
an empty directory — a failure mode that looks like "no data" rather than an error.

- [ ] **Step 1: Restart the swarm on the new code**

It runs detached from `swarm/`. Stop it by exact PID — never an unscoped pattern
kill, which would match other agents' processes on this machine:

```bash
lsof -nP -iTCP:7777 -sTCP:LISTEN     # note the PID
kill <pid>
cd swarm && nohup node --env-file=../.env --import tsx src/server.ts > /tmp/swarm.log 2>&1 &
until curl -s -m 3 http://127.0.0.1:7777/health > /dev/null; do sleep 1; done
```

- [ ] **Step 2: Confirm each swept route still returns its real data**

Empty arrays here are the failure signature — they mean a route is reading a
directory that does not exist.

```bash
for ep in /health /agents/registry /workspaces /squads /agent-sessions /api-keys; do
  printf '%-18s %s\n' "$ep" "$(curl -s -m 5 "http://127.0.0.1:7777$ep" | head -c 110)"
done
```

Expected: `/agents/registry` lists the created agents, `/workspaces` shows
`proving-ground`, `/squads` shows alpha/beta/gamma, `/api-keys` shows provider
listings. An empty `{"agents":[]}` or `{"workspaces":[]}` means state moved —
stop and report.

- [ ] **Step 3: Confirm the state root on disk is untouched**

```bash
ls -1 swarm/.smith/
```

Expected: the same entries as before this plan — `agents`, `cli-tools.json`,
`containers.json`, `logs`, `queue`, `sessions`, `squads`, `users`, `work`,
`workspaces`, `worktrees`. No new directory appeared anywhere.

- [ ] **Step 4: No commit**

This task produces none. If Step 2 or 3 fails, Task 2 is wrong and the branch
does not merge.

---

## Self-review

**Spec coverage.** §1.3 requires paths be "absolute, resolved from the workspace
record. No `process.cwd()`, no `chdir`." Tasks 1–2 deliver the no-`process.cwd()`
half and the guard that keeps it. The "resolved from the workspace record" half
needs a workspace registry, which does not exist yet — that is the next plan, and
this one is its prerequisite. §4.2 step 2 is fully covered; step 1 is deliberately
excluded, with the reasoning in the header.

**Placeholders.** None. Every code step contains literal text; Task 2's Step 4 is
a complete substitution table rather than "replace the remaining sites".

**Type consistency.** `smithPaths(root: string): SmithPaths` and every member name
are spelled identically in `paths.ts`, `paths.test.ts`, and Task 2's substitution
table. `archived(kind, stamp)` takes `ArchivableKind`, and all four literals used
in Task 2 (`"work"`, `"squads"`, `"avatars"`, `"agents"`) are members of it.

**Known residue.** `OrchestratorConfig` keeps its own `queueDir`, `worktreeDir`,
and `logsDir`, which `smithPaths` deliberately does not duplicate — the dispatcher
consumes those and this plan does not touch it. Folding them in is a follow-up,
not a gap: duplicating them here would create two sources of truth for the same
three paths.
