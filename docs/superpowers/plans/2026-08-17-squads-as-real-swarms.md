# Squads Run As Real Swarms — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `POST /squads` prepare a real, running swarm — N members of any size, each in its own git worktree inside one workspace-instance, coordinating through an append-only update feed.

**Architecture:** A squad of N members gets one workspace-instance. Each member receives **its own worktree of the squad's repo on its own branch**, so isolation is enforced by git rather than by convention. Members never edit the same tree; they coordinate by appending `{agentName, timestamp, update}` lines to a feed the swarm serves over HTTP, and by committing — which is instantly visible to every peer, since all worktrees share one object store. Serialization happens only at integration, when the leader merges member branches.

**Tech Stack:** TypeScript ~6.0.0 (ESM, `.js` import specifiers), Node >= 24, `node:test` + `node:assert/strict`, biome 2.5.3.

**Spec:** `docs/superpowers/specs/2026-08-16-workspace-instances-and-assignment-design.md` — §2.3 (swarm shapes), §2.1 (the instance).

## Design decisions this plan encodes

These were settled with Edwin on 2026-08-17 and they override §2.3's two-shape model. Read them before the tasks; several tasks only make sense in their light.

**1. One squad shape, not two.** §2.3 offers `delegated` (built-in Claude subagents) and `federated` (separate sessions). But **every seeded squad leader is `gemini-pro`** with Claude members behind it — all three squads are multi-vendor by design, and built-in subagents are Claude-only. `delegated` could never express the roster the system actually ships.

**2. Claude's subagents are a member's private business, not a squad shape.** A member that happens to be Claude Code may spawn its own subagents for concurrent internal work. Those are **anonymous helpers**: not in the roster, no worktree, no feed entries, invisible to the squad. This is why `delegated` disappears as a squad-level choice rather than becoming a special case.

**3. Per-member worktrees, not a shared tree with turn-taking.** Turn-taking in a shared worktree is a *convention* — nothing stops a CLI editing out of turn, and the conflict is discovered later. That is the detective-not-preventive weakness this codebase keeps eliminating. Separate worktrees make stomping **structurally impossible**.

**4. Commit is the handoff, and it is cheap.** Members can't see each other's uncommitted work — the one real cost of (3). But every member worktree shares the workspace clone's object store, so a peer's commit is visible via `git show` **instantly**, with no push or fetch. Handoff granularity is "commit", which the feed announces.

**5. A branch per member.** Git refuses to check out one branch in two worktrees, so per-member worktrees require per-member branches: `smith/members/<taskId>/<member>`. Integration means merging those into the instance's own `smith/<taskId>`. That merge is the only serialized step.

