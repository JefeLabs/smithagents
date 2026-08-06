# CLI Tool Registry (Active Subscriptions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A machine-level registry of the agent CLI tools (claude, codex, opencode, copilot, agy) that auto-detects installation + auth status, gates the engine picker and agent create/edit, blocks warm-session launch and task dispatch for inactive tools, and surfaces status via a "CLI Tools" settings group plus a warning badge on affected rail agents.

**Architecture:** New `swarm/src/cli-tools.ts` module (status file `.smith/cli-tools.json` + probe orchestration) with per-driver auth probes as an optional `verifyAuth` method on `ToolDriver`. Swarm exposes three routes; broker adds a thin origin-restricted passthrough (same pattern as connectors); control-plane adds a settings card grid and a client-side agent-badge join. Spec: `docs/superpowers/specs/2026-08-06-cli-tool-registry-design.md`.

**Tech Stack:** TypeScript ESM (`.js` import suffixes), Fastify (swarm), hand-rolled `node:http` (broker), React (control-plane). Tests: `node --import tsx --test` for swarm and broker (co-located `src/*.test.ts`), vitest for control-plane. No new dependencies.

## Global Constraints

- **Block only confirmed negatives.** An absent status file, absent tool entry, or `authOk: 'unknown'` NEVER blocks anything. Blocking requires a persisted entry saying `detected: false`, `enabled: false`, or `authOk: false`.
- **Status file:** `<swarm cwd>/.smith/cli-tools.json` — dir mode `0o700`, file mode `0o600` (mirror `swarm/src/channels.ts:36-38`). Already untracked (`.gitignore` tracks only `agents/`, `workspaces/`, `squads/` under `.smith/`).
- **Probe timeouts:** auth probe 10_000 ms, version probe 5_000 ms. Probes never throw; the sweep always completes for every tool.
- **`verifyAuth` is OPTIONAL on `ToolDriver`** (so existing fake drivers in tests keep compiling) and must return `ok: false` only on a CONFIRMED logged-out signal; unrecognizable output → `'unknown'`.
- **`enabled` defaults to `true`** on first detection (migration-critical: ignacio/wilkin keep working the moment this ships).
- **Imports use `.js` suffixes** (`from './cli-tools.js'`) — this is an ESM/tsx codebase.
- **Run tests from the package dir:** `cd swarm && npm test`, `cd broker && npm test`, `cd control-plane && npm test`. A single swarm test file: `cd swarm && node --import tsx --test src/cli-tools.test.ts`.
- Commit messages: conventional commits ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Registry store + gate helpers (`cli-tools.ts` core)

**Files:**
- Create: `swarm/src/cli-tools.ts`
- Create: `swarm/src/cli-tools.test.ts`
- Modify: `docs/superpowers/specs/2026-08-06-cli-tool-registry-design.md` (two-line amendment)

**Interfaces:**
- Consumes: `EngineOption` from `swarm/src/personas.ts:160-166` (`{ cli, label, models, warmSessions, note? }`).
- Produces (later tasks import all of these from `./cli-tools.js`):
  - `interface CliToolStatus { detected: boolean; authOk: boolean | 'unknown'; enabled: boolean; detail: string; version?: string; lastCheckedAt: string }`
  - `interface CliToolsFile { version: 1; tools: Record<string, CliToolStatus> }`
  - `interface CliToolListing extends EngineOption { status: CliToolStatus | null; active: boolean }`
  - `emptyCliToolsFile(): CliToolsFile`
  - `loadCliToolsFile(path: string): Promise<CliToolsFile>` — corrupt/missing → empty
  - `saveCliToolsFile(path: string, file: CliToolsFile): Promise<void>` — 0700/0600
  - `isActive(status: CliToolStatus | undefined): boolean` — undefined → **true**
  - `inactiveDetail(status: CliToolStatus | undefined): string` — '' when active
  - `gateReason(file: CliToolsFile, cli: string): string` — '' when assignable
  - `buildCliToolListings(engines: EngineOption[], file: CliToolsFile): CliToolListing[]`

- [ ] **Step 1: Amend the spec's `isActive` contract**

The spec says `// undefined -> false` for `isActive`, which contradicts its own "Block only confirmed negatives" settled decision and would break agent creation on a fresh boot before the first sweep lands. In `docs/superpowers/specs/2026-08-06-cli-tool-registry-design.md`:

Replace:
```
export function isActive(s: CliToolStatus | undefined): boolean;
// undefined -> false; else s.detected && s.enabled && s.authOk !== false
```
with:
```
export function isActive(s: CliToolStatus | undefined): boolean;
// undefined (never probed) -> true — ignorance never blocks;
// else s.detected && s.enabled && s.authOk !== false
```

Replace:
```
A probe never throws — any probe failure lands as `authOk: false` (or
`detected: false`) with the error in `detail`.
```
with:
```
A probe never throws — a confirmed negative lands as `authOk: false` (or
`detected: false`); unrecognizable output or probe errors land as
`authOk: 'unknown'`, with the reason in `detail`.
```

- [ ] **Step 2: Write the failing tests**

Create `swarm/src/cli-tools.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCliToolListings,
  emptyCliToolsFile,
  gateReason,
  inactiveDetail,
  isActive,
  loadCliToolsFile,
  saveCliToolsFile,
  type CliToolStatus,
} from './cli-tools.js';

const status = (over: Partial<CliToolStatus> = {}): CliToolStatus => ({
  detected: true,
  authOk: true,
  enabled: true,
  detail: 'ok',
  lastCheckedAt: '2026-08-06T00:00:00.000Z',
  ...over,
});

test('isActive: truth table — ignorance never blocks, confirmed negatives do', () => {
  assert.equal(isActive(undefined), true); // never probed
  assert.equal(isActive(status()), true);
  assert.equal(isActive(status({ authOk: 'unknown' })), true); // no reliable probe
  assert.equal(isActive(status({ detected: false })), false);
  assert.equal(isActive(status({ authOk: false })), false);
  assert.equal(isActive(status({ enabled: false })), false);
});

test('inactiveDetail: empty when active, reason otherwise, toggle beats auth wording', () => {
  assert.equal(inactiveDetail(undefined), '');
  assert.equal(inactiveDetail(status()), '');
  assert.equal(inactiveDetail(status({ detected: false, detail: 'binary not found' })), 'binary not found');
  assert.equal(inactiveDetail(status({ enabled: false })), 'disabled in Settings → CLI Tools');
  assert.equal(inactiveDetail(status({ authOk: false, detail: 'not logged in' })), 'not logged in');
});

test('gateReason: empty for unknown tool (no entry) and for active tools', () => {
  const file = emptyCliToolsFile();
  file.tools.codex = status({ authOk: false, detail: 'not logged in — run `codex login`' });
  assert.equal(gateReason(file, 'claude'), ''); // no entry -> assignable
  assert.equal(gateReason(file, 'codex'), 'not logged in — run `codex login`');
});

test('load/save round-trip, 0600 file mode, and corrupt/missing files regenerate empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-tools-'));
  const path = join(dir, 'nested', 'cli-tools.json');
  assert.deepEqual(await loadCliToolsFile(path), emptyCliToolsFile()); // missing
  const file = emptyCliToolsFile();
  file.tools.claude = status();
  await saveCliToolsFile(path, file);
  assert.deepEqual(await loadCliToolsFile(path), file);
  const st = await stat(path);
  assert.equal(st.mode & 0o777, 0o600);
  await writeFile(path, '{not json');
  assert.deepEqual(await loadCliToolsFile(path), emptyCliToolsFile()); // corrupt
});

test('buildCliToolListings joins the catalog with statuses; unprobed tools list as active with null status', () => {
  const engines = [
    { cli: 'claude', label: 'Claude Code', models: ['claude-opus'], warmSessions: true },
    { cli: 'codex', label: 'Codex', models: ['gpt-5'], warmSessions: true },
  ];
  const file = emptyCliToolsFile();
  file.tools.codex = status({ authOk: false, detail: 'not logged in' });
  const listings = buildCliToolListings(engines, file);
  assert.equal(listings.length, 2);
  assert.equal(listings[0]!.cli, 'claude');
  assert.equal(listings[0]!.status, null);
  assert.equal(listings[0]!.active, true);
  assert.equal(listings[1]!.active, false);
  assert.equal(listings[1]!.status?.detail, 'not logged in');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd swarm && node --import tsx --test src/cli-tools.test.ts`
Expected: FAIL — `Cannot find module './cli-tools.js'`

- [ ] **Step 4: Implement the module**

Create `swarm/src/cli-tools.ts`:

```ts
// CLI tool registry — machine-level status of the agent CLI tools (spec:
// docs/superpowers/specs/2026-08-06-cli-tool-registry-design.md). ENGINES
// (personas.ts) says which tools CAN exist; this file records which ones this
// machine actually has: detected on PATH, auth-probed via the tool's driver,
// and user-enabled. One untracked JSON file under .smith/ — a machine fact,
// not a per-user fact, so it does not live on the User record. The gate rule
// throughout: block only confirmed negatives, never ignorance.
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { EngineOption } from './personas.js';

export interface CliToolStatus {
  detected: boolean;              // binary resolvable on PATH
  authOk: boolean | 'unknown';    // driver auth probe result
  enabled: boolean;               // user toggle; defaults true on first detection
  detail: string;                 // human-readable, e.g. "logged in as …"
  version?: string;               // tool-reported version when cheaply available
  lastCheckedAt: string;          // ISO timestamp of last probe
}

export interface CliToolsFile {
  version: 1;
  tools: Record<string, CliToolStatus>;
}

/** One catalog engine joined with this machine's status — drives the whole Settings UI. */
export interface CliToolListing extends EngineOption {
  status: CliToolStatus | null;
  active: boolean;
}

export function emptyCliToolsFile(): CliToolsFile {
  return { version: 1, tools: {} };
}

/** Corrupt or missing file -> empty (the next sweep regenerates it). */
export async function loadCliToolsFile(path: string): Promise<CliToolsFile> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as CliToolsFile;
    if (parsed?.version === 1 && parsed.tools && typeof parsed.tools === 'object') return parsed;
    return emptyCliToolsFile();
  } catch {
    return emptyCliToolsFile();
  }
}

/** Owner-only permissions, mirror of channels.ts saveChannels. */
export async function saveCliToolsFile(path: string, file: CliToolsFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const fh = await open(path, 'w', 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(file, null, 2)}\n`);
  } finally {
    await fh.close();
  }
}

