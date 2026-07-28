# Agent & Workspace Lifecycle Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete agent removal (hard-delete only when never used, else archive-in-place) and full workspace CRUD across swarm, broker, and control-plane; remove the legacy project config layer.

**Architecture:** Both record types gain an `archived: true` field set in place. Swarm exposes mechanical routes (usage facts, archive, hard-delete with its own re-check); the broker aggregates evidence (its transcripts + swarm's facts) and decides the outcome via a pure policy function; the UI shows one "remove" intent whose confirm sheet pre-states the outcome. Spec: `docs/superpowers/specs/2026-07-28-agent-workspace-lifecycle-design.md`.

**Tech Stack:** TypeScript, Fastify (swarm), node:http (broker), node:test via `node --import tsx --test`, React + Tauri (control-plane), Biome.

## Global Constraints

- swarm and broker are **npm** packages (not pnpm); swarm stays NodeNext + `dist`. Never add `@helmsmith/*`, LangChain, or LangGraph to swarm.
- Agent/workspace ids are slugs: `/^[a-z0-9][a-z0-9-]{0,63}$/`.
- Every rejection is a readable 400/404/409 JSON body: `{ error: "human sentence" }` (match the wizard's existing copy style).
- PUT routes merge — a caller sending three fields must not blank the rest.
- Tests: swarm `cd swarm && node --import tsx --test src/<file>.test.ts`; broker `cd broker && node --import tsx --test src/<file>.test.ts`. Full suites: `npm test` in each. Typecheck: `npm run typecheck`. UI: `cd control-plane && npm run typecheck && npx biome check src`.
- Commit after every task with a conventional message (`feat:`/`fix:`/`refactor:`/`docs:`).

---

### Task 1: swarm — `archived` field + active filters

**Files:**
- Modify: `swarm/src/agents.ts`
- Modify: `swarm/src/workspaces.ts`
- Test: `swarm/src/agents.test.ts`, `swarm/src/workspaces.test.ts` (extend existing)

**Interfaces:**
- Consumes: existing `ComposedAgent`, `Workspace`, `loadAgents`, `loadWorkspacesFromDir`.
- Produces: `ComposedAgent.archived?: boolean`; `Workspace.archived?: boolean`; `activeAgents(agents: ComposedAgent[]): ComposedAgent[]`; `activeWorkspaces(ws: Workspace[]): Workspace[]`; `resolveRepo` now ignores archived workspaces.

- [ ] **Step 1: Write failing tests**

In `swarm/src/agents.test.ts` add:

```ts
test('activeAgents filters archived records; loadAgents keeps them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agents-'));
  await saveAgent(dir, { ...base, id: 'alive' });
  await saveAgent(dir, { ...base, id: 'gone', archived: true });
  const all = await loadAgents(dir);
  assert.equal(all.length, 2);
  assert.deepEqual(activeAgents(all).map((a) => a.id), ['alive']);
});
```

(`base` = any valid `ComposedAgent` fixture already used in the file; if none exists, define `const base: ComposedAgent = { id: 'x', name: 'X', role: 'r', directives: 'd', engine: { cli: 'claude', model: 'claude-sonnet' } }`.)

In `swarm/src/workspaces.test.ts` add:

```ts
test('resolveRepo never resolves into an archived workspace', () => {
  const ws: Workspace[] = [
    { name: 'old', archived: true, default: true, repos: [{ name: 'r', path: '/tmp/a' }] },
    { name: 'live', repos: [{ name: 'r', path: '/tmp/b' }] },
  ];
  assert.equal(resolveRepo(ws, undefined, undefined)?.workspace.name, 'live');
  assert.equal(resolveRepo(ws, 'old', undefined), null);
});
```

- [ ] **Step 2: Run tests, verify they fail** (`activeAgents is not exported`, archived resolution returns 'old').

- [ ] **Step 3: Implement**

`agents.ts`: add to `ComposedAgent`:

```ts
  /** Archived in place: hidden from roster/delegation, kept for history. */
  archived?: boolean;
```

and export:

```ts
/** Agents visible to the roster, catalog, and delegation. */
export function activeAgents(agents: ComposedAgent[]): ComposedAgent[] {
  return agents.filter((a) => !a.archived);
}
```

`workspaces.ts`: add `archived?: boolean` to `Workspace` (same comment), export `activeWorkspaces` (same shape), and make `resolveRepo` operate on `activeWorkspaces(workspaces)` as its first line:

```ts
  const live = activeWorkspaces(workspaces);
```

(then use `live` everywhere `workspaces` was used inside).

- [ ] **Step 4: Run both test files — PASS. Run `npm run typecheck` in swarm.**

- [ ] **Step 5: Commit** — `feat(swarm): archived-in-place lifecycle field for agents and workspaces`

---

### Task 2: swarm — agent usage facts, archive route, honest hard-delete

**Files:**
- Create: `swarm/src/lifecycle.ts`
- Test: `swarm/src/lifecycle.test.ts`
- Modify: `swarm/src/server.ts` (existing `DELETE /agents/:id` at ~line 952; add `GET /agents/:id/usage`, `POST /agents/:id/archive`; extend `PUT /agents/:id` merge)

**Interfaces:**
- Consumes: `loadAgents`, `saveAgent`, `findAgent` (agents.ts); `SessionStore` (`.smith/sessions`, records carry `agentId`); `server.activeTasks` manifests (`manifest.profile?.name`).
- Produces:
  - `lifecycle.ts`: `interface AgentUsage { warmSessions: number; activeTasks: number }`; `agentUsage(agent: ComposedAgent, records: SessionRecord[], liveAgentIds: string[], activeTaskProfileNames: string[]): AgentUsage`; `isBusy(liveAgentIds: string[], activeTaskProfileNames: string[], agent: ComposedAgent): boolean`.
  - Routes: `GET /agents/:id/usage` → `{ warmSessions, activeTasks }`; `POST /agents/:id/archive` → `{ ok: true, archived: id }` (409 while busy); `DELETE /agents/:id` → hard-deletes the file, 409 if any swarm-side usage; `PUT /agents/:id` accepts `archived: false` to un-archive.

- [ ] **Step 1: Write failing tests** (`swarm/src/lifecycle.test.ts`)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentUsage, isBusy } from './lifecycle.ts';
import type { ComposedAgent } from './agents.ts';
import type { SessionRecord } from './session-store.ts';

const agent: ComposedAgent = {
  id: 'wilkin', name: 'Wilkin', role: 'r', directives: 'd',
  engine: { cli: 'claude', model: 'claude-sonnet' },
};
const record = (agentId: string): SessionRecord => ({
  id: 's1', agentId, agentName: 'Wilkin', tool: 'claude', profileHash: 'h',
  cwd: '/tmp', branch: 'main', tmuxSession: 'smith-warm-1', createdAt: 'now', turns: 0,
});

test('usage counts stored warm-session records and matching task profiles', () => {
  const u = agentUsage(agent, [record('wilkin'), record('other')], [], ['Wilkin', 'Aurelio']);
  assert.deepEqual(u, { warmSessions: 1, activeTasks: 1 });
});

test('no records, no tasks -> zero usage', () => {
  assert.deepEqual(agentUsage(agent, [], [], []), { warmSessions: 0, activeTasks: 0 });
});

test('busy means a LIVE session or task, not a historical record', () => {
  assert.equal(isBusy([], [], agent), false);
  assert.equal(isBusy(['wilkin'], [], agent), true);
  assert.equal(isBusy([], ['Wilkin'], agent), true);
});
```

- [ ] **Step 2: Run — FAIL (module missing).** `node --import tsx --test src/lifecycle.test.ts`

- [ ] **Step 3: Implement `swarm/src/lifecycle.ts`**

```ts
// Removal lifecycle facts for composed agents. Swarm reports what IT knows —
// warm-session records and live tasks. Conversation evidence lives in the
// broker, which owns the archive-vs-delete decision (spec §1).
import type { ComposedAgent } from './agents.js';
import type { SessionRecord } from './session-store.js';

export interface AgentUsage {
  warmSessions: number;
  activeTasks: number;
}

export function agentUsage(
  agent: ComposedAgent,
  records: SessionRecord[],
  liveAgentIds: string[],
  activeTaskProfileNames: string[],
): AgentUsage {
  const warm = new Set(records.filter((r) => r.agentId === agent.id).map((r) => r.id));
  for (const id of liveAgentIds) if (id === agent.id) warm.add(`live:${id}`);
  return {
    warmSessions: warm.size,
    activeTasks: activeTaskProfileNames.filter((n) => n === agent.name).length,
  };
}

/** Live work only — a historical record does not lock the agent. */
export function isBusy(liveAgentIds: string[], activeTaskProfileNames: string[], agent: ComposedAgent): boolean {
  return liveAgentIds.includes(agent.id) || activeTaskProfileNames.includes(agent.name);
}
```

- [ ] **Step 4: Run lifecycle tests — PASS.**

- [ ] **Step 5: Wire routes in `server.ts`**

Add a private helper next to the existing agent routes (reuses the session manager closure defined at ~line 966):

```ts
    const agentFacts = async (agent: ComposedAgent) => {
      const records = await new SessionStore(resolve(process.cwd(), '.smith/sessions')).load();
      const live = server.agentSessions ? (await server.agentSessions.list()).map((s) => s.agentId) : [];
      const taskNames = [...server.activeTasks.values()]
        .map((t) => t.manifest.profile?.name)
        .filter((n): n is string => Boolean(n));
      return { records, live, taskNames };
    };
```

`GET /agents/:id/usage`:

```ts
    this.app.get<{ Params: { id: string } }>('/agents/:id/usage', async (req, reply) => {
      const agents = await loadAgents(resolve(process.cwd(), '.smith/agents'));
      const agent = agents.find((a) => a.id === req.params.id);
      if (!agent) return reply.status(404).send({ error: `Unknown agent: ${req.params.id}` });
      const { records, live, taskNames } = await agentFacts(agent);
      return agentUsage(agent, records, live, taskNames);
    });
```

`POST /agents/:id/archive`:

```ts
    this.app.post<{ Params: { id: string } }>('/agents/:id/archive', async (req, reply) => {
      const agentsDir = resolve(process.cwd(), '.smith/agents');
      const agents = await loadAgents(agentsDir);
      const agent = agents.find((a) => a.id === req.params.id);
      if (!agent) return reply.status(404).send({ error: `Unknown agent: ${req.params.id}` });
      const { live, taskNames } = await agentFacts(agent);
      if (isBusy(live, taskNames, agent)) {
        return reply.status(409).send({ error: `${agent.name} is working — cancel their task or session first` });
      }
      await saveAgent(agentsDir, { ...agent, archived: true });
      return { ok: true, archived: agent.id };
    });
```

**Replace** the existing `DELETE /agents/:id` body (the timestamp-rename at lines ~952-963) with an honest hard delete:

```ts
    this.app.delete<{ Params: { id: string } }>('/agents/:id', async (req, reply) => {
      const agentsDir = resolve(process.cwd(), '.smith/agents');
      const agents = await loadAgents(agentsDir);
      const agent = agents.find((a) => a.id === req.params.id);
      if (!agent) return reply.status(404).send({ error: `Unknown agent: ${req.params.id}` });
      // Defense in depth: the broker decides archive-vs-delete, but swarm
      // re-checks its own facts so a buggy caller cannot erase history.
      const { records, live, taskNames } = await agentFacts(agent);
      const usage = agentUsage(agent, records, live, taskNames);
      if (usage.warmSessions > 0 || usage.activeTasks > 0) {
        return reply.status(409).send({ error: `${agent.name} has history on this machine — archive instead` });
      }
      await rm(resolve(agentsDir, `${agent.id}.json`));
      return { ok: true, deleted: agent.id };
    });
```

(`rm` from `node:fs/promises` — replace the now-unused `rename` import if nothing else uses it.)

In `PUT /agents/:id`, add to the merged object (un-archive path):

```ts
        archived: b.archived === false ? undefined : existing.archived,
```

In `POST /agents`, upgrade the 409 copy so archived collisions explain themselves:

```ts
      const collider = existing.find((a) => a.id === id);
      if (collider) {
        return reply.status(409).send({
          error: collider.archived
            ? `The name "${id}" belongs to an archived agent — pick another`
            : `Agent "${id}" already exists`,
        });
      }
```

Imports to add at the top of `server.ts`: `activeAgents` (used in Task 5), `agentUsage`, `isBusy` from `./lifecycle.js`, `rm` from `node:fs/promises`.

- [ ] **Step 6: `npm run typecheck` + full `npm test` in swarm — PASS.**

- [ ] **Step 7: Commit** — `feat(swarm): agent usage facts, archive-in-place, and guarded hard delete`

---

### Task 3: swarm — workspace persistence + validation helpers

**Files:**
- Modify: `swarm/src/workspaces.ts`
- Test: `swarm/src/workspaces.test.ts`

**Interfaces:**
- Produces: `saveWorkspace(dir: string, ws: Workspace): Promise<void>` (slug-validated, pretty-printed, trailing newline — mirror of `saveAgent`); `removeWorkspaceFile(dir: string, name: string): Promise<void>`; `isGitRepo(path: string): Promise<boolean>`; `defaultViolation(all: Workspace[], removingName: string): string | null`.

- [ ] **Step 1: Write failing tests**

```ts
test('saveWorkspace rejects a bad slug and round-trips a good one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-'));
  await assert.rejects(() => saveWorkspace(dir, { name: 'Bad Name', repos: [{ name: 'r', path: '/tmp' }] }));
  await saveWorkspace(dir, { name: 'good', repos: [{ name: 'r', path: '/tmp' }] });
  assert.equal((await loadWorkspacesFromDir(dir))[0]?.name, 'good');
});

