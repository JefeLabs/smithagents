# Surface Presence Modes & Eject Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-agent, per-surface presence modes (`autojoin` / `on-request` / `disabled`) enforced by the broker and configured from an avatar-hover popover in the control-plane; flipping to `disabled` is the eject action.

**Architecture:** A single parser (`surfaceModes`) turns the agent file's `channels` field (legacy array or new map) into a mode map. A `SurfacePolicy` (modes + runtime admissions) is the one choke point every surface consults: the AdapterHub text filter, the voice surface's join set, and the brain's tauri roster. The voice surface gains per-agent `joinAgent`/`leaveAgent`. The HTTP layer adds a join endpoint and presence in `GET /agents`; the UI adds a popover that edits via the existing `PUT /agents/:id`.

**Tech Stack:** TypeScript everywhere. Broker: Node built-in test runner via tsx. Control-plane: React + Vite + Tauri, pnpm, biome; vitest gets added here (first UI test infra).

**Spec:** `docs/superpowers/specs/2026-07-29-surface-presence-modes-design.md`

## Global Constraints

- Modes are exactly `'autojoin' | 'on-request' | 'disabled'`. Surfaces are exactly `'tauri' | 'discord' | 'discord-voice'`.
- Legacy compatibility is behavior-exact, per call site: agent file with `channels` **array** → listed surface `autojoin`, unlisted `disabled`. Agent with **no `channels` field at all** → `tauri: autojoin, discord: autojoin, discord-voice: disabled` (today an absent array passes the text filter at `channels.ts:88` but fails the voice designation at `discord-voice.ts:382`).
- Map form: absent key → `disabled`; unknown surface keys preserved verbatim; unrecognized mode values coerce to `disabled` (fail-closed).
- On-request admissions are runtime-only state — never persisted, reset on broker restart.
- Broker commands (run from `broker/`): all tests `npm test`; one file `node --import tsx --test src/<name>.test.ts`; typecheck `npm run typecheck`. Mirror the import style of the neighboring `*.test.ts` files.
- Control-plane commands (run from `control-plane/`): `pnpm typecheck`, `pnpm lint` (biome) must pass; tests `pnpm vitest run` once Task 6 adds the runner.
- The smithagents repo has unrelated uncommitted changes (`swarm/.smith/agents/*.json`, deleted `docs/img.png`). Never include them in any commit. `git add` only the files your task touched.

---

### Task 1: `surface-modes.ts` — parser and policy

**Files:**
- Create: `broker/src/surface-modes.ts`
- Create: `broker/src/surface-modes.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces (later tasks import all of these):

```ts
export type SurfaceMode = 'autojoin' | 'on-request' | 'disabled';
export type SurfaceModeMap = Record<string, SurfaceMode>;
export const KNOWN_SURFACES = ['tauri', 'discord', 'discord-voice'] as const;

/** Parse an agent record's `channels` field (legacy array, map, or absent) into a mode map. */
export function surfaceModes(agent: { channels?: unknown }): SurfaceModeMap;

/** Modes + runtime on-request admissions. One instance in main.ts; every surface consults it. */
export class SurfacePolicy {
  constructor(getAgents: () => Array<{ id: string; channels?: unknown }>);
  modeFor(agentId: string, surface: string): SurfaceMode; // 'disabled' for unknown agents
  attends(agentId: string, surface: string): boolean; // autojoin, or on-request AND admitted
  admit(agentId: string, surface: string): void;
  revoke(agentId: string, surface: string): void;
  revokeAll(surface: string): void; // e.g. crew left voice — clear that surface's admissions
}

/** Pure mode-diff enforcement used by the PUT wrapper (Task 4). Testable with fakes. */
export function applyModeChange(
  deps: {
    leaveAgent(agentId: string): void;
    joinAgent(agentId: string): Promise<void>;
    roomActive(): boolean;
    revoke(agentId: string, surface: string): void;
    log(line: string): void;
  },
  agentId: string,
  before: SurfaceModeMap,
  after: SurfaceModeMap,
): Promise<void>;
```

- [ ] **Step 1: Write the failing tests**

```ts
// broker/src/surface-modes.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyModeChange, SurfacePolicy, surfaceModes } from './surface-modes.ts';

test('legacy array: listed surfaces autojoin, unlisted disabled', () => {
  assert.deepEqual(surfaceModes({ channels: ['tauri', 'discord'] }), {
    tauri: 'autojoin',
    discord: 'autojoin',
    'discord-voice': 'disabled',
  });
});

test('absent channels field: text surfaces autojoin, voice disabled (legacy-exact)', () => {
  assert.deepEqual(surfaceModes({}), {
    tauri: 'autojoin',
    discord: 'autojoin',
    'discord-voice': 'disabled',
  });
});

test('map form: absent key disabled, unknown surfaces preserved, bad values fail closed', () => {
  const modes = surfaceModes({
    channels: { tauri: 'autojoin', 'discord-voice': 'on-request', matrix: 'autojoin', discord: 'sometimes' },
  });
  assert.equal(modes.tauri, 'autojoin');
  assert.equal(modes['discord-voice'], 'on-request');
  assert.equal(modes.matrix, 'autojoin'); // unknown surface passes through
  assert.equal(modes.discord, 'disabled'); // unrecognized value fails closed
});