> **Correction (2026-08-17, during Task 3, ruled by Edwin).** This decision originally read `smith/<taskId>/<member>`, which **cannot exist**: git's ref store holds a loose ref as a literal file under `.git/refs/heads/`, so a branch `smith/<taskId>` and a branch `smith/<taskId>/<member>` would need the same path to be a file and a directory at once. `git branch smith/w-1/fabian` fails with `cannot lock ref 'refs/heads/smith/w-1/fabian': 'refs/heads/smith/w-1' exists` (verified against git 2.55). Because the instance branch `smith/<taskId>` is already shipped, *every* name nested beneath it is unusable. Members therefore live in their own namespace, `smith/members/<taskId>/<member>`, which never collides and keeps every member listable with `git branch --list 'smith/members/*'`. `createInstance` is untouched, so live instances need no migration.

**6. The feed belongs to the swarm, not the broker.** The broker is a host-level singleton with no per-workspace state — the same limitation that blocked artifacts in the previous plan. The swarm owns instances, so it owns the feed, and the feed lives with the work at `<instance>/.runtime/updates.jsonl`.

## Global Constraints

- Node >= 24; TypeScript ~6.0.0; ESM with `.js` import specifiers on every relative import.
- Tests use `node:test` + `node:assert/strict`. **Every test writes to `mkdtempSync(tmpdir())`. No test may touch the real state root at `~/.smithagents`, and no test may reach the network** — build local git repos with `git init`.
- **Registry writes stay sequential** (`for…of` with `await`). Never `Promise.all` / `.map(async …)` over workspaces.
- **Nothing reachable from boot may throw uncaught.**
- **Never destroy uncommitted work.** Nothing in this plan destroys an instance.
- **Untrusted values reaching git must be validated**, and positionals passed after `--`. Note `resolveStartPoint` in `workspace-instances.ts`: a base that exists only as a remote-tracking ref makes `git worktree add -b` **silently discard the branch name**.
- Baselines: **571 tests passing, 0 failing; tsc 12 errors** (pre-existing, in `agent-sessions.ts`, `jira-sync.test.ts`, `server.ts`); biome clean on touched files.
- Measurement traps:
  - Typecheck with `cd swarm && ./node_modules/.bin/tsc --noEmit`. **Never `npx tsc` from the repo root** — decoy placeholder package.
  - tsc ANSI-colorizes, so `grep -c 'error TS'` returns **0 while errors are on screen**. Strip ANSI first: `sed 's/\x1b\[[0-9;]*m//g'`. **A count of 0 means your measurement broke.**
  - `node:test` summary lines start with `ℹ`, not `#`.

## Context: what exists today

- **`POST /squads` (`server.ts:1285`) queues and never launches.** It claims a squad, builds a `SquadManifest` with `status: "queued"`, stores it in `activeSquads`, returns. `buildSquadLaunchScript` (`squads.ts:463`) has **no non-test caller** — and it launches `agent-cli --name X --model Y`, a binary that does not exist. It is a design sketch, never runnable.
- **Squad size is already half-variable.** The route activates `members.slice(0, numAgents)`, and `loadSquadsFromDir` accepts any non-empty `members[]`. But `SquadDefinition.members` is a fixed 4-tuple (`squads.ts:16`) and `defaultSquad` throws unless exactly 4 (`:316`).
- **Instances exist** (previous plan): `createInstance(workspaceDir, ws, workId, repoNames, opts?)` → worktrees of `config/` plus each named repo on `smith/<work-id>`, reattaching to a surviving branch, with `resolveStartPoint` handling remote-only bases.
- **Every driver materializes a persona**, and they differ: claude → `CLAUDE.md`, codex/agy/opencode → `AGENTS.md`, copilot → `.github/copilot-instructions.md`. Each returns the paths it wrote.
- **`AgentOutputContract` (`squads.ts:33`)** already defines what a member reports: `agent`, `role`, `status`, `exitCode`, `summary`, `changes.{modifiedFiles,createdFiles}`, `verification`, `error`.
- **Nothing writes `.jsonl`** in swarm or broker — every hit is *reading* someone else's CLI transcripts.

## Scope

**In:** variable squad size; per-member worktrees in one instance; the append-only update feed and its HTTP surface; `POST /squads` preparing all of it with each member's own driver persona.

**Out, deliberately:**
- **Launching the CLIs.** This plan prepares the swarm — worktrees, personas, feed. Actually starting N tmux panes reuses `agent-sessions.ts`, which already launches CLIs in tmux, and belongs in its own plan once the preparation is verified.
- **Integration/merge.** Merging member branches into `smith/<taskId>` is the leader's job and needs its own conflict story.
- **Deleting `buildSquadLaunchScript`, `validateCompliance`, `formatPermissionBlock`, the `pane` field.** They become dead once launching lands. Removing them in the plan that replaces them means the removal is unreviewed against a working alternative.

---

### Task 1: A squad can be any size

**Files:**
- Modify: `swarm/src/squads.ts`
- Create: `swarm/src/squads.test.ts` — **this file does not exist yet**; these are its first contents, so write its imports too

**Interfaces:**
- Produces: `SquadDefinition.members: SquadMember[]` (was a fixed 4-tuple). `defaultSquad` accepts any non-empty roster with a leader.

- [ ] **Step 1: Write the failing tests**

Create `swarm/src/squads.test.ts` (there is no squad test file today — write the imports it needs: `mkdtempSync`/`rmSync`/`writeFileSync` from `node:fs`, `tmpdir`, `join`, `assert`, `test`, and the squad symbols under test):

```ts
test("defaultSquad-shaped definitions accept 2 and 3 members, not only 4", () => {
  const two: SquadDefinition = {
    id: "alpha",
    members: [
      { name: "Gabriel", pane: 1, model: "gemini-pro", role: "leader", squad: "alpha" },
      { name: "Fabian", pane: 2, model: "claude-fable", role: "architect", squad: "alpha" },
    ],
    leader: { name: "Gabriel", pane: 1, model: "gemini-pro", role: "leader", squad: "alpha" },
  };
  assert.equal(two.members.length, 2, "the type permits a 2-member squad");
});

test("loadSquadsFromDir: a 3-member squad file loads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sq3-"));
  try {
    writeFileSync(
      join(dir, "trio.json"),
      JSON.stringify({
        id: "alpha",
        members: [
          { name: "Gabriel", pane: 1, model: "gemini-pro", role: "leader", squad: "alpha" },
          { name: "Fabian", pane: 2, model: "claude-fable", role: "architect", squad: "alpha" },
          { name: "Santiago", pane: 3, model: "claude-sonnet", role: "developer", squad: "alpha" },
        ],
      }),
    );

    const squads = await loadSquadsFromDir(dir);

    assert.equal(squads.length, 1);
    assert.equal(squads[0].members.length, 3);
    assert.equal(squads[0].leader.name, "Gabriel");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSquadsFromDir: a squad with no leader is still refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sq-nolead-"));
  try {
    writeFileSync(
      join(dir, "bad.json"),
      JSON.stringify({
        id: "alpha",
        members: [{ name: "Fabian", pane: 1, model: "claude-fable", role: "architect", squad: "alpha" }],
      }),
    );
    await assert.rejects(() => loadSquadsFromDir(dir), /leader/i, "a squad without a leader is malformed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

**Check `loadSquadsFromDir`'s current leader handling first** (`squads.ts:350`) — if it already derives or requires a leader, keep that behaviour and adjust the third test to match what it really does. Report what you found.

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/squads.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -20
```

Expected: FAIL — the 2-member literal doesn't satisfy the 4-tuple type.

- [ ] **Step 3: Implement**

In `swarm/src/squads.ts`:

```ts
export interface SquadDefinition {
  id: SquadId;
  /** One or more members. A squad is 2-4 in practice, but the shape does not
   *  enforce a count — only that there is at least one, and a leader. */
  members: SquadMember[];
  leader: SquadMember; // convenience ref to the leader member
}
```

and relax `defaultSquad`'s guard from `members.length !== 4` to `members.length === 0`, keeping the leader requirement and keeping the message accurate about what it actually checks. **The seeded `SQUAD_MEMBERS` table stays exactly as it is** — four members per squad remains the default roster; this only stops the *type* from forbidding others.

- [ ] **Step 4: Run them, then the suite**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t1-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t1-suite.txt | grep -E "^ℹ (tests|pass|fail)"
```