/**
 * Active = assignable to agents and launchable. undefined (never probed) is
 * ACTIVE: we block only confirmed negatives — a missing binary, a confirmed
 * logged-out state, or the user's own toggle. 'unknown' auth counts as active.
 */
export function isActive(status: CliToolStatus | undefined): boolean {
  if (!status) return true;
  return status.detected && status.enabled && status.authOk !== false;
}

/** Human reason a tool is inactive; '' when active. */
export function inactiveDetail(status: CliToolStatus | undefined): string {
  if (!status || isActive(status)) return '';
  if (!status.detected) return status.detail || 'binary not found on PATH';
  if (!status.enabled) return 'disabled in Settings → CLI Tools';
  return status.detail || 'not logged in';
}

/** '' when `cli` may be assigned/launched; else the human reason to refuse. */
export function gateReason(file: CliToolsFile, cli: string): string {
  return isActive(file.tools[cli]) ? '' : inactiveDetail(file.tools[cli]);
}

export function buildCliToolListings(engines: EngineOption[], file: CliToolsFile): CliToolListing[] {
  return engines.map((e) => ({
    ...e,
    status: file.tools[e.cli] ?? null,
    active: isActive(file.tools[e.cli]),
  }));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd swarm && node --import tsx --test src/cli-tools.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add swarm/src/cli-tools.ts swarm/src/cli-tools.test.ts docs/superpowers/specs/2026-08-06-cli-tool-registry-design.md
git commit -m "feat(swarm): cli-tool registry store + gate helpers

Status file load/save (0600, corrupt-safe), isActive/gateReason with the
block-only-confirmed-negatives rule, catalog join. Spec amended: undefined
status is active — ignorance never blocks.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: CommandRunner + probe sweep orchestration

**Files:**
- Modify: `swarm/src/drivers/types.ts` (append to `ToolDriver`, add `CommandRunner` type)
- Modify: `swarm/src/cli-tools.ts` (append sweep functions)
- Modify: `swarm/src/cli-tools.test.ts` (append sweep tests)

**Interfaces:**
- Consumes: Task 1's `CliToolsFile`, `loadCliToolsFile`, `saveCliToolsFile`.
- Produces:
  - `type CommandRunner = (argv: string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>` (in `drivers/types.ts`)
  - `ToolDriver.verifyAuth?(binary: string, run: CommandRunner, timeoutMs: number): Promise<{ ok: boolean | 'unknown'; detail: string }>` (optional method)
  - `defaultRunner: CommandRunner`
  - `interface SweepDeps { agentCommands: Record<string, string>; clis: string[]; run?: CommandRunner; resolveDriver?: (id: string) => Pick<ToolDriver, 'verifyAuth'> | null; authTimeoutMs?: number; now?: () => string }`
  - `sweepCliTools(path: string, deps: SweepDeps, only?: string): Promise<CliToolsFile>`
  - `refreshCliTool(path: string, agentCommands: Record<string, string>, cli: string): Promise<void>` — one-tool sweep with production deps (the on-failure hook)

- [ ] **Step 1: Add `CommandRunner` and the optional `verifyAuth` to the driver contract**

In `swarm/src/drivers/types.ts`, add above `export interface ToolDriver`:

```ts
/**
 * Injected subprocess runner for auth probes — tests stub it; production is
 * cli-tools.defaultRunner. Resolves (never rejects) with the exit code
 * (null when killed/timed out) and captured output.
 */
export type CommandRunner = (
  argv: string[],
  timeoutMs: number,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;
```

Inside `ToolDriver` (after the `materialize` member, before the closing brace):

```ts
  /**
   * Auth/subscription probe for the CLI tool registry. Optional: tools with
   * no reliable non-interactive status command omit it and the registry
   * records authOk 'unknown' — treated as active, since the gate blocks only
   * confirmed negatives. Implementations must not throw and must return
   * ok:false only on a CONFIRMED logged-out signal; anything unrecognizable
   * is 'unknown'. `binary` is the bare executable (no flags).
   */
  verifyAuth?(
    binary: string,
    run: CommandRunner,
    timeoutMs: number,
  ): Promise<{ ok: boolean | 'unknown'; detail: string }>;
```

- [ ] **Step 2: Write the failing sweep tests**

Append to `swarm/src/cli-tools.test.ts` (add `sweepCliTools, type SweepDeps` to the `./cli-tools.js` import, and `import type { CommandRunner } from './drivers/types.js';`):

```ts
const fixedNow = () => '2026-08-06T12:00:00.000Z';

/** Runner scripted by argv[1] ('auth'/'login'/'--version') and argv[0] (binary). */
const scriptedRun =
  (script: Record<string, { code: number | null; stdout: string; stderr?: string }>): CommandRunner =>
  async (argv) => {
    const key = argv.join(' ');
    const hit = Object.entries(script).find(([k]) => key.includes(k));
    return hit ? { stderr: '', ...hit[1] } : { code: 127, stdout: '', stderr: 'not found' };
  };

test('sweepCliTools: detected+auth-ok tool gets a full active entry with version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-tools-'));
  const path = join(dir, 'cli-tools.json');
  const deps: SweepDeps = {
    agentCommands: { claude: 'claude --dangerously-skip-permissions' },
    clis: ['claude'],
    run: scriptedRun({
      'command -v': { code: 0, stdout: '/usr/local/bin/claude\n' },
      '--version': { code: 0, stdout: '2.1.0 (Claude Code)\n' },
    }),
    resolveDriver: () => ({
      verifyAuth: async () => ({ ok: true, detail: 'logged in as edwin' }),
    }),
    now: fixedNow,
  };
  const file = await sweepCliTools(path, deps);
  assert.deepEqual(file.tools.claude, {
    detected: true,
    authOk: true,
    enabled: true,
    detail: 'logged in as edwin',
    version: '2.1.0 (Claude Code)',
    lastCheckedAt: fixedNow(),
  });
  assert.deepEqual(await loadCliToolsFile(path), file); // persisted
});

test('sweepCliTools: missing binary -> detected:false; no driver probe -> authOk unknown; enabled survives', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-tools-'));
  const path = join(dir, 'cli-tools.json');
  const prior = emptyCliToolsFile();
  prior.tools.agy = status({ enabled: false }); // user toggled off earlier
  await saveCliToolsFile(path, prior);
  const deps: SweepDeps = {
    agentCommands: { agy: 'agy --dangerously-skip-permissions', ghost: 'ghost' },
    clis: ['agy', 'ghost'],
    run: scriptedRun({ 'command -v -- agy': { code: 0, stdout: '/usr/local/bin/agy\n' } }),
    resolveDriver: () => null, // no verifyAuth anywhere
    now: fixedNow,
  };
  const file = await sweepCliTools(path, deps);
  assert.equal(file.tools.agy?.detected, true);
  assert.equal(file.tools.agy?.authOk, 'unknown');
  assert.equal(file.tools.agy?.enabled, false); // preserved, not reset to true
  assert.equal(file.tools.ghost?.detected, false);
  assert.equal(isActive(file.tools.ghost), false);
});

test('sweepCliTools with `only` re-probes one tool and leaves other entries untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-tools-'));
  const path = join(dir, 'cli-tools.json');
  const prior = emptyCliToolsFile();
  prior.tools.claude = status({ detail: 'stale-but-not-mine-to-touch' });
  await saveCliToolsFile(path, prior);
  const deps: SweepDeps = {
    agentCommands: { claude: 'claude', codex: 'codex --full-auto' },
    clis: ['claude', 'codex'],
    run: scriptedRun({ 'command -v -- codex': { code: 0, stdout: '/usr/local/bin/codex\n' } }),
    resolveDriver: () => ({ verifyAuth: async () => ({ ok: false, detail: 'not logged in' }) }),
    now: fixedNow,
  };
  const file = await sweepCliTools(path, deps, 'codex');
  assert.equal(file.tools.claude?.detail, 'stale-but-not-mine-to-touch'); // untouched
  assert.equal(file.tools.codex?.authOk, false);
});

test('sweepCliTools: a throwing verifyAuth lands as unknown, never rejects the sweep', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-tools-'));
  const path = join(dir, 'cli-tools.json');
  const deps: SweepDeps = {
    agentCommands: { codex: 'codex' },
    clis: ['codex'],
    run: scriptedRun({ 'command -v': { code: 0, stdout: '/usr/local/bin/codex\n' } }),
    resolveDriver: () => ({
      verifyAuth: async () => {
        throw new Error('driver bug');
      },
    }),
    now: fixedNow,
  };
  const file = await sweepCliTools(path, deps);
  assert.equal(file.tools.codex?.authOk, 'unknown');
  assert.match(file.tools.codex?.detail ?? '', /driver bug/);
});
```

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `cd swarm && node --import tsx --test src/cli-tools.test.ts`
Expected: FAIL — `sweepCliTools` is not exported

- [ ] **Step 4: Implement the sweep**

Append to `swarm/src/cli-tools.ts` (add imports: `import { execFile } from 'node:child_process';`, `import { getDriver } from './drivers/index.js';`, `import type { CommandRunner, ToolDriver } from './drivers/types.js';`):

```ts
const AUTH_TIMEOUT_MS = 10_000;
const VERSION_TIMEOUT_MS = 5_000;

/** Production subprocess runner: resolves with exit code + output, never rejects. */
export const defaultRunner: CommandRunner = (argv, timeoutMs) =>
  new Promise((done) => {
    execFile(argv[0]!, argv.slice(1), { timeout: timeoutMs }, (err, stdout, stderr) => {
      const code = err
        ? typeof (err as { code?: unknown }).code === 'number'
          ? ((err as { code: number }).code)
          : null // killed by timeout/signal
        : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface SweepDeps {
  /** OrchestratorConfig.agentCommands — the binary is the first word. */
  agentCommands: Record<string, string>;
  /** Which tools to keep entries for — pass ENGINES.map(e => e.cli). */
  clis: string[];
  run?: CommandRunner;
  resolveDriver?: (id: string) => Pick<ToolDriver, 'verifyAuth'> | null;
  authTimeoutMs?: number;
  now?: () => string;
}

/**
 * Probe every tool in `deps.clis` (or just `only`) and persist the result.
 * Detection is generic (`command -v` on the configured binary); the auth
 * probe is the driver's, absent probe = 'unknown'. Entries for tools outside
 * this sweep are preserved verbatim; `enabled` always survives re-probes.
 */
export async function sweepCliTools(path: string, deps: SweepDeps, only?: string): Promise<CliToolsFile> {
  const run = deps.run ?? defaultRunner;
  const resolveDriver = deps.resolveDriver ?? getDriver;
  const authTimeoutMs = deps.authTimeoutMs ?? AUTH_TIMEOUT_MS;
  const now = deps.now ?? (() => new Date().toISOString());
  const file = await loadCliToolsFile(path);
  const targets = only ? deps.clis.filter((c) => c === only) : deps.clis;

  await Promise.all(
    targets.map(async (cli) => {
      const baseCommand = deps.agentCommands[cli] ?? cli;
      const binary = baseCommand.split(/\s+/)[0]!;
      const enabled = file.tools[cli]?.enabled ?? true;
      const entry: CliToolStatus = {
        detected: false,
        authOk: 'unknown',
        enabled,
        detail: '',
        lastCheckedAt: now(),
      };
      try {
        const found = await run(['/bin/sh', '-c', `command -v -- ${binary}`], VERSION_TIMEOUT_MS);
        entry.detected = found.code === 0 && found.stdout.trim().length > 0;
        if (!entry.detected) {
          entry.detail = `${binary} not found on PATH`;
        } else {
          const ver = await run([binary, '--version'], VERSION_TIMEOUT_MS);
          if (ver.code === 0 && ver.stdout.trim()) entry.version = ver.stdout.trim().split('\n')[0]!;
          const probe = resolveDriver(cli)?.verifyAuth;
          if (probe) {
            const auth = await probe(binary, run, authTimeoutMs);
            entry.authOk = auth.ok;
            entry.detail = auth.detail;
          } else {
            entry.authOk = 'unknown';
            entry.detail = 'no auth probe for this tool';
          }
        }
      } catch (err) {
        // A probe failure is not a confirmed negative — record it, stay 'unknown'.
        entry.authOk = 'unknown';
        entry.detail = `probe failed: ${String((err as Error).message ?? err)}`;
      }
      file.tools[cli] = entry;
    }),
  );

  await saveCliToolsFile(path, file);
  return file;
}

/** One-tool sweep with production deps — the launch-failure self-correction hook. */
export async function refreshCliTool(
  path: string,
  agentCommands: Record<string, string>,
  cli: string,
): Promise<void> {
  await sweepCliTools(path, { agentCommands, clis: [cli] }, cli);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd swarm && node --import tsx --test src/cli-tools.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 6: Run the full swarm suite to catch driver-typing fallout**

Run: `cd swarm && npm test`
Expected: PASS — `verifyAuth` is optional, so `FakeDriver` in `agent-sessions.test.ts` and every other `ToolDriver` implementer still compile.

- [ ] **Step 7: Commit**

```bash
git add swarm/src/cli-tools.ts swarm/src/cli-tools.test.ts swarm/src/drivers/types.ts
git commit -m "feat(swarm): cli-tool probe sweep + optional driver verifyAuth contract

Generic PATH detection + version capture in the orchestrator; auth is the
driver's optional probe. enabled survives re-probes; probe errors land as
'unknown', never thrown, never blocking.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Driver auth probes (claude, codex, opencode)

**Files:**
- Modify: `swarm/src/drivers/claude.ts` (add method to `ClaudeDriver`)
- Modify: `swarm/src/drivers/codex.ts` (add method to `CodexDriver`)
- Modify: `swarm/src/drivers/opencode.ts` (add method to `OpencodeDriver`)
- Create: `swarm/src/drivers/verify-auth.test.ts`

**Interfaces:**
- Consumes: `CommandRunner` + the `verifyAuth?` signature from Task 2.
- Produces: `verifyAuth` on the three drivers above. **copilot and agy deliberately get none** — `copilot` has only an interactive `login` subcommand (no status/whoami; verified against `copilot --help` 2026-08-06) and `agy` has no auth subcommand at all, so both report `'unknown'` via the sweep's no-probe branch.

Probe commands were verified live on this machine (2026-08-06):
- `claude auth status` → exit 0, JSON `{"loggedIn": true, "authMethod": "claude.ai", "email": "…"}`
- `codex login status` → exit 0, `Logged in using ChatGPT`
- `opencode auth list` → exit 0, credential list (opencode also runs local models, so its probe never confirms a negative)

- [ ] **Step 1: Write the failing tests**

Create `swarm/src/drivers/verify-auth.test.ts`:

```ts
// Auth probes with a stubbed runner — each driver's contract: ok:false only
// on a CONFIRMED logged-out signal, 'unknown' for anything unrecognizable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeDriver } from './claude.js';
import { CodexDriver } from './codex.js';
import { OpencodeDriver } from './opencode.js';
import type { CommandRunner } from './types.js';

const respond =
  (code: number | null, stdout: string, stderr = ''): CommandRunner =>
  async () => ({ code, stdout, stderr });

test('claude: loggedIn true -> ok with email; loggedIn false -> confirmed negative', async () => {
  const d = new ClaudeDriver();
  const yes = await d.verifyAuth('claude', respond(0, '{\n  "loggedIn": true,\n  "email": "edwin@acme.com"\n}'), 10_000);
  assert.deepEqual(yes, { ok: true, detail: 'logged in as edwin@acme.com' });
  const no = await d.verifyAuth('claude', respond(1, '{"loggedIn": false}'), 10_000);
  assert.equal(no.ok, false);
  assert.match(no.detail, /not logged in/);
});

test('claude: non-JSON output (old CLI, garbage) -> unknown, never false', async () => {
  const d = new ClaudeDriver();
  const res = await d.verifyAuth('claude', respond(1, 'error: unknown command "auth"'), 10_000);
  assert.equal(res.ok, 'unknown');
});

test('codex: exit 0 -> ok with first output line; "not logged in" -> confirmed negative; else unknown', async () => {
  const d = new CodexDriver();
  assert.deepEqual(await d.verifyAuth('codex', respond(0, 'Logged in using ChatGPT\n'), 10_000), {
    ok: true,
    detail: 'Logged in using ChatGPT',
  });
  const no = await d.verifyAuth('codex', respond(1, 'Not logged in.\n'), 10_000);
  assert.equal(no.ok, false);
  const weird = await d.verifyAuth('codex', respond(2, 'flag provided but not defined'), 10_000);
  assert.equal(weird.ok, 'unknown');
});

test('opencode: exit 0 -> ok; anything else -> unknown (local models mean auth never confirms a negative)', async () => {
  const d = new OpencodeDriver();
  assert.equal((await d.verifyAuth('opencode', respond(0, 'Credentials …'), 10_000)).ok, true);
  assert.equal((await d.verifyAuth('opencode', respond(1, ''), 10_000)).ok, 'unknown');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd swarm && node --import tsx --test src/drivers/verify-auth.test.ts`
Expected: FAIL — `verifyAuth` is not a function on each driver

- [ ] **Step 3: Implement the three probes**

In `swarm/src/drivers/claude.ts`, add to `ClaudeDriver` (import `CommandRunner` from `./types.js` alongside the existing type imports):

```ts
  async verifyAuth(
    binary: string,
    run: CommandRunner,
    timeoutMs: number,
  ): Promise<{ ok: boolean | 'unknown'; detail: string }> {
    // `claude auth status` prints JSON: {"loggedIn":true,"authMethod":"claude.ai","email":…}.
    const res = await run([binary, 'auth', 'status'], timeoutMs);
    try {
      const parsed = JSON.parse(res.stdout.trim()) as { loggedIn?: boolean; email?: string };
      if (parsed.loggedIn === true) {
        return { ok: true, detail: `logged in${parsed.email ? ` as ${parsed.email}` : ''}` };
      }
      if (parsed.loggedIn === false) return { ok: false, detail: 'not logged in — run `claude /login`' };
    } catch {
      /* not JSON — older CLI or unexpected output: not a confirmed negative */
    }
    return { ok: 'unknown', detail: 'auth status unrecognized' };
  }
```

In `swarm/src/drivers/codex.ts`, add to `CodexDriver` (same `CommandRunner` import):

```ts
  async verifyAuth(
    binary: string,
    run: CommandRunner,
    timeoutMs: number,
  ): Promise<{ ok: boolean | 'unknown'; detail: string }> {
    // `codex login status` -> exit 0 "Logged in using ChatGPT" when authed.
    const res = await run([binary, 'login', 'status'], timeoutMs);
    const out = `${res.stdout}\n${res.stderr}`.trim();
    if (res.code === 0) return { ok: true, detail: out.split('\n')[0] || 'logged in' };
    if (/not logged in/i.test(out)) return { ok: false, detail: 'not logged in — run `codex login`' };
    return { ok: 'unknown', detail: out.split('\n')[0] || 'login status unrecognized' };
  }
```

In `swarm/src/drivers/opencode.ts`, add to `OpencodeDriver` (same `CommandRunner` import):

```ts
  async verifyAuth(
    binary: string,
    run: CommandRunner,
    timeoutMs: number,
  ): Promise<{ ok: boolean | 'unknown'; detail: string }> {
    // `opencode auth list` exits 0 and prints the credential store. opencode
    // also runs local models, so this probe never confirms a negative — a
    // working auth store is ok, anything else is unknown.
    const res = await run([binary, 'auth', 'list'], timeoutMs);
    if (res.code === 0) return { ok: true, detail: 'auth store accessible' };
    return { ok: 'unknown', detail: 'auth list unavailable' };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swarm && node --import tsx --test src/drivers/verify-auth.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: One-shot live sanity check against the real machine**

Run: `cd swarm && node --import tsx -e "import { sweepCliTools } from './src/cli-tools.js'; import { ENGINES } from './src/personas.js'; const f = await sweepCliTools('/tmp/cli-tools-probe.json', { agentCommands: { agy: 'agy', claude: 'claude', codex: 'codex', opencode: 'opencode', copilot: 'copilot' }, clis: ENGINES.map(e => e.cli) }); console.log(JSON.stringify(f, null, 2));"`
Expected: all five detected on this machine; claude/codex `authOk: true`; copilot/agy `authOk: 'unknown'` with `no auth probe for this tool`.

- [ ] **Step 6: Commit**

```bash
git add swarm/src/drivers/claude.ts swarm/src/drivers/codex.ts swarm/src/drivers/opencode.ts swarm/src/drivers/verify-auth.test.ts
git commit -m "feat(swarm): auth probes for claude, codex, opencode drivers

claude parses \`auth status\` JSON, codex reads \`login status\`, opencode
treats an accessible auth store as ok. copilot/agy have no non-interactive
status command and stay 'unknown' by design.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Swarm API routes + startup sweep + catalog annotation

**Files:**
- Modify: `swarm/src/server.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–2 via `import { buildCliToolListings, gateReason, inactiveDetail, isActive, loadCliToolsFile, saveCliToolsFile, sweepCliTools, type SweepDeps } from './cli-tools.js';` — plus `ENGINES`, `findEngine` (already imported in server.ts).
- Produces (HTTP, consumed by broker in Task 6):
  - `GET /cli-tools` → `{ tools: CliToolListing[] }` (lazy first sweep when the file has no entries)
  - `POST /cli-tools/refresh?tool=<cli>` → `{ tools: CliToolListing[] }`
  - `PUT /cli-tools/:id` body `{ enabled: boolean }` → `{ tools: CliToolListing[] }` | 400 | 404 | 409
  - `GET /agents/catalog` engines entries gain `active: boolean` and `statusDetail?: string`

Note on tests: this package's convention (stated at `swarm/src/server.test.ts:1-4` and the long comment below it) is to unit-test exported helpers, NOT to boot `OrchestratorServer` — no route-boot harness exists. All route logic here delegates to Task 1/2 helpers that are already tested; the wiring is verified by the live check in Step 4.

- [ ] **Step 1: Add shared route helpers and the three routes**

In `swarm/src/server.ts`, inside `registerRoutes()` immediately after the `POST /me/connectors/:id/verify` route (ends near line 1443), add:

```ts
    // ── CLI tool registry (machine-level; spec 2026-08-06) ─────────────
    const cliToolsPath = () => resolve(process.cwd(), '.smith/cli-tools.json');
    const cliSweepDeps = (): SweepDeps => ({
      agentCommands: server.orchConfig.agentCommands,
      clis: ENGINES.map((e) => e.cli),
    });

    this.app.get('/cli-tools', async () => {
      let file = await loadCliToolsFile(cliToolsPath());
      // Lazy first sweep: a fresh install that opens Settings before the
      // startup sweep lands still gets real statuses, not blanks.
      if (Object.keys(file.tools).length === 0) {
        file = await sweepCliTools(cliToolsPath(), cliSweepDeps());
      }
      return { tools: buildCliToolListings(ENGINES, file) };
    });

    this.app.post('/cli-tools/refresh', async (req) => {
      const tool = (req.query as { tool?: string }).tool;
      const file = await sweepCliTools(cliToolsPath(), cliSweepDeps(), tool);
      return { tools: buildCliToolListings(ENGINES, file) };
    });

    this.app.put<{ Params: { id: string } }>('/cli-tools/:id', async (req, reply) => {
      const b = req.body as { enabled?: boolean };
      if (typeof b?.enabled !== 'boolean') return reply.status(400).send({ error: 'body must be { enabled: boolean }' });
      if (!findEngine(req.params.id)) return reply.status(404).send({ error: `Unknown CLI tool: ${req.params.id}` });
      const file = await loadCliToolsFile(cliToolsPath());
      const current = file.tools[req.params.id];
      if (!current) return reply.status(409).send({ error: 'Tool not probed yet — refresh first' });
      file.tools[req.params.id] = { ...current, enabled: b.enabled };
      await saveCliToolsFile(cliToolsPath(), file);
      return { tools: buildCliToolListings(ENGINES, file) };
    });
```

- [ ] **Step 2: Annotate the creation catalog**

Replace the `GET /agents/catalog` handler body (`server.ts:857-866`) with:

```ts
    this.app.get('/agents/catalog', async () => {
      // Annotate, don't filter (spec): the wizard grays out inactive engines
      // with the reason instead of hiding them.
      const cliFile = await loadCliToolsFile(resolve(process.cwd(), '.smith/cli-tools.json'));
      return {
        stereotypes: STEREOTYPES,
        jobRoles: JOB_ROLES,
        engines: ENGINES.map((e) => ({
          ...e,
          active: isActive(cliFile.tools[e.cli]),
          statusDetail: inactiveDetail(cliFile.tools[e.cli]) || undefined,
        })),
        languages: LANGUAGES,
        quickQuestions: QUICK_QUESTIONS,
        reactionLevels: REACTION_LEVELS,
      };
    });
```

- [ ] **Step 3: Fire the startup sweep**

In `start()` (`server.ts:236-285`), after `await this.app.listen(...)` (line 274), add:

```ts
    // CLI tool registry: probe machine reality in the background — the cached
    // file serves until fresh results land (spec: startup + manual +
    // on-failure; never a boot gate, never periodic).
    void sweepCliTools(resolve(process.cwd(), '.smith/cli-tools.json'), {
      agentCommands: this.orchConfig.agentCommands,
      clis: ENGINES.map((e) => e.cli),
    }).then(
      (f) =>
        this.app.log.info(
          `CLI tools: ${ENGINES.map((e) => `${e.cli}=${isActive(f.tools[e.cli]) ? 'active' : 'inactive'}`).join(' ')}`,
        ),
      (err) => this.app.log.warn(`CLI tool sweep failed: ${(err as Error).message}`),
    );
```

- [ ] **Step 4: Verify live against a running swarm**

Run:
```bash
cd swarm && npm test   # full suite still green first
```
Then boot briefly and curl. `npm run serve` runs the server with cwd `swarm/`, so this reads/writes the REAL `swarm/.smith/cli-tools.json` — that's fine (it's the file this feature owns; agents/users are untouched):
```bash
cd swarm && (npm run serve &) && sleep 6 \
  && curl -s http://127.0.0.1:7777/cli-tools | head -c 600 && echo \
  && curl -s http://127.0.0.1:7777/agents/catalog | python3 -c "import json,sys; print([{k: e.get(k) for k in ('cli','active','statusDetail')} for e in json.load(sys.stdin)['engines']])" \
  && curl -s -X POST 'http://127.0.0.1:7777/cli-tools/refresh?tool=claude' | head -c 300 && echo
```
Expected: `/cli-tools` lists 5 tools with real statuses; catalog engines carry `active: true` for claude/codex/opencode/copilot/agy on this machine. Kill the dev server afterwards (foreground it or `kill %1` in the same shell — NEVER an unscoped `pkill`).