test('non-object, non-array channels: all disabled', () => {
  assert.deepEqual(surfaceModes({ channels: 'discord' }), {
    tauri: 'disabled',
    discord: 'disabled',
    'discord-voice': 'disabled',
  });
});

test('policy: attends = autojoin, or on-request + admitted; revoked on demand', () => {
  const agents = [{ id: 'ignacio', channels: { discord: 'on-request', tauri: 'autojoin' } }];
  const policy = new SurfacePolicy(() => agents);
  assert.equal(policy.attends('ignacio', 'tauri'), true);
  assert.equal(policy.attends('ignacio', 'discord'), false);
  policy.admit('ignacio', 'discord');
  assert.equal(policy.attends('ignacio', 'discord'), true);
  policy.revoke('ignacio', 'discord');
  assert.equal(policy.attends('ignacio', 'discord'), false);
  policy.admit('ignacio', 'discord');
  policy.revokeAll('discord');
  assert.equal(policy.attends('ignacio', 'discord'), false);
  assert.equal(policy.attends('ghost', 'tauri'), false); // unknown agent: disabled
});

test('applyModeChange: voice disable ejects; autojoin flip joins only with a room', async () => {
  const calls: string[] = [];
  const deps = {
    leaveAgent: (id: string) => calls.push(`leave:${id}`),
    joinAgent: async (id: string) => {
      calls.push(`join:${id}`);
    },
    roomActive: () => true,
    revoke: (id: string, s: string) => calls.push(`revoke:${id}:${s}`),
    log: () => {},
  };
  await applyModeChange(deps, 'ignacio', { 'discord-voice': 'autojoin' }, { 'discord-voice': 'disabled' });
  assert.deepEqual(calls, ['leave:ignacio', 'revoke:ignacio:discord-voice']);

  calls.length = 0;
  await applyModeChange(deps, 'ignacio', { 'discord-voice': 'disabled' }, { 'discord-voice': 'autojoin' });
  assert.deepEqual(calls, ['join:ignacio', 'revoke:ignacio:discord-voice']);

  calls.length = 0;
  deps.roomActive = () => false;
  await applyModeChange(deps, 'ignacio', { 'discord-voice': 'disabled' }, { 'discord-voice': 'autojoin' });
  assert.deepEqual(calls, ['revoke:ignacio:discord-voice']); // no room — no join

  calls.length = 0;
  await applyModeChange(deps, 'ignacio', { discord: 'on-request' }, { discord: 'disabled' });
  assert.deepEqual(calls, ['revoke:ignacio:discord']); // non-voice surfaces: revoke only
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `broker/`): `node --import tsx --test src/surface-modes.test.ts`
Expected: FAIL — module `./surface-modes.ts` not found.

- [ ] **Step 3: Implement `broker/src/surface-modes.ts`**

```ts
/** Per-agent, per-surface presence modes parsed from the agent file's `channels`
 * field, plus the runtime admission state for on-request surfaces.
 *
 * Legacy compatibility is behavior-exact per call site: an ARRAY means listed →
 * autojoin, unlisted → disabled. An ABSENT field historically passed the text
 * delivery filter (channels.ts) but failed the voice designation
 * (discord-voice.ts), so it parses as text-autojoin + voice-disabled.
 */
export type SurfaceMode = 'autojoin' | 'on-request' | 'disabled';
export type SurfaceModeMap = Record<string, SurfaceMode>;
export const KNOWN_SURFACES = ['tauri', 'discord', 'discord-voice'] as const;

const MODES: ReadonlySet<string> = new Set(['autojoin', 'on-request', 'disabled']);

export function surfaceModes(agent: { channels?: unknown }): SurfaceModeMap {
  const channels = agent.channels;
  if (channels === undefined || channels === null) {
    return { tauri: 'autojoin', discord: 'autojoin', 'discord-voice': 'disabled' };
  }
  if (Array.isArray(channels)) {
    const out: SurfaceModeMap = {};
    for (const surface of KNOWN_SURFACES) {
      out[surface] = channels.includes(surface) ? 'autojoin' : 'disabled';
    }
    for (const surface of channels) {
      if (typeof surface === 'string' && !(surface in out)) out[surface] = 'autojoin';
    }
    return out;
  }
  if (typeof channels === 'object') {
    const out: SurfaceModeMap = {};
    for (const surface of KNOWN_SURFACES) out[surface] = 'disabled';
    for (const [surface, mode] of Object.entries(channels as Record<string, unknown>)) {
      out[surface] = typeof mode === 'string' && MODES.has(mode) ? (mode as SurfaceMode) : 'disabled';
    }
    return out;
  }
  return { tauri: 'disabled', discord: 'disabled', 'discord-voice': 'disabled' };
}

export class SurfacePolicy {
  private admissions = new Set<string>();

  constructor(private readonly getAgents: () => Array<{ id: string; channels?: unknown }>) {}

  modeFor(agentId: string, surface: string): SurfaceMode {
    const agent = this.getAgents().find((a) => a.id === agentId);
    if (!agent) return 'disabled';
    return surfaceModes(agent)[surface] ?? 'disabled';
  }

  attends(agentId: string, surface: string): boolean {
    const mode = this.modeFor(agentId, surface);
    if (mode === 'autojoin') return true;
    if (mode === 'on-request') return this.admissions.has(`${agentId} ${surface}`);
    return false;
  }

  admit(agentId: string, surface: string): void {
    this.admissions.add(`${agentId} ${surface}`);
  }

  revoke(agentId: string, surface: string): void {
    this.admissions.delete(`${agentId} ${surface}`);
  }

  revokeAll(surface: string): void {
    for (const key of this.admissions) {
      if (key.endsWith(` ${surface}`)) this.admissions.delete(key);
    }
  }
}

/** Enforce a mode change's immediate effects. Voice: disabled ejects now;
 * autojoin joins now if a room is active. Every changed surface clears any
 * on-request admission (mode changes never smuggle an old admission along). */
export async function applyModeChange(
  deps: {
    leaveAgent(agentId: string): void;
    joinAgent(agentId: string): Promise<void>;
    roomActive(): boolean;
    revoke(agentId: string, surface: string): void;
    log(line: string): void;
  },
  agentId: string,
  before: SurfaceModeMap,
  after: SurfaceModeMap,
): Promise<void> {
  const surfaces = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const surface of surfaces) {
    const from = before[surface] ?? 'disabled';
    const to = after[surface] ?? 'disabled';
    if (from === to) continue;
    if (surface === 'discord-voice') {
      if (to === 'disabled') {
        deps.leaveAgent(agentId);
      } else if (to === 'autojoin' && deps.roomActive()) {
        try {
          await deps.joinAgent(agentId);
        } catch (err) {
          deps.log(`[surface-modes] ${agentId} autojoin flip failed to join: ${String(err)}`);
        }
      }
    }
    deps.revoke(agentId, surface);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test src/surface-modes.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`, then:

```bash
git add broker/src/surface-modes.ts broker/src/surface-modes.test.ts
git commit -m "feat(broker): surface-modes parser, SurfacePolicy, mode-change enforcement"
```

---

### Task 2: Voice surface — mode-aware `joinAll`, per-agent `joinAgent`/`leaveAgent`

**Files:**
- Modify: `broker/src/discord-voice.ts` (options type ≈line 139, join filter ≈line 382, return block ≈line 443)
- Modify: `broker/src/discord-voice.test.ts` (extend, following its existing fake-gateway pattern)
- Modify: `broker/src/main.ts` (≈line 832 token map, ≈line 960 designated-count log)

**Interfaces:**
- Consumes: `surfaceModes` from Task 1.
- Produces: the surface's return object gains
  `joinAgent(agentId: string): Promise<void>` (throws `Error('no active voice channel')` when no room; throws `Error('<id> has no bot token')`; no-op if already connected) and
  `leaveAgent(agentId: string): void` (guarded teardown; no-op when absent). `DiscordVoiceOptions.agents` widens to `() => Array<{ id: string; channels?: unknown }>`.

- [ ] **Step 1: Write the failing tests** (extend `discord-voice.test.ts`; reuse its existing fake gateway/receiver helpers — read the top of the file first and mirror how existing tests construct the surface)

```ts
// Append to broker/src/discord-voice.test.ts — adapt helper names to the file's own.
test('joinAll joins only discord-voice autojoin agents (map form)', async () => {
  // agents: one autojoin, one on-request, one disabled — expect exactly the autojoin
  // agent in connectedAgentIds() after joinAll('c1').
});

test('joinAgent joins one on-request agent into the current room; throws with no room', async () => {
  // before joinAll: await assert.rejects(surface.joinAgent('ignacio'), /no active voice channel/);
  // after joinAll: await surface.joinAgent('ignacio'); assert ignacio in connectedAgentIds().
  // second joinAgent('ignacio') is a no-op (still exactly one connection).
});

test('leaveAgent disconnects exactly that agent; others stay', async () => {
  // join two agents, leaveAgent one, assert connectedAgentIds() has only the other.
  // leaveAgent of an unknown/absent agent is a no-op (no throw).
});
```

Write these as REAL tests against the file's existing fakes — the skeleton above states the required behavior; the fake-gateway setup must match the file's established pattern, which is why it isn't reproduced here. Every assertion listed must exist.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `node --import tsx --test src/discord-voice.test.ts`
Expected: FAIL — `joinAgent is not a function` (and the mode-aware filter test fails since the current filter uses `channels.includes`).

- [ ] **Step 3: Implement in `discord-voice.ts`**

At the top: `import { surfaceModes } from './surface-modes.ts';`
Options type (≈139): `agents: () => Array<{ id: string; channels?: unknown }>;`
Join filter (≈382): replace

```ts
const designated = opts.agents().filter((a) => a.channels?.includes(VOICE_DESIGNATION));
```

with

```ts
const designated = opts.agents().filter((a) => surfaceModes(a)[VOICE_DESIGNATION] === 'autojoin');
```

Add next to `leaveAll`:

```ts
async function joinAgent(agentId: string): Promise<void> {
  if (currentChannelId === null) throw new Error('no active voice channel');
  if (agentMouths.has(agentId)) return;
  const token = opts.agentTokens.get(agentId);
  if (!token) throw new Error(`${agentId} has no bot token`);
  const gateway = opts.gateway ?? realGateway();
  const connection = await gateway.join(currentChannelId, token);
  agentMouths.set(agentId, openMouth(connection));
}

function leaveAgent(agentId: string): void {
  const mouth = agentMouths.get(agentId);
  if (!mouth) return;
  try {
    teardownMouth(mouth); // destroy() throws on already-destroyed — same guard as leaveAll
  } catch (err) {
    log(`[discord-voice] ${agentId}'s mouth teardown failed: ${String(err)}`);
  }
  agentMouths.delete(agentId);
}
```

Add both to the return object alongside `joinAll`/`leaveAll`/`connectedAgentIds`.

In `main.ts`, the two designation sites must include on-request agents (they can be summoned, so they need tokens):
≈832: `const designated = directory.list().filter((a) => surfaceModes(a)['discord-voice'] !== 'disabled');`
≈960: same predicate for the count log. Import `surfaceModes` at the top of `main.ts`.

- [ ] **Step 4: Run the full broker suite**

Run: `npm test`
Expected: PASS — including the pre-existing discord-voice tests (if an old test asserted array-designation behavior, the legacy-array parse gives identical results; investigate any failure rather than rewriting the assertion).

- [ ] **Step 5: Typecheck and commit**

```bash
git add broker/src/discord-voice.ts broker/src/discord-voice.test.ts broker/src/main.ts
git commit -m "feat(broker): mode-aware voice joins, per-agent joinAgent/leaveAgent"
```

---

### Task 3: Text delivery and tauri roster consult `SurfacePolicy.attends`

**Files:**
- Modify: `broker/src/channels.ts` (delivery filter, line ≈88)
- Modify: `broker/src/channels.test.ts` (extend)
- Modify: `broker/src/main.ts` (instantiate the policy; wire AdapterHub; filter the brain's roster)

**Interfaces:**
- Consumes: `SurfacePolicy` from Task 1.
- Produces: `AdapterHub` gains a public settable field
  `attendsPolicy: ((agentId: string, kind: string) => boolean) | null = null;`
  `main.ts` gains a module-level `const policy = new SurfacePolicy(() => directory.list());` that Tasks 4–5 reuse.

- [ ] **Step 1: Write the failing test** (extend `channels.test.ts`, mirroring its existing hub/adapter fakes)

```ts
test('attendsPolicy replaces the legacy channels-array membership check', () => {
  // hub.attendsPolicy = (id, kind) => id === 'ignacio';
  // deliver a line from agent 'ignacio' → the fake adapter receives it;
  // deliver a line from agent 'wilkin' (even with channels including the kind) → adapter does NOT.
});

