# The `delegated` Swarm Shape Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `POST /squads` actually launch a swarm — a leader CLI running in a workspace-instance, with its members generated as Claude Code subagent definitions rather than hand-rolled tmux panes.

**Architecture:** A new `swarm/src/delegated-members.ts` renders a `SquadMember` into a `.claude/agents/<name>.md` definition, with the role's permissions expressed as `tools:` frontmatter — **preventive**, replacing the pane model's detective `validateCompliance`. `POST /squads` then resolves a workspace, creates a workspace-instance for the squad's task, materializes the member definitions into it, and dispatches the leader through the existing task path. A separate reader surfaces member transcripts, which Claude already persists as sidechain entries.

**Tech Stack:** TypeScript ~6.0.0 (ESM, `.js` import specifiers), Node >= 24, `node:test` + `node:assert/strict`, biome 2.5.3.

**Spec:** `docs/superpowers/specs/2026-08-16-workspace-instances-and-assignment-design.md` — §2.3 (swarm shapes), §2.1 (the instance).

## Global Constraints

- Node >= 24; TypeScript ~6.0.0; ESM with `.js` import specifiers on every relative import.
- Tests use `node:test` + `node:assert/strict`. **Every test writes to `mkdtempSync(tmpdir())`. No test may touch the real state root at `~/.smithagents`, and no test may reach the network** — build local git repos with `git init`.
- **Registry writes stay sequential** (`for…of` with `await`). Never `Promise.all` / `.map(async …)` over workspaces.
- **Nothing reachable from boot may throw uncaught.**
- **Never destroy uncommitted work.** Instances are kept past commit (§2.2); nothing in this plan destroys one.
- **Git arguments derived from records or manifests are untrusted:** validate, and pass positionals after `--`. And see `resolveStartPoint` — a base that exists only as a remote-tracking ref makes `git worktree add -b` silently discard the branch name.
- Baselines at the start of this plan: **571 tests passing, 0 failing; tsc 12 errors** (pre-existing, in `agent-sessions.ts`, `jira-sync.test.ts`, `server.ts`); biome clean on touched files.
- Measurement traps — get these right or your numbers are meaningless:
  - Typecheck with `cd swarm && ./node_modules/.bin/tsc --noEmit`. **Never `npx tsc` from the repo root** — it resolves a decoy placeholder package.
  - tsc ANSI-colorizes so `grep -c 'error TS'` returns **0 while errors are on screen**. Strip ANSI first: `sed 's/\x1b\[[0-9;]*m//g'`. **A count of 0 means your measurement broke.**
  - `node:test` summary lines start with `ℹ`, not `#`.

## Context: what exists today

- **`POST /squads` (`server.ts:1285`) queues and never launches.** It validates, claims a squad from the pool, builds a `SquadManifest` with `status: "queued"`, stores it in `activeSquads`, and returns. `buildSquadLaunchScript` (`squads.ts:463`) has **no non-test caller** — the pane model was never wired up.
- **Workspace-instances shipped** (Plan 8): `createInstance(workspaceDir, ws, workId, repoNames, opts?)` gives worktrees of `config/` plus each named repo on one branch `smith/<work-id>`. The dispatcher already routes workspace-routed tasks through one.
- **`ClaudeDriver.materialize` (`drivers/claude.ts:152`)** writes `CLAUDE.md` into the worktree and returns the list of files it wrote. `prepareWorktree` adds those to the worktree's **local exclude** so injected plumbing is never swept into the task's commit. Member definitions must join that list.
- **Claude persists subagent transcripts as sidechain entries**, and `claude.ts:121` skips them (`if (parsed.isSidechain) continue`) because they are not the leader's conversation.
- **Nothing writes `.claude/agents/`** anywhere in the repo today.
- The default workspace is `live.find((w) => w.default) ?? live[0]` (`workspaces.ts:335-338`).

## Scope

**In:** rendering members as Claude subagent definitions with preventive `tools:` permissions; making `POST /squads` create an instance, materialize members, and dispatch the leader; reading member transcripts.

