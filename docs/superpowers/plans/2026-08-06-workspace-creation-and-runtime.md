# New Workspace Creation Flow + Per-Workspace Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the rail's "New session" pencil with a "New workspace" plus button opening a lean `NewWorkspaceModal` (mandatory GitHub connector per repo, "start from a folder" mode with native folder picking + `git init`), and surface swarm's already-built `tmux`/`docker`/`remote` runtime adapters as an optional per-workspace `runtime` setting.

**Architecture:** Bottom-up in three layers. Swarm: `Workspace.runtime` (optional field, validated, exposed on GET, honored at task creation), a one-time `initGit` repo-creation flag on `POST /workspaces`, and `'remote'` joining `RuntimeType` with the server's `WorkerPool` threaded into both runtime-creation sites. Broker: type-only passthrough (`WorkspaceBody`). Control-plane: Tauri dialog plugin (all four wiring layers are net-new), a new lean `NewWorkspaceModal`, and `ToolRail`/`HomePage` rewiring (plus button → modal; the bottom hint's session name becomes the Sessions-panel opener).

**Tech Stack:** swarm/broker: npm, `node:test` + `node:assert/strict`, tsx. control-plane: pnpm, Vitest + `@testing-library/react` (no jest-dom, manual `cleanup()`), Biome, Tauri 2 (`@tauri-apps/plugin-dialog` 2.7.2 JS / `tauri-plugin-dialog` 2.7.2 Rust).

## Global Constraints

- **Runtime union is `'tmux' | 'docker' | 'remote'` everywhere it appears** — `Workspace.runtime` (optional), `RuntimeType`, broker `WorkspaceBody.runtime`, control-plane `WorkspaceRecord.runtime`. Unset always falls back to `server.orchConfig.defaultRuntime` (today's behavior; no migration).
- **⚠️ Deviation from spec §3, deliberate:** the spec says `dispatcher.dispatch()` resolves `manifest.runtime ?? workspace.runtime ?? defaultRuntime`. But `POST /tasks` (server.ts:412) **bakes `defaultRuntime` into `manifest.runtime` at creation**, so a dispatch-only fallback would never fire for API-created tasks — silently dead feature. Resolution therefore happens **at task creation** (`resolveTaskRuntime`, Task 3), where the workspace is already resolved; the dispatcher *additionally* gets the spec's fallback chain (via `resolveConnections`) so directly-constructed manifests behave per spec. The precedence order the spec demands (task override → workspace → server default) is preserved exactly.
- **`initGit` is a one-time creation instruction, never persisted.** `POST /workspaces` accepts it per-repo, runs `git init` before validation, and the route's explicit repo-field mapping drops it from the saved record.
- **GitHub connector required per repo in `NewWorkspaceModal` only.** `WorkspaceManagerModal` keeps its optional `connectorId` — do not touch its soft-fail behavior.
- **Native folder picking is prop-injected, never imported statically into components.** `@tauri-apps/plugin-dialog` is loaded via dynamic `import()` inside `src/services/nativeDialog.ts`, guarded by `isTauri()` from `@tauri-apps/api/core` — the same bundle must keep working in plain browser and in jsdom tests (README: "The front-end uses zero Tauri APIs … guard any future `@tauri-apps/api` usage behind a runtime check").
- **Tauri plugin versions:** `@tauri-apps/plugin-dialog` 2.7.2 (JS), `tauri-plugin-dialog = "2.7.2"` (Rust). One dependency add per side, one `.plugin(tauri_plugin_dialog::init())` registration, one `"dialog:default"` permission string appended to `src-tauri/capabilities/default.json`. No new capability file, no `tauri.conf.json` change.
- **Swarm test conventions:** the suite never boots `OrchestratorServer` — route logic is tested through **exported** helpers (`workspaceProblems` precedent). New route logic must be extracted into exported functions (`gitInitRequestedRepos`, `resolveTaskRuntime`) and tested directly with `mkdtemp` fixtures.
- **Control-plane test conventions:** import `describe/it/expect/vi` from `"vitest"`; manual `cleanup()` in `afterEach`; no `.toBeInTheDocument()` (no jest-dom); query by placeholder text and aria-label, never test ids; selects driven by `userEvent.selectOptions`.
- **Test commands:** swarm/broker: `npm test` and `npm run typecheck` from each package dir. control-plane: `pnpm run test`, `pnpm run typecheck`, `pnpm run lint`. Known pre-existing failures: swarm's `agent-sessions.test.ts` has 2 live-CLI turn-timeout failures on this machine — everything else must pass.
- **Commit style:** terse, present-tense, `type(scope): summary`.
- **Baseline:** branch `worktree-workspace-creation`, cut from main @ 56088fc + cherry-picked 23da5ee (`chore(control-plane): drop entry points superseded by full-screen Settings`) — ToolRail is already avatar-free with a single pencil tool.

---

### Task 1: swarm — `Workspace.runtime` field, validation, API exposure

**Files:**
- Modify: `swarm/src/workspaces.ts` (interface, ~line 29-36)
- Modify: `swarm/src/server.ts` (`workspaceProblems` ~line 1972; `POST /workspaces` ~line 1205-1217; `PUT /workspaces/:name` ~line 1234-1243; `GET /workspaces` ~line 1306-1318)
- Test: `swarm/src/workspaces.test.ts`, `swarm/src/server.test.ts`

**Interfaces:**
- Produces: `Workspace.runtime?: 'tmux' | 'docker' | 'remote'` — consumed by Task 3 (`resolveTaskRuntime`, `resolveConnections`) and, through `GET /workspaces`, by Task 6's modal default.
- Consumes: existing `workspaceProblems`, `saveWorkspace`, `loadWorkspacesFromDir`.

- [ ] **Step 1: Write the failing tests**

In `swarm/src/workspaces.test.ts` (imports at top of file already include `saveWorkspace`, `loadWorkspacesFromDir`, `mkdtemp`, `tmpdir`, `join`, `test`, `assert` — add any missing):

```ts
test('saveWorkspace/loadWorkspacesFromDir round-trips the optional runtime field', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-runtime-'));
  await saveWorkspace(dir, { name: 'acme', repos: [{ name: 'web', path: dir }], runtime: 'docker' });
  const [ws] = await loadWorkspacesFromDir(dir);
  assert.equal(ws!.runtime, 'docker');
  await saveWorkspace(dir, { name: 'plain', repos: [{ name: 'web', path: dir }] });
  const plain = (await loadWorkspacesFromDir(dir)).find((w) => w.name === 'plain');
  assert.equal(plain!.runtime, undefined);
});
```

In `swarm/src/server.test.ts` (file already has `const git = promisify(execFile);` and imports `workspaceProblems`, `mkdtemp`, `tmpdir`, `join`):

```ts
test('workspaceProblems: accepts tmux/docker/remote runtimes, rejects anything else, allows unset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-rt-'));
  await git('git', ['init'], { cwd: dir });
  const base = { name: 'acme', repos: [{ name: 'web', path: dir }] } as Partial<Workspace>;
  assert.equal(await workspaceProblems(base), null);
  assert.equal(await workspaceProblems({ ...base, runtime: 'tmux' }), null);
  assert.equal(await workspaceProblems({ ...base, runtime: 'docker' }), null);
  assert.equal(await workspaceProblems({ ...base, runtime: 'remote' }), null);
  assert.match((await workspaceProblems({ ...base, runtime: 'warp' as never }))!, /runtime/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `swarm/`): `node --import tsx --test src/workspaces.test.ts src/server.test.ts`
Expected: the roundtrip test FAILS on a TypeScript-level complaint or the runtime assertion; the `workspaceProblems` test FAILS on the `'warp'` case (currently returns `null`).

- [ ] **Step 3: Implement**

`swarm/src/workspaces.ts` — append to the `Workspace` interface after `atlassian?`:

```ts
  /** Execution environment for this workspace's tasks. Unset = server's defaultRuntime (today's behavior, unchanged). */
  runtime?: 'tmux' | 'docker' | 'remote';
```

`swarm/src/server.ts` — in `workspaceProblems`, after the repos loop and before the atlassian check:

```ts
  if (b.runtime !== undefined && !['tmux', 'docker', 'remote'].includes(b.runtime)) {
    return `runtime must be one of tmux, docker, remote — got "${b.runtime}"`;
  }
```

`POST /workspaces` — in the `ws: Workspace` construction, after `atlassian: b.atlassian,`:

```ts
        runtime: b.runtime,
```

`PUT /workspaces/:name` — in the `merged: Workspace` construction, after `atlassian: ...`:

```ts
        runtime: b.runtime !== undefined ? b.runtime : existing.runtime,
```

`GET /workspaces` — in the per-workspace mapping, after `atlassian: w.atlassian,`:

```ts
          runtime: w.runtime,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test src/workspaces.test.ts src/server.test.ts` — expected: PASS.
Then `npm run typecheck` — expected: clean.

- [ ] **Step 5: Commit**

```bash
git add swarm/src/workspaces.ts swarm/src/server.ts swarm/src/workspaces.test.ts swarm/src/server.test.ts
git commit -m "feat(swarm): optional per-workspace runtime field, validated and exposed on the workspace API"
```

---

### Task 2: swarm — `initGit` repo creation on `POST /workspaces`

**Files:**
- Modify: `swarm/src/workspaces.ts` (new export next to `isGitRepo`, ~line 125)
- Modify: `swarm/src/server.ts` (`POST /workspaces` route ~line 1190-1193; new exported helper next to `workspaceProblems`)
- Test: `swarm/src/workspaces.test.ts`, `swarm/src/server.test.ts`

**Interfaces:**
- Produces: `initGitRepo(path: string): Promise<void>` (workspaces.ts); `gitInitRequestedRepos(repos: Array<Partial<WorkspaceRepo> & { initGit?: boolean }> | undefined): Promise<string | null>` (server.ts — returns a 400-able problem string or null).
- Consumes: existing `isGitRepo`, `isAbsolute`.
- Note: `isGitRepo` uses `git rev-parse --git-dir`, which walks **up** — a fresh empty folder nested inside some parent repo counts as "already a repo" and is skipped. This is the spec-blessed existing helper's semantics; do not "fix" it.

- [ ] **Step 1: Write the failing tests**

`swarm/src/workspaces.test.ts`:

```ts
test('initGitRepo: turns a plain directory into a git repository', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'initgit-'));
  assert.equal(await isGitRepo(dir), false);
  await initGitRepo(dir);
  assert.equal(await isGitRepo(dir), true);
});
```

(add `initGitRepo`, `isGitRepo` to the imports from `./workspaces.js`)

`swarm/src/server.test.ts`:

```ts
test('gitInitRequestedRepos: inits only flagged non-repo paths, leaves existing repos alone, reports unusable paths', async () => {
  const fresh = await mkdtemp(join(tmpdir(), 'nw-fresh-'));
  const existing = await mkdtemp(join(tmpdir(), 'nw-existing-'));
  await git('git', ['init'], { cwd: existing });
  assert.equal(
    await gitInitRequestedRepos([
      { name: 'a', path: fresh, initGit: true },
      { name: 'b', path: existing, initGit: true },
      { name: 'c', path: join(fresh, 'never-flagged') },
    ]),
    null,
  );
  assert.equal(await isGitRepo(fresh), true);
  assert.equal(await isGitRepo(existing), true);
  const missing = join(fresh, 'no-such-dir', 'deeper');
  assert.match((await gitInitRequestedRepos([{ name: 'x', path: missing, initGit: true }]))!, /git init failed/);
});
```

(add `gitInitRequestedRepos` to the imports from `./server.js`, and `isGitRepo` from `./workspaces.js`)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test src/workspaces.test.ts src/server.test.ts`
Expected: FAIL — `initGitRepo` / `gitInitRequestedRepos` not exported.