test('without attendsPolicy the legacy array check still applies', () => {
  // hub.attendsPolicy = null; agent with channels ['discord'] delivers to kind 'discord',
  // agent with channels [] does not, agent with NO channels field does.
});
```

Write them as real tests against the file's existing helpers, covering every assertion above.

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test src/channels.test.ts`
Expected: FAIL — `attendsPolicy` does not exist.

- [ ] **Step 3: Implement**

In `AdapterHub`:

```ts
/** Presence policy hook (surface-modes). When set, replaces the legacy
 * channels-array membership check for external delivery. */
attendsPolicy: ((agentId: string, kind: string) => boolean) | null = null;
```

Replace line ≈88 (`if (agent.channels && !agent.channels.includes(adapter.kind)) return;`) with:

```ts
const attends = this.attendsPolicy
  ? this.attendsPolicy(agent.id, adapter.kind)
  : !(agent.channels && !agent.channels.includes(adapter.kind));
if (!attends) return;
```

If the local `agent` type in `channels.ts` declares `channels?: string[]`, keep that declaration — the legacy branch still uses it; the policy branch ignores it.

In `main.ts` (near the `directory` construction; find it with `grep -n "new AgentDirectory" broker/src/main.ts`):

```ts
import { SurfacePolicy } from './surface-modes.ts';
const policy = new SurfacePolicy(() => directory.list());
adapterHub.attendsPolicy = (agentId, kind) => policy.attends(agentId, kind);
```