**Out, deliberately:**
- **`federated`.** Separate CLI sessions coordinating through the broker already work — a four-agent brokered run was proven. This plan builds the shape that does *not* exist yet. Choosing between shapes per assignment belongs with work items.
- **Deleting `buildSquadLaunchScript`, `validateCompliance`, `formatPermissionBlock`, and the `pane` field.** The spec calls them deletion candidates "once `delegated` lands". Landing it and removing it in one plan means the removal is unreviewed against a working alternative. Delete them in a follow-up, after this has run.
- **Squad *completion* handling** — what happens when the leader exits, whether the instance is destroyed, how results are collected. §2.2 keeps instances past commit and nothing auto-destroys; wiring completion is its own task once launching works.

---

### Task 1: Render a member as a Claude subagent definition

**Files:**
- Create: `swarm/src/delegated-members.ts`
- Create: `swarm/src/delegated-members.test.ts`

**Interfaces:**
- Consumes: `type SquadMember`, `type SquadRole`, `DEFAULT_ROLE_PERMISSIONS` from `./squads.js`; `type AgentProfile` from `./types.js`.
- Produces:
  - `memberFileName(member: SquadMember): string` — `<lowercased name>.md`, rejecting anything that isn't `/^[a-z0-9][a-z0-9-]*$/` after lowercasing.
  - `renderMemberDefinition(member: SquadMember, profile?: AgentProfile): string` — the full `.claude/agents/*.md` file.

The definition's frontmatter carries `name`, `description`, and **`tools`** — the role's permissions, expressed so Claude Code enforces them up front instead of `validateCompliance` catching violations afterwards.

- [ ] **Step 1: Write the failing tests**

Create `swarm/src/delegated-members.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SquadMember } from "./squads.js";
import { memberFileName, renderMemberDefinition } from "./delegated-members.js";

const member = (over: Partial<SquadMember> = {}): SquadMember => ({
  name: "Fabian",
  pane: 1,
  model: "claude-sonnet",
  role: "developer",
  squad: "alpha",
  ...over,
});

test("memberFileName: lowercases and keeps it a plain file name", () => {
  assert.equal(memberFileName(member()), "fabian.md");
  assert.equal(memberFileName(member({ name: "Maria-Jose" })), "maria-jose.md");
});

test("memberFileName: refuses a name that would escape the agents directory", () => {
  for (const name of ["../evil", "a/b", "a\\b", "", "   ", "."]) {
    assert.throws(() => memberFileName(member({ name })), /name/i, `${name} must be refused`);
  }
});

test("renderMemberDefinition: frontmatter carries name, description and tools", () => {
  const md = renderMemberDefinition(member());
  assert.match(md, /^---\n/, "starts with frontmatter");
  assert.match(md, /\nname: fabian\n/);
  assert.match(md, /\ndescription: .+\n/);
  assert.match(md, /\ntools: .+\n/);
  assert.match(md, /\n---\n/, "frontmatter closes");
});

test("renderMemberDefinition: a leader's tools differ from a developer's", () => {
  const lead = renderMemberDefinition(member({ role: "leader" }));
  const dev = renderMemberDefinition(member({ role: "developer" }));
  const toolsOf = (md: string) => /\ntools: (.+)\n/.exec(md)?.[1] ?? "";
  assert.notEqual(toolsOf(lead), toolsOf(dev), "role permissions reach the frontmatter");
});

test("renderMemberDefinition: the body states the role and the boundary", () => {
  const md = renderMemberDefinition(member({ name: "Fabian", role: "architect" }));
  const body = md.split(/\n---\n/)[2] ?? "";
  assert.match(body, /Fabian/);
  assert.match(body, /architect/i);
  assert.match(body, /stay within/i, "the boundary sentence is present");
});

test("renderMemberDefinition: a profile's directives are used when one is given", () => {
  const md = renderMemberDefinition(member(), {
    name: "Fabian",
    role: "Software Architect",
    directives: "OWN THE SYSTEM STRUCTURE",
  } as never);
  assert.match(md, /OWN THE SYSTEM STRUCTURE/);
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/delegated-members.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -20
```

Expected: FAIL — cannot find module `./delegated-members.js`.

- [ ] **Step 3: Implement**

Create `swarm/src/delegated-members.ts`:

```ts
import { DEFAULT_ROLE_PERMISSIONS, type SquadMember, type SquadRole } from "./squads.js";
import type { AgentProfile } from "./types.js";

/**
 * Claude Code tools each role may use. This is the PREVENTIVE half of the
 * permission model: `tools:` frontmatter stops a member reaching for something
 * outside its role, where the pane model's `validateCompliance` could only
 * notice afterwards that it had.
 *
 * Derived from DEFAULT_ROLE_PERMISSIONS so the two stay in step — the squad
 * definition remains the source of truth for what a role may do.
 */
function toolsFor(role: SquadRole): string[] {
  const p = DEFAULT_ROLE_PERMISSIONS[role];
  const tools = ["Read", "Grep", "Glob"];
  if (p.canEdit) tools.push("Edit", "Write");
  if (p.canRunTests || p.canRunCommands) tools.push("Bash");
  return tools;
}

/** `<name>.md`, refusing anything that isn't a plain file name. */
export function memberFileName(member: SquadMember): string {
  const slug = member.name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(
      `Member name "${member.name}" is not usable as a file name — it becomes .claude/agents/<name>.md`,
    );
  }
  return `${slug}.md`;
}

/**
 * One Claude Code subagent definition.
 *
 * §2.3: members are GENERATED, not authored — from the global template plus the
 * workspace roster, at instance creation, the same way ClaudeDriver.materialize
 * writes CLAUDE.md. Nothing here is committed: the caller adds these files to
 * the worktree's local exclude.
 */
export function renderMemberDefinition(member: SquadMember, profile?: AgentProfile): string {
  const name = member.name.trim().toLowerCase();
  const role = profile?.role ?? member.role;
  const directives = profile?.directives ?? `You are the ${member.role} on squad ${member.squad}.`;
  return [
    "---",
    `name: ${name}`,
    `description: ${member.name} — ${role}. Delegate ${role} work to this member.`,
    `tools: ${toolsFor(member.role).join(", ")}`,
    "---",
    "",
    `# ${member.name} — ${role}`,
    "",
    directives,
    "",
    `You are ${member.name}. Stay within your role's domain; when work belongs to another member, say so instead of doing it badly.`,
    "",
  ].join("\n");
}
```

**Check `DEFAULT_ROLE_PERMISSIONS`'s actual field names before writing `toolsFor`** (`squads.ts:115`) — the names above are illustrative. Use whatever that record really exposes, and if a role's permissions don't map cleanly onto tools, say so in your report rather than inventing a mapping.

- [ ] **Step 4: Run them to verify they pass**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/delegated-members.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add swarm/src/delegated-members.ts swarm/src/delegated-members.test.ts
git commit -m "feat(swarm): render a squad member as a Claude subagent definition

tools: frontmatter makes the role's permissions preventive, where the pane
model's validateCompliance could only detect a violation after it happened."
```

---

### Task 2: Materialize members into an instance

**Files:**
- Modify: `swarm/src/delegated-members.ts`
- Test: `swarm/src/delegated-members.test.ts`

**Interfaces:**
- Consumes: `memberFileName`, `renderMemberDefinition` (Task 1); `type AgentProfile` from `./types.js`.
- Produces: `materializeMembers(dir: string, members: SquadMember[], profiles?: Map<string, AgentProfile>): Promise<string[]>` — writes `.claude/agents/*.md` under `dir` and returns the **repo-relative paths written**, for the caller's local-exclude list.

- [ ] **Step 1: Write the failing tests**

Append to `swarm/src/delegated-members.test.ts` (add `mkdtempSync`, `readFileSync`, `rmSync`, `statSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path`, and `materializeMembers` to the import):

```ts
test("materializeMembers: writes one file per member and returns relative paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-"));
  try {
    const written = await materializeMembers(dir, [
      member({ name: "Fabian", role: "leader" }),
      member({ name: "Maria", role: "developer" }),
    ]);

    assert.deepEqual(written.sort(), [".claude/agents/fabian.md", ".claude/agents/maria.md"]);
    assert.ok(statSync(join(dir, ".claude", "agents", "fabian.md")).isFile());
    assert.match(readFileSync(join(dir, ".claude", "agents", "maria.md"), "utf8"), /name: maria/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("materializeMembers: paths are relative so the caller can exclude them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-rel-"));
  try {
    const written = await materializeMembers(dir, [member()]);
    for (const p of written) {
      assert.ok(!p.startsWith("/"), `${p} must be repo-relative, not absolute`);
      assert.ok(!p.includes(dir), `${p} must not embed the temp dir`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("materializeMembers: a profile is used for the member it names", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-prof-"));
  try {
    const profiles = new Map([["fabian", { name: "Fabian", role: "Software Architect", directives: "STRUCTURE IS YOURS" } as never]]);
    await materializeMembers(dir, [member({ name: "Fabian" }), member({ name: "Maria" })], profiles);

    assert.match(readFileSync(join(dir, ".claude", "agents", "fabian.md"), "utf8"), /STRUCTURE IS YOURS/);
    assert.doesNotMatch(readFileSync(join(dir, ".claude", "agents", "maria.md"), "utf8"), /STRUCTURE IS YOURS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("materializeMembers: refuses a member whose name would escape", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-esc-"));
  try {
    await assert.rejects(() => materializeMembers(dir, [member({ name: "../evil" })]), /name/i);
    assert.throws(() => statSync(join(dir, ".claude")), "nothing was created");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'materializeMembers' 'src/delegated-members.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -20
```