test('isGitRepo: true for a real repo, false for a plain dir', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'git-'));
  await promisify(execFile)('git', ['init', '-q'], { cwd: repo });
  assert.equal(await isGitRepo(repo), true);
  const plain = await mkdtemp(join(tmpdir(), 'plain-'));
  assert.equal(await isGitRepo(plain), false);
});

test('defaultViolation blocks removing the default while other active workspaces exist', () => {
  const all: Workspace[] = [
    { name: 'a', default: true, repos: [{ name: 'r', path: '/tmp' }] },
    { name: 'b', repos: [{ name: 'r', path: '/tmp' }] },
  ];
  assert.match(defaultViolation(all, 'a') ?? '', /default/);
  assert.equal(defaultViolation(all, 'b'), null);
  assert.equal(defaultViolation([all[0]!], 'a'), null); // last one may go
});
```

- [ ] **Step 2: Run — FAIL.** `node --import tsx --test src/workspaces.test.ts`

- [ ] **Step 3: Implement** (append to `workspaces.ts`; add imports `mkdir, writeFile, rm` from `node:fs/promises`, `execFile` from `node:child_process`, `promisify` from `node:util`)

```ts
/** Write one workspace to `dir`. Mirror of agents.saveAgent. */
export async function saveWorkspace(dir: string, ws: Workspace): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(ws.name)) {
    throw new Error(`Invalid workspace name "${ws.name}": use lowercase letters, digits and dashes`);
  }
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${ws.name}.json`), `${JSON.stringify(ws, null, 2)}\n`);
}

export async function removeWorkspaceFile(dir: string, name: string): Promise<void> {
  await rm(join(dir, `${name}.json`));
}

/** True when `path` is inside a git repository (worktrees are cut from here). */
export async function isGitRepo(path: string): Promise<boolean> {
  try {
    await promisify(execFile)('git', ['rev-parse', '--git-dir'], { cwd: path });
    return true;
  } catch {
    return false;
  }
}

/**
 * The invariant: while any OTHER active workspace exists, the default cannot
 * be archived or deleted — the caller must crown a successor first.
 * Returns the human-readable refusal, or null when the removal is fine.
 */
export function defaultViolation(all: Workspace[], removingName: string): string | null {
  const active = activeWorkspaces(all);
  const target = active.find((w) => w.name === removingName);
  const isDefault = target && (Boolean(target.default) || (!active.some((w) => w.default) && active[0] === target));
  if (isDefault && active.length > 1) {
    return `"${removingName}" is the default workspace — set another default first`;
  }
  return null;
}
```

