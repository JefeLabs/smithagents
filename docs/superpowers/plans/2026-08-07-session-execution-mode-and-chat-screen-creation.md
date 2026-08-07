# Session-Level Execution Mode + Chat-Screen Session Creation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move execution mode from the workspace to the session (2×2:
local/remote × in-process/docker), replace modal session creation with a
lazy chat-screen composer, and gate the mode picker by real capability
(Settings → Workspace → Containers for Docker; worker advertisement for
remote modes).

**Spec:** `docs/superpowers/specs/2026-08-07-session-creation-and-execution-mode-design.md` — read it first.

**Architecture:** Swarm's `RuntimeType` grows `remote-tmux`/`remote-docker`
and `WorkerPool` routes by the runtimes workers already advertise. The
broker's `Session` carries an `ExecutionMode` stamped onto every delegated
task via the existing `manifest.runtime` override. Session creation becomes
one atomic `POST /sessions {workspace, runtime, prompt}`; zero sessions is
a legal broker state; the control plane gains a composer screen, a
Containers settings group, and loses the workspace-level mode picker.

**Tech Stack:** TypeScript everywhere. swarm + broker: node test runner via
tsx (`npm test` in each package). control-plane: React + vitest + biome.
No biome in swarm/broker.

## Global Constraints

- `ExecutionMode` string literals, exactly: `'local-in-process' | 'local-docker' | 'remote-in-process' | 'remote-docker'`.
- Seam mapping, exactly: `local-in-process→tmux`, `local-docker→docker`, `remote-in-process→remote-tmux`, `remote-docker→remote-docker`.
- Legacy persisted sessions without `runtime` behave as `local-in-process` everywhere.
- Swarm's bare `'remote'` stays valid as the legacy "any worker" alias.
- ZERO changes to `swarm/src/worker.ts`, `swarm/src/worker-cli.ts`, or the worker WS message shapes.
- Unavailable modes are invisible in pickers, never disabled-greyed.
- The session frame shape changes (`session` may be `null`, gains `runtime`): **both lockstep parsers change in the same task** — `broker/src/text-channel.ts` and `control-plane/src/hooks/useBrokerChat.ts`.
- Title truncation: collapse whitespace, ≤40 chars, `…` suffix when cut.
- Machine files under `.smith/` use the cli-tools pattern: dir mode `0o700`, file mode `0o600`, corrupt/missing → empty default.
- Commit after every task with the exact message given; always `git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents …` and verify `[branch hash]` + file count in the commit output.
- Test commands: swarm `cd swarm && npm test`, broker `cd broker && npm test`, control-plane `cd control-plane && npx vitest run` (+ `npx biome check .` before control-plane commits). Targeted runs: `node --import tsx --test src/<file>.test.ts` (swarm/broker), `npx vitest run src/path/<file>.test.tsx` (control-plane).

---

### Task 1: swarm — RuntimeType 2×2 + WorkerPool kind routing

**Files:**
- Modify: `swarm/src/types.ts:33`
- Modify: `swarm/src/remote-runtime.ts` (`pickWorker` ~line 121, `launch` ~line 155, `RemoteRuntime` ~line 320)
- Modify: `swarm/src/runtime.ts` (`createRuntime` ~line 526)
- Test: `swarm/src/remote-runtime.test.ts`, `swarm/src/runtime.test.ts`

**Interfaces:**
- Consumes: `ConnectedWorker.runtimes: Array<'tmux' | 'docker'>` (already advertised at registration, `remote-types.ts:156`).
- Produces: `RuntimeType = 'tmux' | 'docker' | 'remote' | 'remote-tmux' | 'remote-docker'`; `WorkerPool.launch(sessionName, command, cwd, env?, kind?: 'tmux' | 'docker')`; `WorkerPool.pickWorker(kind?)` (stays private); `new RemoteRuntime(pool, kind?: 'tmux' | 'docker')`; `createRuntime('remote-tmux' | 'remote-docker', …)` returns a kind-filtered `RemoteRuntime`.

- [ ] **Step 1: Write the failing tests**

In `swarm/src/remote-runtime.test.ts`, follow the file's existing fake-worker setup helpers (fake `ws` = `{ send: mock.fn(), readyState: 1 }`; `ConnectedWorker` needs `workerId, name, capacity, activeCount, agents, runtimes, connectedAt, lastHeartbeat, tasks: new Set()`). Add:

```ts
test('launch with kind routes to a worker advertising that runtime', async () => {
  const pool = new WorkerPool();
  const tmuxWs = { send: mock.fn(), readyState: 1 };
  const dockerWs = { send: mock.fn(), readyState: 1 };
  pool.addWorker('w-tmux', workerInfo('w-tmux', ['tmux']), tmuxWs as never);
  pool.addWorker('w-docker', workerInfo('w-docker', ['docker']), dockerWs as never);
  await pool.launch('s1', 'echo hi', '/tmp', undefined, 'docker');
  assert.equal(dockerWs.send.mock.callCount(), 1);
  assert.equal(tmuxWs.send.mock.callCount(), 0);
});

test('launch with kind and no advertising worker throws a named error', async () => {
  const pool = new WorkerPool();
  pool.addWorker('w-tmux', workerInfo('w-tmux', ['tmux']), { send: mock.fn(), readyState: 1 } as never);
  await assert.rejects(pool.launch('s1', 'echo hi', '/tmp', undefined, 'docker'), /No remote workers advertising "docker"/);
});

test('launch without kind keeps legacy any-worker behavior', async () => {
  const pool = new WorkerPool();
  const ws = { send: mock.fn(), readyState: 1 };
  pool.addWorker('w-tmux', workerInfo('w-tmux', ['tmux']), ws as never);
  await pool.launch('s1', 'echo hi', '/tmp');
  assert.equal(ws.send.mock.callCount(), 1);
});
```