- [ ] **Step 3: Implement**

`swarm/src/workspaces.ts`, directly below `isGitRepo`:

```ts
/** `git init` an existing directory — the one case where workspace creation may create the repo instead of rejecting the path (creation-time `initGit` flag). */
export async function initGitRepo(path: string): Promise<void> {
  await promisify(execFile)('git', ['init'], { cwd: path });
}
```

`swarm/src/server.ts`, next to `workspaceProblems` (add `initGitRepo` to the existing `./workspaces.js` import):

```ts
/**
 * POST /workspaces' one creation side effect: repos submitted with the
 * transient `initGit` flag become git repos before workspaceProblems'
 * isGitRepo validation runs. The flag is never persisted — the route's
 * explicit repo-field mapping drops it.
 */
export async function gitInitRequestedRepos(
  repos: Array<Partial<WorkspaceRepo> & { initGit?: boolean }> | undefined,
): Promise<string | null> {
  for (const r of repos ?? []) {
    if (!r?.initGit || !r.path || !isAbsolute(r.path)) continue;
    if (await isGitRepo(r.path)) continue;
    try {
      await initGitRepo(r.path);
    } catch (err) {
      return `Repo "${r.name ?? r.path}": git init failed — ${String((err as Error).message)}`;
    }
  }
  return null;
}
```

`POST /workspaces` route — first lines become:

```ts
      const b = req.body as Partial<Workspace> & { repos?: Array<WorkspaceRepo & { initGit?: boolean }> };
      const initProblem = await gitInitRequestedRepos(b.repos);
      if (initProblem) return reply.status(400).send({ error: initProblem });
      const problem = await workspaceProblems(b);
```

(the existing `ws.repos` construction already maps explicit fields `{name, path, repository, branch, github}`, so `initGit` never reaches disk — no further change needed there)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test src/workspaces.test.ts src/server.test.ts` — expected: PASS. Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add swarm/src/workspaces.ts swarm/src/server.ts swarm/src/workspaces.test.ts swarm/src/server.test.ts
git commit -m "feat(swarm): POST /workspaces initGit flag — git init a submitted folder before validation, never persisted"
```