Expected: **574 pass / 0 fail**. Any pre-existing test that depended on exactly four members is a real signal — fix the test only if the four-ness was incidental, and report it either way.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd swarm && ./node_modules/.bin/tsc --noEmit > /tmp/t1-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t1-tsc.txt | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+')"
npx biome check src/squads.ts src/squads.test.ts
git add swarm/src/squads.ts swarm/src/squads.test.ts
git commit -m "feat(swarm): a squad may be any size, not exactly four

The route already activated a variable count and squad files already accepted
any non-empty roster; only the in-code tuple type forbade it."
```

Expected: `errors=12`; biome clean.

---

### Task 2: The update feed

`{agentName, timestamp, update}` per line, appended, never rewritten. This is the squad's only coordination channel, so it has to be durable and readable while being written.

**Files:**
- Create: `swarm/src/squad-feed.ts`
- Create: `swarm/src/squad-feed.test.ts`

**Interfaces:**
- Produces:
  - `interface SquadUpdate { agentName: string; timestamp: string; update: unknown }`
  - `feedPath(instanceDir: string): string` — `<instanceDir>/.runtime/updates.jsonl`
  - `appendUpdate(instanceDir: string, agentName: string, update: unknown, now?: () => Date): Promise<SquadUpdate>`
  - `readFeed(instanceDir: string, opts?: { since?: string }): Promise<SquadUpdate[]>`

`update` is deliberately `unknown`: a member may post a free-text note or a full `AgentOutputContract`. The feed's job is ordering and attribution, not schema.

- [ ] **Step 1: Write the failing tests**

Create `swarm/src/squad-feed.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { appendUpdate, feedPath, readFeed } from "./squad-feed.js";

test("feedPath: the feed lives with the instance, in its unversioned half", () => {
  assert.equal(feedPath("/i"), join("/i", ".runtime", "updates.jsonl"));
});