In `swarm/src/runtime.test.ts` add (mirroring the existing `createRuntime` remote test's pool setup):

```ts
test('createRuntime maps remote-tmux and remote-docker to kind-filtered RemoteRuntime', () => {
  const pool = new WorkerPool();
  assert.ok(createRuntime('remote-tmux', undefined, pool));
  assert.ok(createRuntime('remote-docker', undefined, pool));
  assert.throws(() => createRuntime('remote-tmux'), /WorkerPool is required/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd swarm && node --import tsx --test src/remote-runtime.test.ts src/runtime.test.ts`
Expected: FAIL — `launch` has no 5th parameter / unknown runtime type.

- [ ] **Step 3: Implement**

`swarm/src/types.ts:33`:

```ts
export type RuntimeType = 'tmux' | 'docker' | 'remote' | 'remote-tmux' | 'remote-docker';
```

`swarm/src/remote-runtime.ts` — `pickWorker` gains a filter:

```ts
private pickWorker(kind?: 'tmux' | 'docker'): { info: ConnectedWorker; ws: WebSocket } | null {
  let best: { info: ConnectedWorker; ws: WebSocket } | null = null;
  let bestLoad = Infinity;
  for (const [, entry] of this.workers) {
    if (kind && !entry.info.runtimes.includes(kind)) continue;
    if (entry.info.activeCount < entry.info.capacity) {
      const load = entry.info.activeCount / entry.info.capacity;
      if (load < bestLoad) {
        bestLoad = load;
        best = entry;
      }
    }
  }
  return best;
}
```

`launch` threads it through (error message names the kind):

```ts
async launch(sessionName: string, command: string, cwd: string, env?: Record<string, string>, kind?: 'tmux' | 'docker'): Promise<void> {
  const worker = this.pickWorker(kind);
  if (!worker) {
    throw new Error(kind ? `No remote workers advertising "${kind}" with capacity` : 'No remote workers available with capacity');
  }
  // …rest unchanged (TaskDispatchMessage does NOT change — no protocol change)
```

`RemoteRuntime` carries the kind (only `launch` uses it — all other ops route by session name via `sessionWorker`, unchanged):

```ts
export class RemoteRuntime implements RuntimeAdapter {
  constructor(
    private readonly pool: WorkerPool,
    private readonly kind?: 'tmux' | 'docker',
  ) {}

  launch(sessionName: string, command: string, cwd: string, env?: Record<string, string>): Promise<void> {
    return this.pool.launch(sessionName, command, cwd, env, this.kind);
  }
  // …every other method unchanged
```

`swarm/src/runtime.ts` `createRuntime` — extend the `'remote'` case (keep its existing lazy-require mechanism exactly as-is, just parameterize):

```ts
case 'remote':
case 'remote-tmux':
case 'remote-docker': {
  if (!workerPool) {
    throw new Error(
      'WorkerPool is required when runtime is "remote". ' +
      'The server must have a WorkerPool with connected workers.',
    );
  }
  // (existing lazy require of RemoteRuntime stays byte-identical)
  const kind = runtime === 'remote-tmux' ? 'tmux' : runtime === 'remote-docker' ? 'docker' : undefined;
  return new RemoteRuntime(workerPool, kind);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swarm && node --import tsx --test src/remote-runtime.test.ts src/runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + full swarm suite**

Run: `cd swarm && npm run typecheck && npm test`
Expected: clean. (`resolveTaskRuntime`'s `location` mapping still compiles because `RuntimeType` only grew; its remote-* location handling is Task 2.)

- [ ] **Step 6: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add swarm/src/types.ts swarm/src/remote-runtime.ts swarm/src/runtime.ts swarm/src/remote-runtime.test.ts swarm/src/runtime.test.ts
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(swarm): remote-tmux/remote-docker runtimes route by worker advertisement"
```

---

### Task 2: swarm — Workspace drops `runtime`, gains `links`; dispatcher drops the workspace clause

**Files:**
- Modify: `swarm/src/workspaces.ts:37` (the `runtime?:` line)
- Modify: `swarm/src/dispatcher.ts:118-136` and `resolveConnections` (~lines 213-240)
- Modify: `swarm/src/server.ts` — POST `/workspaces` (~1395), PUT `/workspaces/:name` (~1436), `resolveTaskRuntime` (~2630), `workspaceProblems` (~2647)
- Test: `swarm/src/dispatcher.test.ts`, `swarm/src/server.test.ts` (or wherever `workspaceProblems`/`resolveTaskRuntime` tests live — find with `grep -rln "resolveTaskRuntime\|workspaceProblems" swarm/src/*.test.ts`)

**Interfaces:**
- Produces: `Workspace.links?: string[]` (no `runtime` field); `resolveTaskRuntime(requested: RuntimeType | undefined, defaultRuntime: RuntimeType): { runtime: RuntimeType; location: LocationType }` — two params, workspace param deleted; POST/PUT `/workspaces` accept + persist `links`.
- Consumes: `RuntimeType` from Task 1.

- [ ] **Step 1: Write the failing tests**

In the file containing existing `resolveTaskRuntime` tests:

```ts
test('resolveTaskRuntime: manifest wins, else server default — no workspace clause', () => {
  assert.equal(resolveTaskRuntime('docker', 'tmux').runtime, 'docker');
  assert.equal(resolveTaskRuntime(undefined, 'tmux').runtime, 'tmux');
});

test('resolveTaskRuntime: remote-* runtimes map to location "remote"', () => {
  assert.equal(resolveTaskRuntime('remote-tmux', 'tmux').location, 'remote');
  assert.equal(resolveTaskRuntime('remote-docker', 'tmux').location, 'remote');
  assert.equal(resolveTaskRuntime('remote', 'tmux').location, 'remote');
  assert.equal(resolveTaskRuntime('docker', 'tmux').location, 'docker');
  assert.equal(resolveTaskRuntime('tmux', 'docker').location, 'local');
});

test('workspaceProblems: links must be an array of strings when present', async () => {
  const base = { name: 'x', repos: [validRepoFixture] }; // reuse the file's existing valid-repo fixture
  assert.equal(await workspaceProblems({ ...base, links: ['https://a', 'https://b'] }), null);
  assert.match((await workspaceProblems({ ...base, links: 'nope' as never })) ?? '', /links/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd swarm && npm test`
Expected: FAIL — `resolveTaskRuntime` takes three args; `links` rejected/ignored.

- [ ] **Step 3: Implement**

`swarm/src/workspaces.ts` — delete line 37 (`runtime?: 'tmux' | 'docker' | 'remote';`) and its doc comment; add in its place:

```ts
/** Default-context links every session in this workspace inherits (spec 2026-08-07). */
links?: string[];
```

`swarm/src/dispatcher.ts` — line 128-129 becomes:

```ts
const runtimeType: RuntimeType =
  manifest.runtime ?? this.config.defaultRuntime;
```

Update the comment above it (lines 124-127) to say "Per-task override wins, then the server default — workspace-level runtime was removed by spec 2026-08-07." In `resolveConnections` delete the `workspaceRuntime?: RuntimeType;` member from its return type (~line 224) and the line that sets it from `workspace.runtime`. Also fix the doc comment at lines 92-94.

`swarm/src/server.ts`:

- POST `/workspaces` (~1424): delete `runtime: b.runtime,`; add `links: sanitizeLinks(b.links),` to the constructed `ws`.
- PUT `/workspaces/:name` (~1451): replace `runtime: b.runtime !== undefined ? b.runtime : existing.runtime,` with `links: b.links !== undefined ? sanitizeLinks(b.links) : existing.links,`.
- `resolveTaskRuntime` (~2630):

```ts
export function resolveTaskRuntime(
  requested: RuntimeType | undefined,
  defaultRuntime: RuntimeType,
): { runtime: RuntimeType; location: LocationType } {
  const runtime = requested ?? defaultRuntime;
  const location: LocationType =
    runtime === 'docker' ? 'docker' : runtime.startsWith('remote') ? 'remote' : 'local';
  return { runtime, location };
}
```

Update its call site in POST `/tasks` (~527): `resolveTaskRuntime(body.runtime, server.orchConfig.defaultRuntime)`.

- `workspaceProblems` (~2655): replace the runtime-values check with:

```ts
if (b.links !== undefined && (!Array.isArray(b.links) || b.links.some((l) => typeof l !== 'string'))) {
  return 'links must be an array of strings';
}
```

- Add near `workspaceProblems`:

```ts
/** Trim, drop empties/non-strings; undefined when nothing survives. */
function sanitizeLinks(links: unknown): string[] | undefined {
  if (!Array.isArray(links)) return undefined;
  const clean = links.filter((l): l is string => typeof l === 'string').map((l) => l.trim()).filter(Boolean);
  return clean.length ? clean : undefined;
}
```

- [ ] **Step 4: Sweep for stragglers**

Run: `grep -rn "workspaceRuntime\|workspace\.runtime\|\.runtime ??" swarm/src --include="*.ts" | grep -v test`
Expected: zero hits outside comments. Fix any hit (dashboard/status displays included). Also delete any now-failing old tests that asserted the workspace clause (`grep -rn "workspaceRuntime\|runtime.*workspace" swarm/src/*.test.ts`) — deleting a test is correct here only when the behavior it pinned was removed by the spec.

- [ ] **Step 5: Run full suite + typecheck**

Run: `cd swarm && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add swarm/src
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(swarm): workspace loses runtime, gains links; dispatch = manifest ?? server default"
```

---

### Task 3: swarm — Containers machine setting (`.smith/containers.json`) + routes

**Files:**
- Create: `swarm/src/containers.ts`
- Create: `swarm/src/containers.test.ts`
- Modify: `swarm/src/server.ts` (add routes next to the `/cli-tools` block, ~1682)

**Interfaces:**
- Produces: `ContainersFile = { version: 1; docker: { enabled: boolean } }`; `loadContainersFile(path)`, `saveContainersFile(path, file)`, `emptyContainersFile()`, `probeDocker(run?)`; HTTP `GET /containers` → `ContainersFile`, `PUT /containers {docker:{enabled:boolean}}` → `ContainersFile`, `POST /containers/verify` → `{ ok: boolean; detail: string }`.
- Consumes: `CommandRunner` from `swarm/src/drivers/types.ts` (same probe seam cli-tools drivers use).

- [ ] **Step 1: Write the failing tests**

`swarm/src/containers.test.ts` (mirror `cli-tools.test.ts` file-handling tests):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyContainersFile, loadContainersFile, saveContainersFile, probeDocker } from './containers.js';

test('missing or corrupt file loads as disabled-docker default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'containers-'));
  assert.deepEqual(await loadContainersFile(join(dir, 'nope.json')), emptyContainersFile());
});

test('save/load round-trip preserves enabled flag', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'containers-'));
  const path = join(dir, 'containers.json');
  await saveContainersFile(path, { version: 1, docker: { enabled: true } });
  assert.equal((await loadContainersFile(path)).docker.enabled, true);
});

test('probeDocker reports ok with server version, and failure as unreachable', async () => {
  const ok = await probeDocker(async () => ({ stdout: '27.0.1\n', stderr: '' }));
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /27\.0\.1/);
  const bad = await probeDocker(async () => { throw new Error('Cannot connect to the Docker daemon'); });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /daemon/i);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd swarm && node --import tsx --test src/containers.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `swarm/src/containers.ts`**

```ts
// Containers registry — machine-level container-provider enablement (spec:
// docs/superpowers/specs/2026-08-07-session-creation-and-execution-mode-design.md §2).
// Shaped as a provider map's first row (docker) so future providers are new
// keys, not a redesign. Same machine-fact storage discipline as cli-tools.ts.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CommandRunner } from './drivers/types.js';

export interface ContainersFile {
  version: 1;
  docker: { enabled: boolean };
}

export function emptyContainersFile(): ContainersFile {
  return { version: 1, docker: { enabled: false } };
}

export async function loadContainersFile(path: string): Promise<ContainersFile> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as ContainersFile;
    if (parsed?.version === 1 && typeof parsed.docker?.enabled === 'boolean') return parsed;
    return emptyContainersFile();
  } catch {
    return emptyContainersFile();
  }
}

export async function saveContainersFile(path: string, file: ContainersFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const fh = await open(path, 'w', 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(file, null, 2)}\n`);
  } finally {
    await fh.close();
  }
}

const defaultRunner: CommandRunner = async (cmd, args) => {
  const { stdout, stderr } = await promisify(execFile)(cmd, args, { timeout: 5000 });
  return { stdout, stderr };
};

/** Diagnostic only — enabling docker never requires a passing probe (spec §2). */
export async function probeDocker(run: CommandRunner = defaultRunner): Promise<{ ok: boolean; detail: string }> {
  try {
    const { stdout } = await run('docker', ['info', '--format', '{{.ServerVersion}}']);
    return { ok: true, detail: `daemon running (server ${stdout.trim()})` };
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    return { ok: false, detail: /ENOENT/.test(msg) ? 'docker binary not found on PATH' : 'docker daemon unreachable — is Docker running?' };
  }
}
```

If `CommandRunner`'s actual signature in `drivers/types.ts` differs (check it), adapt the runner param to that exact type — do not invent a parallel type.

- [ ] **Step 4: Add routes in `server.ts`** (immediately after the `/cli-tools` block):

```ts
// ── Containers (Settings → Workspace → Containers; spec 2026-08-07) ────
const containersPath = () => resolve(process.cwd(), '.smith/containers.json');

this.app.get('/containers', async () => await loadContainersFile(containersPath()));