---

### Task 3: swarm — `'remote'` joins `RuntimeType`; runtime resolves task → workspace → default

**Files:**
- Modify: `swarm/src/types.ts:32` (`RuntimeType`)
- Modify: `swarm/src/runtime.ts:517-537` (collapse `createRuntime` overloads)
- Modify: `swarm/src/dispatcher.ts` (constructor ~line 66-74; `dispatch` runtime resolution ~line 94-107 and its doc comment ~line 87-89; `resolveConnections` return ~line 188-229)
- Modify: `swarm/src/server.ts` (new exported `resolveTaskRuntime`; `POST /tasks` ~line 407-426; `new Dispatcher` line 171; `dispatchTask` ~line 1735-1740)
- Test: `swarm/src/runtime.test.ts`, `swarm/src/dispatcher.test.ts`, `swarm/src/server.test.ts`

**Interfaces:**
- Produces: `RuntimeType = 'tmux' | 'docker' | 'remote'`; `createRuntime(runtime: RuntimeType, dockerConfig?: DockerConfig, workerPool?: WorkerPool): RuntimeAdapter`; `Dispatcher` constructor `(config: OrchestratorConfig, workerPool?: WorkerPool)`; `resolveConnections` return gains `workspaceRuntime?: RuntimeType`; `resolveTaskRuntime(requested: RuntimeType | undefined, workspace: Pick<Workspace, 'runtime'> | undefined, defaultRuntime: RuntimeType): { runtime: RuntimeType; location: LocationType }`.
- Consumes: Task 1's `Workspace.runtime`; existing `WorkerPool` (server field `this.workerPool`, server.ts:148 — a class-property initializer, so it exists before the constructor body assigns `this.dispatcher`).

- [ ] **Step 1: Write the failing tests**

`swarm/src/runtime.test.ts` (add `WorkerPool` import from `./remote-runtime.js`):

```ts
test('createRuntime: remote without a WorkerPool throws; with one, returns the RemoteRuntime adapter', () => {
  assert.throws(() => createRuntime('remote'), /WorkerPool is required/);
  const adapter = createRuntime('remote', undefined, new WorkerPool());
  assert.equal(adapter.constructor.name, 'RemoteRuntime');
});
```

`swarm/src/dispatcher.test.ts` (reuse the existing `fixture()` helper at the top of the file):

```ts
test('resolveConnections: surfaces the matched workspace runtime; unmatched or unset stays undefined', async () => {
  const { root, repoPath } = await fixture();
  const dispatcher = new Dispatcher({} as OrchestratorConfig);
  const unset = await dispatcher.resolveConnections({ context: { repoPath } } as TaskManifest, root);
  assert.equal(unset.workspaceRuntime, undefined);
  await writeFile(
    join(root, '.smith/workspaces/acme.json'),
    JSON.stringify({ name: 'acme', repos: [{ name: 'web', path: repoPath }], runtime: 'docker' }),
  );
  const pinned = await dispatcher.resolveConnections({ context: { repoPath } } as TaskManifest, root);
  assert.equal(pinned.workspaceRuntime, 'docker');
  const nowhere = await dispatcher.resolveConnections({ context: { repoPath: '/nope' } } as TaskManifest, root);
  assert.equal(nowhere.workspaceRuntime, undefined);
});
```

`swarm/src/server.test.ts` (add `resolveTaskRuntime` to the `./server.js` import):

```ts
test('resolveTaskRuntime: per-task override wins, then workspace runtime, then server default — location mirrors the pick', () => {
  assert.deepEqual(resolveTaskRuntime('docker', { runtime: 'remote' }, 'tmux'), { runtime: 'docker', location: 'docker' });
  assert.deepEqual(resolveTaskRuntime(undefined, { runtime: 'remote' }, 'tmux'), { runtime: 'remote', location: 'remote' });
  assert.deepEqual(resolveTaskRuntime(undefined, { runtime: undefined }, 'docker'), { runtime: 'docker', location: 'docker' });
  assert.deepEqual(resolveTaskRuntime(undefined, undefined, 'tmux'), { runtime: 'tmux', location: 'local' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test src/runtime.test.ts src/dispatcher.test.ts src/server.test.ts`
Expected: FAIL — `createRuntime('remote')` is a type error today (fix by implementing), `workspaceRuntime` undefined-but-asserted-'docker', `resolveTaskRuntime` not exported.

- [ ] **Step 3: Implement**

`swarm/src/types.ts:32`:

```ts
export type RuntimeType = 'tmux' | 'docker' | 'remote';
```

`swarm/src/runtime.ts` — delete the two overload signatures (lines 524-532); the implementation signature becomes the only one. Add `import type { WorkerPool } from './remote-runtime.js';` at the top (type-only — the lazy `require` inside the `'remote'` case stays, it exists to avoid a runtime circular import) and add `RuntimeType` to the existing `./types.js` import:

```ts
/**
 * Create the appropriate RuntimeAdapter for the requested runtime type.
 *
 * @param runtime - 'tmux' bare-metal, 'docker' containerised, 'remote' via a worker machine
 * @param dockerConfig - Required when runtime is 'docker'
 * @param workerPool - Required when runtime is 'remote'
 */
export function createRuntime(
  runtime: RuntimeType,
  dockerConfig?: DockerConfig,
  workerPool?: WorkerPool,
): RuntimeAdapter {
```

(body unchanged)

`swarm/src/dispatcher.ts`:

```ts
import type { WorkerPool } from './remote-runtime.js';
```

```ts
  private readonly workerPool?: WorkerPool;

  constructor(config: OrchestratorConfig, workerPool?: WorkerPool) {
    super();
    this.config = config;
    this.workerPool = workerPool;
    this.quarantine = new QuarantineManager(config.logsDir);
  }
```