Tauri roster: find the site that builds the brain's roster string with `grep -n "roster" broker/src/main.ts`. Where the agent list feeds that string, wrap it:

```ts
directory.list().filter((a) => policy.attends(a.id, 'tauri'))
```

(Only the roster/meeting build site — do NOT filter `directory.list()` itself; voice and token-map sites need the full list.)

- [ ] **Step 4: Run the full broker suite**

Run: `npm test` — Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
git add broker/src/channels.ts broker/src/channels.test.ts broker/src/main.ts
git commit -m "feat(broker): SurfacePolicy gate for text delivery and tauri roster"
```

---

### Task 4: Mode-diff enforcement on agent PUT + voice-admission lifecycle

**Files:**
- Modify: `broker/src/main.ts` (the `creation` object's `update` closure — find with `grep -n "update:" broker/src/main.ts` near the `records:` wiring at ≈557; and the leave-crew/`leaveAll` handling at ≈972)

**Interfaces:**
- Consumes: `applyModeChange`, `surfaceModes`, `policy` (Task 3), `surface.joinAgent`/`surface.leaveAgent` (Task 2).
- Produces: behavior only — every successful agent PUT immediately enforces mode changes; crew-leave clears voice admissions.

The logic was already unit-tested in Task 1 (`applyModeChange`); this task is glue, verified by typecheck + the full suite + Task 8's manual pass.

- [ ] **Step 1: Wrap the update closure**

Whatever the existing closure looks like (e.g. `update: (id, body) => swarm.<something>(id, body)`), wrap it:

```ts
update: async (id: string, body: Record<string, unknown>) => {
  const before = surfaceModes((await swarm.registry()).find((a) => a.id === id) ?? {});
  const result = await originalUpdate(id, body); // the pre-existing expression, extracted
  if (!result.error) {
    const after = surfaceModes((await swarm.registry()).find((a) => a.id === id) ?? {});
    await applyModeChange(
      {
        leaveAgent: (agentId) => voiceSurface?.leaveAgent(agentId),
        joinAgent: async (agentId) => {
          await voiceSurface?.joinAgent(agentId);
        },
        roomActive: () => voiceSurface !== null && voicePresence.joinedChannel() !== null,
        revoke: (agentId, surface) => policy.revoke(agentId, surface),
        log: (line) => console.log(line),
      },
      id,
      before,
      after,
    );
  }
  return result;
},
```

Adapt the two reality checks to the actual code: (a) the voice surface variable may be scoped inside the voice-boot gate (≈line 918 `const surface = createDiscordVoiceSurface(...)`) — if so, hoist a nullable module-level `let voiceSurface: ReturnType<typeof createDiscordVoiceSurface> | null = null;` assigned at boot, and use it here; (b) `roomActive` should be exactly "the presence machine says we're in a channel" — `voicePresence.joinedChannel() !== null` — using whatever the presence instance is named at ≈line 986.

- [ ] **Step 2: Clear voice admissions when the crew leaves**

At the leave-crew path (≈972, where `surface.leaveAll()` is awaited), add:

```ts
policy.revokeAll('discord-voice');
```

- [ ] **Step 3: Typecheck and full suite**

Run: `npm run typecheck && npm test` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add broker/src/main.ts
git commit -m "feat(broker): enforce surface-mode changes on agent PUT; clear voice admissions on crew leave"
```