this.app.put('/containers', async (req, reply) => {
  const b = req.body as { docker?: { enabled?: boolean } };
  if (typeof b?.docker?.enabled !== 'boolean') {
    return reply.status(400).send({ error: 'body must be { docker: { enabled: boolean } }' });
  }
  const file = await loadContainersFile(containersPath());
  file.docker.enabled = b.docker.enabled;
  await saveContainersFile(containersPath(), file);
  return file;
});

this.app.post('/containers/verify', async () => await probeDocker());
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd swarm && node --import tsx --test src/containers.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add swarm/src/containers.ts swarm/src/containers.test.ts swarm/src/server.ts
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(swarm): containers machine setting + docker probe routes"
```

---

### Task 4: swarm — `GET /execution-modes` availability

**Files:**
- Modify: `swarm/src/containers.ts` (add pure helper), `swarm/src/server.ts` (route)
- Test: `swarm/src/containers.test.ts`

**Interfaces:**
- Produces: `buildExecutionModes(dockerEnabled: boolean, workerRuntimes: Array<Array<'tmux' | 'docker'>>): Record<ExecutionModeId, boolean>`; `ExecutionModeId` union (same four strings as Global Constraints); HTTP `GET /execution-modes` → `{ modes: Record<ExecutionModeId, boolean> }`.
- Consumes: `server.workerPool.listWorkers()` (existing; each has `runtimes`), `loadContainersFile` (Task 3).

- [ ] **Step 1: Write the failing test** (in `containers.test.ts`):

```ts
test('buildExecutionModes gates by docker toggle and worker advertisement', () => {
  assert.deepEqual(buildExecutionModes(false, []), {
    'local-in-process': true,
    'local-docker': false,
    'remote-in-process': false,
    'remote-docker': false,
  });
  assert.deepEqual(buildExecutionModes(true, [['tmux'], ['docker']]), {
    'local-in-process': true,
    'local-docker': true,
    'remote-in-process': true,
    'remote-docker': true,
  });
  assert.equal(buildExecutionModes(true, [['tmux']])['remote-docker'], false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd swarm && node --import tsx --test src/containers.test.ts`
Expected: FAIL — `buildExecutionModes` not exported.

- [ ] **Step 3: Implement** (in `containers.ts`):

```ts
export type ExecutionModeId = 'local-in-process' | 'local-docker' | 'remote-in-process' | 'remote-docker';

/** Availability = the same data routing uses (spec §2): toggle for docker, advertisement for remote. */
export function buildExecutionModes(
  dockerEnabled: boolean,
  workerRuntimes: Array<Array<'tmux' | 'docker'>>,
): Record<ExecutionModeId, boolean> {
  return {
    'local-in-process': true,
    'local-docker': dockerEnabled,
    'remote-in-process': workerRuntimes.some((r) => r.includes('tmux')),
    'remote-docker': workerRuntimes.some((r) => r.includes('docker')),
  };
}
```

Route in `server.ts` (next to `/containers`):

```ts
this.app.get('/execution-modes', async () => {
  const file = await loadContainersFile(containersPath());
  return { modes: buildExecutionModes(file.docker.enabled, server.workerPool.listWorkers().map((w) => w.runtimes)) };
});
```

- [ ] **Step 4: Run tests + typecheck + full suite**

Run: `cd swarm && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add swarm/src/containers.ts swarm/src/containers.test.ts swarm/src/server.ts
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(swarm): GET /execution-modes capability gating"
```

---

### Task 5: broker — `ExecutionMode` on sessions, lazy init, zero-session accessors

**Files:**
- Modify: `broker/src/sessions.ts`
- Test: `broker/src/sessions.test.ts`

**Interfaces:**
- Produces: `ExecutionMode` union (the four strings); `truncateTitle(text: string): string`; `resolveLazyWorkspace(origin: string | undefined, attendedDiscordWorkspace: string | null, defaultWorkspace: string): string`; `Session.runtime: ExecutionMode` + `Session.awaitingTitle?: boolean`; `SessionSummary.runtime: ExecutionMode`; `SessionManager.init(): Session | null` (no params, never creates); `create(workspace: string, opts?: { title?: string; runtime?: ExecutionMode; awaitingTitle?: boolean }): Session`; `activeOrNull(): Session | null`; `hasActive(): boolean`; `retitle(id: string, title: string): boolean`; `resetAll(): void` (clears, creates nothing).
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests** (add to `sessions.test.ts`, using its existing fake-store pattern):

```ts
test('init with an empty store returns null and creates nothing', () => {
  const mgr = new SessionManager(memoryStore());
  assert.equal(mgr.init(), null);
  assert.equal(mgr.hasActive(), false);
  assert.equal(mgr.activeOrNull(), null);
  assert.deepEqual(mgr.list(), []);
});

test('legacy persisted sessions without runtime read as local-in-process', () => {
  const store = memoryStore();
  store.save({ id: 's1', title: 'old', workspace: 'w', createdAt: T, updatedAt: T, transcript: [], brainHistory: [] } as never);
  const mgr = new SessionManager(store);
  mgr.init();
  assert.equal(mgr.list()[0].runtime, 'local-in-process');
});

test('create carries runtime and truncated title; retitle applies exactly once', () => {
  const mgr = new SessionManager(memoryStore());
  const s = mgr.create('w', { runtime: 'remote-docker', title: truncateTitle('fix the flaky deploy pipeline that keeps timing out on arm builds'), awaitingTitle: true });
  assert.equal(s.runtime, 'remote-docker');
  assert.equal(s.title.length <= 40, true);
  assert.equal(s.title.endsWith('…'), true);
  assert.equal(mgr.retitle(s.id, 'Flaky deploy pipeline'), true);
  assert.equal(mgr.retitle(s.id, 'Second try'), false);
  assert.equal(mgr.activeOrNull()?.title, 'Flaky deploy pipeline');
});

test('truncateTitle collapses whitespace and caps at 40 chars', () => {
  assert.equal(truncateTitle('  hello   world  '), 'hello world');
  assert.equal(truncateTitle(''), 'New session');
  assert.equal(truncateTitle('x'.repeat(60)).length, 40);
});

test('resetAll leaves zero sessions', () => {
  const mgr = new SessionManager(memoryStore());
  mgr.create('w', { runtime: 'local-in-process' });
  mgr.resetAll();
  assert.equal(mgr.hasActive(), false);
  assert.deepEqual(mgr.list(), []);
});

test('resolveLazyWorkspace: discord lands in the attended workspace, everything else in the default', () => {
  assert.equal(resolveLazyWorkspace('discord', 'acme', 'main'), 'acme');
  assert.equal(resolveLazyWorkspace('discord', null, 'main'), 'main');
  assert.equal(resolveLazyWorkspace(undefined, 'acme', 'main'), 'main');
  assert.equal(resolveLazyWorkspace('stdin', 'acme', 'main'), 'main');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd broker && node --import tsx --test src/sessions.test.ts`
Expected: FAIL on every new test.

- [ ] **Step 3: Implement** in `sessions.ts`:

```ts
export type ExecutionMode = 'local-in-process' | 'local-docker' | 'remote-in-process' | 'remote-docker';

const LEGACY_MODE: ExecutionMode = 'local-in-process';

/** Collapse whitespace, cap at 40 chars with an ellipsis (spec §3). */
export function truncateTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return 'New session';
  return clean.length <= 40 ? clean : `${clean.slice(0, 39).trimEnd()}…`;
}
```

`Session` gains `runtime: ExecutionMode;` and `/** True while the brain still owes this session its one post-first-reply retitle. */ awaitingTitle?: boolean;`. `SessionSummary` gains `runtime: ExecutionMode;`.

`init()` — drop the parameter and the create fallback:

```ts
/** Load persisted sessions; activate the most recent if any exist. NEVER creates (spec §4b). */
init(): Session | null {
  for (const s of this.store.loadAll()) {
    s.runtime ??= LEGACY_MODE;
    this.sessions.set(s.id, s);
    this.seq = Math.max(this.seq, Number(/^s(\d+)$/.exec(s.id)?.[1] ?? 0));
  }
  const latest = [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
  this.activeId = latest?.id ?? '';
  return latest;
}
```

`create` (replaces the old `(workspace, title?)` signature):

```ts
create(workspace: string, opts?: { title?: string; runtime?: ExecutionMode; awaitingTitle?: boolean }): Session {
  this.seq += 1;
  const session: Session = {
    id: `s${this.seq}`,
    title: opts?.title?.trim() || `Session ${this.seq}`,
    workspace,
    runtime: opts?.runtime ?? LEGACY_MODE,
    awaitingTitle: opts?.awaitingTitle,
    createdAt: this.now(),
    updatedAt: this.now(),
    transcript: [],
    brainHistory: [],
  };
  this.sessions.set(session.id, session);
  this.activeId = session.id;
  this.store.save(session);
  return session;
}
```

New accessors + retitle + resetAll:

```ts
hasActive(): boolean {
  return this.sessions.has(this.activeId);
}

activeOrNull(): Session | null {
  return this.sessions.get(this.activeId) ?? null;
}

/** Apply the brain's one-time title. Returns false if this session isn't owed one. */
retitle(id: string, title: string): boolean {
  const session = this.sessions.get(id);
  if (!session?.awaitingTitle) return false;
  session.title = title;
  session.awaitingTitle = undefined;
  session.updatedAt = this.now();
  this.store.save(session);
  return true;
}

/** Wipe every conversation. Creates nothing — the UI lands on the composer (spec §4b). */
resetAll(): void {
  this.sessions.clear();
  this.activeId = '';
  this.seq = 0;
}
```

Module-level, next to `truncateTitle` (spec §4b's channel rule, pinned by a test because its only caller is untestable `main.ts`):

```ts
/** Which workspace a lazily-created session lands in: discord = the attended workspace, every other origin = the default workspace. */
export function resolveLazyWorkspace(
  origin: string | undefined,
  attendedDiscordWorkspace: string | null,
  defaultWorkspace: string,
): string {
  return origin === 'discord' ? (attendedDiscordWorkspace ?? defaultWorkspace) : defaultWorkspace;
}
```

`list()` adds `runtime: s.runtime` to the mapped summary. Keep `active()` throwing as-is (remaining callers are updated in Task 8; by then every caller guards with `hasActive()`).

- [ ] **Step 4: Run tests**

Run: `cd broker && node --import tsx --test src/sessions.test.ts`
Expected: new tests PASS; any old test asserting "init creates Session 1" or `resetAll` returning a session now fails — rewrite those old tests to pin the new lazy behavior (they contradict the spec).

- [ ] **Step 5: Typecheck** — `cd broker && npm run typecheck` will FAIL in `main.ts`/`text-channel.ts` (old `init(name)`/`create(ws, title)` callers). That is expected mid-plan; do NOT patch main.ts here (Task 8 owns it). Only `sessions.ts` + its test must be green: `node --import tsx --test src/sessions.test.ts`.

- [ ] **Step 6: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add broker/src/sessions.ts broker/src/sessions.test.ts
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(broker): session-level ExecutionMode, lazy init, zero-session accessors"
```

---

### Task 6: broker — brain retitle helper + deterministic context seed

**Files:**
- Create: `broker/src/session-title.ts`
- Create: `broker/src/session-title.test.ts`
- Modify: `broker/src/brain.ts` (add `seedContext`)
- Test: `broker/src/brain.test.ts` (add one case; create the file only if it doesn't exist — check first)

**Interfaces:**
- Consumes: `StreamFactory`, `BrainStreamLike` from `brain.ts` (a stream has `.on('text', cb)` and `.finalMessage(): Promise<{content: Block[]; stop_reason: …}>`).
- Produces: `generateSessionTitle(streamFactory: StreamFactory, model: string, firstUserText: string, firstReply: string): Promise<string | null>`; `BrokerBrain.seedContext(note: string): void`.

- [ ] **Step 1: Write the failing tests**

`broker/src/session-title.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSessionTitle } from './session-title.js';

const fakeStream = (text: string) => ({
  on() {},
  finalMessage: async () => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }),
});

test('returns a cleaned single-line title', async () => {
  const title = await generateSessionTitle((() => fakeStream('  "Fix deploy pipeline."  ')) as never, 'm', 'u', 'r');
  assert.equal(title, 'Fix deploy pipeline');
});

test('returns null when the stream factory throws', async () => {
  const title = await generateSessionTitle((() => { throw new Error('boom'); }) as never, 'm', 'u', 'r');
  assert.equal(title, null);
});
```

Brain seed test (in `brain.test.ts`, following that file's existing BrokerBrain construction pattern):

```ts
test('seedContext pushes a user/assistant pair without any API call', () => {
  const factory = mock.fn(); // must never be called
  const brain = new BrokerBrain(factory as never, fakeExecutors);
  brain.seedContext('workspace "acme": builds the acme app\nlinks:\nhttps://acme.dev');
  const h = brain.exportHistory();
  assert.equal(h.length, 2);
  assert.match(String(h[0].content), /workspace context.*acme/s);
  assert.equal(h[1].role, 'assistant');
  assert.equal(factory.mock.callCount(), 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd broker && node --import tsx --test src/session-title.test.ts src/brain.test.ts`
Expected: FAIL — module/method missing.

- [ ] **Step 3: Implement**

`broker/src/session-title.ts`:

```ts
// One background call after a session's first reply names it (spec §3:
// "truncate now, brain retitles once"). Failure is silent — the truncated
// title simply stays; naming must never break a conversation.
import type { StreamFactory } from './brain.ts';

const SYSTEM =
  'You name chat sessions. Reply with ONLY a 2-6 word title for the conversation excerpt. No quotes, no trailing punctuation, no explanation.';

export async function generateSessionTitle(
  streamFactory: StreamFactory,
  model: string,
  firstUserText: string,
  firstReply: string,
): Promise<string | null> {
  try {
    const stream = streamFactory({
      model,
      max_tokens: 30,
      system: SYSTEM,
      messages: [{ role: 'user', content: `User: ${firstUserText.slice(0, 600)}\n\nAssistant: ${firstReply.slice(0, 600)}` }],
      tools: [],
    });
    const final = await stream.finalMessage();
    const text = final.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
      .map((b) => b.text)
      .join(' ');
    const clean = text.replace(/\s+/g, ' ').replace(/^["'\s]+|["'.\s]+$/g, '').trim();
    if (!clean) return null;
    return clean.length <= 60 ? clean : `${clean.slice(0, 59).trimEnd()}…`;
  } catch {
    return null;
  }
}
```

If `StreamFactory`'s params type marks `tools` as the concrete `TOOLS` type rather than an array type, loosen nothing in `brain.ts` — pass `tools: []` with a cast (`[] as never`) and note why inline is unnecessary; check what compiles cleanly first.

`brain.ts` — add below `exportHistory`:

```ts
/** Deterministic session-birth context (workspace description + links) — no API call (spec §3). */
seedContext(note: string): void {
  this.history.push({ role: 'user', content: `[workspace context — not the human speaking] ${note}` });
  this.history.push({ role: 'assistant', content: 'Noted.' });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd broker && node --import tsx --test src/session-title.test.ts src/brain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add broker/src/session-title.ts broker/src/session-title.test.ts broker/src/brain.ts broker/src/brain.test.ts
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(broker): brain retitle helper + deterministic workspace-context seed"
```

---

### Task 7: broker — execution-mode seam + swarm-client additions

**Files:**
- Create: `broker/src/execution-modes.ts`
- Modify: `broker/src/swarm-client.ts` (`WorkspaceBody` ~line 90, `submitTask` ~line 190, new methods near `listWorkspaces` ~line 339)
- Test: `broker/src/swarm-client.test.ts`, plus a small `broker/src/execution-modes.test.ts`

**Interfaces:**
- Produces: `EXEC_TO_RUNTIME: Record<ExecutionMode, 'tmux' | 'docker' | 'remote-tmux' | 'remote-docker'>`; `isExecutionMode(v: unknown): v is ExecutionMode`; `SwarmClient.executionModes(): Promise<Record<string, boolean>>`; `SwarmClient.containers()`, `setContainers(dockerEnabled: boolean)`, `verifyContainers()`; `submitTask` accepts `runtime?: string` and sends it as the POST `/tasks` body's `runtime`; `WorkspaceBody` drops `runtime`, gains `links?: string[]`.
- Consumes: `ExecutionMode` from `sessions.ts` (Task 5); swarm routes from Tasks 3-4.

- [ ] **Step 1: Write the failing tests**

`broker/src/execution-modes.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXEC_TO_RUNTIME, isExecutionMode } from './execution-modes.js';

test('mapping matches the spec seam exactly', () => {
  assert.deepEqual(EXEC_TO_RUNTIME, {
    'local-in-process': 'tmux',
    'local-docker': 'docker',
    'remote-in-process': 'remote-tmux',
    'remote-docker': 'remote-docker',
  });
});

test('isExecutionMode guards strings', () => {
  assert.equal(isExecutionMode('remote-docker'), true);
  assert.equal(isExecutionMode('tmux'), false);
  assert.equal(isExecutionMode(42), false);
});
```

In `swarm-client.test.ts` (follow its existing fetch-stub pattern): assert `submitTask({ …, runtime: 'remote-docker' })` sends body with `runtime: 'remote-docker'`; assert `executionModes()` GETs `/execution-modes` and unwraps `modes`; assert `setContainers(true)` PUTs `{ docker: { enabled: true } }` to `/containers`.

- [ ] **Step 2: Run to verify failure**

Run: `cd broker && node --import tsx --test src/execution-modes.test.ts src/swarm-client.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`broker/src/execution-modes.ts`:

```ts
// The broker↔swarm seam for execution modes (spec §1): sessions speak
// ExecutionMode, swarm speaks RuntimeType, and this map is the only place
// the two vocabularies meet.
import type { ExecutionMode } from './sessions.ts';

export const EXEC_TO_RUNTIME: Record<ExecutionMode, 'tmux' | 'docker' | 'remote-tmux' | 'remote-docker'> = {
  'local-in-process': 'tmux',
  'local-docker': 'docker',
  'remote-in-process': 'remote-tmux',
  'remote-docker': 'remote-docker',
};

export function isExecutionMode(v: unknown): v is ExecutionMode {
  return typeof v === 'string' && v in EXEC_TO_RUNTIME;
}
```

`swarm-client.ts`:
- `WorkspaceBody`: delete the `runtime?:` member and its comment; add `links?: string[];`.
- `submitTask` request type gains `runtime?: string;` and the body gains `runtime: req.runtime,`.
- New methods:

```ts
async executionModes(): Promise<Record<string, boolean>> {
  const r = await this.http('GET', '/execution-modes');
  return (r.modes as Record<string, boolean>) ?? {};
}

async containers(): Promise<{ version: 1; docker: { enabled: boolean } }> {
  return (await this.http('GET', '/containers')) as never;
}

async setContainers(dockerEnabled: boolean): Promise<{ version: 1; docker: { enabled: boolean } }> {
  return (await this.http('PUT', '/containers', { docker: { enabled: dockerEnabled } })) as never;
}

async verifyContainers(): Promise<{ ok: boolean; detail: string }> {
  return (await this.http('POST', '/containers/verify', {})) as never;
}
```

- [ ] **Step 4: Run tests**

Run: `cd broker && node --import tsx --test src/execution-modes.test.ts src/swarm-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add broker/src/execution-modes.ts broker/src/execution-modes.test.ts broker/src/swarm-client.ts broker/src/swarm-client.test.ts
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(broker): execution-mode seam map + swarm-client modes/containers/runtime"
```

---

### Task 8: broker — text-channel protocol (session:null frame, atomic create route, passthroughs)

**Files:**
- Modify: `broker/src/text-channel.ts` (frame union ~line 46, `sessions` dep ~line 144, session route ~line 799, passthrough blocks ~line 722)
- Test: `broker/src/text-channel.test.ts` (extend; if absent, add cases to whatever file currently tests these routes — find with `grep -rln "sessionMatch\|'/sessions'" broker/src/*.test.ts`)

**Interfaces:**
- Produces (wire protocol): session frame `{ type: 'session'; session: { id; title; workspace; runtime: string } | null; sessions: Array<{ id; title; workspace; updatedAt; active; runtime: string }>; transcript; workspaces }`; `POST /sessions` body `{ workspace?: string; runtime?: string; prompt?: string }` → `200 {ok:true}` | `4xx {error}` (status from handler); passthrough `GET /execution-modes`, `GET /containers`, `PUT /containers` (origin-restricted exactly like the cli-tools PUT), `POST /containers/verify`.
- Produces (dep contracts for main.ts): `sessions.create(body: { workspace?: string; runtime?: string; prompt?: string }): Promise<{ error: string; status?: number } | null>`; `sessions.activate(id): string | null` (unchanged); new constructor dep `execModes?: { list(): Promise<Record<string, boolean>> }`; new dep `containers?: { get(): Promise<unknown>; set(enabled: boolean): Promise<unknown>; verify(): Promise<unknown> }`.
- Consumes: nothing from swarm directly — main.ts injects the swarm-client calls (Task 9).

- [ ] **Step 1: Write the failing tests.** `text-channel.test.ts` boots a real `TextChannel` on a port and drives it with `fetch` — reuse its existing construction helper (~line 72) and add the new deps in the same positional/options style the constructor uses:

```ts
test('POST /sessions forwards {workspace, runtime, prompt} and maps the handler status', async () => {
  const calls: unknown[] = [];
  const channel = makeChannel({
    sessions: {
      create: async (body: unknown) => {
        calls.push(body);
        return (body as { runtime?: string }).runtime === 'remote-docker'
          ? { error: 'execution mode "remote-docker" is not available', status: 409 }
          : null;
      },
      activate: () => null,
    },
  });
  const port = await channel.listen(0);
  const ok = await fetch(`http://127.0.0.1:${port}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'acme', runtime: 'local-in-process', prompt: 'fix the build' }),
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(calls[0], { workspace: 'acme', runtime: 'local-in-process', prompt: 'fix the build' });
  const conflict = await fetch(`http://127.0.0.1:${port}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'acme', runtime: 'remote-docker', prompt: 'x' }),
  });
  assert.equal(conflict.status, 409);
  assert.match(((await conflict.json()) as { error: string }).error, /not available/);
  channel.close();
});

test('the session frame type accepts session: null with an empty transcript', () => {
  const channel = makeChannel({});
  // Compile-time pin for the lockstep protocol: this call must typecheck.
  channel.broadcast({ type: 'session', session: null, sessions: [], transcript: [], workspaces: [] });
  channel.close();
});

test('execution-modes and containers routes pass through their deps', async () => {
  const channel = makeChannel({
    execModes: { list: async () => ({ 'local-in-process': true, 'local-docker': false, 'remote-in-process': false, 'remote-docker': false }) },
    containers: {
      get: async () => ({ version: 1, docker: { enabled: false } }),
      set: async (enabled: boolean) => ({ version: 1, docker: { enabled } }),
      verify: async () => ({ ok: false, detail: 'docker daemon unreachable — is Docker running?' }),
    },
  });
  const port = await channel.listen(0);
  const modes = (await (await fetch(`http://127.0.0.1:${port}/execution-modes`)).json()) as { modes: Record<string, boolean> };
  assert.equal(modes.modes['local-in-process'], true);
  const put = await fetch(`http://127.0.0.1:${port}/containers`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN }, // same allowed-origin constant the cli-tools PUT tests use
    body: JSON.stringify({ docker: { enabled: true } }),
  });
  assert.equal(put.status, 200);
  const badOrigin = await fetch(`http://127.0.0.1:${port}/containers`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ docker: { enabled: true } }),
  });
  assert.equal(badOrigin.status, 403); // match the exact refusal status the cli-tools PUT tests assert
  channel.close();
});
```

`makeChannel` here stands for the file's existing channel-construction helper — extend that helper with the two new optional deps rather than inventing a second one. Copy the allowed-origin constant and refusal-status assertions from the existing cli-tools PUT tests so the containers guard is pinned to identical behavior.

- [ ] **Step 2: Run to verify failure**

Run: `cd broker && node --import tsx --test src/text-channel.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Frame union (line ~46): `session:` member becomes `{ id: string; title: string; workspace: string; runtime: string } | null`; the `sessions` array row type gains `runtime: string`.
- `sessions` dep type (line ~145):

```ts
private readonly sessions?: {
  create(body: { workspace?: string; runtime?: string; prompt?: string }): Promise<{ error: string; status?: number } | null>;
  activate(id: string): string | null;
};
```

- Session route (line ~799): keep the regex; the create arm becomes async:

```ts
req.on('end', () => {
  let parsed: { workspace?: unknown; runtime?: unknown; prompt?: unknown } = {};
  try {
    parsed = JSON.parse(body || '{}') as typeof parsed;
  } catch {
    /* empty body is fine */
  }
  if (sessionMatch[1]) {
    const error = this.sessions!.activate(decodeURIComponent(sessionMatch[1]));
    res.writeHead(error ? 400 : 200, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify(error ? { error } : { ok: true }));
    return;
  }
  void this.sessions!.create({
    workspace: typeof parsed.workspace === 'string' ? parsed.workspace : undefined,
    runtime: typeof parsed.runtime === 'string' ? parsed.runtime : undefined,
    prompt: typeof parsed.prompt === 'string' ? parsed.prompt : undefined,
  }).then((r) => {
    res.writeHead(r ? (r.status ?? 400) : 200, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify(r ? { error: r.error } : { ok: true }));
  });
});
```

- Passthroughs: copy the `/cli-tools` block's shape (line ~722) for `GET /execution-modes` → `this.execModes.list()`, `GET /containers` → `this.containers.get()`, `PUT /containers` → `this.containers.set(body.docker.enabled)` with the SAME origin restriction the cli-tools PUT uses (copy that guard verbatim), `POST /containers/verify` → `this.containers.verify()`.
- Constructor: add the two new optional deps in the same style/position as `cliTools`.

- [ ] **Step 4: Run tests + typecheck** — `text-channel.test.ts` green; `npm run typecheck` still red only in `main.ts` (fixed next task).

- [ ] **Step 5: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add broker/src/text-channel.ts broker/src/text-channel.test.ts
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(broker): session:null frame, atomic POST /sessions, modes/containers passthrough"
```

---

### Task 9: broker — main.ts wiring (lazy creation everywhere, retitle, delegation stamping)

**Files:**
- Modify: `broker/src/main.ts` (sessionFrame ~527, handleUserText ~514, sessions handler ~930, reset handler ~955, boot init ~1179, refreshWorkspaceNames ~539, textChannel construction, Broker deps)
- Modify: `broker/src/broker.ts` (`dispatchWork` ~228, deps interface)
- Test: `broker/src/broker.test.ts` (dispatch stamping; find the existing dispatchWork tests with `grep -n "dispatchWork" broker/src/*.test.ts`)

**Interfaces:**
- Consumes: everything produced by Tasks 5-8.
- Produces: `Broker` deps gain `sessionRuntime?: () => string | undefined`; `dispatchWork` passes `runtime: this.deps.sessionRuntime?.()` into `swarm.submitTask`. main.ts-internal: `startSession(workspace: string, opts: { runtime: ExecutionMode; title: string; awaitingTitle?: boolean }): Session`, `switchDiscord(ws: string): void`, `let attendedDiscordWorkspace`, `let defaultWorkspaceName`, `let workspaceRecords: SwarmWorkspace[]`.

- [ ] **Step 1: Write the failing test** — `broker.test.ts` builds brokers as `new Broker({ ...basicDeps(fakeSwarm, directory), extraDep })` (~line 89); its fake swarm records `submitTask` calls. Add:

```ts
test('dispatchWork stamps the active session runtime onto the submitted task', async () => {
  const f = fakeSwarm(); // the file's existing recording fake
  const b = new Broker({ ...basicDeps(f, directoryWithIdleAgent('wilkin')), sessionRuntime: () => 'remote-docker' });
  await b.dispatchWork({ agent: 'wilkin', task: 'fix the build' });
  assert.equal(f.submitTaskCalls[0].runtime, 'remote-docker');
});

test('dispatchWork omits runtime when no session is active', async () => {
  const f = fakeSwarm();
  const b = new Broker({ ...basicDeps(f, directoryWithIdleAgent('wilkin')), sessionRuntime: () => undefined });
  await b.dispatchWork({ agent: 'wilkin', task: 'fix the build' });
  assert.equal(f.submitTaskCalls[0].runtime, undefined);
});
```

(`fakeSwarm`/`directoryWithIdleAgent` stand for the file's actual fixture helpers — reuse whatever the existing `dispatchWork` tests use to get an idle, delegable agent; do not build a parallel fixture.)

- [ ] **Step 2: Run to verify failure** — `cd broker && node --import tsx --test src/broker.test.ts`.

- [ ] **Step 3: Implement `broker.ts`**

Deps interface gains:

```ts
/** Mapped RuntimeType of the active session (EXEC_TO_RUNTIME applied by main.ts); undefined = no session, server default applies. */
sessionRuntime?: () => string | undefined;
```

`dispatchWork`'s `submitTask` call adds `runtime: this.deps.sessionRuntime?.(),`.

- [ ] **Step 4: Implement `main.ts`** — the changes, in file order:

**Workspace record cache** — `refreshWorkspaceNames` keeps full records (it already fetches them):

```ts
let workspaceRecords: SwarmWorkspace[] = [];
let defaultWorkspaceName = 'default';

async function refreshWorkspaceNames(): Promise<void> {
  const all = await swarm.listWorkspaces().catch(() => []);
  workspaceRecords = all.filter((w) => !w.archived);
  workspaceNames = workspaceRecords.map((w) => w.name);
  defaultWorkspaceName = workspaceRecords.find((w) => w.default)?.name ?? workspaceNames[0] ?? 'default';
  await broker.refreshWorkspaces();
  textChannel.broadcast(sessionFrame());
}
```

**Discord attendance tracking** — one wrapper replaces the three inline `switchDiscordForWorkspace` call sites (create/activate/reset) and the boot call:

```ts
let attendedDiscordWorkspace: string | null = null;
function switchDiscord(workspaceName: string): void {
  attendedDiscordWorkspace = workspaceName;
  void discordWorkspaceSwitcher
    .switchDiscordForWorkspace(workspaceName)
    .catch((err: unknown) => console.error(`[discord] workspace switch failed for "${workspaceName}": ${String(err)}`));
}
```

**Null-tolerant frame:**

```ts
function sessionFrame() {
  const s = sessionManager.activeOrNull();
  return {
    type: 'session' as const,
    session: s ? { id: s.id, title: s.title, workspace: s.workspace, runtime: s.runtime } : null,
    sessions: sessionManager.list(),
    transcript: (s?.transcript ?? []).map((t) => ({ role: t.role, text: t.text })),
    workspaces: workspaceNames,
  };
}
```

**Session birth core** (used by the HTTP route and lazy creation):

```ts
function startSession(workspace: string, opts: { runtime: ExecutionMode; title: string; awaitingTitle?: boolean }): Session {
  const s = sessionManager.create(workspace, { ...opts });
  brain.loadHistory(s.brainHistory);
  const rec = workspaceRecords.find((w) => w.name === workspace);
  if (rec?.description || rec?.links?.length) {
    const links = rec.links?.length ? `\nlinks:\n${rec.links.join('\n')}` : '';
    brain.seedContext(`workspace "${workspace}": ${rec.description ?? ''}${links}`);
    sessionManager.saveBrainHistory(brain.exportHistory());
  }
  switchDiscord(workspace);
  textChannel.broadcast(sessionFrame());
  return s;
}
```

**Lazy creation in `handleUserText`** (spec: voice → default workspace; Discord → attended workspace). Check `TurnOrigin`'s actual literal for Discord (`grep -n "TurnOrigin" broker/src/*.ts`) and use it verbatim:

```ts
function handleUserText(text: string, origin?: TurnOrigin): void {
  if (origin) textChannel.broadcast({ type: 'utterance', text });
  if (!sessionManager.hasActive()) {
    const workspace = resolveLazyWorkspace(origin, attendedDiscordWorkspace, defaultWorkspaceName);
    startSession(workspace, { runtime: 'local-in-process', title: truncateTitle(text), awaitingTitle: true });
  }
  sessionManager.appendTranscript('user', text);
  void broker.handleUtterance(text, origin).then(async () => {
    sessionManager.saveBrainHistory(brain.exportHistory());
    await maybeRetitle();
  });
}

/** One-shot post-first-reply rename (spec §3); silent on failure. */
async function maybeRetitle(): Promise<void> {
  const s = sessionManager.activeOrNull();
  if (!s?.awaitingTitle) return;
  const firstUser = s.transcript.find((t) => t.role === 'user')?.text ?? '';
  const firstReply = s.transcript.find((t) => t.role === 'broker')?.text ?? '';
  if (!firstReply) return; // no reply landed yet — the next turn retries
  const title = await generateSessionTitle(streamFactory, 'claude-haiku-4-5', firstUser, firstReply);
  if (title && sessionManager.retitle(s.id, title)) textChannel.broadcast(sessionFrame());
}
```

**The sessions handler** (replaces the current `create`/`activate` object ~line 930 — note the old `broker.announce` greeting is deleted: the prompt itself now drives the first reply):

```ts
{
  create: async (body) => {
    const workspace = body.workspace;
    const prompt = body.prompt?.trim() ?? '';
    if (!workspace || !workspaceNames.includes(workspace)) return { error: `unknown workspace: ${body.workspace ?? '(none)'}` };
    if (!prompt) return { error: 'prompt is required' };
    if (!isExecutionMode(body.runtime)) return { error: `runtime must be one of: ${Object.keys(EXEC_TO_RUNTIME).join(', ')}` };
    const modes = await swarm.executionModes().catch(() => null);
    if (modes && modes[body.runtime] === false) {
      return { error: `execution mode "${body.runtime}" is not available`, status: 409 };
    }
    startSession(workspace, { runtime: body.runtime, title: truncateTitle(prompt), awaitingTitle: true });
    textChannel.broadcast({ type: 'utterance', text: prompt }); // entry-point broadcast, same as POST /utterance
    handleUserText(prompt);
    return null;
  },
  activate: (id) => {
    const s = sessionManager.activate(id);
    if (!s) return `unknown session: ${id}`;
    brain.loadHistory(s.brainHistory);
    switchDiscord(s.workspace);
    textChannel.broadcast(sessionFrame());
    return null;
  },
},
```

**Reset handler** (~line 968): `sessionManager.resetAll()` (no return value now); then `brain.loadHistory([]); switchDiscord(defaultWorkspaceName);` and keep the frame broadcasts. Delete the `fresh` variable and its comment block's stale parts.

**Boot** (~line 1179):

```ts
const activeSession = sessionManager.init(); // Session | null — zero sessions is legal (spec §4b)
```

Where boot code currently uses `activeSession` unconditionally (brain history load, initial Discord switch — read the surrounding lines), guard: `if (activeSession) { brain.loadHistory(activeSession.brainHistory); switchDiscord(activeSession.workspace); } else { switchDiscord(bootWorkspaces.find((w) => w.default)?.name ?? bootWorkspaces[0]?.name ?? 'default'); }` — and seed `defaultWorkspaceName`/`workspaceRecords` from `bootWorkspaces` at the same spot.

**textChannel construction:** pass the new deps —
`execModes: { list: () => swarm.executionModes() }` and
`containers: { get: () => swarm.containers(), set: (enabled) => swarm.setContainers(enabled), verify: () => swarm.verifyContainers() }`.

**Broker construction:** add `sessionRuntime: () => { const s = sessionManager.activeOrNull(); return s ? EXEC_TO_RUNTIME[s.runtime] : undefined; }`.

**Guard sweep:** `grep -n "sessionManager.active()" broker/src/main.ts` — every remaining call site must either be inside a path that just ensured a session (`handleUserText` after lazy create) or be rewritten to `activeOrNull()` with a null guard. The old `create: (title, workspace)` handler's `sessionManager.active().workspace` fallback is gone with the handler.

Imports to add in main.ts: `truncateTitle`, `resolveLazyWorkspace`, `type ExecutionMode` from `./sessions.ts`; `EXEC_TO_RUNTIME`, `isExecutionMode` from `./execution-modes.ts`; `generateSessionTitle` from `./session-title.ts`. Note `resolveLazyWorkspace`'s `origin` param takes the `TurnOrigin` value directly — verify the Discord literal is `'discord'` (`grep -n "TurnOrigin" broker/src/*.ts`) and adjust the helper's comparison in `sessions.ts` (and its test) if the real literal differs.

- [ ] **Step 5: Run the full broker suite + typecheck**

Run: `cd broker && npm run typecheck && npm test`
Expected: PASS — this is the task where the whole broker package must be green again.

- [ ] **Step 6: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add broker/src
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(broker): lazy session creation everywhere, brain retitle, session-runtime task stamping"
```

---

### Task 10: control-plane — useBrokerChat: null session, runtime, createSession(workspace, runtime, prompt), modes + containers clients

**Files:**
- Modify: `control-plane/src/hooks/useBrokerChat.ts` (SessionSummary ~54, WorkspaceRecord ~87, session frame handling ~199-210, createSession ~584, new fetchers near listCliTools ~507, hook return ~615)
- Test: `control-plane/src/hooks/useBrokerChat.test.ts` (extend if present — check; the frame-parser change MUST have a test either way)

**Interfaces:**
- Produces: `type ExecutionMode = 'local-in-process' | 'local-docker' | 'remote-in-process' | 'remote-docker'` (exported from this hook file — the control plane's copy of the vocabulary); `SessionSummary.runtime: ExecutionMode`; `session` state type becomes `{ id; title; workspace; runtime: ExecutionMode } | null`; `createSession(workspace: string, runtime: ExecutionMode, prompt: string): Promise<{ error?: string; status?: number }>`; `listExecutionModes(): Promise<Record<ExecutionMode, boolean>>`; `getContainers(): Promise<{ docker: { enabled: boolean } }>`; `setDockerEnabled(enabled: boolean): Promise<{ docker: { enabled: boolean } }>`; `verifyContainers(): Promise<{ ok: boolean; detail: string }>`; `WorkspaceRecord` drops `runtime`, gains `links?: string[]`.
- Consumes: broker routes from Tasks 8-9. This is the second lockstep parser — the frame type here must exactly mirror `text-channel.ts`'s union from Task 8.

- [ ] **Step 1: Write the failing test.** There is no `useBrokerChat.test.ts` yet — create it, borrowing the fetch-stubbing style of `useCliToolHealth.test.ts` (vitest, `vi.stubGlobal("fetch", …)`):

```ts
import { describe, expect, it, vi } from "vitest";
import type { ExecutionMode } from "./useBrokerChat";

// createSession/listExecutionModes are useCallback closures over `base`; test
// them through a rendered hook if the file's siblings do, else export the two
// fetch helpers as standalone functions taking `base` and test those directly
// (preferred — pure and rerender-free). The assertions that matter:

it("createSession POSTs {workspace, runtime, prompt} and surfaces {error, status} on 409", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: 'execution mode "remote-docker" is not available' }), { status: 409 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const r = await postSession("127.0.0.1:7790", "acme", "remote-docker" as ExecutionMode, "fix the build");
  expect(fetchMock.mock.calls[0][0]).toContain("/sessions");
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ workspace: "acme", runtime: "remote-docker", prompt: "fix the build" });
  expect(r).toEqual({ error: 'execution mode "remote-docker" is not available', status: 409 });
});

it("session frame type accepts null (lockstep pin)", () => {
  // Compile-time: this literal must satisfy the exported SessionFrame type.
  const frame: SessionFrame = { type: "session", session: null, sessions: [], transcript: [], workspaces: [] };
  expect(frame.session).toBeNull();
});
```

To make this testable, extract the fetch bodies into exported module-level helpers `postSession(base, workspace, runtime, prompt)` and `fetchExecutionModes(base)` that the hook's `useCallback`s delegate to, and export the `SessionFrame` type — a small, honest seam, matching how the hook file already exports `WorkspaceRecord` and friends.

- [ ] **Step 2: Run to verify failure** — `cd control-plane && npx vitest run src/hooks`.

- [ ] **Step 3: Implement** — type/state changes as in Interfaces;

```ts
const createSession = useCallback(
  async (workspace: string, runtime: ExecutionMode, prompt: string): Promise<{ error?: string; status?: number }> => {
    try {
      const res = await fetch(`http://${base}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace, runtime, prompt }),
      });
      if (res.ok) return {};
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { error: body.error ?? `broker returned ${res.status}`, status: res.status };
    } catch {
      return { error: "broker unreachable" };
    }
  },
  [base],
);

const listExecutionModes = useCallback(async (): Promise<Record<ExecutionMode, boolean>> => {
  const res = await fetch(`http://${base}/execution-modes`);
  const body = (await res.json()) as { modes?: Record<ExecutionMode, boolean> };
  return body.modes ?? { "local-in-process": true, "local-docker": false, "remote-in-process": false, "remote-docker": false };
}, [base]);
```

Containers fetchers mirror the `listCliTools`/`setCliToolEnabled` trio (GET `/containers`, PUT `/containers` with `{docker:{enabled}}`, POST `/containers/verify`). Frame handling: `setSession(frame.session)` (state now nullable), transcript from `frame.transcript` (empty when null). Export the new functions from the hook's return object.

Per Step 1's seam: the `createSession`/`listExecutionModes` `useCallback`s are thin wrappers over exported module-level `postSession(base, workspace, runtime, prompt)` / `fetchExecutionModes(base)` helpers (the code above moves into those helpers), and the session-frame type is exported as `SessionFrame` so the lockstep pin compiles against the real type.

- [ ] **Step 4: Run tests + typecheck** — `cd control-plane && npx vitest run && npm run typecheck`. Expected: hook tests PASS; page/organism compile errors remain (Tasks 11-14 fix their own consumers — if `tsc` noise blocks you, proceed; the final task regains a fully green typecheck).

- [ ] **Step 5: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add control-plane/src/hooks
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(control-plane): nullable session frame, runtime-aware createSession, modes/containers clients"
```

---

### Task 11: control-plane — `NewSessionScreen` composer organism

**Files:**
- Create: `control-plane/src/organisms/NewSessionScreen.tsx`
- Create: `control-plane/src/organisms/NewSessionScreen.test.tsx`
- Modify: `control-plane/src/index.css` (or the stylesheet pattern sibling organisms use — match `SessionsPanel`'s styling location)

**Interfaces:**
- Consumes: `ExecutionMode`, `SessionSummary`, `WorkspaceRecord` from `useBrokerChat`.
- Produces:

```ts
export interface NewSessionScreenProps {
  workspaces: string[];
  records: WorkspaceRecord[] | null;          // description + links preview
  sessions: SessionSummary[];                  // default-mode derivation
  modes: Record<ExecutionMode, boolean> | null; // null = still loading -> only local-in-process
  lockedWorkspace?: string;                    // set => picker locked (spec §3)
  forced?: boolean;                            // zero-session boot: no cancel affordance
  onSend: (workspace: string, runtime: ExecutionMode, prompt: string) => Promise<{ error?: string } | undefined>;
  onCancel: () => void;
}
export const MODE_LABELS: Record<ExecutionMode, string> = {
  "local-in-process": "In process",
  "local-docker": "Local Docker",
  "remote-in-process": "Remote",
  "remote-docker": "Remote Docker",
};
```

- [ ] **Step 1: Write the failing tests** (vitest + testing-library, mirroring `NewWorkspaceModal.test.tsx`'s setup):

```tsx
it("renders only available modes — unavailable are absent, not disabled", () => {
  render(<NewSessionScreen {...base} modes={{ "local-in-process": true, "local-docker": true, "remote-in-process": false, "remote-docker": false }} />);
  expect(screen.getByText("In process")).toBeInTheDocument();
  expect(screen.getByText("Local Docker")).toBeInTheDocument();
  expect(screen.queryByText("Remote Docker")).toBeNull();
});

it("defaults mode to the workspace's most recent session's mode when still available", () => {
  render(
    <NewSessionScreen
      {...base}
      lockedWorkspace="acme"
      modes={{ "local-in-process": true, "local-docker": true, "remote-in-process": false, "remote-docker": false }}
      sessions={[
        { id: "s1", title: "old", workspace: "acme", updatedAt: "2026-08-01T00:00:00Z", active: false, runtime: "local-in-process" },
        { id: "s2", title: "new", workspace: "acme", updatedAt: "2026-08-07T00:00:00Z", active: false, runtime: "local-docker" },
      ]}
    />,
  );
  expect(screen.getByRole("radio", { name: "Local Docker" })).toBeChecked();
});

it("locks the workspace picker when lockedWorkspace is set", () => {
  render(<NewSessionScreen {...base} lockedWorkspace="acme" />);
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.getByText("acme")).toBeInTheDocument();
});

it("send calls onSend(workspace, mode, prompt) and shows a returned error while keeping the prompt text", async () => {
  const onSend = vi.fn().mockResolvedValue({ error: 'execution mode "local-docker" is not available' });
  render(<NewSessionScreen {...base} lockedWorkspace="acme" onSend={onSend} />);
  await userEvent.type(screen.getByRole("textbox"), "fix the build");
  await userEvent.click(screen.getByRole("button", { name: /send|start/i }));
  expect(onSend).toHaveBeenCalledWith("acme", "local-in-process", "fix the build");
  expect(await screen.findByText(/not available/)).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveValue("fix the build");
});

it("shows the workspace description and links as context preview", () => {
  render(
    <NewSessionScreen
      {...base}
      lockedWorkspace="acme"
      records={[{ name: "acme", default: true, repos: [], description: "builds the acme app", links: ["https://acme.dev/docs"] }]}
    />,
  );
  expect(screen.getByText("builds the acme app")).toBeInTheDocument();
  expect(screen.getByText("https://acme.dev/docs")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify failure** — `cd control-plane && npx vitest run src/organisms/NewSessionScreen.test.tsx`.

- [ ] **Step 3: Implement.** Layout: a centered column (workspace select → mode segmented control → context preview block → textarea + send button), styled with the app's existing class conventions (`sessions-panel`-adjacent naming: `new-session-screen__…`). Behavior rules:
  - Workspace select: options from `workspaces`; when `lockedWorkspace` is set render it as static text, not a select.
  - Mode control: `(Object.keys(MODE_LABELS) as ExecutionMode[]).filter((m) => modes?.[m])` — with `modes === null` that yields nothing, so special-case: `modes === null ? ["local-in-process"] : …filter`. Default selection: most recent session (by `updatedAt`) in the chosen workspace whose mode is still available, else `"local-in-process"`. Recompute when the workspace changes.
  - Context preview: from `records?.find((r) => r.name === ws)` — description paragraph + links as a list; render nothing when both empty.
  - Send: disable while empty prompt or in-flight; on `{error}` result show it inline and do NOT clear the textarea; on success the parent unmounts this screen (session frame arrives) — don't clear locally either.
  - `forced` hides the cancel/back affordance; Escape calls `onCancel` only when not forced.

- [ ] **Step 4: Run tests** — `npx vitest run src/organisms/NewSessionScreen.test.tsx`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add control-plane/src/organisms/NewSessionScreen.tsx control-plane/src/organisms/NewSessionScreen.test.tsx control-plane/src/index.css
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(control-plane): NewSessionScreen composer with gated mode picker"
```

---

### Task 12: control-plane — HomePage composer wiring (entry points + zero-session boot)

**Files:**
- Modify: `control-plane/src/pages/HomePage.tsx` (~36 state, ~309-338 panel/modal wiring, stage render)
- Modify: `control-plane/src/organisms/SessionsPanel.tsx` (the "new session" row's `onCreate` semantics stay `(workspace?: string) => void` — verify the row passes its filter value; no fetch happens here anymore)
- Test: `control-plane/src/organisms/SessionsPanel.test.tsx` if it exists; HomePage behavior is covered by the composer tests + manual smoke (Task 15)

**Interfaces:**
- Consumes: `NewSessionScreen` (Task 11), `createSession`/`listExecutionModes`/`session` (Task 10).
- Produces: HomePage state `composer: { locked?: string } | null`; composer is rendered when `composer !== null || (connected && session === null)`; the second condition is the forced zero-session state.

- [ ] **Step 1: Wire it.**
  - `const [composer, setComposer] = useState<{ locked?: string } | null>(null);` plus `const [modes, setModes] = useState<Record<ExecutionMode, boolean> | null>(null);` and `const [wsRecords, setWsRecords] = useState<WorkspaceRecord[] | null>(null);`
  - `useEffect`: when the composer becomes visible (`composer !== null || (connected && session === null)`), `void listExecutionModes().then(setModes).catch(() => setModes(null)); void listWorkspaceRecords().then(setWsRecords).catch(() => setWsRecords(null));`
  - `SessionsPanel` `onCreate={(ws) => { setSessionsOpen(false); setComposer({ locked: ws || undefined }); }}`
  - `NewWorkspaceModal` `onCreated={(name) => setComposer({ locked: name })}` (replacing `createSession(name)`).
  - Stage render: when composer is visible, render `NewSessionScreen` in place of the chat/voice stage:

```tsx
<NewSessionScreen
  workspaces={workspaces}
  records={wsRecords}
  sessions={sessions}
  modes={modes}
  lockedWorkspace={composer?.locked}
  forced={session === null}
  onSend={async (ws, mode, prompt) => {
    const r = await createSession(ws, mode, prompt);
    if (r.error) {
      if (r.status === 409) void listExecutionModes().then(setModes).catch(() => {});
      return r;
    }
    setComposer(null);
    return undefined;
  }}
  onCancel={() => setComposer(null)}
/>
```

  The 409 branch re-fetches availability so a vanished mode disappears from the picker while the user's text survives (spec §5).

- [ ] **Step 2: Verify SessionsPanel.** Its row already calls `onCreate(ws)` where `ws` is the panel's filter value — confirm and update its test to assert `onCreate` is called with the filter (and that no fetch fires from the panel itself).

- [ ] **Step 3: Run tests + typecheck + lint**

Run: `cd control-plane && npx vitest run && npm run typecheck && npx biome check .`
Expected: everything green except `NewWorkspaceModal` (still sends `runtime`) — that's Task 13; if its compile breaks the build here, do the minimal removal of the `runtime` body field as part of this task's typecheck fix and leave the full modal rework to Task 13.

- [ ] **Step 4: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add control-plane/src/pages/HomePage.tsx control-plane/src/organisms/SessionsPanel.tsx control-plane/src/organisms/SessionsPanel.test.tsx
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(control-plane): composer entry points + forced zero-session screen"
```

---

### Task 13: control-plane — NewWorkspaceModal loses mode picker, gains description+links; WorkspaceManagerModal gains links

**Files:**
- Modify: `control-plane/src/organisms/NewWorkspaceModal.tsx` (delete `RuntimeChoice`/`runtime` state ~54, the records-based default effect ~67-69, the `runtime` body field ~95, the picker control ~212; add description + links fields)
- Modify: `control-plane/src/organisms/WorkspaceManagerModal.tsx` (links textarea beside description)
- Test: `control-plane/src/organisms/NewWorkspaceModal.test.tsx`, `control-plane/src/organisms/WorkspaceManagerModal.test.tsx`

**Interfaces:**
- Consumes: `WorkspaceRecord.links?: string[]` (Task 10).
- Produces: both modals submit `links: string[]` (textarea, one URL per line, blank lines dropped) and `description`; `NewWorkspaceModal`'s `list` prop is REMOVED (it existed only to default the mode picker — check `HomePage` passes and drop there too).

- [ ] **Step 1: Update the failing tests first.** In `NewWorkspaceModal.test.tsx`: delete every assertion about the execution-mode picker/`runtime` body field; add: "submits description and newline-split links", "no execution mode control renders". In `WorkspaceManagerModal.test.tsx`: add "editing saves links".

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/organisms/NewWorkspaceModal.test.tsx src/organisms/WorkspaceManagerModal.test.tsx`.

- [ ] **Step 3: Implement.** Links field in both modals:

```tsx
<label className="nwm__label">
  links <span className="nwm__hint">one per line — docs, dashboards, tickets</span>
  <textarea value={linksText} onChange={(e) => setLinksText(e.target.value)} rows={3} />
</label>
```

Submit-side: `links: linksText.split("\n").map((l) => l.trim()).filter(Boolean)`. (Class names: match each modal's actual prefix.) Description in `NewWorkspaceModal`: plain optional text input feeding `description` in the existing `save` body. Remove the mode picker component usage and, if the picker was a locally-defined subcomponent used nowhere else, delete it.

- [ ] **Step 4: Run tests + full sweep**

Run: `cd control-plane && npx vitest run && npm run typecheck && npx biome check .`
Expected: PASS across the package.

- [ ] **Step 5: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add control-plane/src/organisms control-plane/src/pages
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(control-plane): workspace modals = repo + context (description, links); mode picker removed"
```

---

### Task 14: control-plane — Settings → Workspace → Containers group

**Files:**
- Create: `control-plane/src/organisms/settings/ContainersGroup.tsx`
- Create: `control-plane/src/organisms/settings/ContainersGroup.test.tsx`
- Modify: `control-plane/src/organisms/SettingsPanel.tsx` (add group id under the "Workspace" heading ~96, render arm, props), `control-plane/src/pages/HomePage.tsx` (pass the three fetchers)

**Interfaces:**
- Consumes: `getContainers`, `setDockerEnabled`, `verifyContainers` (Task 10).
- Produces:

```ts
export interface ContainersGroupProps {
  getContainers: () => Promise<{ docker: { enabled: boolean } }>;
  setDockerEnabled: (enabled: boolean) => Promise<{ docker: { enabled: boolean } }>;
  verifyContainers: () => Promise<{ ok: boolean; detail: string }>;
}
```

- [ ] **Step 1: Write the failing tests** (mirror `CliToolsGroup.test.tsx` harness): loads and shows the toggle state; toggling calls `setDockerEnabled` and reflects the response; Verify button shows `detail` for both ok and failure results; the group renders as a provider LIST with docker as the only row (assert a row container exists — future providers are rows, spec §2).

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/organisms/settings/ContainersGroup.test.tsx`.

- [ ] **Step 3: Implement.** One provider row: name "Docker", enable toggle, Verify button + inline status line (reuse the exact status/badge classes `CliToolsGroup` uses). Enabling never requires a passing verify (spec §2) — the toggle and the probe are independent controls. `SettingsPanel`: add `{ id: "containers", label: "Containers", icon: Container }` (lucide `Container` icon) to the "Workspace" heading's `groups` array, a render arm gated on the three props being present (same optional-props pattern as ChannelsGroup), and thread the props from HomePage.

- [ ] **Step 4: Run tests + sweep** — `cd control-plane && npx vitest run && npm run typecheck && npx biome check .` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add control-plane/src/organisms/settings control-plane/src/organisms/SettingsPanel.tsx control-plane/src/pages/HomePage.tsx
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(control-plane): Containers settings group gating local-docker"
```

---

### Task 15: Full verification + spec cross-check

**Files:** none new — verification only.

- [ ] **Step 1: All three suites + typechecks from clean state**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/swarm && npm run typecheck && npm test
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/broker && npm run typecheck && npm test
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/control-plane && npm run typecheck && npx biome check . && npx vitest run
```

Expected: all green. Fix anything red before proceeding.

- [ ] **Step 2: Straggler greps** (each must return nothing unexpected):

```bash
grep -rn "workspaceRuntime" swarm broker control-plane --include="*.ts" --include="*.tsx"
grep -rn "Session 1" broker/src --include="*.ts" | grep -v test        # no fabricated-session assumptions
grep -rn "runtime" control-plane/src/organisms/NewWorkspaceModal.tsx    # mode picker fully gone
grep -rn "'remote'" swarm/src/runtime.ts                                # legacy alias still handled
```

- [ ] **Step 3: Lockstep parser audit** — diff the session-frame types by eye: `broker/src/text-channel.ts` union member vs `useBrokerChat.ts` frame type. Field names, nullability, and `runtime` presence must match exactly on `session`, `sessions` rows, `transcript`, `workspaces`.

- [ ] **Step 4: Spec coverage read-through** — open the spec and tick every section against the implementation: §1 data model (Tasks 1-2, 5), §2 availability + Containers (3, 4, 14), §3 composer + naming (6, 9, 11, 12), §4 delegation/routing (1, 7, 9), §4b zero-session state (5, 8, 9, 10, 12), §5 error handling (9 → 409 path, 12 → re-fetch, 1 → named no-worker error), §6 testing (each task's tests). Anything unimplemented: stop and add a task, don't hand-wave.

- [ ] **Step 5: Manual smoke checklist** (report results; live broker runs in tmux session `smith-broker` from the main checkout on 7790 — restart is Edwin's call, note it as pending rather than restarting anything yourself):
  1. Fresh boot with zero session files → app opens on composer; only "In process" visible with docker off and no workers.
  2. Enable Docker in Settings → Containers, reopen composer → "Local Docker" appears.
  3. Send first prompt → chat state, truncated title in panel, retitled after first reply.
  4. Sessions panel → new session in a filtered workspace → workspace locked in composer.
  5. New workspace flow → lands in composer scoped to it, description/links preview shows.
  6. Delegate work from a `local-docker` session → task manifest runtime `docker` (check swarm logs).

- [ ] **Step 6: Final commit** (only if fixes were made in this task)

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add -A swarm/src broker/src control-plane/src
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "chore: session-execution-mode verification fixes"
```