In `dispatch()`, move the `resolveConnections` call **above** runtime resolution and thread both through (replaces lines 99-107; update the method doc comment's numbered list to `1. manifest.runtime 2. the task's workspace's own runtime 3. config.defaultRuntime`):

```ts
    // Resolve once: pairs this user's credentials with the workspace/repo
    // config for this task, feeding prepareWorktree (Atlassian MCP
    // materialization), runtime.launch (env injection), and the runtime
    // choice itself (workspace.runtime, design §3) below.
    const connections = await this.resolveConnections(manifest);

    // Per-task override wins, then the task's workspace's own runtime, then
    // the server-wide default. API-created tasks arrive already resolved
    // (resolveTaskRuntime at POST /tasks); this chain covers directly-
    // constructed manifests.
    const runtimeType: RuntimeType =
      manifest.runtime ?? connections.workspaceRuntime ?? this.config.defaultRuntime;
    const runtime = createRuntime(runtimeType, this.config.docker, this.workerPool);
```

In `resolveConnections`: add `workspaceRuntime?: 'tmux' | 'docker' | 'remote';` to the declared return type, and change the final return to:

```ts
    return { atlassian, env, workspaceRuntime: workspace.runtime };
```

(the two early `return { env };` paths stay as-is — no workspace, no runtime)

`swarm/src/server.ts` — next to `workspaceProblems` (add `LocationType`, `RuntimeType` to the `./types.js` import if absent):

```ts
/**
 * Creation-time runtime resolution (design §3): per-task override wins, then
 * the resolved workspace's own runtime, then the server default. Resolved
 * here — not only at dispatch — because this route bakes the result into
 * manifest.runtime, which dispatchTask and the dashboard both read.
 */
export function resolveTaskRuntime(
  requested: RuntimeType | undefined,
  workspace: Pick<Workspace, 'runtime'> | undefined,
  defaultRuntime: RuntimeType,
): { runtime: RuntimeType; location: LocationType } {
  const runtime = requested ?? workspace?.runtime ?? defaultRuntime;
  return { runtime, location: runtime === 'docker' ? 'docker' : runtime === 'remote' ? 'remote' : 'local' };
}
```

`POST /tasks` — replace lines 412-413 (`runtime:` / `location:` in the manifest construction); insert directly above the `const manifest` statement:

```ts
      const resolvedRuntime = resolveTaskRuntime(body.runtime, resolved?.workspace, server.orchConfig.defaultRuntime);
```

and in the manifest:

```ts
        runtime: resolvedRuntime.runtime,
        location: body.location ?? resolvedRuntime.location,
```

Line 171: `this.dispatcher = new Dispatcher(this.orchConfig, this.workerPool);`

`dispatchTask` (~line 1739): `const runtime = createRuntime(runtimeType, this.orchConfig.docker, this.workerPool);`

- [ ] **Step 4: Run the full swarm suite**

Run: `npm test` and `npm run typecheck`
Expected: everything passes except the 2 known `agent-sessions` live-CLI timeouts; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add swarm/src/types.ts swarm/src/runtime.ts swarm/src/dispatcher.ts swarm/src/server.ts swarm/src/runtime.test.ts swarm/src/dispatcher.test.ts swarm/src/server.test.ts
git commit -m "feat(swarm): remote joins RuntimeType; task runtime resolves task -> workspace -> server default with WorkerPool threaded through"
```

---

### Task 4: broker — `WorkspaceBody` passthrough types

**Files:**
- Modify: `broker/src/swarm-client.ts:60-71` (`WorkspaceBody`)

**Interfaces:**
- Produces: `WorkspaceBody.runtime?: 'tmux' | 'docker' | 'remote'`; repos entries gain `initGit?: boolean`. `SwarmWorkspace extends WorkspaceBody` picks both up automatically.
- Consumes: nothing new — `text-channel.ts`'s `POST /workspaces` already forwards the raw parsed JSON (`this.workspaces.save(parsed, true)` → `swarm.createWorkspace(body)`), so no route change is needed or wanted.

- [ ] **Step 1: Implement** — in `WorkspaceBody`, extend the repos element type and add `runtime`:

```ts
  repos: Array<{
    name: string;
    path: string;
    repository?: string;
    branch?: string;
    github?: { owner: string; repo: string; connectorId?: string };
    /** Creation-time only: git init the path if it isn't a repo yet. Never persisted by swarm. */
    initGit?: boolean;
  }>;
  default?: boolean;
  /** Execution environment for this workspace's tasks; unset = swarm's server default. */
  runtime?: 'tmux' | 'docker' | 'remote';
```

- [ ] **Step 2: Verify** — from `broker/`: `npm run typecheck` then `npm test`. Expected: clean, 212 pass.

- [ ] **Step 3: Commit**

```bash
git add broker/src/swarm-client.ts
git commit -m "feat(broker): workspace body types carry runtime and per-repo initGit through the proxy"
```

---

### Task 5: control-plane — Tauri dialog plugin wiring (all four layers)

**Files:**
- Modify: `control-plane/src-tauri/Cargo.toml:17-25` ([dependencies])
- Modify: `control-plane/src-tauri/src/lib.rs:1-16`
- Modify: `control-plane/src-tauri/capabilities/default.json`
- Modify: `control-plane/package.json` (+ `pnpm-lock.yaml`, `src-tauri/Cargo.lock` regenerate)

**Interfaces:**
- Produces: the `dialog:default` IPC permission and the `@tauri-apps/plugin-dialog` JS package Task 7's `nativeDialog.ts` dynamically imports.
- Notes: `tauri.conf.json` has no `app.security.capabilities` allowlist, so every file under `capabilities/` auto-loads — appending one permission string is sufficient. `gen/schemas/` is gitignored and regenerates on build. The existing `tauri-plugin-log` is registered dynamically inside `.setup()` — that is *not* the pattern here; dialog registers on the builder chain.

- [ ] **Step 1: Rust dependency** — `Cargo.toml` `[dependencies]`, after `tauri-plugin-log = "2"`:

```toml
tauri-plugin-dialog = "2.7.2"
```

- [ ] **Step 2: Register on the builder** — `lib.rs` (2-space indent; `.plugin()` chained before `.setup(`):

```rust
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
```

- [ ] **Step 3: Capability permission** — `capabilities/default.json`:

```json
  "permissions": [
    "core:default",
    "dialog:default"
  ]
```

- [ ] **Step 4: JS package** — from `control-plane/`:

```bash
pnpm add @tauri-apps/plugin-dialog@2.7.2
```

- [ ] **Step 5: Verify** — `cd src-tauri && cargo check` (first run compiles deps — allow minutes). Expected: clean check, `dialog` appears in the regenerated `gen/schemas/acl-manifests.json`. Then `cd .. && pnpm run test && pnpm run typecheck` — expected: unchanged (37 pass, clean).

- [ ] **Step 6: Commit**

```bash
git add control-plane/src-tauri/Cargo.toml control-plane/src-tauri/Cargo.lock control-plane/src-tauri/src/lib.rs control-plane/src-tauri/capabilities/default.json control-plane/package.json control-plane/pnpm-lock.yaml
git commit -m "feat(control-plane): wire tauri-plugin-dialog (deps, builder registration, dialog:default capability)"
```

---

### Task 6: control-plane — `WorkspaceRecord` types + `NewWorkspaceModal` (existing-repo mode)

**Files:**
- Modify: `control-plane/src/hooks/useBrokerChat.ts:76-89` (`WorkspaceRecord`), `:259-269` (`saveWorkspace` return type)
- Create: `control-plane/src/organisms/NewWorkspaceModal.tsx`
- Modify: `control-plane/src/styles/components.css` (append `.new-workspace`, `.nw-repo-row`)
- Test: `control-plane/src/organisms/NewWorkspaceModal.test.tsx`

**Interfaces:**
- Produces: `WorkspaceRecord.runtime?: "tmux" | "docker" | "remote"`; repos element gains `initGit?: boolean`; `saveWorkspace` return broadens to `Promise<{ error?: string; name?: string }>` (the broker response body carries the created record; the type finally admits it — the server slugs names, so the modal must use the returned `name`); `NewWorkspaceModal` with props `{ open, onClose, save, list, listMyConnectors, activeWorkspace?, pickFolder?, onCreated }`.
- Consumes: `ConnectorInstanceRecord`, `SegmentedControl` (`{options: {id,label}[], selected, onSelect: (id: string) => void, ariaLabel}` — renders `role="tab"` buttons with `aria-selected`), CSS classes `.scrim` (needs `data-open="true"` or invisible), `.workspace-manager__head`, `.account-panel__form`, `.settings-btn*`, `.wizard__hint`/`.wizard__error`, `.repo-row__remove`.
- **Do NOT copy** `WorkspaceManagerModal.submit`'s normalizer (it silently drops `github` — and the connectorId — when owner/repo are blank); here owner/repo/connector are all required, so nothing is normalized away. **Do NOT reuse `.repo-row`** (its 4-column grid is already wrong for its own children).

- [ ] **Step 1: Extend the types** — `useBrokerChat.ts`: in `WorkspaceRecord.repos` element add `initGit?: boolean;` after `github?`; after `atlassian?` add:

```ts
  /** Execution environment for this workspace's tasks; unset = swarm's server default. */
  runtime?: "tmux" | "docker" | "remote";
```

and change `saveWorkspace`'s signature/cast to `Promise<{ error?: string; name?: string }>` / `as { error?: string; name?: string }`.

- [ ] **Step 2: Write the failing tests** — `control-plane/src/organisms/NewWorkspaceModal.test.tsx`:

```tsx
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewWorkspaceModal } from "./NewWorkspaceModal";

const CONNECTORS = [
  { id: "gh-1", vendorId: "github", label: "personal", fields: {} },
  { id: "gh-2", vendorId: "github", label: "acme-corp", fields: {} },
  { id: "atl-1", vendorId: "atlassian", label: "personal", fields: {} },
];

function props(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    save: vi.fn(async () => ({ name: "acme" })),
    list: vi.fn(async () => []),
    listMyConnectors: vi.fn(async () => CONNECTORS),
    onCreated: vi.fn(),
    ...overrides,
  };
}