- [ ] **Step 4: Run — PASS. Typecheck.**

- [ ] **Step 5: Commit** — `feat(swarm): workspace persistence, git validation, default invariant`

---

### Task 4: swarm — workspace CRUD routes

**Files:**
- Modify: `swarm/src/server.ts` (workspace routes near existing `GET /workspaces` ~line 1117; workspace load at line 226)

**Interfaces:**
- Consumes: Task 3 helpers; `server.workspaces` private field (line 147, loaded line 226).
- Produces: `POST /workspaces` (201, full record), `PUT /workspaces/:name` (merge), `POST /workspaces/:name/archive`, `DELETE /workspaces/:name` (guarded), `GET /workspaces/:name/usage` → `{ activeTasks: number }`. `GET /workspaces` now also returns `path` per repo and `archived` per workspace. After every mutation `server.workspaces` reloads from disk.

- [ ] **Step 1: Extract a reload helper.** Next to line 226's load, give the server a method (or closure) `reloadWorkspaces = async () => { server.workspaces = await loadWorkspacesFromDir(resolve(process.cwd(), '.smith/workspaces')); }` and call it from boot (replacing the inline assignment) and after each mutation below.

- [ ] **Step 2: Add validation shared by POST/PUT**

```ts
    const workspaceProblems = async (b: Partial<Workspace>): Promise<string | null> => {
      if (!b.name?.trim()) return 'Missing required field: name';
      if (!Array.isArray(b.repos) || b.repos.length === 0) return 'A workspace needs at least one repo';
      for (const r of b.repos) {
        if (!r?.name?.trim()) return 'Every repo needs a name';
        if (!r.path || !isAbsolute(r.path)) return `Repo "${r.name}": path must be absolute`;
        if (!(await isGitRepo(r.path))) return `Repo "${r.name}": ${r.path} is not a git repository`;
      }
      return null;
    };
```

(import `isAbsolute` from `node:path`, plus Task 3 exports from `./workspaces.js`.)

- [ ] **Step 3: Implement the routes**