---

### Task 5: Join endpoint + presence and Discord availability in `GET /agents`

**Files:**
- Modify: `broker/src/text-channel.ts` (constructor + routes; `/agents` GET at ≈228)
- Modify: `broker/src/text-channel.test.ts` (extend, following its `start(0)` + fetch pattern)
- Modify: `broker/src/main.ts` (wire the new provider)

**Interfaces:**
- Consumes: `policy` (Task 3), `voiceSurface` (Task 4's hoisted handle), the `discordToken`/adapter state (≈line 733).
- Produces: text-channel constructor gains an optional provider (place it after `workspaces`):

```ts
private readonly surfaces?: {
  /** Per-agent live presence, keyed agentId → surface → present. */
  presence(): Record<string, Record<string, boolean>>;
  /** Discord availability for the UI's grayed rows. */
  info(): { configured: boolean; voiceReady: boolean };
  /** On-request admission. Resolves {ok:true} or {error, status}. */
  join(agentId: string, surface: string): Promise<{ ok: true } | { error: string; status: number }>;
},
```

  HTTP surface: `GET /agents` response becomes `{ agents: [...each with presence: {...}], discord: { configured, voiceReady } }`; new route `POST /agents/:id/surfaces/:surface/join` → `200 {ok:true}` or `{status} {error}`. (The `agents` array shape is additive — `AddAgentModal.tsx:143` keeps working.)

- [ ] **Step 1: Write the failing tests** (extend `text-channel.test.ts` with its existing fakes)

```ts
test('GET /agents merges presence and discord availability', async () => {
  // construct the channel with a fake surfaces provider:
  //   presence: () => ({ ignacio: { 'discord-voice': true } }),
  //   info: () => ({ configured: true, voiceReady: true }),
  //   join: async () => ({ ok: true }),
  // GET /agents → body.agents[i].presence deep-equals the fake's entry (missing ids → {}),
  // body.discord deep-equals { configured: true, voiceReady: true }.
});

test('POST /agents/:id/surfaces/:surface/join maps provider results to status codes', async () => {
  // provider join returns { error: 'no active voice channel', status: 409 } → response 409 with that error;
  // returns { ok: true } → 200. Assert the provider received (decoded id, surface).
});
```

Write as real tests, covering every assertion.

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test src/text-channel.test.ts`
Expected: FAIL — constructor arity/route missing.

- [ ] **Step 3: Implement the routes**

`GET /agents` handler becomes:

```ts
if (req.method === 'GET' && url.pathname === '/agents') {
  void this.creation.records().then((agents) => {
    const presence = this.surfaces?.presence() ?? {};
    const withPresence = agents.map((a) => ({
      ...a,
      presence: presence[String((a as { id?: unknown }).id)] ?? {},
    }));
    return json(200, { agents: withPresence, discord: this.surfaces?.info() ?? { configured: false, voiceReady: false } });
  }, fail);
  return;
}
```

New route (place near the other `/agents/...` matchers):

```ts
const joinMatch = /^\/agents\/([^/]+)\/surfaces\/([^/]+)\/join$/.exec(url.pathname);
if (req.method === 'POST' && joinMatch && this.surfaces) {
  void this.surfaces.join(decodeURIComponent(joinMatch[1]!), decodeURIComponent(joinMatch[2]!)).then(
    (r) => ('error' in r ? json(r.status, { error: r.error }) : json(200, { ok: true })),
    fail,
  );
  return;
}
```

- [ ] **Step 4: Wire the provider in `main.ts`**

Where the `TextChannel` is constructed (find with `grep -n "new TextChannel" broker/src/main.ts`), pass:

```ts
{
  presence: () => {
    const out: Record<string, Record<string, boolean>> = {};
    const voiceIds = new Set(voiceSurface?.connectedAgentIds() ?? []);
    const discordUp = Boolean(discordToken); // same flag that gated the adapter at ≈733
    for (const a of directory.list()) {
      out[a.id] = {
        tauri: policy.attends(a.id, 'tauri'),
        discord: discordUp && policy.attends(a.id, 'discord'),
        'discord-voice': voiceIds.has(a.id),
      };
    }
    return out;
  },
  info: () => ({ configured: Boolean(discordToken), voiceReady: voiceSurface !== null }),
  join: async (agentId, surface) => {
    if (surface === 'discord-voice') {
      if (!voiceSurface) return { error: 'Discord voice is not configured', status: 409 };
      try {
        await voiceSurface.joinAgent(agentId);
      } catch (err) {
        return { error: String(err instanceof Error ? err.message : err), status: 409 };
      }
      policy.admit(agentId, surface);
      return { ok: true } as const;
    }
    if (surface === 'discord' && !discordToken) return { error: 'Discord is not configured', status: 409 };
    if (surface !== 'discord' && surface !== 'tauri') return { error: `unknown surface: ${surface}`, status: 404 };
    policy.admit(agentId, surface);
    return { ok: true } as const;
  },
}
```

(`discordToken` is read at ≈733 inside the adapter boot — hoist the `Boolean(discordToken)` availability to a module-level `const discordConfigured` if scoping requires.)

- [ ] **Step 5: Full suite, typecheck, commit**

Run: `npm run typecheck && npm test` — Expected: PASS.

```bash
git add broker/src/text-channel.ts broker/src/text-channel.test.ts broker/src/main.ts
git commit -m "feat(broker): surface join endpoint, presence + discord availability in GET /agents"
```

---

### Task 6: Control-plane test infra + `useSurfacePolicy` hook

**Files:**
- Modify: `control-plane/package.json` (devDeps + `"test": "vitest run"` script)
- Create: `control-plane/vitest.config.ts`
- Create: `control-plane/src/hooks/useSurfacePolicy.ts`
- Create: `control-plane/src/hooks/useSurfacePolicy.test.ts`

**Interfaces:**
- Consumes: broker HTTP API from Task 5.
- Produces:

```ts
export type SurfaceMode = 'autojoin' | 'on-request' | 'disabled';
export const SURFACES = [
  { key: 'tauri', label: 'Tauri app' },
  { key: 'discord', label: 'Discord text' },
  { key: 'discord-voice', label: 'Discord voice' },
] as const;

/** Pure: agent record → mode map (mirrors the broker parser, incl. legacy array + absent field). */
export function modesFrom(record: { channels?: unknown }): Record<string, SurfaceMode>;
/** Pure: Join now renders only for on-request agents not currently present. */
export function joinNowVisible(mode: SurfaceMode, present: boolean): boolean;

export function useSurfacePolicy(agentId: string): {
  loading: boolean;
  modes: Record<string, SurfaceMode>;
  presence: Record<string, boolean>;
  discord: { configured: boolean; voiceReady: boolean };
  /** Per-surface inline error text (PUT/POST failures land here). */
  errors: Record<string, string>;
  setMode(surface: string, mode: SurfaceMode): void; // optimistic PUT of the FULL record with channels as a map; reverts + records error on failure
  joinNow(surface: string): void; // POST join; records the broker's error text on failure
};
```

- [ ] **Step 1: Add the test infra**

Run (from `control-plane/`): `pnpm add -D vitest jsdom @testing-library/react @testing-library/user-event`
Add to `package.json` scripts: `"test": "vitest run"`.
Create `control-plane/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'] },
});
```

- [ ] **Step 2: Write the failing tests**

```ts
// control-plane/src/hooks/useSurfacePolicy.test.ts
import { describe, expect, it } from 'vitest';
import { joinNowVisible, modesFrom } from './useSurfacePolicy';