Expected: FAIL — `materializeMembers is not a function`.

- [ ] **Step 3: Implement**

Add to `swarm/src/delegated-members.ts` (imports: `mkdir`, `writeFile` from `node:fs/promises`, `join` from `node:path`):

```ts
/**
 * Write every member's definition into `dir/.claude/agents/`, where Claude Code
 * discovers subagents for the directory it runs in.
 *
 * Returns REPO-RELATIVE paths. The caller adds them to the worktree's local
 * exclude, exactly as it already does for CLAUDE.md and bin/smith-delegate:
 * these are injected plumbing, and sweeping them into the task's commit would
 * put generated files into the user's history.
 *
 * Every name is validated BEFORE anything is written, so a bad member cannot
 * leave a half-materialized agents directory behind.
 */
export async function materializeMembers(
  dir: string,
  members: SquadMember[],
  profiles?: Map<string, AgentProfile>,
): Promise<string[]> {
  const planned = members.map((m) => ({ member: m, file: memberFileName(m) }));

  const agentsDir = join(dir, ".claude", "agents");
  await mkdir(agentsDir, { recursive: true });
  const written: string[] = [];
  for (const { member, file } of planned) {
    const profile = profiles?.get(member.name.trim().toLowerCase());
    await writeFile(join(agentsDir, file), renderMemberDefinition(member, profile));
    written.push(`.claude/agents/${file}`);
  }
  return written;
}
```

Note the `planned` map runs every `memberFileName` **before** the `mkdir` — that is what makes the escape test's "nothing was created" assertion true.

- [ ] **Step 4: Run the file, then the suite**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/delegated-members.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t2-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t2-suite.txt | grep -E "^ℹ (tests|pass|fail)"
```

Expected: 10 tests in the file; suite **581 pass / 0 fail**.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd swarm && ./node_modules/.bin/tsc --noEmit > /tmp/t2-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t2-tsc.txt | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+')"
npx biome check src/delegated-members.ts src/delegated-members.test.ts
git add swarm/src/delegated-members.ts swarm/src/delegated-members.test.ts
git commit -m "feat(swarm): materialize squad members into an instance

Returns repo-relative paths so the caller can exclude them locally — generated
plumbing must never land in the user's commit. Names are validated before any
write, so a bad member leaves nothing behind."
```

Expected: `errors=12`; biome clean.

---

### Task 3: `POST /squads` launches a delegated swarm

This is the task that makes squads real. Today the route queues a manifest and stops.

**Files:**
- Modify: `swarm/src/server.ts` — the `POST /squads` handler at `:1285`
- Test: `swarm/src/server.test.ts`

**Interfaces:**
- Consumes: `materializeMembers` (Task 2); `createInstance` from `./workspace-instances.js`; `loadWorkspaces`, `workspaceDir`, `activeWorkspaces` from `./workspaces.js`; the existing squad pool and `activeSquads`.
- Produces: no new exports. The route's response gains `workspace`, `instance`, and `members` (the written definition paths).

**Read `server.ts:1285-1338` before editing.** The handler already claims a squad, picks `activeAgents`, and builds the manifest. Keep all of that.

- [ ] **Step 1: Write the failing test**

This repo does not boot the server in tests (`server.test.ts` covers pure helpers), so extract the launch step and test that. Add to `swarm/src/server.test.ts`:

```ts
test("prepareDelegatedSwarm: creates an instance and materializes members into the leader's worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "sq-"));
  try {
    const paths = smithPaths(root);
    const origin = makeGitOrigin(join(root, "origin"));       // local git repo, no network
    const ws = { name: "pg", repos: [{ name: "app", path: origin, branch: "main" }] };
    await saveWorkspace(paths, ws as never);

    const result = await prepareDelegatedSwarm(paths, ws as never, "task-1", [
      { name: "Fabian", pane: 1, model: "claude-sonnet", role: "leader", squad: "alpha" },
      { name: "Maria", pane: 2, model: "claude-sonnet", role: "developer", squad: "alpha" },
    ] as never);

    assert.equal(result.cwd, join(workspaceDir(paths, ws as never), ".runtime", "instances", "task-1", "app"));
    assert.deepEqual(result.members.sort(), [".claude/agents/fabian.md", ".claude/agents/maria.md"]);
    assert.ok(statSync(join(result.cwd, ".claude", "agents", "fabian.md")).isFile());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareDelegatedSwarm: member definitions land in the repo worktree, not config/", async () => {
  const root = mkdtempSync(join(tmpdir(), "sq-where-"));
  try {
    const paths = smithPaths(root);
    const origin = makeGitOrigin(join(root, "origin"));
    const ws = { name: "pg", repos: [{ name: "app", path: origin, branch: "main" }] };
    await saveWorkspace(paths, ws as never);

    const result = await prepareDelegatedSwarm(paths, ws as never, "task-2", [
      { name: "Fabian", pane: 1, model: "claude-sonnet", role: "leader", squad: "alpha" },
    ] as never);

    const inst = join(workspaceDir(paths, ws as never), ".runtime", "instances", "task-2");
    assert.ok(statSync(join(inst, "app", ".claude", "agents", "fabian.md")).isFile(), "in the repo worktree");
    assert.throws(() => statSync(join(inst, "config", ".claude")), "NOT in config/");
    assert.equal(result.cwd, join(inst, "app"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

Build `makeGitOrigin` with the same `execFileSync("git", ["init", …])` fixture pattern `workspace-instances.test.ts` uses.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'prepareDelegatedSwarm' 'src/server.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -20
```

Expected: FAIL — `prepareDelegatedSwarm is not a function`.

- [ ] **Step 3: Implement the launch step**

Export from `swarm/src/server.ts`:

```ts
/**
 * Everything a delegated squad needs before its leader starts: an instance for
 * the task, and each member written as a Claude subagent definition inside the
 * worktree the leader will run in.
 *
 * The leader runs in the REPO worktree, not the instance root, matching how the
 * dispatcher already starts agents — so `.claude/agents/` has to sit there for
 * Claude Code to discover it. `config/` is alongside as a sibling.
 */
export async function prepareDelegatedSwarm(
  paths: SmithPaths,
  ws: Workspace,
  taskId: string,
  members: SquadMember[],
): Promise<{ cwd: string; instanceDir: string; branch: string; members: string[] }> {
  const repo = ws.repos[0];
  if (!repo) throw new Error(`Workspace "${ws.name}" has no repos to run a squad in`);

  const inst = await createInstance(workspaceDir(paths, ws), ws, taskId, [repo.name], {
    base: repo.branch ?? "main",
  });
  const member = inst.members.find((m) => m.name === repo.name);
  if (!member) throw new Error(`Instance "${taskId}" has no worktree for repo "${repo.name}"`);

  const written = await materializeMembers(member.path, members);
  return { cwd: member.path, instanceDir: inst.dir, branch: inst.branch, members: written };
}
```

- [ ] **Step 4: Wire it into the route**

In `POST /squads`, after the manifest is built and stored, resolve a workspace and prepare the swarm. Accept an optional `workspace` name in the body; fall back to the default exactly as the rest of the system does (`live.find((w) => w.default) ?? live[0]`, `workspaces.ts:335-338`):

```ts
      const all = activeWorkspaces(await loadWorkspaces(this.paths));
      const ws = body.workspace ? all.find((w) => w.name === body.workspace) : (all.find((w) => w.default) ?? all[0]);
      if (!ws) {
        this.squadPool.release(squadId);
        return reply.status(400).send({
          error: body.workspace ? `Unknown workspace: ${body.workspace}` : "No workspace available to run a squad in",
        });
      }

      let prepared: Awaited<ReturnType<typeof prepareDelegatedSwarm>>;
      try {
        prepared = await prepareDelegatedSwarm(this.paths, ws, taskId, activeAgents);
      } catch (err) {
        this.squadPool.release(squadId);
        return reply.status(400).send({ error: String((err as Error).message) });
      }
```