```ts
    this.app.post('/workspaces', async (req, reply) => {
      const b = req.body as Partial<Workspace>;
      const problem = await workspaceProblems(b);
      if (problem) return reply.status(400).send({ error: problem });
      const dir = resolve(process.cwd(), '.smith/workspaces');
      const name = b.name!.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const all = await loadWorkspacesFromDir(dir);
      const collider = all.find((w) => w.name === name);
      if (collider) {
        return reply.status(409).send({
          error: collider.archived
            ? `The name "${name}" belongs to an archived workspace — pick another`
            : `Workspace "${name}" already exists`,
        });
      }
      const ws: Workspace = {
        name,
        description: b.description?.trim() || undefined,
        repos: b.repos!.map((r) => ({ name: r.name.trim(), path: r.path, repository: r.repository, branch: r.branch || 'main' })),
        default: Boolean(b.default) || activeWorkspaces(all).length === 0,
      };
      try {
        if (ws.default) for (const other of all.filter((w) => w.default)) await saveWorkspace(dir, { ...other, default: undefined });
        await saveWorkspace(dir, ws);
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
      await reloadWorkspaces();
      return reply.status(201).send(ws);
    });

    this.app.put<{ Params: { name: string } }>('/workspaces/:name', async (req, reply) => {
      const b = req.body as Partial<Workspace>;
      const dir = resolve(process.cwd(), '.smith/workspaces');
      const all = await loadWorkspacesFromDir(dir);
      const existing = all.find((w) => w.name === req.params.name);
      if (!existing) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
      const merged: Workspace = {
        ...existing,
        // The name is the file key and what sessions point at — immutable.
        name: existing.name,
        description: b.description !== undefined ? b.description.trim() || undefined : existing.description,
        repos: b.repos ?? existing.repos,
        default: b.default ?? existing.default,
        archived: b.archived === false ? undefined : existing.archived,
      };
      const problem = await workspaceProblems(merged);
      if (problem) return reply.status(400).send({ error: problem });
      if (merged.default && !existing.default) {
        for (const other of all.filter((w) => w.default && w.name !== merged.name)) {
          await saveWorkspace(dir, { ...other, default: undefined });
        }
      }
      if (existing.default && b.default === false && activeWorkspaces(all).length > 1) {
        return reply.status(409).send({ error: `"${existing.name}" is the default workspace — set another default first` });
      }
      await saveWorkspace(dir, merged);
      await reloadWorkspaces();
      return merged;
    });

    this.app.post<{ Params: { name: string } }>('/workspaces/:name/archive', async (req, reply) => {
      const dir = resolve(process.cwd(), '.smith/workspaces');
      const all = await loadWorkspacesFromDir(dir);
      const ws = all.find((w) => w.name === req.params.name);
      if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
      const violation = defaultViolation(all, ws.name);
      if (violation) return reply.status(409).send({ error: violation });
      await saveWorkspace(dir, { ...ws, archived: true });
      await reloadWorkspaces();
      return { ok: true, archived: ws.name };
    });

    this.app.delete<{ Params: { name: string } }>('/workspaces/:name', async (req, reply) => {
      const dir = resolve(process.cwd(), '.smith/workspaces');
      const all = await loadWorkspacesFromDir(dir);
      const ws = all.find((w) => w.name === req.params.name);
      if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
      const violation = defaultViolation(all, ws.name);
      if (violation) return reply.status(409).send({ error: violation });
      const repoPaths = new Set(ws.repos.map((r) => r.path));
      const activeTasks = [...server.activeTasks.values()].filter((t) => {
        const repository = (t.manifest as { context?: { repository?: string } }).context?.repository;
        return repository !== undefined && repoPaths.has(repository);
      }).length;
      if (activeTasks > 0) {
        return reply.status(409).send({ error: `Workspace "${ws.name}" has ${activeTasks} running task(s) — archive instead` });
      }
      await removeWorkspaceFile(dir, ws.name);
      await reloadWorkspaces();
      return { ok: true, deleted: ws.name };
    });

    this.app.get<{ Params: { name: string } }>('/workspaces/:name/usage', async (req, reply) => {
      const all = await loadWorkspacesFromDir(resolve(process.cwd(), '.smith/workspaces'));
      const ws = all.find((w) => w.name === req.params.name);
      if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
      const repoPaths = new Set(ws.repos.map((r) => r.path));
      const activeTasks = [...server.activeTasks.values()].filter((t) => {
        const repository = (t.manifest as { context?: { repository?: string } }).context?.repository;
        return repository !== undefined && repoPaths.has(repository);
      }).length;
      return { activeTasks };
    });
```

- [ ] **Step 4: Extend `GET /workspaces`** (line ~1117): add `path: r.path` to each mapped repo and `archived: Boolean(w.archived)` to each workspace, and compute the effective default over `activeWorkspaces(server.workspaces)` instead of all.

- [ ] **Step 5: `npm run typecheck` + `npm test` in swarm.** Manual smoke: `curl -s -X POST :7777/workspaces -d '{"name":"tmp","repos":[{"name":"r","path":"'$PWD'"}]}' -H 'content-type: application/json'` then DELETE it; confirm the file appears/disappears under `swarm/.smith/workspaces/`.

- [ ] **Step 6: Commit** — `feat(swarm): workspace CRUD with default invariant and git validation`

---

### Task 5: swarm — delegation and registry respect the lifecycle

**Files:**
- Modify: `swarm/src/server.ts` (`POST /tasks` enrich site ~line 364, `POST /agent-sessions` ~line 985, `GET /agents/registry` ~line 1259)

**Interfaces:**
- Consumes: `activeAgents` (Task 1).
- Produces: archived agents are un-delegable (404 with copy `"…is archived"`), registry returns all records (each naturally carrying `archived` when set) — the broker filters.

- [ ] **Step 1:** At `POST /agent-sessions` (and the `POST /tasks` composed-agent lookup feeding `enrichFromComposedAgent`), resolve with `findAgent(...)` as today, then:

```ts
      if (agent?.archived) return reply.status(404).send({ error: `${agent.name} is archived` });
```

- [ ] **Step 2:** Leave `GET /agents/registry` returning ALL agents — the `archived` field rides along in the JSON. Add a one-line comment: `// Full registry, archived included — the broker filters for the roster and needs the rest for history.`

- [ ] **Step 3:** `npm run typecheck && npm test`.

- [ ] **Step 4: Commit** — `feat(swarm): archived agents are invisible to delegation`

---

### Task 6: swarm — remove the legacy project layer

**Files:**
- Delete: `swarm/src/project.ts` (and `swarm/src/project.test.ts` if present)
- Modify: `swarm/src/index.ts` (lines 12-18: the `./project.js` export block), `swarm/src/types.ts` (project-only types), `swarm/src/server.ts` (boot warning)

- [ ] **Step 1:** Delete `swarm/src/project.ts`. Remove the `loadProjectConfig, loadProjectsFromDir, detectCurrentProject, resolveManifest, interpolatePattern` export block from `index.ts`.

- [ ] **Step 2:** Run `npm run typecheck`. Chase every error it raises: remove now-unreferenced types from `types.ts` (`ProjectConfig`, `BranchingStrategy`, `PullRequestConfig` — but ONLY if the compiler proves nothing else uses them; `TaskManifest` stays). If `cli.ts` or `dispatcher.ts` import project helpers, delete those code paths — they are the dead config system.