async function fillOneValidRepo() {
  await userEvent.type(screen.getByPlaceholderText("acme"), "My App");
  await userEvent.type(screen.getByPlaceholderText("web"), "web");
  await userEvent.type(screen.getByPlaceholderText(/acme-web/), "/Users/me/code/acme-web");
  await userEvent.type(screen.getByPlaceholderText("GitHub owner"), "acme");
  await userEvent.type(screen.getByPlaceholderText("GitHub repo"), "web");
  await userEvent.selectOptions(await screen.findByLabelText(/github connector/i), "gh-1");
}

describe("NewWorkspaceModal", () => {
  afterEach(() => {
    cleanup();
  });

  it("connector select lists only github-vendor connectors and offers no pickable empty option", async () => {
    render(<NewWorkspaceModal {...props()} />);
    const select = await screen.findByLabelText(/github connector/i);
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toContain("personal");
    expect(options).toContain("acme-corp");
    expect(options).not.toContain("— none picked —");
    expect(select.querySelector<HTMLOptionElement>('option[value=""]')?.disabled).toBe(true);
  });

  it("create stays disabled until name, repo fields, and the connector are all present", async () => {
    render(<NewWorkspaceModal {...props()} />);
    const create = (await screen.findByRole("button", { name: /create workspace/i })) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await userEvent.type(screen.getByPlaceholderText("acme"), "My App");
    await userEvent.type(screen.getByPlaceholderText("web"), "web");
    await userEvent.type(screen.getByPlaceholderText(/acme-web/), "/Users/me/code/acme-web");
    await userEvent.type(screen.getByPlaceholderText("GitHub owner"), "acme");
    await userEvent.type(screen.getByPlaceholderText("GitHub repo"), "web");
    expect(create.disabled).toBe(true); // connector still unpicked — the required gate
    await userEvent.selectOptions(await screen.findByLabelText(/github connector/i), "gh-1");
    expect(create.disabled).toBe(false);
  });

  it("create posts runtime + required connector and hands the server-slugged name to onCreated", async () => {
    const save = vi.fn(async () => ({ name: "my-app" }));
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<NewWorkspaceModal {...props({ save, onCreated, onClose })} />);
    await fillOneValidRepo();
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "My App",
          runtime: "tmux",
          repos: [
            expect.objectContaining({
              name: "web",
              path: "/Users/me/code/acme-web",
              github: expect.objectContaining({ owner: "acme", repo: "web", connectorId: "gh-1" }),
            }),
          ],
        }),
        true,
      ),
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("my-app"));
    expect(onClose).toHaveBeenCalled();
  });

  it("defaults execution mode to the active workspace's runtime", async () => {
    const list = vi.fn(async () => [{ name: "acme", default: true, repos: [], runtime: "docker" }]);
    render(<NewWorkspaceModal {...props({ list, activeWorkspace: "acme" })} />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    const dockerTab = await screen.findByRole("tab", { name: "Local Docker" });
    await waitFor(() => expect(dockerTab.getAttribute("aria-selected")).toBe("true"));
  });

  it("a save error is shown inline and onCreated never fires", async () => {
    const save = vi.fn(async () => ({ error: 'Repo "web": /nope is not a git repository' }));
    const onCreated = vi.fn();
    render(<NewWorkspaceModal {...props({ save, onCreated })} />);
    await fillOneValidRepo();
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    expect(await screen.findByText(/is not a git repository/)).toBeDefined();
    expect(onCreated).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail** — `pnpm run test` → FAIL: module `./NewWorkspaceModal` not found.

- [ ] **Step 4: Implement the component** — `control-plane/src/organisms/NewWorkspaceModal.tsx`:

```tsx
import { Plus, X } from "lucide-react";
import { type MouseEvent, useEffect, useState } from "react";
import { SegmentedControl } from "../atoms/SegmentedControl";
import type { ConnectorInstanceRecord, WorkspaceRecord } from "../hooks/useBrokerChat";

type RuntimeChoice = "tmux" | "docker" | "remote";

const RUNTIME_OPTIONS = [
  { id: "tmux", label: "In process" },
  { id: "docker", label: "Local Docker" },
  { id: "remote", label: "Remote Docker" },
];

interface DraftRepo {
  name: string;
  path: string;
  owner: string;
  repo: string;
  connectorId: string;
}

const emptyRepo = (): DraftRepo => ({ name: "", path: "", owner: "", repo: "", connectorId: "" });

interface NewWorkspaceModalProps {
  open: boolean;
  onClose: () => void;
  /** POST /workspaces via the broker proxy — same function WorkspaceManagerModal uses. */
  save: (ws: WorkspaceRecord, isNew: boolean) => Promise<{ error?: string; name?: string }>;
  /** Full records — used only to default the execution mode to the active workspace's runtime. */
  list: () => Promise<WorkspaceRecord[]>;
  listMyConnectors: () => Promise<ConnectorInstanceRecord[]>;
  /** The session's current workspace name, if any. */
  activeWorkspace?: string;
  /** Native folder picker — absent outside the Tauri shell (Task 7 renders Browse only when provided). */
  pickFolder?: () => Promise<string | null>;
  /** Called with the created (server-slugged) workspace name — the caller creates + activates the first session. */
  onCreated: (name: string) => void;
}

export function NewWorkspaceModal({
  open,
  onClose,
  save,
  list,
  listMyConnectors,
  activeWorkspace,
  pickFolder,
  onCreated,
}: NewWorkspaceModalProps) {
  const [name, setName] = useState("");
  const [repos, setRepos] = useState<DraftRepo[]>([emptyRepo()]);
  const [runtime, setRuntime] = useState<RuntimeChoice>("tmux");
  const [connectors, setConnectors] = useState<ConnectorInstanceRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: open-keyed reset, same pattern as WorkspaceManagerModal
  useEffect(() => {
    if (!open) return;
    setName("");
    setRepos([emptyRepo()]);
    setBusy(false);
    setError(null);
    void listMyConnectors().then(setConnectors);
    // Execution mode defaults to the active workspace's own runtime, not a hardcoded value (design §4).
    void list().then((records) => {
      setRuntime(records.find((w) => w.name === activeWorkspace)?.runtime ?? "tmux");
    });
  }, [open]);

  const githubConnectors = connectors.filter((c) => c.vendorId === "github");

  const updateRepo = (index: number, patch: Partial<DraftRepo>) => {
    setRepos((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const canCreate =
    name.trim().length > 0 &&
    repos.every((r) => r.name.trim() && r.path.trim() && r.owner.trim() && r.repo.trim() && r.connectorId);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const record: WorkspaceRecord = {
      name: name.trim(),
      default: false, // the first-ever workspace defaults itself server-side
      runtime,
      repos: repos.map((r) => ({
        name: r.name.trim(),
        path: r.path.trim(),
        branch: "main",
        github: { owner: r.owner.trim(), repo: r.repo.trim(), connectorId: r.connectorId },
      })),
    };
    const result = await save(record, true).catch((err: unknown): { error?: string } => ({ error: String(err) }));
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    // The server slugs the name ("My App" -> "my-app") — the first session must target the saved name.
    onCreated(result.name ?? record.name);
    onClose();
  };

  const onScrimClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  if (!open) return null;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click-outside dismiss, same pattern as WorkspaceManagerModal
    <div className="scrim" data-open="true" role="dialog" aria-modal="true" aria-label="New workspace" onClick={onScrimClick}>
      <section className="new-workspace">
        <header className="workspace-manager__head">
          <h3>New workspace</h3>
          <button type="button" className="settings-btn" onClick={onClose}>
            close
          </button>
        </header>
        <div className="account-panel__form">
          <label htmlFor="nw-name">Workspace name</label>
          <input id="nw-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="acme" />
        </div>
        <p className="wizard__hint">Repos — every repo needs a GitHub connector before create enables.</p>
        {githubConnectors.length === 0 && (
          <p className="wizard__hint">No GitHub connectors yet — add one in Settings → Integrations first.</p>
        )}
        {repos.map((repo, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until saved; only appended/removed at the ends
          <div key={i} className="nw-repo-row">
            <input value={repo.name} onChange={(e) => updateRepo(i, { name: e.target.value })} placeholder="web" />
            <input
              value={repo.path}
              onChange={(e) => updateRepo(i, { path: e.target.value })}
              placeholder="/Users/me/code/acme-web"
            />
            <input value={repo.owner} onChange={(e) => updateRepo(i, { owner: e.target.value })} placeholder="GitHub owner" />
            <input value={repo.repo} onChange={(e) => updateRepo(i, { repo: e.target.value })} placeholder="GitHub repo" />
            <select
              aria-label="GitHub connector"
              value={repo.connectorId}
              onChange={(e) => updateRepo(i, { connectorId: e.target.value })}
            >
              <option value="" disabled>
                pick a connector…
              </option>
              {githubConnectors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="repo-row__remove"
              onClick={() => setRepos((rs) => rs.filter((_, j) => j !== i))}
              disabled={repos.length <= 1}
              aria-label="Remove repo"
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        ))}
        <button type="button" className="settings-btn" onClick={() => setRepos((rs) => [...rs, emptyRepo()])}>
          <Plus size={11} strokeWidth={2.2} /> add another
        </button>
        <p className="wizard__hint">Execution mode</p>
        <SegmentedControl
          ariaLabel="Execution mode"
          options={RUNTIME_OPTIONS}
          selected={runtime}
          onSelect={(id) => setRuntime(id as RuntimeChoice)}
        />
        {error && <p className="wizard__error">{error}</p>}
        <button
          type="button"
          className="settings-btn settings-btn--primary settings-btn--wide"
          onClick={() => void submit()}
          disabled={busy || !canCreate}
        >
          {busy ? "creating…" : "create workspace"}
        </button>
      </section>
    </div>
  );
}
```

- [ ] **Step 5: Append the CSS** — `control-plane/src/styles/components.css` (bottom of file):

```css
/* ── New-workspace modal — the rail's lean create flow ─────────────── */
.new-workspace {
  width: min(600px, 94vw);
  max-height: 86vh;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: var(--pill);
  border: 1px solid var(--pill-br);
  border-radius: 18px;
  backdrop-filter: blur(20px) saturate(1.3);
  box-shadow: 0 30px 90px rgba(0, 0, 0, 0.5);
  padding: 22px;
  animation: rise 0.28s ease both;
}
.nw-repo-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding: 10px;
  border: 1px solid var(--pill-br);
  border-radius: 12px;
}
.nw-repo-row input,
.nw-repo-row select {
  flex: 1 1 110px;
  min-width: 0;
  background: var(--bg-2, transparent);
  border: 1px solid var(--pill-br);
  border-radius: 8px;
  padding: 6px 8px;
  color: var(--text);
  font-size: 12px;
}
.nw-repo-row input:nth-of-type(2) {
  flex: 2 1 220px;
}
```

(then eyeball against `.repo-row input` at components.css:1813 and match any token drift — the intent is visual parity with the manager modal's inputs)

- [ ] **Step 6: Run tests to verify they pass** — `pnpm run test` (all 5 new + 37 existing), `pnpm run typecheck`, `pnpm run lint`. Expected: PASS/clean.

- [ ] **Step 7: Commit**

```bash
git add control-plane/src/hooks/useBrokerChat.ts control-plane/src/organisms/NewWorkspaceModal.tsx control-plane/src/organisms/NewWorkspaceModal.test.tsx control-plane/src/styles/components.css
git commit -m "feat(control-plane): NewWorkspaceModal — lean create flow with required per-repo GitHub connector and execution mode"
```

---

### Task 7: control-plane — "New folder" mode: toggle, native Browse, `initGit`

**Files:**
- Create: `control-plane/src/services/nativeDialog.ts` (new dir)
- Modify: `control-plane/src/organisms/NewWorkspaceModal.tsx`
- Test: `control-plane/src/organisms/NewWorkspaceModal.test.tsx`

**Interfaces:**
- Produces: `hasNativeFolderPicker(): boolean` and `pickFolder(): Promise<string | null>` (nativeDialog.ts, consumed by Task 8's HomePage); `DraftRepo` gains `mode: "existing" | "new"`; submitted repos carry `initGit: true` when `mode === "new"`.
- Consumes: Task 5's plugin + permission; Task 6's component and `pickFolder?` prop (already declared there).

- [ ] **Step 1: Write the failing tests** — append to `NewWorkspaceModal.test.tsx`:

```tsx
  it("new-folder mode with a native picker: Browse fills the path and submit carries initGit", async () => {
    const save = vi.fn(async () => ({ name: "fresh" }));
    const pickFolder = vi.fn(async () => "/Users/me/dev/fresh");
    render(<NewWorkspaceModal {...props({ save, pickFolder })} />);
    await userEvent.click(screen.getByRole("tab", { name: "New folder" }));
    await userEvent.click(await screen.findByRole("button", { name: /browse/i }));
    await waitFor(() =>
      expect((screen.getByPlaceholderText(/new-project/) as HTMLInputElement).value).toBe("/Users/me/dev/fresh"),
    );
    await userEvent.type(screen.getByPlaceholderText("acme"), "Fresh");
    await userEvent.type(screen.getByPlaceholderText("web"), "app");
    await userEvent.type(screen.getByPlaceholderText("GitHub owner"), "me");
    await userEvent.type(screen.getByPlaceholderText("GitHub repo"), "fresh");
    await userEvent.selectOptions(await screen.findByLabelText(/github connector/i), "gh-1");
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          repos: [expect.objectContaining({ path: "/Users/me/dev/fresh", initGit: true })],
        }),
        true,
      ),
    );
  });

  it("existing-repo mode never sends initGit", async () => {
    const save = vi.fn(async () => ({ name: "acme" }));
    render(<NewWorkspaceModal {...props({ save })} />);
    await fillOneValidRepo();
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const submitted = (save.mock.calls[0]![0] as { repos: Array<Record<string, unknown>> }).repos[0]!;
    expect("initGit" in submitted).toBe(false);
  });

  it("without a native picker the Browse button is absent; a typed path still works in new-folder mode", async () => {
    render(<NewWorkspaceModal {...props()} />);
    await userEvent.click(screen.getByRole("tab", { name: "New folder" }));
    expect(screen.queryByRole("button", { name: /browse/i })).toBeNull();
    await userEvent.type(screen.getByPlaceholderText(/new-project/), "/Users/me/dev/typed");
    expect((screen.getByPlaceholderText(/new-project/) as HTMLInputElement).value).toBe("/Users/me/dev/typed");
  });
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm run test` → FAIL: no `tab` named "New folder".

- [ ] **Step 3: Implement**

`control-plane/src/services/nativeDialog.ts`:

```ts
import { isTauri } from "@tauri-apps/api/core";

/** True only inside the Tauri shell — the shared bundle must keep working in a plain browser (README's zero-Tauri-APIs rule). */
export function hasNativeFolderPicker(): boolean {
  return isTauri();
}

/** Native OS folder dialog. Resolves the picked absolute path, or null on cancel / outside Tauri. Dynamic import keeps the plugin out of the browser/jsdom bundle. */
export async function pickFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false });
  return typeof picked === "string" ? picked : null;
}
```

`NewWorkspaceModal.tsx` changes:

1. `DraftRepo` gains `mode`, `emptyRepo` sets it:

```ts
interface DraftRepo {
  /** Both modes converge on `path`; only the source of the value differs (design §4). */
  mode: "existing" | "new";
  name: string;
  path: string;
  owner: string;
  repo: string;
  connectorId: string;
}

const emptyRepo = (): DraftRepo => ({ mode: "existing", name: "", path: "", owner: "", repo: "", connectorId: "" });
```

2. A `browse` handler next to `updateRepo`:

```ts
  const browse = async (index: number) => {
    if (!pickFolder) return;
    const picked = await pickFolder();
    if (picked) updateRepo(index, { path: picked });
  };
```

3. Each repo row gains the mode toggle as its first child, the path placeholder becomes mode-dependent, and Browse renders after the path input only in new-folder mode with a picker present:

```tsx
          <div key={i} className="nw-repo-row">
            <SegmentedControl
              ariaLabel={`Repo ${i + 1} source`}
              options={[
                { id: "existing", label: "Existing repo" },
                { id: "new", label: "New folder" },
              ]}
              selected={repo.mode}
              onSelect={(id) => updateRepo(i, { mode: id as DraftRepo["mode"] })}
            />
            <input value={repo.name} onChange={(e) => updateRepo(i, { name: e.target.value })} placeholder="web" />
            <input
              value={repo.path}
              onChange={(e) => updateRepo(i, { path: e.target.value })}
              placeholder={repo.mode === "new" ? "/Users/me/code/new-project" : "/Users/me/code/acme-web"}
            />
            {repo.mode === "new" && pickFolder && (
              <button type="button" className="settings-btn" onClick={() => void browse(i)}>
                Browse…
              </button>
            )}
```

(the SegmentedControl needs full row width — add to the CSS block: `.nw-repo-row .seg { flex: 1 1 100%; }`)

4. `submit`'s repo mapping carries the flag:

```ts
      repos: repos.map((r) => ({
        name: r.name.trim(),
        path: r.path.trim(),
        branch: "main",
        github: { owner: r.owner.trim(), repo: r.repo.trim(), connectorId: r.connectorId },
        ...(r.mode === "new" ? { initGit: true } : {}),
      })),
```

- [ ] **Step 4: Run tests to verify they pass** — `pnpm run test`, `pnpm run typecheck`, `pnpm run lint`. Expected: PASS/clean (jsdom never reaches the dynamic import — `pickFolder` is prop-injected in tests and absent by default).

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/services/nativeDialog.ts control-plane/src/organisms/NewWorkspaceModal.tsx control-plane/src/organisms/NewWorkspaceModal.test.tsx control-plane/src/styles/components.css
git commit -m "feat(control-plane): new-folder repo mode — native Browse via tauri dialog, initGit flag on submit"
```

---

### Task 8: control-plane — `ToolRail` plus button, HomePage wiring, clickable hint

**Files:**
- Modify: `control-plane/src/organisms/ToolRail.tsx` (whole file, 40 lines)
- Modify: `control-plane/src/pages/HomePage.tsx` (leftRail ~line 141-145, hint ~line 184-189, modal renders ~line 227+, imports, state ~line 29-31)
- Modify: `control-plane/src/styles/base.css` (append `.subhint__session`)
- Test: `control-plane/src/organisms/ToolRail.test.tsx` (new)

**Interfaces:**
- Produces: `ToolRailProps` = `{ onNewWorkspace?: () => void; onSettings?: () => void }` (replacing `onSessions`).
- Consumes: Task 6/7's `NewWorkspaceModal` + `nativeDialog`; existing `useBrokerChat` values HomePage already destructures (`saveWorkspace`, `listWorkspaceRecords`, `listMyConnectors`, `createSession`, `session`); `ToolButton` (sets `aria-label={label}`, so role-name queries work).
- Gotcha: ToolRail dispatches on the **literal label string** — the label and the `if` must change together.

- [ ] **Step 1: Write the failing test** — `control-plane/src/organisms/ToolRail.test.tsx`:

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRail } from "./ToolRail";

describe("ToolRail", () => {
  afterEach(() => {
    cleanup();
  });

  it("the rail's single tool is New workspace and clicking it fires onNewWorkspace", async () => {
    const onNewWorkspace = vi.fn();
    render(<ToolRail onNewWorkspace={onNewWorkspace} />);
    expect(screen.queryByRole("button", { name: /new session/i })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /new workspace/i }));
    expect(onNewWorkspace).toHaveBeenCalledTimes(1);
  });

  it("settings button still fires onSettings", async () => {
    const onSettings = vi.fn();
    render(<ToolRail onSettings={onSettings} />);
    await userEvent.click(screen.getByRole("button", { name: /settings/i }));
    expect(onSettings).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm run test` → FAIL: no button named /new workspace/.

- [ ] **Step 3: Implement `ToolRail`** — replace lines 1-17 region as follows (map body and Settings row unchanged apart from the label check):

```tsx
import { Plus, Settings } from "lucide-react";
import { useState } from "react";
import { Logo } from "../atoms/Logo";
import { ToolButton } from "../atoms/ToolButton";

const TOOLS = [{ icon: Plus, label: "New workspace" }];

interface ToolRailProps {
  /** "New workspace" tool — opens the create-workspace flow directly (design §5). */
  onNewWorkspace?: () => void;
  /** Settings — the reset surface. */
  onSettings?: () => void;
}

// No operator avatar: there's no "account" concept in an all-local, single-operator
// app — reintroduce it when cloud hosting makes identity meaningful.
export function ToolRail({ onNewWorkspace, onSettings }: ToolRailProps) {
```

and inside the map's onClick:

```tsx
            if (tool.label === "New workspace") onNewWorkspace?.();
```

- [ ] **Step 4: Implement HomePage wiring**

Imports: add `NewWorkspaceModal` and `import { hasNativeFolderPicker, pickFolder } from "../services/nativeDialog";`. State (next to `workspacesOpen`): `const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);`

leftRail:

```tsx
      leftRail={
        <ToolRail onNewWorkspace={() => setNewWorkspaceOpen(true)} onSettings={() => setSettingsOpen(true)} />
      }
```

hint (replaces the current block — the `{title} · {workspace}` text becomes the Sessions-panel opener, the rail's lost affordance per design §5):

```tsx
      hint={
        <>
          {session && (
            <>
              <button type="button" className="subhint__session" onClick={() => setSessionsOpen((open) => !open)}>
                {session.title} · {session.workspace}
              </button>
              {" — "}
            </>
          )}
          agents raise ✋ when they have something to add — click their circle to give them the floor · press{" "}
          <kbd>g</kbd> to tune the grid
        </>
      }
```

Render, next to the `WorkspaceManagerModal`:

```tsx
          <NewWorkspaceModal
            open={newWorkspaceOpen}
            onClose={() => setNewWorkspaceOpen(false)}
            save={saveWorkspace}
            list={listWorkspaceRecords}
            listMyConnectors={listMyConnectors}
            activeWorkspace={session?.workspace}
            pickFolder={hasNativeFolderPicker() ? pickFolder : undefined}
            onCreated={(name) => createSession(name)}
          />
```

(`createSession` is fire-and-forget; the broker activates the new session server-side and pushes the refreshed `session` WS frame — landing the UI in the new chat with no explicit activate call)

`control-plane/src/styles/base.css`, after the `.subhint kbd` rule:

```css
.subhint__session {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  letter-spacing: inherit;
  color: var(--text-2);
  cursor: pointer;
}
.subhint__session:hover {
  text-decoration: underline;
}
```

- [ ] **Step 5: Run everything** — `pnpm run test`, `pnpm run typecheck`, `pnpm run lint`. Expected: PASS/clean.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/organisms/ToolRail.tsx control-plane/src/organisms/ToolRail.test.tsx control-plane/src/pages/HomePage.tsx control-plane/src/styles/base.css
git commit -m "feat(control-plane): rail plus button opens NewWorkspaceModal; session hint becomes the sessions-panel opener"
```

---

### Task 9: Full verification + finish

- [ ] **Step 1: Full suites** — swarm `npm test` + `npm run typecheck` (expect only the 2 known agent-sessions timeouts), broker `npm test` + `npm run typecheck`, control-plane `pnpm run test` + `pnpm run typecheck` + `pnpm run lint`.
- [ ] **Step 2: Manual smoke (optional but recommended)** — `pnpm tauri dev` in control-plane: plus button opens the modal; New folder → Browse opens the native dialog; create lands in a fresh session; the hint's session name reopens the Sessions panel.
- [ ] **Step 3: Use superpowers:finishing-a-development-branch** — decide merge of `worktree-workspace-creation` with Edwin (note: main also needs the dropped 23da5ee/01a6ea6 cleanup back — this branch carries it, so merging restores it).

---

## Self-review (done at plan time)

- **Spec coverage:** §1 data model → Task 1; §2 repo init → Task 2; §3 runtime resolution → Task 3 (with the documented creation-time deviation); §4 API/broker → Tasks 1-4; §4 UI fields → Tasks 6-7; §5 rail/hint wiring → Task 8; native picking → Tasks 5+7; out-of-scope list respected (no WorkspaceManagerModal runtime picker, no Docker/worker config, no adjacency scanning).
- **Type consistency:** `runtime` union spelled identically in workspaces.ts / types.ts / swarm-client.ts / useBrokerChat.ts / RuntimeChoice; `resolveTaskRuntime` consumed with the same signature it's declared with; `workspaceRuntime` name matches between dispatcher change and test; `onCreated(result.name ?? record.name)` matches `saveWorkspace`'s broadened return.
- **Known judgment calls:** PUT /workspaces accepts `runtime` API-side (one line, keeps the API symmetric; the manager-modal picker stays out of scope per spec). `isGitRepo`'s walk-up semantics documented, not "fixed". Placeholder `<option>` is `disabled` rather than absent — satisfies "no none option" intent while keeping the select startable-empty.