**Release the claimed squad on every failure path** — a squad claimed but never launched is stuck active, and `POST /squads` 409s on it forever. Check the pool's actual release method name before using it; if there is none, say so in your report rather than inventing one.

Then include `workspace: ws.name`, `instance: prepared.instanceDir`, `branch: prepared.branch`, and `members: prepared.members` in the response, and leave `status: "queued"` **as it is** — this task prepares the swarm; dispatching the leader and tracking completion is out of scope, and claiming `"running"` would be false.

- [ ] **Step 5: Verify**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t3-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t3-suite.txt | grep -E "^ℹ (tests|pass|fail)"
cd swarm && ./node_modules/.bin/tsc --noEmit > /tmp/t3-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t3-tsc.txt | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+')"
npx biome check src/server.ts src/server.test.ts
```

Expected: **583 pass / 0 fail**; `errors=12`; biome clean.

- [ ] **Step 6: Commit**

```bash
git add swarm/src/server.ts swarm/src/server.test.ts
git commit -m "feat(swarm): POST /squads prepares a delegated swarm

The route queued a manifest and stopped. It now resolves a workspace, creates
an instance for the task, and writes each member as a Claude subagent
definition in the worktree the leader will run in. Status stays queued: this
prepares the swarm, it does not yet dispatch the leader."
```

---

### Task 4: Read a member's transcript

§2.3: *"Member transcripts are already persisted as sidechain entries in the leader's session file — `claude.ts:117` skips them deliberately, so per-member observability is a filter change, not new infrastructure."*

**Files:**
- Modify: `swarm/src/drivers/claude.ts`
- Test: `swarm/src/drivers/claude.test.ts`

**Interfaces:**
- Produces: `readMemberMessages(sessionFile: string): Promise<Array<{ member?: string; role: string; text: string; at?: string }>>` — the sidechain entries the main parser skips, in file order.

**Do not change the existing parser.** The skip at `claude.ts:121` is correct: subagent chatter is not the leader's conversation, and merging it would corrupt every existing consumer. This adds a second reader over the same file.

- [ ] **Step 1: Write the failing test**

Append to `swarm/src/drivers/claude.test.ts`:

```ts
test("readMemberMessages: returns the sidechain entries the conversation parser skips", async () => {
  const dir = mkdtempSync(join(tmpdir(), "side-"));
  try {
    const file = join(dir, "session.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "lead prompt" } }),
        JSON.stringify({ type: "assistant", isSidechain: true, message: { role: "assistant", content: "member says hi" } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "leader replies" } }),
      ].join("\n"),
    );

    const members = await readMemberMessages(file);

    assert.equal(members.length, 1, "only the sidechain entry");
    assert.match(members[0].text, /member says hi/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readMemberMessages: the conversation parser is unchanged by this addition", async () => {
  const dir = mkdtempSync(join(tmpdir(), "side-main-"));
  try {
    const file = join(dir, "session.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "lead prompt" } }),
        JSON.stringify({ type: "assistant", isSidechain: true, message: { role: "assistant", content: "member noise" } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "leader replies" } }),
      ].join("\n"),
    );

    const convo = await new ClaudeDriver().readMessages(file);   // use this driver's real parser entry point

    assert.equal(convo.length, 2, "sidechain still excluded from the conversation");
    assert.ok(!convo.some((m) => /member noise/.test(m.text)), "member chatter never leaks into the conversation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

**Check the driver's real parser method name** before writing the second test — the point is to pin that this task did not change it.

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'readMemberMessages' 'src/drivers/claude.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -20
```

Expected: FAIL — `readMemberMessages is not a function`.

- [ ] **Step 3: Implement**

Add to `swarm/src/drivers/claude.ts`, reusing the file's existing `ClaudeLine` interface and text-extraction logic rather than duplicating it:

```ts
/**
 * Member (subagent) messages from a leader's session file.
 *
 * The conversation parser skips `isSidechain` entries because they are not the
 * leader's conversation — this reads exactly those, so a delegated swarm's
 * members are observable without changing what the conversation means.
 * Deliberately a second pass over the same file: no existing consumer changes.
 */
export async function readMemberMessages(
  sessionFile: string,
): Promise<Array<{ member?: string; role: string; text: string; at?: string }>> { … }
```

Extract the shared text-from-content logic into a small module-private helper used by both readers, so a change to Claude's content shape can't make them disagree.

- [ ] **Step 4: Verify**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t4-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t4-suite.txt | grep -E "^ℹ (tests|pass|fail)"
cd swarm && ./node_modules/.bin/tsc --noEmit > /tmp/t4-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t4-tsc.txt | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+')"
npx biome check src/drivers/claude.ts src/drivers/claude.test.ts
```

Expected: **585 pass / 0 fail**; `errors=12`; biome clean.

- [ ] **Step 5: Commit**

```bash
git add swarm/src/drivers/claude.ts swarm/src/drivers/claude.test.ts
git commit -m "feat(swarm): read a delegated member's transcript

Claude already persists subagent turns as sidechain entries; the conversation
parser skips them and still does. This is a second reader over the same file,
so members become observable without changing what the conversation means."
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
curl -s -m 5 http://127.0.0.1:7777/squads | head -c 300; echo
```

Expected: `['proving-ground']`, and the squad list responding as before.

- [ ] **Step 3: Launch a squad against the real workspace**

```bash
curl -s -m 20 -X POST http://127.0.0.1:7777/squads \
  -H 'content-type: application/json' \
  -d '{"prompt":"probe: prepare only","mode":"squad","agents":2}' | python3 -m json.tool
```

Expected: a response naming the workspace, the instance directory, the branch, and two `.claude/agents/*.md` paths.

- [ ] **Step 4: Inspect what was actually created**

```bash
T=$(curl -s -m 5 http://127.0.0.1:7777/squads | python3 -c "
import sys,json; s=[x for x in json.load(sys.stdin)['squads'] if x.get('taskId')]; print(s[0]['taskId'] if s else '')")
I=~/.smithagents/workspaces/proving-ground/.runtime/instances/$T
ls -1 "$I"; ls -1 "$I"/*/.claude/agents/ 2>/dev/null
cat "$I"/smith-agent-proving-ground/.claude/agents/*.md | head -20
git -C "$I/smith-agent-proving-ground" status --porcelain
```

Expected: the instance holds `config` and the repo; `.claude/agents/*.md` exist **in the repo worktree**; each has `name`, `description` and `tools` frontmatter. **`git status` will show the agent files as untracked** — that is expected here, because Task 3 prepares the swarm without going through the dispatcher's local-exclude step. **Note it in your report**: whoever wires the leader dispatch must add `prepared.members` to the exclude list, or generated files will land in the user's commit.

- [ ] **Step 5: Clean up the probe instance**

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
```

`force` is correct here: the agent definitions are generated plumbing, and the probe committed nothing.

- [ ] **Step 6: No commit**

If Step 3 or 4 fails, the branch does not merge.

---

## Self-review

**Spec coverage.** §2.3's `delegated` row is Tasks 1-3: members are built-in subagents (`.claude/agents/*.md`), engines are claude-only by construction, the leader delegates via the Agent tool, and permissions are `tools:` frontmatter — **preventive**, which is the row's distinguishing claim against `federated`'s detective grants. "Members are generated, not authored" is Tasks 1-2. Per-member observability is Task 4, and it is the filter change §2.3 predicts rather than new infrastructure. `federated` is out of scope with a reason: it already works.

**Placeholders.** Two deliberate gaps, both flagged inline rather than left blank: `toolsFor` must be written against `DEFAULT_ROLE_PERMISSIONS`'s real fields (`squads.ts:115`), and `readMemberMessages`' body reuses the file's existing extraction logic rather than a snippet I'd be guessing at. Both say what to check and what to report if it doesn't fit.

**Type consistency.** `memberFileName`, `renderMemberDefinition`, `materializeMembers`, `prepareDelegatedSwarm`, `readMemberMessages` are spelled identically throughout. `materializeMembers` returns repo-relative paths and `prepareDelegatedSwarm` passes them through as `members`, which is the same list Task 5 Step 4 checks and a future dispatch step must exclude.

**Known risks, stated plainly.**
1. **The generated agent files are untracked in the user's repo worktree** and nothing excludes them yet, because this plan stops short of dispatching the leader. Task 5 Step 4 surfaces it deliberately rather than letting it be discovered later.
2. **`POST /squads` claims a squad from the pool before preparing.** Every new failure path must release it, or that squad 409s forever. Called out in Task 3 Step 4.
3. **A squad runs in `ws.repos[0]`.** Single-repo squads only; which repos a squad touches is assignment's job, and assignment does not exist yet.