- [ ] **Step 3:** Add the boot warning next to the workspace load (~line 226):

```ts
    try {
      const legacy = await Promise.all([
        stat(resolve(process.cwd(), '.smith/project.json')).then(() => '.smith/project.json', () => null),
        stat(resolve(process.cwd(), '.smith/projects')).then(() => '.smith/projects/', () => null),
      ]);
      for (const found of legacy.filter(Boolean)) {
        this.app.log.warn(`${found} is a legacy project config — projects were removed; use .smith/workspaces/ (see PRD §2)`);
      }
    } catch { /* fs races are not boot problems */ }
```

(import `stat` from `node:fs/promises`.)

- [ ] **Step 4:** `npm test` — full suite green.

- [ ] **Step 5: Commit** — `refactor(swarm): remove the legacy project config layer`

---

### Task 7: broker — removal policy + transcript evidence

**Files:**
- Create: `broker/src/removal.ts`
- Test: `broker/src/removal.test.ts`
- Modify: `broker/src/sessions.ts` (add `allSessions()`)

**Interfaces:**
- Consumes: `Session`, `TranscriptLine` (sessions.ts).
- Produces: `interface RemovalEvidence { transcriptHit: boolean; warmSessions: number; activeTasks: number }`; `resolveRemoval(e: RemovalEvidence): 'delete' | 'archive'`; `transcriptMentions(sessions: Session[], agent: { id: string; name: string }): boolean`; `SessionManager.allSessions(): Session[]`; `createRemovalService(ports: RemovalPorts)` → `{ preview(id), execute(id) }` (the whole decision path, swarm injected as a port so it tests with stubs).

- [ ] **Step 1: Write failing tests** (`broker/src/removal.test.ts`)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRemoval, transcriptMentions } from './removal.ts';
import type { Session } from './sessions.ts';

const session = (texts: string[]): Session => ({
  id: 's1', title: 't', workspace: 'w', createdAt: 'c', updatedAt: 'u', brainHistory: [],
  transcript: texts.map((text) => ({ role: 'broker' as const, text, at: 'now' })),
});

test('no evidence -> delete; any evidence -> archive', () => {
  assert.equal(resolveRemoval({ transcriptHit: false, warmSessions: 0, activeTasks: 0 }), 'delete');
  assert.equal(resolveRemoval({ transcriptHit: true, warmSessions: 0, activeTasks: 0 }), 'archive');
  assert.equal(resolveRemoval({ transcriptHit: false, warmSessions: 1, activeTasks: 0 }), 'archive');
  assert.equal(resolveRemoval({ transcriptHit: false, warmSessions: 0, activeTasks: 2 }), 'archive');
});

test('transcriptMentions matches the speaker prefix, by name or id, case-insensitively', () => {
  const agent = { id: 'wilkin', name: 'Wilkin' };
  assert.equal(transcriptMentions([session(['Wilkin: claro, I will take it'])], agent), true);
  assert.equal(transcriptMentions([session(['wilkin: lowercase prefix'])], agent), true);
  assert.equal(transcriptMentions([session(['Aurelio: ask Wilkin later'])], agent), false); // mention ≠ speaking
  assert.equal(transcriptMentions([session([])], agent), false);
});

test('user lines never count as agent speech', () => {
  const s = session([]);
  s.transcript.push({ role: 'user', text: 'Wilkin: pretend I am him', at: 'now' });
  assert.equal(transcriptMentions([s], { id: 'wilkin', name: 'Wilkin' }), false);
});

test('removal service: aggregates evidence, calls the matching swarm op', async () => {
  const ops: string[] = [];
  const make = (transcript: string[], usage: { warmSessions: number; activeTasks: number }) =>
    createRemovalService({
      registry: async () => [{ id: 'wilkin', name: 'Wilkin' }],
      agentUsage: async () => usage,
      deleteAgent: async (id) => void ops.push(`delete:${id}`),
      archiveAgent: async (id) => void ops.push(`archive:${id}`),
      sessions: () => [session(transcript)],
      onChanged: async () => void ops.push('refresh'),
    });
  const clean = await make([], { warmSessions: 0, activeTasks: 0 }).execute('wilkin');
  assert.deepEqual(clean, { outcome: 'deleted' });
  const spoke = await make(['Wilkin: hola'], { warmSessions: 0, activeTasks: 0 }).execute('wilkin');
  assert.deepEqual(spoke, { outcome: 'archived' });
  assert.deepEqual(ops, ['delete:wilkin', 'refresh', 'archive:wilkin', 'refresh']);
  assert.deepEqual(await make([], { warmSessions: 0, activeTasks: 0 }).preview('nobody'), { error: 'Unknown agent: nobody' });
});
```

- [ ] **Step 2: Run — FAIL.** `node --import tsx --test src/removal.test.ts`

- [ ] **Step 3: Implement `broker/src/removal.ts`**

```ts
/**
 * The archive-vs-delete decision (spec §1). Pure — every branch testable
 * without a broker. Evidence spans two services: transcriptHit is ours,
 * warmSessions/activeTasks come from swarm's usage endpoint.
 *
 * Known approximation: transcripts cap at 500 lines per session, so speech
 * that rolled off no longer counts as evidence — once the record is gone,
 * deleting the speaker orphans nothing.
 */
import type { Session } from './sessions.ts';

export interface RemovalEvidence {
  transcriptHit: boolean;
  warmSessions: number;
  activeTasks: number;
}