describe('modesFrom', () => {
  it('parses map form with absent keys disabled', () => {
    expect(modesFrom({ channels: { tauri: 'autojoin' } })).toMatchObject({
      tauri: 'autojoin',
      discord: 'disabled',
      'discord-voice': 'disabled',
    });
  });
  it('parses legacy array: listed autojoin, unlisted disabled', () => {
    expect(modesFrom({ channels: ['discord'] })).toMatchObject({
      tauri: 'disabled',
      discord: 'autojoin',
      'discord-voice': 'disabled',
    });
  });
  it('absent field: text autojoin, voice disabled', () => {
    expect(modesFrom({})).toMatchObject({
      tauri: 'autojoin',
      discord: 'autojoin',
      'discord-voice': 'disabled',
    });
  });
});

describe('joinNowVisible', () => {
  it('shows only for on-request and not present', () => {
    expect(joinNowVisible('on-request', false)).toBe(true);
    expect(joinNowVisible('on-request', true)).toBe(false);
    expect(joinNowVisible('autojoin', false)).toBe(false);
    expect(joinNowVisible('disabled', false)).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run` — Expected: FAIL (module missing).

- [ ] **Step 4: Implement the hook**

Follow the fetch style of `AddAgentModal.tsx` (module-local `const BASE = "127.0.0.1:7790";`, plain `fetch`). Implementation outline the code must follow:
- `modesFrom` mirrors Task 1's parser exactly (same three branches; keep it dependency-free — no cross-package import).
- On mount and after every mutation: `GET http://${BASE}/agents`, find the record by `agentId`, derive `modes` via `modesFrom`, read `presence` and top-level `discord`.
- `setMode`: build `channels` as a full map (current modes with the one change), `PUT http://${BASE}/agents/${agentId}` with the **full stored record** (the fetched record spread + new `channels`) — the update path replaces the record, and sending it whole avoids depending on merge semantics. Optimistic: set local mode immediately; on non-OK response, restore the previous mode and put the response's `error` text in `errors[surface]`.
- `joinNow`: `POST http://${BASE}/agents/${agentId}/surfaces/${surface}/join`; on non-OK, put the error text in `errors[surface]`; on OK, refetch.

- [ ] **Step 5: Run tests, typecheck, lint, commit**

Run: `pnpm vitest run && pnpm typecheck && pnpm lint` — Expected: all pass.

```bash
git add control-plane/package.json control-plane/pnpm-lock.yaml control-plane/vitest.config.ts control-plane/src/hooks/useSurfacePolicy.ts control-plane/src/hooks/useSurfacePolicy.test.ts
git commit -m "feat(control-plane): vitest infra + useSurfacePolicy hook"
```

---

### Task 7: `SurfacePolicyPopover` + avatar hover/long-press anchor

**Files:**
- Create: `control-plane/src/molecules/SurfacePolicyPopover.tsx`
- Create: `control-plane/src/molecules/SurfacePolicyPopover.test.tsx`
- Modify: `control-plane/src/molecules/AgentAvatar.tsx` (anchor + open state)
- Modify: `control-plane/src/styles/components.css` (popover styles)

**Interfaces:**
- Consumes: `useSurfacePolicy`, `SURFACES`, `joinNowVisible` (Task 6); `SegmentedControl` atom (as used in `DiscordIdentityPanel.tsx`); `useLongPress` hook (as used in `AgentRoster.tsx`).
- Produces: `<SurfacePolicyPopover agentId name onClose />`; `AgentAvatar` gains optional `agentId?: string` — when present, hover (500ms intent delay) or long-press opens the popover.

- [ ] **Step 1: Write the failing component test**

```tsx
// control-plane/src/molecules/SurfacePolicyPopover.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SurfacePolicyPopover } from './SurfacePolicyPopover';

const agentsPayload = (channels: unknown, presence: Record<string, boolean>, configured = true) => ({
  agents: [{ id: 'ignacio', name: 'Ignacio', channels, presence }],
  discord: { configured, voiceReady: configured },
});

describe('SurfacePolicyPopover', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders one row per surface with live presence, and Join now only when visible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(
      agentsPayload({ tauri: 'autojoin', discord: 'on-request', 'discord-voice': 'on-request' },
        { tauri: true, discord: true, 'discord-voice': false }),
    ))));
    render(<SurfacePolicyPopover agentId="ignacio" name="Ignacio" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Discord voice')).toBeDefined());
    // discord is on-request but PRESENT (admitted) → no Join now; discord-voice absent → Join now.
    expect(screen.getAllByRole('button', { name: /join now/i })).toHaveLength(1);
  });

  it('mode click PUTs the full record with a channels map', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') return new Response(JSON.stringify({ ok: true }));
      return new Response(JSON.stringify(agentsPayload(['tauri'], { tauri: true })));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<SurfacePolicyPopover agentId="ignacio" name="Ignacio" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Discord text')).toBeDefined());
    await userEvent.click(screen.getAllByRole('radio', { name: /disabled/i })[0]!);
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(put).toBeDefined();
    const body = JSON.parse(String(put![1]!.body));
    expect(body.channels).toMatchObject({ tauri: 'disabled', discord: 'disabled', 'discord-voice': 'disabled' });
  });

  it('grays the Discord rows when Discord is unconfigured', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(
      agentsPayload({}, {}, false),
    ))));
    render(<SurfacePolicyPopover agentId="ignacio" name="Ignacio" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/not configured/i)).toBeDefined());
  });
});
```

(If `SegmentedControl` doesn't expose `role="radio"`, read `control-plane/src/atoms/SegmentedControl.tsx` first and target whatever roles/labels it actually renders — adjust the queries, not the behavior under test.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run` — Expected: FAIL (component missing).

- [ ] **Step 3: Implement the popover**

Structure (styling via `components.css` classes, following the file's existing BEM-ish conventions, e.g. `.surface-popover`, `.surface-popover__row`):

```tsx
export function SurfacePolicyPopover({ agentId, name, onClose }: { agentId: string; name: string; onClose: () => void }) {
  const { loading, modes, presence, discord, errors, setMode, joinNow } = useSurfacePolicy(agentId);
  // <div className="surface-popover" role="dialog" aria-label={`${name} — surfaces`}>
  //   header: `${name} — surfaces`
  //   for each of SURFACES:
  //     presence dot (filled when presence[key])
  //     label
  //     SegmentedControl with the three modes, selected=modes[key], onSelect=(m) => setMode(key, m)
  //     Join now button when joinNowVisible(modes[key], presence[key]) — onClick={() => joinNow(key)}
  //     inline error line when errors[key]
  //   Discord rows: when !discord.configured, render the row grayed (disabled controls) with
  //   a note "Discord is not configured on the broker" instead of live controls.
  //   Escape key calls onClose.
}
```

In `AgentAvatar.tsx`: accept `agentId?: string`; wrap the existing `<Avatar …/>` in a relatively-positioned span; open on `onMouseEnter` after a 500ms timer (cancel on leave — hover intent, not flicker), keep open while the pointer is inside the popover, close on leave of the whole anchor or Escape; on touch, open via `useLongPress` (same hook and thresholds `AgentRoster.tsx` uses). The popover must not hijack the avatar's existing `onClick` (calling on a hand-raise still works).

- [ ] **Step 4: Run everything**

Run: `pnpm vitest run && pnpm typecheck && pnpm lint` — Expected: all pass.

- [ ] **Step 5: Wire `agentId` through and commit**

In `AgentRoster.tsx`, pass `agentId={entry.id}` where `AgentAvatar` is rendered for solo agents (squad circles: skip — per-member config belongs to the member avatars in the expanded view).

```bash
git add control-plane/src/molecules/SurfacePolicyPopover.tsx control-plane/src/molecules/SurfacePolicyPopover.test.tsx control-plane/src/molecules/AgentAvatar.tsx control-plane/src/organisms/AgentRoster.tsx control-plane/src/styles/components.css
git commit -m "feat(control-plane): surface-policy popover on avatar hover/long-press"
```

---

### Task 8: Manual end-to-end verification + MANUAL-TESTING.md entry

**Files:**
- Modify: `docs/MANUAL-TESTING.md` (append a "Surface presence modes" section with the checklist below)

**Interfaces:** none — this is the live verification the automated tests can't give (real Discord gateway, real Tauri window).

- [ ] **Step 1: Run the stack** (broker `npm run serve` from `broker/` with the Discord env vars set; control-plane `pnpm tauri dev` or `pnpm dev`)

- [ ] **Step 2: Walk the checklist and append it to `docs/MANUAL-TESTING.md`:**

```markdown
## Surface presence modes (2026-07-29)

- Hover an agent's avatar (desktop) → popover lists Tauri app / Discord text / Discord voice with modes.
- Long-press the avatar (touch) → same popover.
- With the crew in a VC: flip an agent's Discord voice to **disabled** → their bot leaves the VC member list within a beat; others stay.
- Flip it back to **autojoin** while the crew is still in the VC → the bot rejoins.
- Set an agent to **on request**, have the crew join a VC → that agent stays out; press **Join now** → they join.
- Press **Join now** when the crew is NOT in a VC → inline "the crew isn't in a voice channel yet" error, button still enabled.
- Everyone leaves the VC and a human rejoins → the on-request agent stays out (admission cleared), autojoin agents return.
- Restart the broker mid-admission → the admitted on-request agent does not auto-return.
- Unset DISCORD_TOKEN and restart → both Discord rows render grayed with the "not configured" note.
- Hand-edit an agent file back to the legacy array form → behavior matches the pre-feature suite (text delivered, voice only when designated).
```

- [ ] **Step 3: Fix anything the walk surfaces** (each fix goes through its owning task's test file first — red, green, then amend here)

- [ ] **Step 4: Commit**

```bash
git add docs/MANUAL-TESTING.md
git commit -m "docs: manual test checklist for surface presence modes"
```