- [ ] **Step 5: Commit**

```bash
git add swarm/src/server.ts
git commit -m "feat(swarm): cli-tools routes, catalog annotation, startup sweep

GET /cli-tools (lazy first sweep), POST /cli-tools/refresh, PUT toggle;
/agents/catalog engines annotated with active/statusDetail; background
sweep after listen.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Enforcement — create/edit gating, launch/dispatch blocking, on-failure re-probe

**Files:**
- Modify: `swarm/src/server.ts` (POST /agents, PUT /agents/:id, POST /agent-sessions catch, both `AgentSessionManager` construction sites)
- Modify: `swarm/src/agent-sessions.ts` (config hook + gate in `create()`)
- Modify: `swarm/src/dispatcher.ts` (gate at top of `dispatch()`, re-probe on failure)
- Modify: `swarm/src/agent-sessions.test.ts` (one new test)

**Interfaces:**
- Consumes: `gateReason`, `loadCliToolsFile`, `refreshCliTool` from `./cli-tools.js`; `ToolLaunchError` from `./drivers/errors.js` (already imported in agent-sessions.ts; add the import to dispatcher.ts).
- Produces:
  - `AgentSessionConfig.toolGate?: (cli: string) => Promise<string>` — resolves `''` when launchable, else the human reason. Absent = no gating (tests, ephemeral runs) — same convention as `resolveDriver`.
  - Blocked launches throw `ToolLaunchError(cli, 'subscription-inactive: <reason>')` (existing error type, `code: 'tool_launch_failed'`).

- [ ] **Step 1: Write the failing warm-session gate test**

Append to `swarm/src/agent-sessions.test.ts` (imports for `AgentSessionManager`, `ToolLaunchError`, `AGENT`, `runtime`, `FakeDriver` already exist in the file):

```ts
test('create() refuses when toolGate reports a reason — before any worktree or tmux work', async () => {
  const gated = new AgentSessionManager(runtime, {
    agentCommands: { claude: 'true' },
    worktreeDir: '.smith/worktrees',
    resolveDriver: () => new FakeDriver(),
    toolGate: async () => 'not logged in — run `claude /login`',
  });
  await assert.rejects(
    // repoRoot is deliberately bogus: the gate must fire before git touches it.
    () => gated.create(AGENT, JSON.stringify(AGENT), '/nonexistent-repo-root', 'main'),
    (err: unknown) => {
      assert.ok(err instanceof ToolLaunchError);
      assert.match((err as Error).message, /subscription-inactive: not logged in/);
      return true;
    },
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd swarm && node --import tsx --test src/agent-sessions.test.ts`
Expected: the new test FAILS (`toolGate` not a known config key / create does not reject with subscription-inactive). Pre-existing tests in this file need real tmux — if the suite skips or the environment lacks tmux, run just the compile+new test and note it.

- [ ] **Step 3: Implement the session gate**

In `swarm/src/agent-sessions.ts`:

Add to `AgentSessionConfig` (after `resolveDriver`, line ~58):

```ts
  /** CLI-tool registry gate — resolves '' when launchable, else the human
   *  reason to refuse. Absent = no gating (tests, ephemeral runs). */
  toolGate?: (cli: string) => Promise<string>;
```

In `create()` after the `if (!baseCommand) throw ...` check (line 88), before `const id = randomUUID();`:

```ts
    const gate = await this.config.toolGate?.(agent.engine.cli);
    if (gate) throw new ToolLaunchError(agent.engine.cli, `subscription-inactive: ${gate}`);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd swarm && node --import tsx --test src/agent-sessions.test.ts`
Expected: new test PASS

- [ ] **Step 5: Wire the gate + agent-record gating + re-probe in server.ts**

All edits in `swarm/src/server.ts` (extend the Task 4 import from `./cli-tools.js` with `gateReason` and `refreshCliTool`):

**(a)** Both `AgentSessionManager` construction sites — `reconcileSessions()` (line ~213) and the `sessionManager()` closure (line ~1044) — gain one property in the config object literal:

```ts
        toolGate: async (cli) => gateReason(await loadCliToolsFile(resolve(process.cwd(), '.smith/cli-tools.json')), cli),
```

**(b)** `POST /agents` (line ~868): after the `findEngine` validation block (lines 878-880), add:

```ts
      const requestedCli = b.engine?.cli ?? 'claude'; // must gate the default too
      const cliGate = gateReason(await loadCliToolsFile(resolve(process.cwd(), '.smith/cli-tools.json')), requestedCli);
      if (cliGate) return reply.status(400).send({ error: `${requestedCli} is not available: ${cliGate}` });
```

**(c)** `PUT /agents/:id` (line ~960): after its `findEngine` validation block (lines 979-981), add — gate ONLY an actual engine change, so an agent whose tool went dark can still be edited:

```ts
      if (b.engine?.cli && b.engine.cli !== existing.engine.cli) {
        const cliGate = gateReason(await loadCliToolsFile(resolve(process.cwd(), '.smith/cli-tools.json')), b.engine.cli);
        if (cliGate) return reply.status(400).send({ error: `${b.engine.cli} is not available: ${cliGate}` });
      }
```

**(d)** `POST /agent-sessions` catch block (lines 1078-1080) becomes:

```ts
      } catch (err) {
        if ((err as { code?: string }).code === 'tool_launch_failed') {
          // Self-correction (spec: on-failure re-probe): a launch failure is
          // the freshest signal — refresh just this tool, fire-and-forget.
          void refreshCliTool(
            resolve(process.cwd(), '.smith/cli-tools.json'),
            server.orchConfig.agentCommands,
            agent.engine.cli,
          ).catch(() => {});
        }
        return reply.status(sessionErrorStatus(err)).send({ error: String((err as Error).message) });
      }
```

- [ ] **Step 6: Implement the dispatch gate + re-probe**

In `swarm/src/dispatcher.ts`:

Add imports:
```ts
import { gateReason, loadCliToolsFile, refreshCliTool } from './cli-tools.js';
import { ToolLaunchError } from './drivers/errors.js';
```

At the top of `dispatch()` (line ~98, before `resolveConnections`):

```ts
    // CLI tool registry gate (spec): refuse before any worktree exists. Only
    // confirmed negatives block; a stale 'active' self-corrects below.
    const cliFile = await loadCliToolsFile(join(this.config.smithRoot, 'cli-tools.json'));
    const cliGate = gateReason(cliFile, manifest.agent);
    if (cliGate) throw new ToolLaunchError(manifest.agent, `subscription-inactive: ${cliGate}`);
```

Convert the `try { … } finally { … }` in `dispatch()` (lines 119-184) to `try { … } catch (err) { … throw err; } finally { … }`:

```ts
    } catch (err) {
      // Any dispatch failure refreshes this tool's status (spec: on-failure
      // re-probe) — cheap, async, and harmless when the cause was elsewhere.
      void refreshCliTool(join(this.config.smithRoot, 'cli-tools.json'), this.config.agentCommands, manifest.agent).catch(
        () => {},
      );
      throw err;
    } finally {
```

- [ ] **Step 7: Full swarm suite**

Run: `cd swarm && npm test`
Expected: PASS. Existing dispatcher/server tests keep passing because their tmp cwds have no `.smith/cli-tools.json` → `loadCliToolsFile` returns empty → `gateReason` returns `''` → nothing is gated. If any test fails on the new gate, that test has a real cli-tools file in its cwd — fix the test cwd, not the gate.

- [ ] **Step 8: Commit**

```bash
git add swarm/src/server.ts swarm/src/agent-sessions.ts swarm/src/dispatcher.ts swarm/src/agent-sessions.test.ts
git commit -m "feat(swarm): enforce cli-tool registry at create/edit/launch/dispatch

POST /agents gates engine.cli (default included); PUT gates only engine
changes; warm sessions gate via AgentSessionConfig.toolGate; dispatch gates
before worktree creation. Launch failures fire a one-tool re-probe.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Broker passthrough

**Files:**
- Modify: `broker/src/swarm-client.ts`
- Modify: `broker/src/text-channel.ts`
- Modify: `broker/src/main.ts`
- Modify: `broker/src/text-channel.test.ts`

**Interfaces:**
- Consumes: swarm HTTP routes from Task 4.
- Produces:
  - `SwarmClient.listCliTools(): Promise<{ tools: CliToolListing[] }>`, `.refreshCliTools(tool?)`, `.setCliToolEnabled(id, enabled)` + exported `CliToolListing`/`CliToolStatusRecord` types
  - `TextChannel` constructor gains a FINAL positional param `cliTools?: { list(): Promise<Record<string, unknown>>; refresh(tool?: string): Promise<Record<string, unknown>>; setEnabled(id: string, enabled: boolean): Promise<Record<string, unknown>> }` (index 15 — after `tasks`, so no existing call site shifts)
  - Broker routes on 7790 (origin-restricted): `GET /cli-tools`, `POST /cli-tools/refresh?tool=`, `PUT /cli-tools/:id`

- [ ] **Step 1: Write the failing passthrough test**

In `broker/src/text-channel.test.ts`: extend the `channelWith` helper's options interface and constructor call (its `connectors` is `ConstructorParameters<typeof TextChannel>[13]`, `tasks` is `[14]`):

```ts
  cliTools?: ConstructorParameters<typeof TextChannel>[15];
```
and pass `opts.cliTools,` after `opts.tasks,` in the `new TextChannel(...)` call.

Then add (mirroring the connectors tests at lines 512-534 — note the `Origin: 'http://localhost:1420'` header these origin-restricted routes require):

```ts
test('GET /cli-tools and PUT /cli-tools/:id pass through to the swarm registry', async () => {
  const toggled: Array<[string, boolean]> = [];
  const listing = { tools: [{ cli: 'claude', label: 'Claude Code', active: true, status: null }] };
  const channel = channelWith({
    cliTools: {
      list: async () => listing,
      refresh: async () => listing,
      setEnabled: async (id, enabled) => {
        toggled.push([id, enabled]);
        return listing;
      },
    },
  });
  const port = await channel.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/cli-tools`, {
      headers: { Origin: 'http://localhost:1420' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), listing);

    const put = await fetch(`http://127.0.0.1:${port}/cli-tools/codex`, {
      method: 'PUT',
      headers: { Origin: 'http://localhost:1420', 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual(toggled, [['codex', false]]);

    const badPut = await fetch(`http://127.0.0.1:${port}/cli-tools/codex`, {
      method: 'PUT',
      headers: { Origin: 'http://localhost:1420', 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes' }),
    });
    assert.equal(badPut.status, 400);
  } finally {
    await channel.stop();
  }
});

test('POST /cli-tools/refresh forwards the ?tool= filter', async () => {
  const asked: Array<string | undefined> = [];
  const channel = channelWith({
    cliTools: {
      list: async () => ({}),
      refresh: async (tool) => {
        asked.push(tool);
        return { tools: [] };
      },
      setEnabled: async () => ({}),
    },
  });
  const port = await channel.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/cli-tools/refresh?tool=claude`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:1420' },
    });
    assert.equal(res.status, 200);
    const all = await fetch(`http://127.0.0.1:${port}/cli-tools/refresh`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:1420' },
    });
    assert.equal(all.status, 200);
    assert.deepEqual(asked, ['claude', undefined]);
  } finally {
    await channel.stop();
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd broker && node --import tsx --test src/text-channel.test.ts`
Expected: FAIL — index 15 doesn't exist yet / routes 404

- [ ] **Step 3: Implement `TextChannel` param + routes**

In `broker/src/text-channel.ts`:

**(a)** Constructor — after the `tasks` param (lines 172-175), add the new final param:

```ts
    /** CLI tool registry (CLI Tools settings group + rail badge): machine-level tool statuses, re-probe, enable toggle. Origin-restricted like connectors. */
    private readonly cliTools?: {
      list(): Promise<Record<string, unknown>>;
      refresh(tool?: string): Promise<Record<string, unknown>>;
      setEnabled(id: string, enabled: boolean): Promise<Record<string, unknown>>;
    },
```

**(b)** Routes — insert directly after the `POST /me/connectors/:id/verify` handler block (ends near line 599), in the same origin-restricted section:

```ts
        if (req.method === 'GET' && url.pathname === '/cli-tools' && this.cliTools) {
          if (originBlocked()) return;
          void this.cliTools.list().then((r) => credJson(200, r), credFail);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/cli-tools/refresh' && this.cliTools) {
          if (originBlocked()) return;
          void this.cliTools
            .refresh(url.searchParams.get('tool') ?? undefined)
            .then((r) => credJson(200, r), credFail);
          return;
        }
        const cliToolMatch = /^\/cli-tools\/([^/]+)$/.exec(url.pathname);
        if (req.method === 'PUT' && cliToolMatch && this.cliTools) {
          if (originBlocked()) return;
          let body = '';
          req.on('data', (c) => {
            body += c;
          });
          req.on('end', () => {
            let parsed: { enabled?: unknown } = {};
            try {
              parsed = JSON.parse(body || '{}') as { enabled?: unknown };
            } catch {
              return credJson(400, { error: 'body must be JSON' });
            }
            if (typeof parsed.enabled !== 'boolean') return credJson(400, { error: 'body must be { enabled: boolean }' });
            void this.cliTools!
              .setEnabled(decodeURIComponent(cliToolMatch[1]!), parsed.enabled)
              .then((r) => credJson((r as { error?: string }).error ? 400 : 200, r), credFail);
          });
          return;
        }
```

(Route-order note: `POST /cli-tools/refresh` is matched before the `PUT` regex, and a stray `PUT /cli-tools/refresh` just becomes `setEnabled('refresh', …)` → swarm 404s on `findEngine` — no special-casing needed.)

- [ ] **Step 4: Implement the `SwarmClient` methods + `main.ts` wiring**

In `broker/src/swarm-client.ts`, add near the other exported record types (after `ConnectorInstanceRecord`, ~line 86):

```ts
export interface CliToolStatusRecord {
  detected: boolean;
  authOk: boolean | 'unknown';
  enabled: boolean;
  detail: string;
  version?: string;
  lastCheckedAt: string;
}

export interface CliToolListing {
  cli: string;
  label: string;
  models: string[];
  warmSessions: boolean;
  note?: string;
  status: CliToolStatusRecord | null;
  active: boolean;
}
```

And methods after `verifyConnector` (~line 346):

```ts
  async listCliTools(): Promise<{ tools: CliToolListing[] }> {
    return this.http('GET', '/cli-tools') as unknown as Promise<{ tools: CliToolListing[] }>;
  }

  async refreshCliTools(tool?: string): Promise<{ tools: CliToolListing[] }> {
    return this.http('POST', `/cli-tools/refresh${tool ? `?tool=${encodeURIComponent(tool)}` : ''}`) as unknown as Promise<{
      tools: CliToolListing[];
    }>;
  }

  async setCliToolEnabled(id: string, enabled: boolean): Promise<{ tools: CliToolListing[] }> {
    return this.http('PUT', `/cli-tools/${encodeURIComponent(id)}`, { enabled }) as unknown as Promise<{
      tools: CliToolListing[];
    }>;
  }
```

In `broker/src/main.ts`, after the `connectors` block (lines 519-533):

```ts
// CLI tool registry (CLI Tools settings group + rail badge): same thin
// passthrough shape as `connectors`, origin-restricted the same way.
const cliTools = {
  list: () => swarm.listCliTools() as unknown as Promise<Record<string, unknown>>,
  refresh: (tool?: string) => swarm.refreshCliTools(tool) as unknown as Promise<Record<string, unknown>>,
  setEnabled: (id: string, enabled: boolean) =>
    swarm.setCliToolEnabled(id, enabled) as unknown as Promise<Record<string, unknown>>,
};
```

and pass `cliTools,` as the new final argument of the `new TextChannel(...)` call (after `tasks` — find the call around line 540-836; `tasks` is currently last).

- [ ] **Step 5: Run broker suite**

Run: `cd broker && npm test`
Expected: PASS including the two new tests

- [ ] **Step 6: Commit**

```bash
git add broker/src/swarm-client.ts broker/src/text-channel.ts broker/src/main.ts broker/src/text-channel.test.ts
git commit -m "feat(broker): cli-tools passthrough on 7790

GET /cli-tools, POST /cli-tools/refresh, PUT /cli-tools/:id — thin
origin-restricted forwards to swarm, same pattern as connectors.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Wizard gating (AddAgentModal)

**Files:**
- Modify: `control-plane/src/organisms/AddAgentModal.tsx`

**Interfaces:**
- Consumes: the annotated catalog from Task 4 via broker `GET /agent-catalog` (the modal already fetches it at line 125; the annotation flows through the passthrough untouched).
- Produces: engine `<option>`s disabled with a reason when inactive; default engine = first ACTIVE one.

- [ ] **Step 1: Extend the local `EngineOption` type**

In `AddAgentModal.tsx` (interface at lines 29-35), add:

```ts
  /** From the cli-tool registry: false = grayed out in the picker. Absent/true = selectable. */
  active?: boolean;
  /** Human reason when inactive ("not logged in — run `codex login`"). */
  statusDetail?: string;
```

- [ ] **Step 2: Default to the first active engine**

Line ~129, replace `const first = c.engines?.[0];` with:

```ts
        const first = c.engines?.find((e) => e.active !== false) ?? c.engines?.[0];
```

- [ ] **Step 3: Gray out inactive options + show the reason**

Replace the engine `<option>` render (lines 362-366) with:

```tsx
                  {(catalog?.engines ?? []).map((e) => (
                    <option key={e.cli} value={e.cli} disabled={e.active === false}>
                      {e.label}
                      {e.active === false ? " — unavailable" : ""}
                    </option>
                  ))}
```

After the warm-sessions hint block (lines 384-390), add:

```tsx
              {engine?.active === false && (
                <p className="wizard__error">
                  {engine.statusDetail ?? "This CLI is unavailable on this machine."} Fix it in Settings → CLI Tools.
                </p>
              )}
```

(This hint only renders for an EDIT of an agent whose engine went inactive — a fresh create can't select a disabled option. That's the intended asymmetry: editing other fields stays allowed, and the swarm's PUT gate only rejects engine *changes*.)

- [ ] **Step 4: Typecheck + suite**

Run: `cd control-plane && npx tsc --noEmit && npm test`
Expected: PASS (no new tests here — this is presentation-only wiring over already-tested server annotation; verified end-to-end in Task 10)

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/organisms/AddAgentModal.tsx
git commit -m "feat(control-plane): gray out inactive engines in the agent wizard

Annotated catalog drives disabled options with the reason inline; default
engine selection skips inactive tools.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: CLI Tools settings group

**Files:**
- Modify: `control-plane/src/hooks/useBrokerChat.ts`
- Create: `control-plane/src/organisms/settings/CliToolsGroup.tsx`
- Create: `control-plane/src/organisms/settings/CliToolsGroup.test.tsx`
- Modify: `control-plane/src/organisms/SettingsPanel.tsx`
- Modify: `control-plane/src/pages/HomePage.tsx`

**Interfaces:**
- Consumes: broker routes from Task 6.
- Produces:
  - `useBrokerChat` return gains `listCliTools(): Promise<CliToolListing[]>`, `refreshCliTools(tool?): Promise<CliToolListing[]>`, `setCliToolEnabled(id, enabled): Promise<CliToolListing[] | { error: string }>` + exported `CliToolListing`/`CliToolStatusRecord` types
  - `SettingsGroupId` union gains `"cli-tools"`; `CliToolsGroup` component; exported pure `pillFor(t: CliToolListing): { label: string; cls: string }`

- [ ] **Step 1: Write the failing pill-precedence test**

Create `control-plane/src/organisms/settings/CliToolsGroup.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import type { CliToolListing } from "../../hooks/useBrokerChat";
import { pillFor } from "./CliToolsGroup";

const listing = (status: CliToolListing["status"], active = false): CliToolListing => ({
  cli: "claude",
  label: "Claude Code",
  models: ["claude-opus"],
  warmSessions: true,
  status,
  active,
});

const st = (over: Partial<NonNullable<CliToolListing["status"]>> = {}) => ({
  detected: true,
  authOk: true as const,
  enabled: true,
  detail: "",
  lastCheckedAt: "2026-08-06T00:00:00.000Z",
  ...over,
});

describe("pillFor — precedence: reality before preference (spec §6)", () => {
  it("null status -> not checked", () => {
    expect(pillFor(listing(null, true)).label).toBe("not checked");
  });
  it("not installed beats everything, even disabled", () => {
    expect(pillFor(listing(st({ detected: false, enabled: false }))).label).toBe("not installed");
  });
  it("needs login beats disabled", () => {
    expect(pillFor(listing(st({ authOk: false, enabled: false }))).label).toBe("needs login");
  });
  it("disabled when only the toggle is off", () => {
    expect(pillFor(listing(st({ enabled: false }))).label).toBe("disabled");
  });
  it("active otherwise, including authOk unknown", () => {
    expect(pillFor(listing(st(), true)).label).toBe("active");
    expect(pillFor(listing(st({ authOk: "unknown" }), true)).label).toBe("active");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd control-plane && npm test`
Expected: FAIL — `CliToolsGroup` module not found

- [ ] **Step 3: Add the client API to `useBrokerChat.ts`**

Types after `ChannelsRecord` (line ~106):

```ts
/** One CLI tool's machine status, as the registry persists it. */
export interface CliToolStatusRecord {
  detected: boolean;
  authOk: boolean | "unknown";
  enabled: boolean;
  detail: string;
  version?: string;
  lastCheckedAt: string;
}

/** Catalog engine joined with machine status — drives the CLI Tools settings cards. */
export interface CliToolListing {
  cli: string;
  label: string;
  models: string[];
  warmSessions: boolean;
  note?: string;
  status: CliToolStatusRecord | null;
  active: boolean;
}
```

Callbacks after `verifyConnector` (line ~412), following its exact style:

```ts
  const listCliTools = useCallback(async (): Promise<CliToolListing[]> => {
    const res = await fetch(`http://${base}/cli-tools`);
    return ((await res.json()) as { tools?: CliToolListing[] }).tools ?? [];
  }, [base]);

  const refreshCliTools = useCallback(
    async (tool?: string): Promise<CliToolListing[]> => {
      const res = await fetch(`http://${base}/cli-tools/refresh${tool ? `?tool=${encodeURIComponent(tool)}` : ""}`, {
        method: "POST",
      });
      return ((await res.json()) as { tools?: CliToolListing[] }).tools ?? [];
    },
    [base],
  );

  const setCliToolEnabled = useCallback(
    async (id: string, enabled: boolean): Promise<CliToolListing[] | { error: string }> => {
      const res = await fetch(`http://${base}/cli-tools/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const body = (await res.json()) as { tools?: CliToolListing[]; error?: string };
      return body.error ? { error: body.error } : (body.tools ?? []);
    },
    [base],
  );
```

Add `listCliTools, refreshCliTools, setCliToolEnabled,` to the hook's return object (search the file for `verifyConnector,` in the return statement and add alongside).

- [ ] **Step 4: Create `CliToolsGroup.tsx`**

```tsx
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { CliToolListing } from "../../hooks/useBrokerChat";

interface CliToolsGroupProps {
  listCliTools: () => Promise<CliToolListing[]>;
  refreshCliTools: (tool?: string) => Promise<CliToolListing[]>;
  setCliToolEnabled: (id: string, enabled: boolean) => Promise<CliToolListing[] | { error: string }>;
}

/** Status pill precedence: reality before preference (spec §6). Exported for tests. */
export function pillFor(t: CliToolListing): { label: string; cls: string } {
  if (!t.status) return { label: "not checked", cls: "connector-status--unconnected" };
  if (!t.status.detected) return { label: "not installed", cls: "connector-status--unconnected" };
  if (t.status.authOk === false) return { label: "needs login", cls: "connector-status--unconnected" };
  if (!t.status.enabled) return { label: "disabled", cls: "connector-status--unconnected" };
  return { label: "active", cls: "connector-status--connected" };
}

/** Card grid, one per catalog engine — machine status, refresh probes, and the opt-out toggle. */
export function CliToolsGroup({ listCliTools, refreshCliTools, setCliToolEnabled }: CliToolsGroupProps) {
  const [tools, setTools] = useState<CliToolListing[]>([]);
  const [busy, setBusy] = useState<string | null>(null); // cli being refreshed, "*" = all
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once load, same convention as IntegrationsGroup
  useEffect(() => {
    void listCliTools().then(setTools, (err: unknown) => setError(`Could not load CLI tools — ${String(err)}`));
  }, []);

  const refresh = async (tool?: string) => {
    setBusy(tool ?? "*");
    setError(null);
    try {
      setTools(await refreshCliTools(tool));
    } catch (err) {
      setError(`Refresh failed — ${String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (t: CliToolListing) => {
    const result = await setCliToolEnabled(t.cli, !(t.status?.enabled ?? true));
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setError(null);
    setTools(result);
  };

  return (
    <>
      <h1>cli tools</h1>
      <p className="wizard__hint">
        Agent CLI tools detected on this machine. Only active tools can be assigned to agents; an agent whose
        tool goes dark is flagged in the rail and blocked from launching.
      </p>
      {error && <p className="wizard__error">{error}</p>}
      <button type="button" className="settings-btn" onClick={() => void refresh()} disabled={busy !== null}>
        <RefreshCw size={12} strokeWidth={2} /> {busy === "*" ? "checking…" : "refresh all"}
      </button>
      <div className="connector-grid">
        {tools.map((t) => {
          const pill = pillFor(t);
          return (
            <div key={t.cli} className="connector-card">
              <div className="connector-card__head">
                <b>{t.label}</b>
                {t.note && <em>{t.note}</em>}
              </div>
              <div className="connector-instance">
                <span className={`connector-status ${pill.cls}`}>{pill.label}</span>
                <span>
                  {t.status?.version ? t.status.version : t.cli}
                  {t.status?.detail ? ` — ${t.status.detail}` : ""}
                </span>
              </div>
              {t.status?.lastCheckedAt && (
                <p className="wizard__hint">last checked {new Date(t.status.lastCheckedAt).toLocaleString()}</p>
              )}
              <div className="connector-instance">
                <button
                  type="button"
                  className="settings-btn"
                  onClick={() => void refresh(t.cli)}
                  disabled={busy !== null}
                >
                  {busy === t.cli ? "checking…" : "refresh"}
                </button>
                {t.status?.detected && (
                  <button type="button" className="settings-btn" onClick={() => void toggle(t)}>
                    {t.status.enabled ? "disable" : "enable"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
```

- [ ] **Step 5: Register the settings group**

In `control-plane/src/organisms/SettingsPanel.tsx`:
- Line 1: add `Terminal` to the lucide import.
- Line 15: `export type SettingsGroupId = "general" | "integrations" | "cli-tools" | "channels" | "themes";`
- Import: `import { CliToolsGroup } from "./settings/CliToolsGroup";` and `import type { CliToolListing } from "../hooks/useBrokerChat";` (merge into the existing type import at lines 3-8).
- Props interface (after `verifyConnector`, line ~39):

```ts
  listCliTools?: () => Promise<CliToolListing[]>;
  refreshCliTools?: (tool?: string) => Promise<CliToolListing[]>;
  setCliToolEnabled?: (id: string, enabled: boolean) => Promise<CliToolListing[] | { error: string }>;
```

- `GROUPS` (line 49-54): insert after integrations: `{ id: "cli-tools", label: "CLI Tools", icon: Terminal },`
- Destructure the three new props in the component signature (after `verifyConnector,`).
- Render branch (after the integrations branch, line ~126):

```tsx
        {active === "cli-tools" &&
          (listCliTools && refreshCliTools && setCliToolEnabled ? (
            <CliToolsGroup
              listCliTools={listCliTools}
              refreshCliTools={refreshCliTools}
              setCliToolEnabled={setCliToolEnabled}
            />
          ) : (
            <p className="wizard__hint">CLI Tools — not wired up yet.</p>
          ))}
```

- [ ] **Step 6: Wire HomePage**

In `control-plane/src/pages/HomePage.tsx`: add `listCliTools, refreshCliTools, setCliToolEnabled,` to the `useBrokerChat()` destructure (after `verifyConnector,`, line ~80) and pass all three to `<SettingsPanel …>` (after `verifyConnector={verifyConnector}`, line ~216):

```tsx
            listCliTools={listCliTools}
            refreshCliTools={refreshCliTools}
            setCliToolEnabled={setCliToolEnabled}
```

- [ ] **Step 7: Run tests + typecheck**

Run: `cd control-plane && npx tsc --noEmit && npm test`
Expected: PASS including the 5 pillFor tests

- [ ] **Step 8: Commit**

```bash
git add control-plane/src/hooks/useBrokerChat.ts control-plane/src/organisms/settings/CliToolsGroup.tsx control-plane/src/organisms/settings/CliToolsGroup.test.tsx control-plane/src/organisms/SettingsPanel.tsx control-plane/src/pages/HomePage.tsx
git commit -m "feat(control-plane): CLI Tools settings group

Card per engine with status pill (reality-before-preference precedence),
per-tool + all refresh, and the enable toggle. Reuses connector card styles.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Rail warning badge for agents on dark tools

**Files:**
- Create: `control-plane/src/hooks/useCliToolHealth.ts`
- Create: `control-plane/src/hooks/useCliToolHealth.test.ts`
- Modify: `control-plane/src/data/agents.ts` (`AgentSeed`)
- Modify: `control-plane/src/molecules/AgentAvatar.tsx`
- Modify: `control-plane/src/organisms/AgentRoster.tsx`
- Modify: `control-plane/src/pages/HomePage.tsx`
- Modify: `control-plane/src/styles/components.css`

**Interfaces:**
- Consumes: broker `GET /cli-tools` (Task 6) and existing broker `GET /agents` (returns full stored records incl. `engine.cli`, plus presence).
- Produces:
  - `computeEngineWarnings(tools, agents): Record<string, string>` (pure, exported for tests)
  - `useCliToolHealth(): { warnings: Record<string, string>; refresh: () => Promise<void> }`
  - `AgentSeed.engineWarning?: string`; `AgentAvatarProps.engineWarning?: string`

- [ ] **Step 1: Write the failing join test**

Create `control-plane/src/hooks/useCliToolHealth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { CliToolListing } from "./useBrokerChat";
import { computeEngineWarnings } from "./useCliToolHealth";

const tool = (cli: string, active: boolean, detail = ""): CliToolListing => ({
  cli,
  label: cli,
  models: [],
  warmSessions: true,
  active,
  status: active
    ? null
    : { detected: true, authOk: false, enabled: true, detail, lastCheckedAt: "2026-08-06T00:00:00.000Z" },
});

describe("computeEngineWarnings", () => {
  it("flags only agents whose engine tool is inactive, with the tool's detail", () => {
    const warnings = computeEngineWarnings(
      [tool("claude", true), tool("codex", false, "not logged in — run `codex login`")],
      [
        { id: "ignacio", engine: { cli: "claude" } },
        { id: "wilkin", engine: { cli: "codex" } },
        { id: "ghost" }, // no engine on record -> never flagged
      ],
    );
    expect(warnings).toEqual({ wilkin: "codex: not logged in — run `codex login`" });
  });
  it("empty tool list (fetch failed, nothing probed) flags nobody", () => {
    expect(computeEngineWarnings([], [{ id: "ignacio", engine: { cli: "claude" } }])).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd control-plane && npm test`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the hook**

Create `control-plane/src/hooks/useCliToolHealth.ts`:

```ts
import { useCallback, useEffect, useState } from "react";
import type { CliToolListing } from "./useBrokerChat";

const BASE = "127.0.0.1:7790";

/**
 * Pure join: agentId -> warning for every agent whose engine tool the
 * registry confirms inactive. Absent knowledge (no probe, fetch failure)
 * flags nobody — same block-only-confirmed-negatives rule as the swarm gate.
 */
export function computeEngineWarnings(
  tools: CliToolListing[],
  agents: Array<{ id?: string; engine?: { cli?: string } }>,
): Record<string, string> {
  const inactive = new Map(tools.filter((t) => !t.active).map((t) => [t.cli, t.status?.detail || "unavailable"]));
  const warnings: Record<string, string> = {};
  for (const a of agents) {
    const cli = a.engine?.cli;
    if (a.id && cli && inactive.has(cli)) warnings[a.id] = `${cli}: ${inactive.get(cli) ?? "unavailable"}`;
  }
  return warnings;
}

/** Fetches the registry + agent records once on mount; `refresh` re-joins on demand (settings close, agent edits). */
export function useCliToolHealth() {
  const [warnings, setWarnings] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      const [toolsRes, agentsRes] = await Promise.all([
        fetch(`http://${BASE}/cli-tools`),
        fetch(`http://${BASE}/agents`),
      ]);
      const tools = ((await toolsRes.json()) as { tools?: CliToolListing[] }).tools ?? [];
      const agents =
        ((await agentsRes.json()) as { agents?: Array<{ id?: string; engine?: { cli?: string } }> }).agents ?? [];
      setWarnings(computeEngineWarnings(tools, agents));
    } catch {
      setWarnings({}); // no knowledge -> no badges, never stale ones
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { warnings, refresh };
}
```

- [ ] **Step 4: Thread the warning through seed → roster → avatar**

**(a)** `control-plane/src/data/agents.ts` — add to `AgentSeed`:

```ts
  /** Set when this agent's engine CLI is confirmed inactive — drives the rail warning badge. */
  engineWarning?: string;
```

**(b)** `control-plane/src/molecules/AgentAvatar.tsx`:
- Import: add `TriangleAlert` to the lucide import (line 1).
- `AgentAvatarProps`: add `/** Engine-tool warning ("codex: not logged in…") — shows the badge + tooltip line. */ engineWarning?: string;`
- Destructure `engineWarning` in the component signature.
- Label (lines 78-84): prepend a branch — when `engineWarning` and no `hand`, use `` `${name}, ${role} — engine unavailable: ${engineWarning}` `` (keep the existing chain otherwise).
- Badge markup — after the `{hand && (…)}` block (lines 104-108):

```tsx
        {engineWarning && !hand && (
          <span className="engine-warning" aria-hidden="true">
            <TriangleAlert strokeWidth={2.2} />
          </span>
        )}
```

- Tip (lines 109-114): inside `<span className="tip">`, after the existing inner `<span>`, add:

```tsx
          {engineWarning && <span>⚠ {engineWarning}</span>}
```

**(c)** `control-plane/src/organisms/AgentRoster.tsx` — in `RosterItem`'s `<AgentAvatar …>` (lines 89-100), add:

```tsx
        engineWarning={editMode ? undefined : entry.engineWarning}
```

**(d)** `control-plane/src/pages/HomePage.tsx`:
- `import { useCliToolHealth } from "../hooks/useCliToolHealth";`
- After the `usePushToTalk` block (line ~91): `const { warnings: engineWarnings, refresh: refreshEngineWarnings } = useCliToolHealth();`
- In the roster→seed map (lines 93-104), add `engineWarning: engineWarnings[a.id],`
- `<SettingsPanel onClose={…}>`: change to also refresh — `onClose={() => { setSettingsOpen(false); void refreshEngineWarnings(); }}`
- `<AddAgentModal onClose={…}>` (line 260): append `void refreshEngineWarnings();` inside its existing close handler (engine edits change the join).

**(e)** `control-plane/src/styles/components.css` — after the `.avatar .hand` rules (lines 146-163), add (static sibling of `.hand`; top-RIGHT so it never collides with the hand badge at top-left or the status dot):

```css
.avatar .engine-warning {
  position: absolute;
  right: -5px;
  top: -5px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: #e05a5a;
  color: #fff;
  border: 2px solid var(--ground);
}
.avatar .engine-warning svg {
  width: 10px;
  height: 10px;
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd control-plane && npx tsc --noEmit && npm test`
Expected: PASS including the 2 new join tests

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/hooks/useCliToolHealth.ts control-plane/src/hooks/useCliToolHealth.test.ts control-plane/src/data/agents.ts control-plane/src/molecules/AgentAvatar.tsx control-plane/src/organisms/AgentRoster.tsx control-plane/src/pages/HomePage.tsx control-plane/src/styles/components.css
git commit -m "feat(control-plane): rail warning badge for agents on inactive CLI tools

Client-side join of /cli-tools with agent records; badge + tooltip detail on
the avatar; refreshes when settings or the agent wizard close.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: All three suites + typechecks**

```bash
(cd swarm && npm test) && (cd broker && npm test) && (cd control-plane && npx tsc --noEmit && npm test)
```
Expected: all PASS.

- [ ] **Step 2: Live walkthrough**

Start swarm + broker + control-plane the way this repo normally runs them (note: the LIVE broker runs in tmux session `smith-broker` from the main checkout — do not kill it; run this walkthrough from your worktree on different state, or coordinate a restart with Edwin). Verify:

1. Swarm boot log shows `CLI tools: claude=active codex=active …`.
2. `.smith/cli-tools.json` exists with mode 600 and five entries.
3. Settings → CLI Tools shows five cards; claude shows `logged in as …`; copilot/agy show `no auth probe for this tool` yet read **active**.
4. Toggle codex off → card flips to `disabled`; the Add Agent wizard grays out Codex; `PUT /agents/wilkin` with `engine.cli: "codex"` unchanged still succeeds (edit other fields), but switching ignacio TO codex is rejected with the reason.
5. With codex disabled, wilkin's avatar shows the warning badge; a warm-session start for wilkin returns the `subscription-inactive` error.
6. Toggle codex back on → refresh → badge clears.

- [ ] **Step 3: Report**

Report results to Edwin with any deviations found, then hand back for the finishing-a-development-branch flow.

---

## Self-review notes (already applied)

- **Spec coverage:** §1 store → Task 1-2; §2 driver probes → Task 3 (copilot/agy omission is the spec's own `'unknown'` branch); §3 routes → Task 4; §4 broker → Task 6; §5 gating/enforcement → Tasks 4 (annotation), 5, 7; §6 UI → Tasks 8-9; §7 error handling → Tasks 2 (never-throw sweep), 5 (re-probe); §8 testing → each task's test steps. Spec's `isActive(undefined)` line amended in Task 1 Step 1 (contradicted the block-only-confirmed-negatives decision; ignorance is now explicitly active).
- **Type consistency:** `CliToolStatus`/`CliToolsFile`/`CliToolListing` defined once in Task 1 and re-declared structurally (broker/control-plane are separate packages that already re-declare shapes — e.g. `ConnectorInstanceRecord` exists in all three). `gateReason` is the single gate primitive used by routes, sessions, and dispatcher.
- **The `PUT /cli-tools/:id` 409** ("not probed yet") is unreachable through the UI (cards only render probed tools' toggles) but guards a raw API caller.