export function resolveRemoval(e: RemovalEvidence): 'delete' | 'archive' {
  return e.transcriptHit || e.warmSessions > 0 || e.activeTasks > 0 ? 'archive' : 'delete';
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Did this agent ever SPEAK (speaker-prefixed broker line) in any session? */
export function transcriptMentions(sessions: Session[], agent: { id: string; name: string }): boolean {
  const prefix = new RegExp(`^\\s*(?:${escapeRe(agent.name)}|${escapeRe(agent.id)})\\s*:`, 'i');
  return sessions.some((s) => s.transcript.some((line) => line.role === 'broker' && prefix.test(line.text)));
}

export interface RemovalPorts {
  registry: () => Promise<Array<{ id: string; name: string }>>;
  agentUsage: (id: string) => Promise<{ warmSessions: number; activeTasks: number }>;
  deleteAgent: (id: string) => Promise<void>;
  archiveAgent: (id: string) => Promise<void>;
  sessions: () => Session[];
  /** Post-removal refresh: reseed the directory, rebroadcast the roster. */
  onChanged: () => Promise<void>;
}

/** The whole decision path behind "remove". Swarm is a port, so this tests with stubs. */
export function createRemovalService(ports: RemovalPorts) {
  const preview = async (id: string): Promise<{ outcome: 'delete' | 'archive'; reasons: string[] } | { error: string }> => {
    const agent = (await ports.registry()).find((a) => a.id === id);
    if (!agent) return { error: `Unknown agent: ${id}` };
    const usage = await ports.agentUsage(id);
    const transcriptHit = transcriptMentions(ports.sessions(), agent);
    const reasons = [
      ...(transcriptHit ? ['has spoken in a session'] : []),
      ...(usage.warmSessions > 0 ? [`${usage.warmSessions} warm session(s)`] : []),
      ...(usage.activeTasks > 0 ? [`${usage.activeTasks} running task(s)`] : []),
    ];
    return { outcome: resolveRemoval({ transcriptHit, ...usage }), reasons };
  };
  const execute = async (id: string): Promise<{ outcome: 'deleted' | 'archived' } | { error: string }> => {
    const decision = await preview(id);
    if ('error' in decision) return decision;
    try {
      if (decision.outcome === 'delete') await ports.deleteAgent(id);
      else await ports.archiveAgent(id);
    } catch (err) {
      return { error: String((err as Error).message) }; // swarm's busy-lock 409s land here, readable
    }
    await ports.onChanged();
    return { outcome: decision.outcome === 'delete' ? 'deleted' : 'archived' };
  };
  return { preview, execute };
}
```

- [ ] **Step 4:** Add to `SessionManager` (sessions.ts, near `list()`):

```ts
  /** Every session with its full transcript — evidence for removal decisions. */
  allSessions(): Session[] {
    return [...this.sessions.values()];
  }
```

- [ ] **Step 5: Run removal tests + full broker `npm test` — PASS. Typecheck.**

- [ ] **Step 6: Commit** — `feat(broker): pure removal policy over cross-service evidence`

---

### Task 8: broker — swarm-client lifecycle methods

**Files:**
- Modify: `broker/src/swarm-client.ts`
- Test: `broker/src/swarm-client.test.ts` (existing `fetchImpl` stub pattern)

**Interfaces:**
- Produces (all on `SwarmClient`): `agentUsage(id): Promise<{ warmSessions: number; activeTasks: number }>`; `archiveAgent(id): Promise<void>`; `deleteAgent(id): Promise<void>`; `createWorkspace(body): Promise<SwarmWorkspace>`; `updateWorkspace(name, body): Promise<SwarmWorkspace>`; `archiveWorkspace(name): Promise<void>`; `deleteWorkspace(name): Promise<void>`; `workspaceUsage(name): Promise<{ activeTasks: number }>`. `SwarmWorkspace.repos[]` gains `path: string`; `SwarmWorkspace` and `RegistryAgent` gain `archived?: boolean`.

- [ ] **Step 1: Write failing tests** (follow the file's existing stub style — a `fetchImpl` that records `method`/`path` and returns canned JSON):

```ts
test('lifecycle methods hit the right swarm routes', async () => {
  const calls: string[] = [];
  const client = new SwarmClient({
    baseUrl: 'http://s',
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url).replace('http://s', '')}`);
      return new Response(JSON.stringify({ ok: true, warmSessions: 0, activeTasks: 0, workspaces: [] }));
    }) as typeof fetch,
  });
  await client.agentUsage('wilkin');
  await client.archiveAgent('wilkin');
  await client.deleteAgent('wilkin');
  await client.createWorkspace({ name: 'w', repos: [] });
  await client.updateWorkspace('w', { description: 'd' });
  await client.archiveWorkspace('w');
  await client.deleteWorkspace('w');
  await client.workspaceUsage('w');
  assert.deepEqual(calls, [
    'GET /agents/wilkin/usage',
    'POST /agents/wilkin/archive',
    'DELETE /agents/wilkin',
    'POST /workspaces',
    'PUT /workspaces/w',
    'POST /workspaces/w/archive',
    'DELETE /workspaces/w',
    'GET /workspaces/w/usage',
  ]);
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** (methods delegate to the private `http()`; `deleteAgent`/`deleteWorkspace` use method `'DELETE'`; add the type fields). Body types — define once and reuse:

```ts
export interface WorkspaceBody {
  name: string;
  description?: string;
  repos: Array<{ name: string; path: string; repository?: string; branch?: string }>;
  default?: boolean;
}
```

`createWorkspace(body: WorkspaceBody)`; `updateWorkspace(name: string, body: Partial<WorkspaceBody>)`.

- [ ] **Step 4: Run — PASS. Typecheck.**

- [ ] **Step 5: Commit** — `feat(broker): swarm-client lifecycle and workspace CRUD methods`

---

### Task 9: broker — removal + workspace HTTP surface, roster filtering

**Files:**
- Modify: `broker/src/main.ts` (creation service ~line 430; directory seeding; workspace frame source)
- Modify: `broker/src/text-channel.ts` (agent routes block at lines 199-256; new workspace routes)
- Test: `broker/src/text-channel.test.ts` (existing patterns)

**Interfaces:**
- Consumes: Task 7 (`resolveRemoval`, `transcriptMentions`, `allSessions()`), Task 8 client methods.
- Produces broker HTTP:
  - `GET /agents/:id/removal` → `{ outcome: 'delete' | 'archive', reasons: string[] }` (the confirm-sheet preview)
  - `DELETE /agents/:id` → `{ outcome: 'deleted' | 'archived' }`
  - `GET /workspaces` → `{ workspaces: SwarmWorkspace[] }` (full records incl. paths; active + archived flagged)
  - `POST /workspaces`, `PUT /workspaces/:name` → proxied result or `{ error }`
  - `DELETE /workspaces/:name` → `{ outcome: 'deleted' | 'archived' }` (broker decides via its sessions evidence + swarm usage)
- Directory seeds ACTIVE agents only: wherever `directory.seed(...)` receives `swarmClient.registry()`, filter `.filter((a) => !a.archived)`.

- [ ] **Step 1: Wire the removal service in `main.ts`** next to the creation object (~line 430), and pass it to the text channel alongside `creation`:

```ts
const removal = createRemovalService({
  registry: () => swarmClient.registry(),
  agentUsage: (id) => swarmClient.agentUsage(id),
  deleteAgent: (id) => swarmClient.deleteAgent(id),
  archiveAgent: (id) => swarmClient.archiveAgent(id),
  sessions: () => sessionManager.allSessions(),
  onChanged: async () => {
    directory.seed((await swarmClient.registry()).filter((a) => !a.archived));
    broadcastRoster(); // the exact function the creation path already calls to push a roster frame — reuse it, do not invent a channel
  },
});
```

Add a `workspaces` service beside it, mirroring `removal`'s shape: `list` = `swarmClient.listWorkspaces()`; `save(body, isNew)` = `isNew ? createWorkspace(body) : updateWorkspace(body.name, body)` then re-push the workspace-names frame; `remove(name)` = evidence check `sessionManager.allSessions().some((s) => s.workspace === name)` OR `(await swarmClient.workspaceUsage(name)).activeTasks > 0` → `archiveWorkspace`, else `deleteWorkspace` → `{ outcome }`, with thrown client errors returned as `{ error }` exactly like `execute` does. (Add `workspaceUsage(name)` to SwarmClient in Task 8 — `GET /workspaces/:name/usage`.)

- [ ] **Step 2: Routes in `text-channel.ts`** — inside the same block as the existing agent routes (order matters: removal preview before the `editMatch` handlers):

```ts
        const removalMatch = /^\/agents\/([^/]+)\/removal$/.exec(url.pathname);
        if (req.method === 'GET' && removalMatch && this.removal) {
          void this.removal.preview(decodeURIComponent(removalMatch[1]!)).then(
            (r) => json('error' in r ? 404 : 200, r), fail);
          return;
        }
        if (req.method === 'DELETE' && editMatch && this.removal) {
          void this.removal.execute(decodeURIComponent(editMatch[1]!)).then(
            (r) => json('error' in r ? 409 : 200, r), fail);
          return;
        }
```

Workspace routes follow the same body-collecting pattern as `POST /agents`: `GET /workspaces`, `POST /workspaces`, and `PUT|DELETE /workspaces/:name` via `/^\/workspaces\/([^/]+)$/`. Constructor: accept the two new handler objects the same way `creation`/`sessions`/`work` are accepted today.

- [ ] **Step 3: Tests** in `text-channel.test.ts` (existing harness): stub `removal`/`workspaces` handlers; assert `GET /agents/x/removal` returns the preview JSON, `DELETE /agents/x` returns `{outcome}`, workspace `POST` 201-or-400 passes the handler's answer through, and an unknown id yields 404 with `{ error }`.

- [ ] **Step 4: Directory seeding** — every `directory.seed(await swarmClient.registry())` site in `main.ts` gets `.filter((a) => !a.archived)`.

- [ ] **Step 5: `npm test` + typecheck in broker — PASS.**

- [ ] **Step 6: Commit** — `feat(broker): one remove intent — broker decides archive vs delete`

---

### Task 10: UI — remove an agent from edit mode

**Files:**
- Modify: `control-plane/src/organisms/AgentRoster.tsx` (RosterItem, props)
- Create: `control-plane/src/molecules/ConfirmSheet.tsx`
- Modify: `control-plane/src/hooks/useBrokerChat.ts` (two fetch helpers)
- Modify: `control-plane/src/pages/HomePage.tsx` (wiring)

**Interfaces:**
- Consumes: broker `GET /agents/:id/removal` and `DELETE /agents/:id` (Task 9).
- Produces: `AgentRosterProps.onRemove?: (entry: AgentSeed) => void`; `useBrokerChat` returns `removalPreview(id): Promise<{ outcome: string; reasons: string[] }>` and `removeAgent(id): Promise<{ outcome: string } | { error: string }>`; `ConfirmSheet({ open, title, body, confirmLabel, onConfirm, onCancel })`.

- [ ] **Step 1: useBrokerChat helpers** (same style as the `activity` fetches at lines 177-187):

```ts
  const removalPreview = async (id: string) => {
    const res = await fetch(`http://${base}/agents/${encodeURIComponent(id)}/removal`);
    return (await res.json()) as { outcome: "delete" | "archive"; reasons: string[] };
  };
  const removeAgent = async (id: string) => {
    const res = await fetch(`http://${base}/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
    return (await res.json()) as { outcome?: string; error?: string };
  };
```

Export both from the hook's return object.

- [ ] **Step 2: ✕ badge in `RosterItem`** — render only in edit mode, solo, not busy (busy circles are already locked). Inside the wrapper div after `<AgentAvatar …/>`:

```tsx
      {editMode && entry.kind !== "squad" && !busy && props.onRemove && (
        <button
          type="button"
          className="roster-item__remove"
          aria-label={`Remove ${entry.name}`}
          onClick={(e) => {
            e.stopPropagation(); // the circle tap opens the edit wizard — not this
            props.onRemove?.();
          }}
        >
          <X size={10} strokeWidth={2.5} />
        </button>
      )}
```

Add `onRemove?: () => void` to `RosterItem`'s props, `onRemove?: (entry: AgentSeed) => void` to `AgentRosterProps`, thread it in the `entries.map` (`onRemove={onRemove ? () => onRemove(entry) : undefined}`), and import `X` from lucide-react. Style `.roster-item__remove` as a small top-left circular badge in the styles dir, matching the existing edit-mode visual language.

- [ ] **Step 3: `ConfirmSheet` molecule** — a minimal centered overlay in the app's modal style (see AddAgentModal's shell for class conventions):

```tsx
interface ConfirmSheetProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmSheet({ open, title, body, confirmLabel, onConfirm, onCancel }: ConfirmSheetProps) {
  if (!open) return null;
  return (
    <div className="confirm-sheet__backdrop" role="presentation" onClick={onCancel}>
      <section className="confirm-sheet" role="alertdialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <p>{body}</p>
        <footer>
          <button type="button" onClick={onCancel}>cancel</button>
          <button type="button" className="confirm-sheet__danger" onClick={onConfirm}>{confirmLabel}</button>
        </footer>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: HomePage wiring** — state `const [removing, setRemoving] = useState<{ entry: AgentSeed; outcome: string; reasons: string[] } | null>(null);`. `AgentRoster` gets `onRemove={async (entry) => setRemoving({ entry, ...(await removalPreview(entry.id)) })}`. Render in `overlays`:

```tsx
          <ConfirmSheet
            open={removing !== null}
            title={`Remove ${removing?.entry.name}?`}
            body={
              removing?.outcome === "delete"
                ? `${removing.entry.name} has never worked or spoken — this removes them permanently.`
                : `${removing?.entry.name} has history (${removing?.reasons.join(", ")}) — they will be archived.`
            }
            confirmLabel={removing?.outcome === "delete" ? "delete" : "archive"}
            onConfirm={async () => {
              if (removing) await removeAgent(removing.entry.id);
              setRemoving(null); // roster frame refresh arrives over WS
            }}
            onCancel={() => setRemoving(null)}
          />
```

- [ ] **Step 5: Verify** — `npm run typecheck && npx biome check src` in control-plane. Then live: run swarm + broker + `npm run tauri dev`, create a throwaway agent, long-press → ✕ → sheet says "removes them permanently" → confirm → circle disappears and `swarm/.smith/agents/<id>.json` is gone. Ask an existing agent that has spoken → sheet says "will be archived" → file gains `"archived": true`.

- [ ] **Step 6: Commit** — `feat(ui): remove agents from edit mode with an outcome-stating confirm`

---

### Task 11: UI — workspace manager

**Files:**
- Create: `control-plane/src/organisms/WorkspaceManagerModal.tsx`
- Modify: `control-plane/src/organisms/SessionsPanel.tsx` (manage button), `control-plane/src/hooks/useBrokerChat.ts` (workspace record calls), `control-plane/src/pages/HomePage.tsx` (wiring)

**Interfaces:**
- Consumes: broker `GET /workspaces`, `POST /workspaces`, `PUT /workspaces/:name`, `DELETE /workspaces/:name` (Task 9).
- Produces: `useBrokerChat` returns `listWorkspaceRecords(): Promise<WorkspaceRecord[]>`, `saveWorkspace(body: WorkspaceRecord, isNew: boolean): Promise<{ error?: string }>`, `removeWorkspace(name: string): Promise<{ outcome?: string; error?: string }>` where `WorkspaceRecord = { name: string; description?: string; default: boolean; archived?: boolean; repos: Array<{ name: string; path: string; branch: string }> }`; `SessionsPanelProps.onManage?: () => void`.

- [ ] **Step 1: Hook helpers** — same fetch pattern as Task 10, mapping to the three broker routes (`PUT` when `isNew` is false). Export the `WorkspaceRecord` type from the hook.

- [ ] **Step 2: `WorkspaceManagerModal`** — modal shell in the AddAgentModal style. Left: list of active workspaces (name, repo count, `default` tag). Right (or below on narrow): the form —

```tsx
interface WorkspaceManagerModalProps {
  open: boolean;
  onClose: () => void;
  list: () => Promise<WorkspaceRecord[]>;
  save: (ws: WorkspaceRecord, isNew: boolean) => Promise<{ error?: string }>;
  remove: (name: string) => Promise<{ outcome?: string; error?: string }>;
}
```

Behavior: on open, `list()` into state; "new workspace" resets the form (`{ name: "", default: list is empty, repos: [{ name: "", path: "", branch: "main" }] }`); repo rows add/remove with a `+ repo` button; name field is disabled when editing (the name is the file key); save calls `save(form, isNew)` and shows `error` inline verbatim (swarm's copy is written to be read); remove uses the same two-step pattern as Task 10 — a ConfirmSheet whose body switches on the returned outcome, and surfaces the default-invariant 409 (`"set another default first"`) inline instead of the sheet.

- [ ] **Step 3: SessionsPanel** — add `onManage?: () => void` to props and a footer row after the new-session buttons:

```tsx
        {onManage && (
          <button type="button" className="session-row session-row--manage" onClick={() => { onManage(); onClose(); }}>
            manage workspaces…
          </button>
        )}
```

Also the spec's workspace switcher: when more than one workspace exists, render a chip row between the header and the list — `all` plus one chip per workspace name — held in local state and used to filter the rendered sessions:

```tsx
  const [wsFilter, setWsFilter] = useState<string | null>(null);
  const visible = wsFilter ? sessions.filter((s) => s.workspace === wsFilter) : sessions;
```

```tsx
      {workspaces.length > 1 && (
        <div className="sessions-panel__filter">
          {[null, ...workspaces].map((ws) => (
            <button
              key={ws ?? "all"}
              type="button"
              className={`ws-chip${wsFilter === ws ? " ws-chip--on" : ""}`}
              onClick={() => setWsFilter(ws)}
            >
              {ws ?? "all"}
            </button>
          ))}
        </div>
      )}
```

(map over `visible` instead of `sessions` in the list; import `useState`.)

- [ ] **Step 4: HomePage** — `const [workspacesOpen, setWorkspacesOpen] = useState(false);`, pass `onManage={() => setWorkspacesOpen(true)}` to SessionsPanel, render the modal in `overlays` with the three hook functions.

- [ ] **Step 5: Verify** — typecheck + biome. Live: create a workspace pointing at a real repo path → file lands in `swarm/.smith/workspaces/`; a non-git path shows swarm's readable 400 inline; "new session" list now offers the new workspace; removing an unused workspace deletes its file, removing one with sessions archives it.

- [ ] **Step 6: Commit** — `feat(ui): create, edit and remove workspaces from the sessions panel`

---

### Task 12: docs + full verification

**Files:**
- Modify: `README.md` (data-over-code table), `PRD.md` (§5 shipped, §6.2 open items)

- [ ] **Step 1: PRD** — in §5 add a dated line: workspaces and agents are fully managed from the UI (create/edit/remove with archive-on-history), legacy project layer removed. In §6.2, delete the now-false clause "no edit/delete surface for an existing agent (only create and archive-by-API)" and rewrite the item to what remains open (voice preview). Note un-archive is API-only.

- [ ] **Step 2: README** — in the data-over-code table, note that `swarm/.smith/agents/*.json` and `workspaces/*.json` may carry `archived: true` (hidden from the roster, kept for history), and that workspaces are managed from the app (drop-a-file still works).

- [ ] **Step 3: Full verification** — run and confirm green, pasting output into the task log:

```bash
cd swarm && npm run typecheck && npm test
cd ../broker && npm run typecheck && npm test
cd ../control-plane && npm run typecheck && npx biome check src
```

- [ ] **Step 4: Manual e2e sweep** (all three services up): agent create → speak → remove ⇒ archived (file keeps `archived: true`, roster hides it, old transcript still renders); agent create → remove ⇒ file gone; archived name reuse ⇒ readable 409 in the wizard; workspace create/edit/default-switch/remove; delegation into the new workspace lands a worktree.

- [ ] **Step 5: Commit** — `docs: record shipped agent/workspace lifecycle management`