test("appendUpdate: one JSON object per line, with attribution and a timestamp", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feed-"));
  try {
    await appendUpdate(dir, "Fabian", "interface committed");
    await appendUpdate(dir, "Santiago", { status: "SUCCESS", summary: "tests green" });

    const lines = readFileSync(feedPath(dir), "utf8").trim().split("\n");
    assert.equal(lines.length, 2, "one line per update");
    const first = JSON.parse(lines[0]);
    assert.equal(first.agentName, "Fabian");
    assert.equal(first.update, "interface committed");
    assert.match(first.timestamp, /^\d{4}-\d{2}-\d{2}T/, "ISO timestamp");
    assert.deepEqual(JSON.parse(lines[1]).update, { status: "SUCCESS", summary: "tests green" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendUpdate: an update containing a newline stays ONE line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feed-nl-"));
  try {
    await appendUpdate(dir, "Fabian", "line one\nline two");
    const lines = readFileSync(feedPath(dir), "utf8").trim().split("\n");
    assert.equal(lines.length, 1, "a newline in the payload must not split the record");
    assert.equal(JSON.parse(lines[0]).update, "line one\nline two");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFeed: empty when there is no feed yet", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feed-none-"));
  try {
    assert.deepEqual(await readFeed(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFeed: returns updates in append order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feed-order-"));
  try {
    for (const n of ["a", "b", "c"]) await appendUpdate(dir, n, n);
    assert.deepEqual((await readFeed(dir)).map((u) => u.agentName), ["a", "b", "c"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFeed: since returns only later entries, so a member can poll", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feed-since-"));
  try {
    let t = 0;
    const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++));
    await appendUpdate(dir, "a", "1", clock);
    const second = await appendUpdate(dir, "b", "2", clock);
    await appendUpdate(dir, "c", "3", clock);

    const later = await readFeed(dir, { since: second.timestamp });

    assert.deepEqual(later.map((u) => u.agentName), ["c"], "since is exclusive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFeed: a corrupt line does not lose the rest of the feed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feed-bad-"));
  try {
    await appendUpdate(dir, "a", "1");
    writeFileSync(feedPath(dir), `${readFileSync(feedPath(dir), "utf8")}{not json\n`);
    await appendUpdate(dir, "c", "3");

    const feed = await readFeed(dir);

    assert.deepEqual(feed.map((u) => u.agentName), ["a", "c"], "the readable entries survive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/squad-feed.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -20
```

Expected: FAIL — cannot find module `./squad-feed.js`.

- [ ] **Step 3: Implement**

Create `swarm/src/squad-feed.ts`:

```ts
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** One line of the feed: who, when, and whatever they said. */
export interface SquadUpdate {
  agentName: string;
  timestamp: string;
  /** Free-form: a note, or a full AgentOutputContract. The feed orders and
   *  attributes; it deliberately does not impose a schema on the payload. */
  update: unknown;
}

/** The squad's feed, beside the instance it describes. */
export function feedPath(instanceDir: string): string {
  return join(instanceDir, ".runtime", "updates.jsonl");
}

/**
 * Append one update. `JSON.stringify` escapes newlines, so a multi-line payload
 * stays a single record — the property the whole format depends on.
 *
 * Append-only and never rewritten: a reader can consume the file while members
 * are still writing to it, which is what makes polling safe.
 */
export async function appendUpdate(
  instanceDir: string,
  agentName: string,
  update: unknown,
  now: () => Date = () => new Date(),
): Promise<SquadUpdate> {
  const entry: SquadUpdate = { agentName, timestamp: now().toISOString(), update };
  const file = feedPath(instanceDir);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(entry)}\n`);
  return entry;
}

/**
 * The feed in append order, optionally only what followed `since` (exclusive).
 *
 * A malformed line is SKIPPED rather than fatal: this file is appended to by
 * several processes at once, so a torn final line is an expected transient —
 * failing the whole read would make the feed unusable exactly when it is busiest.
 */
export async function readFeed(instanceDir: string, opts: { since?: string } = {}): Promise<SquadUpdate[]> {
  let raw: string;
  try {
    raw = await readFile(feedPath(instanceDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: SquadUpdate[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: SquadUpdate;
    try {
      parsed = JSON.parse(line) as SquadUpdate;
    } catch {
      continue; // torn or hand-edited line — keep the rest
    }
    if (opts.since && parsed.timestamp <= opts.since) continue;
    out.push(parsed);
  }
  return out;
}
```

Note the asymmetry with the rest of the codebase, and it is deliberate: elsewhere a malformed file **throws** so corruption can't look like emptiness. Here a malformed *line* is skipped, because concurrent appends make a torn last line normal rather than exceptional. State this in your report so the reviewer weighs it as a decision, not an oversight.

- [ ] **Step 4: Run them, then the suite**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/squad-feed.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t2-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t2-suite.txt | grep -E "^ℹ (tests|pass|fail)"
```

Expected: 7 tests in the file; suite **581 pass / 0 fail**.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd swarm && ./node_modules/.bin/tsc --noEmit > /tmp/t2-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t2-tsc.txt | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+')"
npx biome check src/squad-feed.ts src/squad-feed.test.ts
git add swarm/src/squad-feed.ts swarm/src/squad-feed.test.ts
git commit -m "feat(swarm): an append-only update feed per instance

{agentName, timestamp, update} per line. A torn line is skipped rather than
fatal: several members append concurrently, so a partial last line is normal."
```

---

### Task 3: A worktree per member

Git refuses to check out one branch in two worktrees, so per-member isolation requires a branch per member.

**Files:**
- Modify: `swarm/src/workspace-instances.ts`
- Test: `swarm/src/workspace-instances.test.ts`

**Interfaces:**
- Consumes: `createInstance`, `resolveStartPoint`, `workIdProblem` from the same module.
- Produces: `addMemberWorktrees(instanceDir: string, repoSource: string, workId: string, memberNames: string[], base?: string): Promise<InstanceMember[]>` — creates `<instanceDir>/members/<name>/` on `smith/members/<workId>/<name>` (see the correction under design decision 5), idempotent, reattaching to a surviving branch exactly as `createInstance` does.
- Also produces: `memberBranch(workId, name)` and `membersDir(instanceDir)`, exported so Task 4 names branches through the same one place rather than re-spelling the convention.

- [ ] **Step 1: Write the failing tests**

Append to `swarm/src/workspace-instances.test.ts`:

```ts
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
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'addMemberWorktrees' 'src/workspace-instances.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -20
```

Expected: FAIL — `addMemberWorktrees is not a function`.

- [ ] **Step 3: Implement**

Add to `swarm/src/workspace-instances.ts`, reusing the module's existing `isWorktree`, `resolveStartPoint` and `run`:

```ts
/**
 * One worktree per squad member, under `<instance>/members/<name>/`.
 *
 * A BRANCH PER MEMBER (`smith/members/<workId>/<name>`) because git refuses to check
 * out one branch in two worktrees. That is also what makes member isolation
 * structural rather than a convention: two members physically cannot edit the
 * same tree, so no turn-taking protocol is needed.
 *
 * They still share the workspace clone's object store, so a peer's COMMIT is
 * visible immediately via `git show <branch>:<path>` with no push or fetch —
 * commit is the handoff, and the feed announces it.
 *
 * Idempotent in the same sense as createInstance: an existing member worktree
 * is left exactly as it is, because it may hold work in progress.
 */
export async function addMemberWorktrees(
  instanceDir: string,
  repoSource: string,
  workId: string,
  memberNames: string[],
  base?: string,
): Promise<InstanceMember[]> { … }
```

Validate `workId` with `workIdProblem` (same module) and each member name with **`repoNameProblem`** from `./workspace-repos.js` — it is already shipped and tested, and rejects separators, `.`/`..` and blanks, which is exactly the escape surface here. It does not reject a leading dash, and does not need to: a member name reaches git only inside `smith/members/<workId>/<name>`, never as a bare argument. **Validate every name before creating anything**, so a bad member cannot leave a half-built `members/` directory. Prune before adding, and attach rather than `-b` when the member's branch already exists, exactly as `createInstance` does.

- [ ] **Step 4: Run the file, then the suite**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/workspace-instances.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t3-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t3-suite.txt | grep -E "^ℹ (tests|pass|fail)"
```

Expected: suite **586 pass / 0 fail**.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd swarm && ./node_modules/.bin/tsc --noEmit > /tmp/t3-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t3-tsc.txt | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+')"
npx biome check src/workspace-instances.ts src/workspace-instances.test.ts
git add swarm/src/workspace-instances.ts swarm/src/workspace-instances.test.ts
git commit -m "feat(swarm): a worktree and branch per squad member

Git refuses one branch in two worktrees, so member isolation needs a branch
each — which also makes stomping structurally impossible rather than merely
discouraged. Peers still share an object store, so commit is the handoff."
```

---

### Task 4: `POST /squads` prepares the swarm, and serves the feed

**Files:**
- Modify: `swarm/src/server.ts`
- Test: `swarm/src/server.test.ts`

**Interfaces:**
- Consumes: `createInstance`, `addMemberWorktrees`; `appendUpdate`, `readFeed`, `feedPath`; `loadWorkspaces`, `workspaceDir`, `activeWorkspaces`; `getDriver` from `./drivers/index.js`.
- Produces:
  - `prepareSquadSwarm(paths, ws, taskId, members): Promise<{ instanceDir: string; feed: string; members: Array<{ name: string; path: string; branch: string; persona: string[] }> }>` — exported for testing.
  - `POST /squads/:taskId/updates` → appends `{agentName, update}`.
  - `GET /squads/:taskId/updates?since=` → the feed.

**Each member gets its own driver's persona**, not a generic one: claude writes `CLAUDE.md`, codex/agy/opencode write `AGENTS.md`, copilot writes `.github/copilot-instructions.md`. That is what makes a mixed-vendor squad work — every member is told who it is in the dialect its own CLI reads.

- [ ] **Step 1: Write the failing tests**

Append to `swarm/src/server.test.ts`:

```ts
test("prepareSquadSwarm: every member gets a worktree, a branch, and its own driver's persona", async () => {
  const root = mkdtempSync(join(tmpdir(), "psq-"));
  try {
    const paths = smithPaths(root);
    const origin = makeGitOrigin(join(root, "origin"));   // local fixture — see Step 1b
    const ws = { name: "pg", repos: [{ name: "app", path: origin, branch: "main" }] };
    await saveWorkspace(paths, ws as never);

    const prepared = await prepareSquadSwarm(paths, ws as never, "t-1", [
      { name: "Gabriel", pane: 1, model: "gemini-pro", role: "leader", squad: "alpha" },
      { name: "Santiago", pane: 2, model: "claude-sonnet", role: "developer", squad: "alpha" },
    ] as never);

    assert.equal(prepared.members.length, 2);
    for (const m of prepared.members) {
      assert.ok(statSync(m.path).isDirectory(), `${m.name} has a worktree`);
      assert.equal(m.branch, `smith/members/t-1/${m.name.toLowerCase()}`);
      assert.ok(m.persona.length > 0, `${m.name} was told who it is`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareSquadSwarm: the feed is ready before any member starts", async () => {
  const root = mkdtempSync(join(tmpdir(), "psq-feed-"));
  try {
    const paths = smithPaths(root);
    const origin = makeGitOrigin(join(root, "origin"));   // local fixture — see Step 1b
    const ws = { name: "pg", repos: [{ name: "app", path: origin, branch: "main" }] };
    await saveWorkspace(paths, ws as never);

    const prepared = await prepareSquadSwarm(paths, ws as never, "t-2", [
      { name: "Gabriel", pane: 1, model: "gemini-pro", role: "leader", squad: "alpha" },
    ] as never);

    await appendUpdate(prepared.instanceDir, "Gabriel", "starting");
    assert.deepEqual((await readFeed(prepared.instanceDir)).map((u) => u.agentName), ["Gabriel"]);
    assert.equal(prepared.feed, feedPath(prepared.instanceDir));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 1b: Build the fixture this test needs**

`makeGitOrigin` does **not** exist. Write a local one in `server.test.ts` that `git init`s a repo, writes a file, and commits — copy the shape of `makeWorkspace` in `workspace-instances.test.ts:57`. **Do not import a helper across test files**: fixtures are not a shared API here, and coupling two suites through one makes either harder to change.

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'prepareSquadSwarm' 'src/server.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -20
```

Expected: FAIL — `prepareSquadSwarm is not a function`.

- [ ] **Step 3: Implement `prepareSquadSwarm`**

Export it from `swarm/src/server.ts`. It should: resolve the squad's repo (`ws.repos[0]`, erroring clearly if there is none); `createInstance` for `taskId` on that repo; `addMemberWorktrees` for every member; then for each member resolve its driver from the member's model and call the driver's `materialize` into that member's worktree, collecting the returned paths as `persona`.

**Map `SquadModel` to a driver explicitly** — `gemini-pro` is not a Claude model, and the whole point of this shape is honouring that. If a model has no driver, throw naming the member and the model rather than silently defaulting to Claude. Report what mapping you used.

- [ ] **Step 4: Wire the route and the feed endpoints**

In `POST /squads`, after the manifest is stored, resolve a workspace (optional `body.workspace`, else `all.find((w) => w.default) ?? all[0]`) and call `prepareSquadSwarm`. **Release the claimed squad on every failure path** — a squad claimed but never launched 409s forever. Check the pool's real release method name; if there is none, say so rather than inventing one.

Add the two feed routes, both resolving the instance from `activeSquads.get(...)`'s `taskId` so a caller cannot name an arbitrary directory:

```ts
this.app.post<{ Params: { taskId: string } }>("/squads/:taskId/updates", async (req, reply) => { … });
this.app.get<{ Params: { taskId: string }; Querystring: { since?: string } }>("/squads/:taskId/updates", async (req, reply) => { … });
```

Leave `status: "queued"` as it is — this prepares the swarm; launching the CLIs is a separate plan, and claiming `"running"` would be false.

- [ ] **Step 5: Verify**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t4-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t4-suite.txt | grep -E "^ℹ (tests|pass|fail)"
cd swarm && ./node_modules/.bin/tsc --noEmit > /tmp/t4-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t4-tsc.txt | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+')"
npx biome check src/server.ts src/server.test.ts
```

Expected: **588 pass / 0 fail**; `errors=12`; biome clean.

- [ ] **Step 6: Commit**

```bash
git add swarm/src/server.ts swarm/src/server.test.ts
git commit -m "feat(swarm): POST /squads prepares a real swarm

An instance, a worktree and branch per member, each member told who it is in
its own CLI's dialect, and a feed ready before anyone starts. Status stays
queued: this prepares the swarm, it does not yet launch the CLIs."
```

---

### Task 5: Verify against the live install

**Files:** none. **No commit.**

- [ ] **Step 1: Back up**

```bash
B=$(mktemp -d)/smithagents-preplan9
mkdir -p "$B" && cp -a ~/.smithagents/workspaces "$B/workspaces"
echo "backup at $B"
```

- [ ] **Step 2: Restart and confirm nothing regressed**

```bash
PID=$(lsof -nP -iTCP:7777 -sTCP:LISTEN -t | head -1); kill "$PID"
until ! lsof -nP -iTCP:7777 -sTCP:LISTEN >/dev/null 2>&1; do sleep 1; done
cd swarm && nohup node --env-file=../.env --import tsx src/server.ts > /tmp/swarm-p9.log 2>&1 &
until curl -s -m 3 http://127.0.0.1:7777/health > /dev/null; do sleep 1; done
curl -s -m 5 http://127.0.0.1:7777/workspaces | python3 -c "
import sys,json; print('  names:', [w['name'] for w in json.load(sys.stdin)['workspaces']])"
```

- [ ] **Step 3: Prepare a 2-member squad against the real workspace**

```bash
curl -s -m 30 -X POST http://127.0.0.1:7777/squads \
  -H 'content-type: application/json' \
  -d '{"prompt":"probe: prepare only","mode":"squad","agents":2}' | python3 -m json.tool
```

Expected: two members, each with a worktree path, a `smith/members/<taskId>/<name>` branch, and persona files. **A 2-member squad is the point** — it exercises Task 1.

- [ ] **Step 4: Inspect what was created, and prove isolation on real data**

```bash
T=$(curl -s -m 5 http://127.0.0.1:7777/squads | python3 -c "
import sys,json; s=[x for x in json.load(sys.stdin)['squads'] if x.get('taskId')]; print(s[0]['taskId'] if s else '')")
I=~/.smithagents/workspaces/proving-ground/.runtime/instances/$T
ls -1 "$I" "$I/members" 2>/dev/null
for m in "$I"/members/*/; do
  echo "  $(basename "$m"): $(git -C "$m" rev-parse --abbrev-ref HEAD)  persona: $(ls -1 "$m" | grep -iE 'CLAUDE.md|AGENTS.md' | tr '\n' ' ')"
done
echo "--- isolation: one member's uncommitted file must NOT appear in the other ---"
M=($(ls -d "$I"/members/*/)); echo scratch > "${M[0]}SCRATCH.md"
ls "${M[1]}SCRATCH.md" 2>/dev/null && echo "  LEAKED — FAILURE" || echo "  isolated, as designed"
rm -f "${M[0]}SCRATCH.md"
```

Expected: one directory per member, each on its own branch, each carrying the persona file **its own CLI reads** (the gemini leader should get `AGENTS.md`, a Claude member `CLAUDE.md`). **If the leader gets `CLAUDE.md`, the model→driver mapping is wrong and the branch does not merge.**

- [ ] **Step 5: Exercise the feed over HTTP**

```bash
curl -s -m 10 -X POST "http://127.0.0.1:7777/squads/$T/updates" \
  -H 'content-type: application/json' -d '{"agentName":"Gabriel","update":"probe: standing up"}' | head -c 200; echo
curl -s -m 10 -X POST "http://127.0.0.1:7777/squads/$T/updates" \
  -H 'content-type: application/json' -d '{"agentName":"Santiago","update":{"status":"SUCCESS","summary":"probe"}}' | head -c 200; echo
curl -s -m 10 "http://127.0.0.1:7777/squads/$T/updates" | python3 -m json.tool | head -20
cat ~/.smithagents/workspaces/proving-ground/.runtime/instances/$T/.runtime/updates.jsonl
```

Expected: two lines on disk, one JSON object each, both readable back in order with `agentName`, `timestamp` and `update`.

- [ ] **Step 6: Clean up the probe**

```bash
cd swarm && node --import tsx -e "
import { loadConfig } from './src/config.js';
import { smithPaths } from './src/paths.js';
import { loadWorkspaces, workspaceDir } from './src/workspaces.js';
import { destroyInstance, listInstances } from './src/workspace-instances.js';
const paths = smithPaths(loadConfig().smithRoot);
const ws = (await loadWorkspaces(paths)).find(w => w.name === 'proving-ground');
const dir = workspaceDir(paths, ws);
for (const id of await listInstances(dir)) await destroyInstance(dir, ws, id, [ws.repos[0].name], { force: true });
console.log('instances now:', await listInstances(dir));
"
git -C ~/.smithagents/workspaces/proving-ground/smith-agent-proving-ground worktree list
```

**`destroyInstance` does not know about member worktrees** — it removes the instance's own members, not `members/*`. Report whether the member worktrees are left registered; if they are, that is a real finding for the review, not something to paper over here.

- [ ] **Step 7: No commit**

If Step 4 or 5 fails, the branch does not merge.

---

## Self-review

**Spec coverage.** §2.3's `federated` row — separate sessions, mixed engines, isolation per member — is Tasks 3-4, with the coordination channel made concrete as the feed. §2.3's `delegated` row is **deliberately not implemented**, per design decision 2: it is not a squad shape but a member's private optimization, and the shipped roster (gemini leaders) could never use it. §2.1's instance is the container. Design decisions 1-6 are recorded above because they override the spec, and a reader must see them before the tasks.

**Placeholders.** Three deliberate gaps, each flagged with what to check and what to report: `loadSquadsFromDir`'s existing leader handling (Task 1), `addMemberWorktrees`' body (Task 3 — it reuses module-private helpers I should not guess the shape of), and the `SquadModel`→driver mapping (Task 4), which is the one place a wrong guess would silently defeat the plan's purpose.

**Type consistency.** `SquadUpdate`, `feedPath`, `appendUpdate`, `readFeed`, `addMemberWorktrees`, `prepareSquadSwarm` are spelled identically throughout. `addMemberWorktrees` returns `InstanceMember[]`, the same type `createInstance` returns, so both feed the same consumers. Member branches are `smith/members/<workId>/<name>` everywhere, in their own namespace rather than nested under the instance's own `smith/<workId>` — which git's ref store forbids outright; see the correction under design decision 5.

**Known risks, stated plainly.**
1. **`destroyInstance` does not know about member worktrees.** It removes the members `createInstance` made, not `members/*`. Task 5 Step 6 surfaces it deliberately rather than letting it be found later; fixing it may belong in this branch or the next, and the review should rule.
2. **The feed skips malformed lines where the rest of this codebase throws.** Deliberate — concurrent appends make a torn last line normal — but it is a genuine departure from the established convention and must be reviewed as a decision.
3. **Nothing launches yet.** This plan prepares a swarm; `status` stays `"queued"` and the CLIs are started in a later plan. A reader expecting `POST /squads` to run agents will be surprised, which is why the route's response says what it prepared rather than claiming it started.
