# Workspace Channels (Discord Text + Voice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Discord bot token + channel definitions (text and voice) out of `.env`, boot-time, global config into per-workspace, UI-editable config, with broker connecting to a workspace's Discord bot only while that workspace's session is active.

**Architecture:** Config + credential both live in a new untracked, per-workspace file (`swarm/.smith/channels/<name>.json`) — separate from the tracked `Workspace` record, since a Workspace file is git-tracked and can never hold a live secret. A new `ChannelsManagerModal` (own entry point, own screen — not inside the workspace connector form) lets an operator edit a workspace's bot token + channel lists. Broker gains a session-activation lifecycle hook that tears down the previous workspace's Discord connections (if any) and boots the newly-active workspace's (if configured) — text and voice each get their own boot/teardown pair, sized separately because voice has none today and text already has an unused one.

**Tech Stack:** TypeScript, Fastify (swarm), plain Node `http`/`ws` + `discord.js` (broker), React + Vite (control-plane), `node:test` (swarm/broker tests), Vitest (control-plane tests), Biome (lint/format).

## Global Constraints

- Spec source of truth: `docs/superpowers/specs/2026-08-05-workspace-channels-design.md`.
- Channels get their own dedicated UI area — not a fieldset inside `WorkspaceManagerModal`'s connector form, not inside `AccountPanel`.
- Anything holding a credential stays untracked: `swarm/.smith/channels/*.json` relies on the existing blanket `swarm/.smith/*` `.gitignore` rule — do NOT add a `!swarm/.smith/channels/` override.
- API responses never round-trip the bot token: redact to `hasDiscordToken: boolean`.
- Broker connects to a workspace's Discord bot only while that workspace's session is active — never more than one live Discord connection (per surface: text, voice) at a time.
- CORS origin-restriction (the `isAllowedOrigin`/`credentialCors` pattern already in `broker/src/text-channel.ts`) is applied to the new channels routes from the start — not shipped open and fixed later.
- Swarm tests: `node --import tsx --test --test-timeout 60000 'src/*.test.ts' 'src/**/*.test.ts'` (run via `npm test` from `swarm/`).
- Broker tests: `node --import tsx --test src/*.test.ts` (run via `npm test` from `broker/`).
- Control-plane tests: `vitest run` (run via `npm run test` from `control-plane/`, uses **pnpm** as package manager — `pnpm run test`); typecheck via `pnpm run typecheck`; lint via `pnpm run lint`.
- Fastify route error convention: `reply.status(<code>).send({ error: '<message>' })`.
- `node:test` conventions: `import { test } from 'node:test'; import assert from 'node:assert/strict';` — no `describe`, no hooks; fixtures are real temp dirs via `mkdtemp(join(tmpdir(), '<prefix>-'))`.
- Control-plane test conventions: Vitest, explicit imports (`test.globals` not set) — `render`/`screen`/`waitFor` from `@testing-library/react`, `userEvent` default import, `afterEach`/`describe`/`expect`/`it`/`vi` from `"vitest"`, `cleanup()` in `afterEach`.
- Commit after every task, terse present-tense commit style matching this repo's `git log`.
- No new dependency in `swarm/` — Discord token verification uses plain `fetch` against `https://discord.com/api/v10/users/@me` with a `Bot <token>` header, the same shape `verify-github.ts` already uses for GitHub. `discord.js` is already a `broker/` dependency (`^14.27.0`) — no new dependency there either.

---

## Phase 1 — Config & Credential Plumbing

### Task 1: `swarm/src/channels.ts` — data model

**Files:**
- Create: `swarm/src/channels.ts`
- Test: `swarm/src/channels.test.ts`

**Interfaces:**
- Produces: `WorkspaceChannels { discord?: { botToken: string; textChannels: string[]; voiceChannels: string[] } }`, `loadChannelsFor(dir: string, workspaceName: string): Promise<WorkspaceChannels | null>`, `saveChannels(dir: string, workspaceName: string, channels: WorkspaceChannels): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```ts
// swarm/src/channels.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadChannelsFor, saveChannels } from './channels.js';

test('saveChannels rejects a bad workspace-name slug and round-trips a good one, including the bot token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'channels-'));
  await assert.rejects(() => saveChannels(dir, 'Bad Name', { discord: { botToken: 'x', textChannels: [], voiceChannels: [] } }));
  await saveChannels(dir, 'acme', {
    discord: { botToken: 'discord-tok', textChannels: ['111'], voiceChannels: ['222'] },
  });
  const loaded = await loadChannelsFor(dir, 'acme');
  assert.deepEqual(loaded, { discord: { botToken: 'discord-tok', textChannels: ['111'], voiceChannels: ['222'] } });
});

test('saveChannels writes owner-only permissions (0o600), same as users.ts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'channels-'));
  await saveChannels(dir, 'acme', { discord: { botToken: 'tok', textChannels: [], voiceChannels: [] } });
  const st = await stat(join(dir, 'acme.json'));
  assert.equal(st.mode & 0o777, 0o600);
});

test('loadChannelsFor returns null for a workspace with no channels file yet', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'channels-'));
  assert.equal(await loadChannelsFor(dir, 'nope'), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `swarm/`): `npm test -- --test-name-pattern="saveChannels|loadChannelsFor"`
Expected: FAIL — `Cannot find module './channels.js'`

- [ ] **Step 3: Implement `channels.ts`** (mirrors `users.ts`'s untracked, owner-only-permissions pattern exactly — see that file's `saveUser` — but keyed by workspace name via a direct lookup, not a "current user" resolution)

```ts
// swarm/src/channels.ts
// Workspace channels — Discord bot token + channel lists, per workspace.
// One JSON file per workspace under .smith/channels/, untracked (holds the
// bot token) — same invariant as users.ts, applied to a different owner:
// Workspace records are git-tracked and can never hold a live secret, so
// this lives in its own untracked companion file, keyed by the same
// workspace name (design §"Settled decisions").
import { readdir, readFile, mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface WorkspaceChannels {
  discord?: {
    botToken: string;              // secret
    textChannels: string[];        // Discord channel IDs
    voiceChannels: string[];       // Discord channel IDs
  };
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** One workspace's channel config, or null if it has none configured yet. */
export async function loadChannelsFor(dir: string, workspaceName: string): Promise<WorkspaceChannels | null> {
  try {
    const raw = await readFile(join(dir, `${workspaceName}.json`), 'utf8');
    return JSON.parse(raw) as WorkspaceChannels;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Write one workspace's channel config to `dir`. Mirror of users.saveUser — owner-only permissions (0o600). */
export async function saveChannels(dir: string, workspaceName: string, channels: WorkspaceChannels): Promise<void> {
  if (!SLUG.test(workspaceName)) {
    throw new Error(`Invalid workspace name "${workspaceName}": use lowercase letters, digits and dashes`);
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = join(dir, `${workspaceName}.json`);
  const fh = await open(filePath, 'w', 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(channels, null, 2)}\n`);
  } finally {
    await fh.close();
  }
}

/** Remove a workspace's channel config file, if any. No-op if it never existed. */
export async function removeChannelsFor(dir: string, workspaceName: string): Promise<void> {
  await rm(join(dir, `${workspaceName}.json`), { force: true });
}
```

`loadChannelsFor` is deliberately unlike `users.ts`'s `loadUsersFromDir` (which loads every file in the directory into an array) — this reads one workspace's file directly by name, since callers always know which workspace they're asking about (no "load all, then resolve" step needed, unlike `resolveCurrentUser`'s default-flag fallback).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="saveChannels|loadChannelsFor"`
Expected: PASS

- [ ] **Step 5: Confirm the untracked-storage invariant, then commit**

```bash
cd swarm && mkdir -p .smith/channels && echo '{}' > .smith/channels/tmp.json
git check-ignore -v .smith/channels/tmp.json   # must print the swarm/.smith/* rule
rm -rf .smith/channels
git add swarm/src/channels.ts swarm/src/channels.test.ts
git commit -m "feat(swarm): WorkspaceChannels data model — Discord bot token + channel lists, per workspace"
```

---

### Task 2: `swarm/src/verify-discord.ts` — token verification

**Files:**
- Create: `swarm/src/verify-discord.ts`
- Test: `swarm/src/verify-discord.test.ts`

**Interfaces:**
- Produces: `verifyDiscordToken(token: string, fetchImpl?: typeof fetch): Promise<{ ok: boolean; detail: string }>`.

- [ ] **Step 1: Write the failing tests**

```ts
// swarm/src/verify-discord.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyDiscordToken } from './verify-discord.js';

test('verifyDiscordToken: ok on 200 from /users/@me, sends Bot auth', async () => {
  const f = (async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), 'https://discord.com/api/v10/users/@me');
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bot disc-tok');
    return new Response(JSON.stringify({ username: 'smithagents-crew', id: '123' }), { status: 200 });
  }) as typeof fetch;
  const r = await verifyDiscordToken('disc-tok', f);
  assert.equal(r.ok, true);
  assert.match(r.detail, /smithagents-crew/);
});

test('verifyDiscordToken: not ok on 401, detail carries the reason', async () => {
  const f = (async () => new Response(JSON.stringify({ message: '401: Unauthorized' }), { status: 401 })) as typeof fetch;
  const r = await verifyDiscordToken('bad-tok', f);
  assert.equal(r.ok, false);
  assert.match(r.detail, /401/);
});

test('verifyDiscordToken: network failure resolves {ok:false}, never rejects', async () => {
  const f = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  const r = await verifyDiscordToken('any-tok', f);
  assert.equal(r.ok, false);
  assert.match(r.detail, /fetch failed/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="verifyDiscordToken"`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
// swarm/src/verify-discord.ts
// Live check for a Discord bot token — same shape as verify-github.ts's
// verifyGithubToken: plain fetch, no discord.js dependency needed here
// (swarm has none; that's a broker-only dependency). Wraps the fetch in
// try/catch from the start — this codebase already had to retrofit that
// once for verify-atlassian.ts/verify-github.ts, no reason to ship the same
// gap here.
export interface VerifyResult {
  ok: boolean;
  detail: string;
}

const DISCORD_API = 'https://discord.com/api/v10';

export async function verifyDiscordToken(token: string, fetchImpl: typeof fetch = fetch): Promise<VerifyResult> {
  try {
    const res = await fetchImpl(`${DISCORD_API}/users/@me`, { headers: { authorization: `Bot ${token}` } });
    const body = (await res.json().catch(() => ({}))) as { username?: string; message?: string };
    if (!res.ok) return { ok: false, detail: `Discord ${res.status}: ${body.message ?? 'unauthorized'}` };
    return { ok: true, detail: `Bot authenticated as ${body.username}` };
  } catch (err) {
    return { ok: false, detail: `Could not reach Discord: ${err instanceof Error ? err.message : String(err)}` };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="verifyDiscordToken"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add swarm/src/verify-discord.ts swarm/src/verify-discord.test.ts
git commit -m "feat(swarm): verifyDiscordToken live-check helper"
```

---

### Task 3: Swarm routes — `GET/PUT /workspaces/:name/channels`, `POST /workspaces/:name/channels/verify-discord`, plus an internal-only raw-token route

**Files:**
- Modify: `swarm/src/server.ts`

**Interfaces:**
- Consumes: `loadChannelsFor`/`saveChannels` (Task 1), `verifyDiscordToken` (Task 2).
- Produces: `buildChannelsUpdate(existing: WorkspaceChannels | null, b: Partial<WorkspaceChannels>): WorkspaceChannels` — a new module-level **exported** function, placed at the end of `server.ts` right after `buildUserUpdate` (which is also module-level/exported there), matching that function's own doc-comment convention ("Pulled out of the route handler so it's unit-testable without booting the server.").

**A fourth route is needed beyond the three the design spec anticipated, for a reason the spec didn't foresee.** Every other credential in this codebase (Jira/Confluence/GitHub) is used by *swarm itself* to make a one-shot external call and return only the result — the raw token never has to leave swarm's process. Discord is different: the live connection (discord.js Gateway WebSocket, message/voice event handling) lives in **broker**, not swarm — broker already owns all of that code (`discord-adapter.ts`, `discord-voice.ts`). That means broker genuinely needs the *raw* bot token at least once, to open its own connection — the redacted `GET /workspaces/:name/channels` route (correct for the UI) can never serve that need. The mitigation: a separate, unambiguously-named internal route, never proxied through `text-channel.ts`'s browser-facing, origin-restricted surface — broker's `SwarmClient` calls it directly, server-to-server, the same trust boundary broker and swarm already share for everything else in `all-local` mode (loopback-bound, no auth).

**Read `swarm/src/server.ts` fresh before editing** — this file has been modified by several other tasks already; the exact current line numbers for where to insert (`redactUser`/`/me` routes at ~1317, `buildUserUpdate` at the file's tail ~1861) are a snapshot, not guaranteed current by the time you start. Find the real current `/me`/verify-routes block (search for `redactUser`) and the real current tail (search for `buildUserUpdate`) and insert relative to those.

- [ ] **Step 1: Write the failing tests** (mirrors `server.test.ts`'s existing `buildUserUpdate` tests — read that file first to match its exact style)

```ts
// swarm/src/server.test.ts — append, following the file's existing buildUserUpdate/workspaceProblems test style
import { buildChannelsUpdate } from './server.js';

test('buildChannelsUpdate: a submitted discord block replaces the existing one wholesale (no partial-field merge needed — unlike User.atlassian, there is only one credential field, botToken, so there is no sibling-field-blanking risk to guard against)', () => {
  const existing = { discord: { botToken: 'old-tok', textChannels: ['1'], voiceChannels: [] } };
  const merged = buildChannelsUpdate(existing, { discord: { botToken: 'new-tok', textChannels: ['1', '2'], voiceChannels: ['9'] } });
  assert.deepEqual(merged, { discord: { botToken: 'new-tok', textChannels: ['1', '2'], voiceChannels: ['9'] } });
});

test('buildChannelsUpdate: omitting discord in the submitted body preserves the existing config', () => {
  const existing = { discord: { botToken: 'old-tok', textChannels: ['1'], voiceChannels: [] } };
  const merged = buildChannelsUpdate(existing, {});
  assert.deepEqual(merged, existing);
});

test('buildChannelsUpdate: no existing config and no submitted discord block yields an empty config', () => {
  assert.deepEqual(buildChannelsUpdate(null, {}), {});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="buildChannelsUpdate"`
Expected: FAIL — `buildChannelsUpdate` doesn't exist.

- [ ] **Step 3: Add the module-level function, the imports, and the three routes**

```ts
// swarm/src/server.ts — extend the existing import block (find it — likely near the users.js/verify-github.js imports)
import { loadChannelsFor, saveChannels, type WorkspaceChannels } from './channels.js';
import { verifyDiscordToken } from './verify-discord.js';
```

```ts
// swarm/src/server.ts — three new routes, placed alongside the existing /workspaces/:name/... routes
// (find the real current location — search for the verify-atlassian/verify-github routes and insert nearby)
const redactChannels = (c: WorkspaceChannels | null) => ({
  hasDiscordToken: Boolean(c?.discord?.botToken),
  textChannels: c?.discord?.textChannels ?? [],
  voiceChannels: c?.discord?.voiceChannels ?? [],
});

this.app.get<{ Params: { name: string } }>('/workspaces/:name/channels', async (req, reply) => {
  const ws = server.workspaces.find((w) => w.name === req.params.name);
  if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
  const channels = await loadChannelsFor(resolve(process.cwd(), '.smith/channels'), req.params.name);
  return redactChannels(channels);
});

this.app.put<{ Params: { name: string } }>('/workspaces/:name/channels', async (req, reply) => {
  const ws = server.workspaces.find((w) => w.name === req.params.name);
  if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
  const dir = resolve(process.cwd(), '.smith/channels');
  const existing = await loadChannelsFor(dir, req.params.name);
  const b = req.body as Partial<WorkspaceChannels>;
  const merged = buildChannelsUpdate(existing, b);
  try {
    await saveChannels(dir, req.params.name, merged);
  } catch (err) {
    return reply.status(400).send({ error: String((err as Error).message) });
  }
  return redactChannels(merged);
});

this.app.post<{ Params: { name: string } }>('/workspaces/:name/channels/verify-discord', async (req, reply) => {
  const ws = server.workspaces.find((w) => w.name === req.params.name);
  if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
  const channels = await loadChannelsFor(resolve(process.cwd(), '.smith/channels'), req.params.name);
  if (!channels?.discord?.botToken) {
    return reply.status(400).send({ error: `Workspace "${ws.name}" has no Discord bot token saved yet` });
  }
  return verifyDiscordToken(channels.discord.botToken);
});

// Internal-only — returns the RAW bot token, unlike every other route in this
// block. Never proxied through broker's browser-facing text-channel.ts
// surface (see this task's header note for why this route has to exist at
// all). broker's SwarmClient calls it directly, server-to-server, on the
// same loopback-bound, no-separate-auth trust boundary broker and swarm
// already share for every other request between them in all-local mode.
this.app.get<{ Params: { name: string } }>('/workspaces/:name/channels/discord-token', async (req, reply) => {
  const ws = server.workspaces.find((w) => w.name === req.params.name);
  if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
  const channels = await loadChannelsFor(resolve(process.cwd(), '.smith/channels'), req.params.name);
  if (!channels?.discord) return reply.status(404).send({ error: `Workspace "${ws.name}" has no Discord config` });
  return channels.discord;
});
```

```ts
// swarm/src/server.ts — new module-level exported function, placed right after buildUserUpdate at the file's tail
/**
 * PUT /workspaces/:name/channels merge: a submitted `discord` block replaces
 * the existing one wholesale — unlike User.atlassian's two-field credential
 * pair (email/apiToken, where a partial submission could blank one field
 * while updating the other), WorkspaceChannels.discord has exactly one
 * credential field (botToken) alongside two plain lists, so there's no
 * sibling-field-blanking risk the way there was for PUT /me — see that
 * route's fix history. Pulled out of the route handler so it's unit-testable
 * without booting the server.
 */
export function buildChannelsUpdate(existing: WorkspaceChannels | null, b: Partial<WorkspaceChannels>): WorkspaceChannels {
  return {
    discord: b.discord ?? existing?.discord,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="buildChannelsUpdate"`
Expected: PASS

- [ ] **Step 5: Manual verification**

```bash
cd swarm && cp ../.env.example ../.env 2>/dev/null; npm run serve &
curl -s http://localhost:7777/workspaces/jefelabs/channels | jq   # {"hasDiscordToken":false,"textChannels":[],"voiceChannels":[]}
curl -s -X PUT http://localhost:7777/workspaces/jefelabs/channels -H 'content-type: application/json' \
  -d '{"discord":{"botToken":"test-tok","textChannels":["111"],"voiceChannels":[]}}' | jq
curl -s http://localhost:7777/workspaces/jefelabs/channels | jq '.hasDiscordToken'   # true — persisted, token itself absent
curl -s -X POST http://localhost:7777/workspaces/jefelabs/channels/verify-discord | jq   # {"ok":false,"detail":"Discord 401: ..."} (fake token)
curl -s http://localhost:7777/workspaces/jefelabs/channels/discord-token | jq   # {"botToken":"test-tok","textChannels":["111"],"voiceChannels":[]} — the ONE route in this task that returns the raw token; confirm every other route above never does
kill %1; rm -f ../.env   # only if you created it just now for this check — confirm with git status --short first
```

- [ ] **Step 6: Run the full swarm suite and typecheck, then commit**

```bash
npm test        # confirm no regression
npx tsc --noEmit
git add swarm/src/server.ts swarm/src/server.test.ts
git commit -m "feat(swarm): GET/PUT /workspaces/:name/channels, verify-discord route, internal discord-token route"
```

---

### Task 4: Broker proxy — `SwarmClient` methods + `SwarmClientLike` widen

**Files:**
- Modify: `broker/src/swarm-client.ts`
- Modify: `broker/src/broker.ts`
- Test: `broker/src/swarm-client.test.ts`

**Interfaces:**
- Produces: `SwarmClient.getWorkspaceChannels(name): Promise<ChannelsRecord>`, `.saveWorkspaceChannels(name, body): Promise<ChannelsRecord>`, `.verifyWorkspaceDiscord(name): Promise<VerifyResult>`, `.getWorkspaceDiscordConfig(name): Promise<DiscordChannelsConfig | null>`; `ChannelsRecord { hasDiscordToken: boolean; textChannels: string[]; voiceChannels: string[] }`, `DiscordChannelsConfig { botToken: string; textChannels: string[]; voiceChannels: string[] }`.
- `getWorkspaceDiscordConfig` (the one method that returns the raw token — calls Task 3's internal-only `/discord-token` route) is used **directly by `main.ts`'s session-lifecycle hook (Task 9)**, not through `BrokerDeps`/`Broker`. It is deliberately **not** added to the `SwarmClientLike` interface below — that interface is what `Broker`'s executors use, and none of them need the raw token; only the Discord connection lifecycle (owned in `main.ts`, outside `Broker`) does. Keeping it off `SwarmClientLike` means no hand-built fake implementing that interface needs a stub for a method it will never call.

- [ ] **Step 1: Write the failing test**

```ts
// broker/src/swarm-client.test.ts — append, using this file's existing fakeFetch helper
test('channels methods hit the right swarm routes', async () => {
  const calls: string[] = [];
  const client = new SwarmClient({
    baseUrl: 'http://s',
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url).replace('http://s', '')}`);
      return new Response(JSON.stringify({ hasDiscordToken: false, textChannels: [], voiceChannels: [], ok: true, detail: 'x' }));
    }) as typeof fetch,
  });
  await client.getWorkspaceChannels('acme');
  await client.saveWorkspaceChannels('acme', { discord: { botToken: 'tok', textChannels: [], voiceChannels: [] } });
  await client.verifyWorkspaceDiscord('acme');
  await client.getWorkspaceDiscordConfig('acme');
  assert.deepEqual(calls, [
    'GET /workspaces/acme/channels',
    'PUT /workspaces/acme/channels',
    'POST /workspaces/acme/channels/verify-discord',
    'GET /workspaces/acme/channels/discord-token',
  ]);
});

test('getWorkspaceDiscordConfig returns null when the workspace has no Discord config (404), instead of throwing', async () => {
  const client = new SwarmClient({
    baseUrl: 'http://s',
    fetchImpl: (async () => new Response(JSON.stringify({ error: 'no Discord config' }), { status: 404 })) as typeof fetch,
  });
  assert.equal(await client.getWorkspaceDiscordConfig('acme'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `broker/`): `npm test -- --test-name-pattern="channels methods hit the right"`
Expected: FAIL — methods don't exist.

- [ ] **Step 3: Add the types and methods**

```ts
// broker/src/swarm-client.ts — new exported types, near MeRecord/VerifyResult
export interface ChannelsRecord {
  hasDiscordToken: boolean;
  textChannels: string[];
  voiceChannels: string[];
}

/** Raw shape — holds the actual bot token. Only getWorkspaceDiscordConfig returns this. */
export interface DiscordChannelsConfig {
  botToken: string;
  textChannels: string[];
  voiceChannels: string[];
}
```

```ts
// broker/src/swarm-client.ts — new methods on SwarmClient
async getWorkspaceChannels(name: string): Promise<ChannelsRecord> {
  return this.http('GET', `/workspaces/${encodeURIComponent(name)}/channels`) as unknown as Promise<ChannelsRecord>;
}

async saveWorkspaceChannels(
  name: string,
  body: { discord?: { botToken: string; textChannels: string[]; voiceChannels: string[] } },
): Promise<ChannelsRecord> {
  return this.http('PUT', `/workspaces/${encodeURIComponent(name)}/channels`, body) as unknown as Promise<ChannelsRecord>;
}

async verifyWorkspaceDiscord(name: string): Promise<VerifyResult> {
  return this.http('POST', `/workspaces/${encodeURIComponent(name)}/channels/verify-discord`, {}) as unknown as Promise<VerifyResult>;
}

/**
 * The one method in this class that returns a raw secret — used only by
 * main.ts's Discord connection lifecycle (Task 9), never through
 * BrokerDeps/Broker. `http()` throws on any non-2xx (including the expected,
 * routine "this workspace has no Discord config" 404) — that's a normal
 * outcome here, not a failure worth surfacing, so it's swallowed into `null`
 * rather than propagated. A swarm-down/network failure collapses into the
 * same `null` — the lifecycle hook's correct response to "can't reach swarm"
 * is identical to "no Discord configured": skip Discord for this workspace.
 */
async getWorkspaceDiscordConfig(name: string): Promise<DiscordChannelsConfig | null> {
  try {
    return (await this.http('GET', `/workspaces/${encodeURIComponent(name)}/channels/discord-token`)) as unknown as DiscordChannelsConfig;
  } catch {
    return null;
  }
}
```

```ts
// broker/src/broker.ts — widen SwarmClientLike (import ChannelsRecord from swarm-client.ts alongside the existing imports there)
export interface SwarmClientLike {
  // ...existing methods unchanged...
  getWorkspaceChannels(name: string): Promise<ChannelsRecord>;
  saveWorkspaceChannels(name: string, body: { discord?: { botToken: string; textChannels: string[]; voiceChannels: string[] } }): Promise<ChannelsRecord>;
  verifyWorkspaceDiscord(name: string): Promise<VerifyResult>;
}
```

**Widening `SwarmClientLike` breaks any hand-built fake implementing it** (this happened once already, for `broker.test.ts`'s fake in an earlier task) — search `broker/src/*.test.ts` for object literals typed as or assigned to `SwarmClientLike`/passed as the `swarm:` dep, and add matching stub methods to keep them type-valid. Confirm via `npx tsc --noEmit` after this step, not just the targeted test.

- [ ] **Step 4: Run test to verify it passes, typecheck, commit**

Run: `npm test -- --test-name-pattern="channels methods hit the right"` → PASS
Run: `npm run typecheck` → clean (confirms no broken fakes elsewhere)

```bash
git add broker/src/swarm-client.ts broker/src/swarm-client.test.ts broker/src/broker.ts broker/src/broker.test.ts
git commit -m "feat(broker): SwarmClient channels methods, widen SwarmClientLike"
```

---

### Task 5: Broker local routes — `/workspaces/:name/channels` passthrough, with CORS origin restriction from the start

**Files:**
- Modify: `broker/src/text-channel.ts`
- Modify: `broker/src/main.ts`
- Test: `broker/src/text-channel.test.ts`

**Interfaces:**
- Consumes: `SwarmClient.getWorkspaceChannels/saveWorkspaceChannels/verifyWorkspaceDiscord` (Task 4), the existing `isAllowedOrigin`/`credentialCors`/`originBlocked`-style helpers already in `text-channel.ts` (added for the `/me` and verify-atlassian/verify-github routes — read that file fresh to find their exact current names and shape before reusing them).
- Produces: local `GET/PUT /workspaces/:name/channels`, `POST /workspaces/:name/channels/verify-discord` on `TextChannel`'s HTTP surface, origin-restricted the same way the `/me` routes already are.

**Read `broker/src/text-channel.ts` and `broker/src/main.ts` fresh before editing** — both have been modified multiple times by prior tasks (the constructor now has more than a dozen positional params; the CORS/origin-check helpers were added in a fix wave after this plan's sibling feature shipped). Do not assume the exact shape described in this plan's earlier connectors work is still current without checking.

- [ ] **Step 1: Write the failing test** (mirror this file's existing `/me`-origin-restriction test exactly — find it and copy its shape)

```ts
// broker/src/text-channel.test.ts — append, using channelWith + the file's existing origin-check test pattern
test('GET /workspaces/:name/channels is origin-restricted like /me; PUT round-trips through', async () => {
  const calls: string[] = [];
  const channel = channelWith({
    channels: {
      get: async (name: string) => {
        calls.push(`get ${name}`);
        return { hasDiscordToken: false, textChannels: [], voiceChannels: [] };
      },
      save: async (name: string, body: unknown) => {
        calls.push(`save ${name}`);
        return { hasDiscordToken: true, textChannels: [], voiceChannels: [] };
      },
      verifyDiscord: async (name: string) => ({ ok: true, detail: 'Bot authenticated as crew' }),
    },
  });
  const port = await channel.start(0);
  try {
    const blocked = await fetch(`http://127.0.0.1:${port}/workspaces/acme/channels`, {
      headers: { Origin: 'http://evil.example' },
    });
    assert.equal(blocked.status, 403);

    const get = await fetch(`http://127.0.0.1:${port}/workspaces/acme/channels`, {
      headers: { Origin: 'http://localhost:1420' },
    });
    assert.equal(get.status, 200);
    assert.deepEqual(await get.json(), { hasDiscordToken: false, textChannels: [], voiceChannels: [] });

    const put = await fetch(`http://127.0.0.1:${port}/workspaces/acme/channels`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:1420' },
      body: JSON.stringify({ discord: { botToken: 'tok', textChannels: [], voiceChannels: [] } }),
    });
    assert.equal((await put.json()).hasDiscordToken, true);
    assert.deepEqual(calls, ['get acme', 'save acme']);
  } finally {
    await channel.stop();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="channels is origin-restricted"`
Expected: FAIL — `channelWith` doesn't accept `channels`, routes 404.

- [ ] **Step 3: Extend `TextChannel`'s constructor and add the three routes**

Find the constructor's existing credential-adjacent dependency param (likely `me?: {...}`, following the `workspaces?: {...}` param) and add a new sibling param after it:

```ts
// broker/src/text-channel.ts — new constructor param, following whatever positional convention the existing me/workspaces params use
/** Per-workspace Discord channel config (channels manager UI). Origin-restricted like /me. */
private readonly channels?: {
  get(name: string): Promise<Record<string, unknown>>;
  save(name: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  verifyDiscord(name: string): Promise<Record<string, unknown>>;
},
```

Add the three routes inside the same origin-restricted block the `/me` routes already live in — reuse the existing `originBlocked()`/`credJson`/`credFail` helpers verbatim, do not reinvent them:

```ts
const wsChannelsMatch = /^\/workspaces\/([^/]+)\/channels$/.exec(url.pathname);
if (req.method === 'GET' && wsChannelsMatch && this.channels) {
  if (originBlocked()) return;
  void this.channels.get(decodeURIComponent(wsChannelsMatch[1]!)).then((r) => credJson(200, r), credFail);
  return;
}
if (req.method === 'PUT' && wsChannelsMatch && this.channels) {
  if (originBlocked()) return;
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(body || '{}') as Record<string, unknown>;
    } catch {
      return credJson(400, { error: 'body must be JSON' });
    }
    void this.channels!.save(decodeURIComponent(wsChannelsMatch[1]!), parsed).then(
      (r) => credJson((r as { error?: string }).error ? 400 : 200, r),
      credFail,
    );
  });
  return;
}
const verifyDiscordMatch = /^\/workspaces\/([^/]+)\/channels\/verify-discord$/.exec(url.pathname);
if (req.method === 'POST' && verifyDiscordMatch && this.channels) {
  if (originBlocked()) return;
  void this.channels.verifyDiscord(decodeURIComponent(verifyDiscordMatch[1]!)).then(
    (r) => credJson((r as { error?: string }).error ? 400 : 200, r),
    credFail,
  );
  return;
}
```

(`originBlocked`, `credJson`, `credFail` are whatever the existing `/me` routes' helper names actually are in the file you're reading — use those exact names, not the illustrative ones above if they differ.)

- [ ] **Step 4: Wire real implementations in `main.ts`**

```ts
// broker/src/main.ts — alongside the existing `me` object passed into `new TextChannel(...)`
{
  get: (name) => swarm.getWorkspaceChannels(name),
  save: (name, body) => swarm.saveWorkspaceChannels(name, body as { discord?: { botToken: string; textChannels: string[]; voiceChannels: string[] } }),
  verifyDiscord: (name) => swarm.verifyWorkspaceDiscord(name),
},
```

Add this as the new trailing positional arg (matching wherever the `me` object currently sits in the real, current `new TextChannel(...)` call).

- [ ] **Step 5: Run test to verify it passes, typecheck, commit**

Run: `npm test -- --test-name-pattern="channels is origin-restricted"` → PASS
Run: `npm run typecheck` → clean

```bash
git add broker/src/text-channel.ts broker/src/text-channel.test.ts broker/src/main.ts
git commit -m "feat(broker): /workspaces/:name/channels routes, origin-restricted, wired to swarm"
```

---

### Task 6: Control-plane — `ChannelsManagerModal` + entry point

**Files:**
- Create: `control-plane/src/organisms/ChannelsManagerModal.tsx`
- Test: `control-plane/src/organisms/ChannelsManagerModal.test.tsx`
- Modify: `control-plane/src/hooks/useBrokerChat.ts`
- Modify: `control-plane/src/organisms/SessionsPanel.tsx`
- Modify: `control-plane/src/pages/HomePage.tsx`

**Interfaces:**
- Consumes: broker's `GET/PUT /workspaces/:name/channels`, `POST .../verify-discord` (Task 5); reuses the **existing** `listWorkspaceRecords()` for the workspace picker — no new "list channels" endpoint needed, channels are looked up per-selected-workspace.
- Produces: `useBrokerChat` gains `ChannelsRecord` type + `getWorkspaceChannels(name)`, `saveWorkspaceChannels(name, body)`, `verifyWorkspaceDiscord(name)`; `SessionsPanelProps` gains `onManageChannels?: () => void`; `HomePage` gains `channelsOpen` state mounting `ChannelsManagerModal`.

- [ ] **Step 1: Add the hook functions**

```ts
// control-plane/src/hooks/useBrokerChat.ts — new exported type + functions
export interface ChannelsRecord {
  hasDiscordToken: boolean;
  textChannels: string[];
  voiceChannels: string[];
}

const getWorkspaceChannels = useCallback(
  async (name: string): Promise<ChannelsRecord> => {
    const res = await fetch(`http://${base}/workspaces/${encodeURIComponent(name)}/channels`);
    return (await res.json()) as ChannelsRecord;
  },
  [base],
);

const saveWorkspaceChannels = useCallback(
  async (
    name: string,
    body: { discord?: { botToken: string; textChannels: string[]; voiceChannels: string[] } },
  ): Promise<ChannelsRecord & { error?: string }> => {
    const res = await fetch(`http://${base}/workspaces/${encodeURIComponent(name)}/channels`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as ChannelsRecord & { error?: string };
  },
  [base],
);

const verifyWorkspaceDiscord = useCallback(
  async (name: string): Promise<{ ok?: boolean; detail?: string; error?: string }> => {
    const res = await fetch(`http://${base}/workspaces/${encodeURIComponent(name)}/channels/verify-discord`, {
      method: "POST",
    });
    return (await res.json()) as { ok?: boolean; detail?: string; error?: string };
  },
  [base],
);
```

Add `getWorkspaceChannels`, `saveWorkspaceChannels`, `verifyWorkspaceDiscord` to the hook's returned object.

- [ ] **Step 2: Write the failing component test**

```tsx
// control-plane/src/organisms/ChannelsManagerModal.test.tsx
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelsManagerModal } from "./ChannelsManagerModal";

describe("ChannelsManagerModal", () => {
  afterEach(() => {
    cleanup();
  });

  it("picking a workspace loads its channel config; saving submits the bot token and channel lists", async () => {
    const listWorkspaces = vi.fn(async () => [{ name: "acme", description: undefined, default: true, repos: [] }]);
    const getChannels = vi.fn(async () => ({ hasDiscordToken: false, textChannels: [], voiceChannels: [] }));
    const saveChannels = vi.fn(async () => ({ hasDiscordToken: true, textChannels: ["111"], voiceChannels: [] }));
    render(
      <ChannelsManagerModal
        open
        onClose={() => {}}
        listWorkspaces={listWorkspaces}
        getChannels={getChannels}
        saveChannels={saveChannels}
        verifyDiscord={vi.fn()}
      />,
    );
    await waitFor(() => expect(listWorkspaces).toHaveBeenCalled());
    await userEvent.click(await screen.findByText("acme"));
    await waitFor(() => expect(getChannels).toHaveBeenCalledWith("acme"));

    await userEvent.type(screen.getByPlaceholderText(/discord bot token/i), "disc-tok");
    await userEvent.type(screen.getByPlaceholderText(/text channel id/i), "111");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(saveChannels).toHaveBeenCalledWith(
        "acme",
        expect.objectContaining({ discord: expect.objectContaining({ botToken: "disc-tok", textChannels: ["111"] }) }),
      ),
    );
  });

  it("Test connection calls verifyDiscord for the selected workspace and shows the result", async () => {
    const verifyDiscord = vi.fn(async () => ({ ok: true, detail: "Bot authenticated as smithagents-crew" }));
    render(
      <ChannelsManagerModal
        open
        onClose={() => {}}
        listWorkspaces={vi.fn(async () => [{ name: "acme", description: undefined, default: true, repos: [] }])}
        getChannels={vi.fn(async () => ({ hasDiscordToken: true, textChannels: [], voiceChannels: [] }))}
        saveChannels={vi.fn()}
        verifyDiscord={verifyDiscord}
      />,
    );
    await userEvent.click(await screen.findByText("acme"));
    await userEvent.click(await screen.findByRole("button", { name: /test connection/i }));
    await waitFor(() => expect(verifyDiscord).toHaveBeenCalledWith("acme"));
    expect(await screen.findByText(/authenticated as smithagents-crew/i)).toBeDefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run (from `control-plane/`): `pnpm run test -- ChannelsManagerModal`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement `ChannelsManagerModal.tsx`** — hybrid of `WorkspaceManagerModal`'s workspace-picker shell (left column, reusing `listWorkspaceRecords`-shaped data — but note this modal reuses the SAME `list` prop shape as `WorkspaceManagerModal`, i.e. `() => Promise<WorkspaceRecord[]>`, purely to populate the picker; it never calls `saveWorkspace`) and `AccountPanel`'s single-credential form shape (right column, once a workspace is picked). Reuses the existing `.workspace-manager`/`.workspace-manager__head`/`.workspace-row*`/`.account-panel__form` CSS classes verbatim — no new CSS needed, matching the precedent `AccountPanel` already set by reusing `.workspace-manager__head`.

```tsx
// control-plane/src/organisms/ChannelsManagerModal.tsx
import { Plus, X } from "lucide-react";
import type { MouseEvent } from "react";
import { useEffect, useState } from "react";
import type { ChannelsRecord, WorkspaceRecord } from "../hooks/useBrokerChat";

interface ChannelsManagerModalProps {
  open: boolean;
  onClose: () => void;
  listWorkspaces: () => Promise<WorkspaceRecord[]>;
  getChannels: (name: string) => Promise<ChannelsRecord>;
  saveChannels: (
    name: string,
    body: { discord?: { botToken: string; textChannels: string[]; voiceChannels: string[] } },
  ) => Promise<ChannelsRecord & { error?: string }>;
  verifyDiscord: (name: string) => Promise<{ ok?: boolean; detail?: string; error?: string }>;
}

interface FormState {
  hasDiscordToken: boolean;
  botToken: string;       // cleared to "" on every load — never round-tripped
  textChannels: string[];
  voiceChannels: string[];
}

const blankForm = (): FormState => ({ hasDiscordToken: false, botToken: "", textChannels: [], voiceChannels: [] });

/** Discord (and future channel-type) config — its own area, separate from the workspace connector form. */
export function ChannelsManagerModal({ open, onClose, listWorkspaces, getChannels, saveChannels, verifyDiscord }: ChannelsManagerModalProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(blankForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [testing, setTesting] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-fetch when the panel opens
  useEffect(() => {
    if (!open) return;
    setSelected(null);
    setForm(blankForm());
    setError(null);
    setTestResult(null);
    setLoadError(null);
    void listWorkspaces().then(setWorkspaces, (err: unknown) => setLoadError(`Could not load workspaces — ${String(err)}`));
  }, [open]);

  if (!open) return null;

  const selectWorkspace = (name: string) => {
    setSelected(name);
    setError(null);
    setTestResult(null);
    void getChannels(name).then((c) => setForm({ hasDiscordToken: c.hasDiscordToken, botToken: "", textChannels: c.textChannels, voiceChannels: c.voiceChannels }));
  };

  const submit = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    // No botToken typed and nothing saved yet -> omit discord entirely rather
    // than persist an empty-token block (same "don't send what wasn't
    // touched" discipline AccountPanel already applies to its own secrets).
    const discord =
      form.botToken.trim() || form.hasDiscordToken
        ? { botToken: form.botToken.trim(), textChannels: form.textChannels.filter(Boolean), voiceChannels: form.voiceChannels.filter(Boolean) }
        : undefined;
    const result = await saveChannels(selected, { discord }).catch((err: unknown): { error?: string } => ({ error: String(err) }));
    setBusy(false);
    if ("error" in result && result.error) {
      setError(result.error);
      return;
    }
    setForm((f) => ({ ...f, hasDiscordToken: (result as ChannelsRecord).hasDiscordToken, botToken: "" }));
  };

  const testDiscord = async () => {
    if (!selected) return;
    setTesting(true);
    const r = await verifyDiscord(selected);
    setTesting(false);
    setTestResult({ ok: Boolean(r.ok), detail: r.detail ?? r.error ?? "unknown" });
  };

  const updateList = (key: "textChannels" | "voiceChannels", index: number, value: string) => {
    setForm((f) => ({ ...f, [key]: f[key].map((v, i) => (i === index ? value : v)) }));
  };
  const addToList = (key: "textChannels" | "voiceChannels") => setForm((f) => ({ ...f, [key]: [...f[key], ""] }));
  const removeFromList = (key: "textChannels" | "voiceChannels", index: number) =>
    setForm((f) => ({ ...f, [key]: f[key].filter((_, i) => i !== index) }));

  const onScrimClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click-outside dismiss, same pattern as WorkspaceManagerModal/AccountPanel
    <div className="scrim" data-open="true" role="dialog" aria-modal="true" aria-label="Manage channels" onClick={onScrimClick}>
      <section className="workspace-manager">
        <header className="workspace-manager__head">
          <h2>channels</h2>
          <button type="button" className="sessions-panel__close" onClick={onClose} aria-label="Close channels manager">
            <X size={13} strokeWidth={2} />
          </button>
        </header>
        {loadError && <p className="wizard__error">{loadError}</p>}
        <div className="workspace-manager__body">
          <div className="workspace-manager__list">
            {workspaces.map((ws) => (
              <div key={ws.name} className={`workspace-row${selected === ws.name ? " workspace-row--active" : ""}`}>
                <button type="button" className="workspace-row__pick" onClick={() => selectWorkspace(ws.name)}>
                  <span className="workspace-row__name">{ws.name}</span>
                </button>
              </div>
            ))}
            {workspaces.length === 0 && <p className="wizard__hint">No workspaces yet — create one first.</p>}
          </div>

          <div className="account-panel__form">
            {!selected && <p className="wizard__hint">Pick a workspace to configure its Discord channels.</p>}
            {selected && (
              <>
                <span className="wizard__hint">Discord {form.hasDiscordToken ? "— token saved" : "— not connected"}</span>
                <input
                  type="password"
                  value={form.botToken}
                  onChange={(e) => setForm((f) => ({ ...f, botToken: e.target.value }))}
                  placeholder="Discord bot token"
                />

                <span className="wizard__hint">Text channels</span>
                {form.textChannels.map((id, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until saved; only appended/removed at the ends
                  <div key={i} className="repo-row">
                    <input value={id} onChange={(e) => updateList("textChannels", i, e.target.value)} placeholder="Text channel id" />
                    <button type="button" className="repo-row__remove" onClick={() => removeFromList("textChannels", i)} aria-label="Remove text channel">
                      <X size={12} strokeWidth={2} />
                    </button>
                  </div>
                ))}
                <button type="button" className="settings-btn" onClick={() => addToList("textChannels")}>
                  <Plus size={11} strokeWidth={2.2} /> text channel
                </button>

                <span className="wizard__hint">Voice channels</span>
                {form.voiceChannels.map((id, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until saved; only appended/removed at the ends
                  <div key={i} className="repo-row">
                    <input value={id} onChange={(e) => updateList("voiceChannels", i, e.target.value)} placeholder="Voice channel id" />
                    <button type="button" className="repo-row__remove" onClick={() => removeFromList("voiceChannels", i)} aria-label="Remove voice channel">
                      <X size={12} strokeWidth={2} />
                    </button>
                  </div>
                ))}
                <button type="button" className="settings-btn" onClick={() => addToList("voiceChannels")}>
                  <Plus size={11} strokeWidth={2.2} /> voice channel
                </button>

                {form.hasDiscordToken && (
                  <button type="button" className="settings-btn" onClick={() => void testDiscord()} disabled={testing}>
                    {testing ? "testing…" : "Test connection"}
                  </button>
                )}
                {testResult && <p className={testResult.ok ? "wizard__hint" : "wizard__error"}>{testResult.detail}</p>}

                {error && <p className="wizard__error">{error}</p>}

                <button type="button" className="settings-btn settings-btn--primary settings-btn--wide" onClick={() => void submit()} disabled={busy}>
                  {busy ? "saving…" : "save"}
                </button>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm run test -- ChannelsManagerModal`
Expected: PASS

- [ ] **Step 6: Wire the entry point — `SessionsPanel` footer → `HomePage` state → mount**

```tsx
// control-plane/src/organisms/SessionsPanel.tsx — add onManageChannels alongside onManage, both in props and destructure
interface SessionsPanelProps {
  // ...existing props...
  onManage?: () => void;
  onManageChannels?: () => void;
}
```

```tsx
{/* inside <footer>, right after the existing onManage button block */}
{onManageChannels && (
  <button
    type="button"
    className="session-row session-row--manage"
    onClick={() => {
      onManageChannels();
      onClose();
    }}
  >
    manage channels…
  </button>
)}
```

```tsx
// control-plane/src/pages/HomePage.tsx
const [channelsOpen, setChannelsOpen] = useState(false);
// ...add getWorkspaceChannels, saveWorkspaceChannels, verifyWorkspaceDiscord, listWorkspaceRecords (already destructured) to the useBrokerChat() destructure...
// ...find the existing <SessionsPanel .../> render call and add onManageChannels={() => setChannelsOpen(true)}...
// ...in the overlays fragment, alongside WorkspaceManagerModal/AccountPanel:
<ChannelsManagerModal
  open={channelsOpen}
  onClose={() => setChannelsOpen(false)}
  listWorkspaces={listWorkspaceRecords}
  getChannels={getWorkspaceChannels}
  saveChannels={saveWorkspaceChannels}
  verifyDiscord={verifyWorkspaceDiscord}
/>
```

Read the real current `<SessionsPanel .../>` call and overlays fragment before editing — add alongside the existing props/mounts without disturbing them.

- [ ] **Step 7: Typecheck, lint, run full control-plane suite, commit**

Run: `pnpm run typecheck && pnpm run lint && pnpm run test` (from `control-plane/`) → all clean

```bash
git add control-plane/src/organisms/ChannelsManagerModal.tsx control-plane/src/organisms/ChannelsManagerModal.test.tsx control-plane/src/hooks/useBrokerChat.ts control-plane/src/organisms/SessionsPanel.tsx control-plane/src/pages/HomePage.tsx
git commit -m "feat(control-plane): ChannelsManagerModal — its own entry point, separate from workspace connectors"
```

---

## Phase 2 — Connection Lifecycle (broker-side)

**Read this before starting any task in this phase.** Research for this plan found a real asymmetry the design spec's "small, contained adjustment" language didn't anticipate: Discord's **text** adapter already has a working, unused `stop()` (`createDiscordAdapter()` returns `{ adapter, stop() }`; `main.ts` today discards `stop`) — Task 7 is mostly *capturing* something that already exists. Discord's **voice** setup (`setupDiscordVoice`) has **no teardown at all** today — calling it twice would leak a second `earClient`, a second `voiceStateUpdate` listener, and orphan the first connection's state. Task 8 is building real teardown from scratch against a 200-line function with live audio/presence state — it is the highest-risk task in this entire plan. They're split into separate tasks deliberately, sized for that difference, not because the design calls for it.

### Task 7: Discord text adapter — callable boot/teardown

**Files:**
- Modify: `broker/src/main.ts`
- Modify: `broker/src/channels.ts` (only if Step 1's `AdapterHub` check finds no removal method — see below)
- Test: `broker/src/main.test.ts` (create if it doesn't exist — check first; if `main.ts`'s top-level script structure genuinely resists unit testing, extracting `bootDiscordText`/`teardownDiscordText` into a separately-importable, testable module is an acceptable and expected deviation — note it in your report rather than skipping tests)

**Interfaces:**
- Consumes: `createDiscordAdapter` (existing, `discord-adapter.ts`) — its returned `{ adapter, stop() }` shape is unchanged by this task.
- Produces: `async function bootDiscordText(token: string, textChannels: string[]): Promise<{ stop: () => Promise<void> } | null>` (returns `null` when `textChannels` is empty, matching today's "allowlist empty → don't start, log why" guard), `async function teardownDiscordText(): Promise<void>`, module-level `let activeDiscordText: { stop: () => Promise<void> } | null = null`.

- [ ] **Step 1: Check `AdapterHub`'s removal API before writing anything**

`broker/src/channels.ts`'s `AdapterHub` class has a confirmed `register(adapter: ChannelAdapter): void` (used at the current text-adapter boot site). Whether it has a matching `unregister`/`deregister` method is **not confirmed** — check it directly (`Read` the class). If a removal method exists, use it in `teardownDiscordText()`. If it doesn't, add a minimal one (`unregister(kind: string): void` — removes the adapter of that `kind` from whatever internal collection `AdapterHub` uses, mirroring however `register` stores it) with its own focused test in `broker/src/channels.test.ts`, matching that file's existing style. Do not skip this — an adapter that's been `stop()`-ed but never unregistered would leave `AdapterHub` still trying to `deliver()` speech through a dead connection.

- [ ] **Step 2: Write the failing test(s)** — exact shape depends on Step 1's finding (whether `main.ts` logic needs extracting into a testable module); at minimum, cover:

```ts
// Illustrative — adapt to wherever bootDiscordText/teardownDiscordText actually end up
test('bootDiscordText: empty textChannels returns null without starting a client', async () => {
  const result = await bootDiscordText('tok', []);
  assert.equal(result, null);
});

test('bootDiscordText then teardownDiscordText: stop() is called exactly once, activeDiscordText resets to null', async () => {
  // inject a fake createDiscordAdapter (this file's existing DI seam — see discord-adapter.ts's
  // clientFactory option, or add an equivalent seam to bootDiscordText if none exists yet)
  // ...
});
```

- [ ] **Step 3: Extract the boot logic, add teardown**

Replace the current inline block (search `main.ts` for `const discordToken = process.env.DISCORD_TOKEN;` — the surrounding `if (discordToken) {...}` block) with:

```ts
// broker/src/main.ts — module-level, replacing the bare `discordConfigured` const's text-related role
let activeDiscordText: { stop: () => Promise<void> } | null = null;

/** Boots the text adapter for one workspace's bot+channels. Null if textChannels is empty (nothing to attend). */
async function bootDiscordText(token: string, textChannels: string[]): Promise<{ stop: () => Promise<void> } | null> {
  if (textChannels.length === 0) {
    console.error('[discord] bot token present but no text channels configured — adapter not started.');
    return null;
  }
  const { adapter, stop } = await createDiscordAdapter({
    token,
    allowlist: textChannels,
    onUtterance: (u) => adapterHub.onUtterance('discord', u),
  });
  adapterHub.register(adapter);
  console.log(`[discord] crew attending ${textChannels.length} channel(s)`);
  return {
    stop: async () => {
      adapterHub.unregister('discord'); // or whatever Step 1 found/added
      await stop();
    },
  };
}

async function teardownDiscordText(): Promise<void> {
  if (!activeDiscordText) return;
  await activeDiscordText.stop().catch((err) => console.error(`[discord] teardown failed: ${String(err)}`));
  activeDiscordText = null;
}
```

Do not wire this into session activation yet — that's Task 9. This task's job is just making boot/teardown exist as safe, callable, tested functions; the *old* inline boot block can stay as dead-ish code temporarily calling `bootDiscordText` once at the bottom (assign its result to `activeDiscordText`) so the app's current boot-time behavior is preserved until Task 9 replaces this call site with the real workspace-driven one.

- [ ] **Step 4: Run tests, typecheck, commit**

```bash
npm test
npm run typecheck
git add broker/src/main.ts broker/src/channels.ts broker/src/channels.test.ts broker/src/main.test.ts
git commit -m "feat(broker): callable bootDiscordText/teardownDiscordText, replacing inline one-shot boot"
```

---

### Task 8: Discord voice — callable boot/teardown (highest-risk task in this plan)

**Files:**
- Modify: `broker/src/main.ts`

**Interfaces:**
- Produces: `setupDiscordVoice`'s return type changes from `Promise<void>` to `Promise<(() => Promise<void>) | null>` — the returned function, when present, is a **closure** over that specific invocation's `earClient`, `surface`, and `presence` (not new module-level mutable state beyond what already exists for `voiceSurface`/`voicePresence`). A new module-level `let voiceTeardown: (() => Promise<void>) | null = null;` holds it between calls.

**Read `setupDiscordVoice`'s full current body in `broker/src/main.ts` before touching it** — it's ~200 lines with a documented, deliberately subtle design (the `earAwareGateway`/per-connection `alive` closure — read its own doc comment in full, it explains a real race that was already fixed once). This task adds a teardown path; it does not touch that existing logic.

- [ ] **Step 1: Identify exactly what teardown must undo**

From reading the function: (a) `earClient` (local `const`, line ~1003) — a live discord.js `Client`, logged in; needs `.destroy()`. (b) one `earClient.on('voiceStateUpdate', ...)` listener (registered near the function's end) — discord.js's own `client.destroy()` is expected to tear down the client's own listeners as part of disconnecting, but this is worth confirming empirically (log before/after, or check discord.js's own destroy() behavior) rather than assuming — note what you found in your report. (c) if a voice channel is currently joined (the ear + any agent mouths connected), it needs the same clean-leave sequence `onPresenceEvent`'s existing `'leave-crew'` branch already uses: `await surface.leaveAll(); policy.revokeAll('discord-voice'); broker.detachVoiceSurface();` — call this defensively (wrapped so a "nothing was joined" no-op doesn't throw) rather than trying to precisely detect join state first. (d) the module-level `voiceSurface`/`voicePresence` need to reset to `null` after all of the above, so `presence()`/`info()` (which already read them) correctly reflect "voice not ready" the instant teardown completes.

- [ ] **Step 2: Write the failing test(s)** — this needs the same testability check as Task 7 (does `main.ts`'s structure allow testing this directly, or does the logic need extracting?). At minimum, cover: calling the returned teardown function results in `earClient.destroy()` being called (inject a fake `DiscordClient`/`Client` the same way `discord-adapter.ts` already supports a `clientFactory` seam — add an equivalent seam to `setupDiscordVoice` if one doesn't exist), and that `voiceSurface`/`voicePresence` are `null` after teardown.

- [ ] **Step 3: Add the teardown closure, return it**

At the end of `setupDiscordVoice`, right after `voiceSurface = surface;` and `voicePresence = presence;` are assigned (and after the `earClient.on('voiceStateUpdate', ...)` listener is registered), build and return a teardown closure:

```ts
// broker/src/main.ts — inside setupDiscordVoice, replacing its `return;` (implicit, since it's Promise<void> today) with a real return value
const teardown = async (): Promise<void> => {
  try {
    await surface.leaveAll();
    policy.revokeAll('discord-voice');
    broker.detachVoiceSurface();
  } catch (err) {
    // Nothing was joined, or leaveAll itself failed — either way, still tear
    // down the client below rather than leaving a half-torn-down connection.
    console.error(`[discord-voice] leaveAll during teardown: ${String(err)}`);
  }
  await earClient.destroy();
  voiceSurface = null;
  voicePresence = null;
};
return teardown;
```

Change the function's declared return type from `Promise<void>` to `Promise<(() => Promise<void>) | null>` (returning `null` from its two existing early-return guards — the `ffmpeg` check and the missing-`DISCORD_TOKEN` check — instead of a bare `return;`).

Add a module-level:

```ts
let voiceTeardown: (() => Promise<void>) | null = null;
```

Do not wire the call sites yet (the boot-time `if (voiceChannelAllowlist.length > 0) { await setupDiscordVoice(...) }` block, and capturing its result into `voiceTeardown`) — that's Task 9, alongside the text adapter's equivalent wiring, so both surfaces get switched together in one place.

- [ ] **Step 4: Manual verification — this is the step that matters most for this task**

No amount of unit testing fully substitutes for exercising this against a real Discord bot, because the risk is entirely in discord.js's own connection/listener lifecycle, not in this plan's own logic. Using a real (test) Discord bot token and a voice channel:

1. Boot broker with `DISCORD_VOICE_CHANNELS` set (today's boot path, unchanged by this task) — confirm voice works as it does today (join a channel, agents connect).
2. Manually call the teardown closure (temporarily, e.g. from a debug script or a REPL-style call) while a human is actively joined to the voice channel.
3. Confirm: the ear disconnects cleanly (no orphaned connection visible in Discord's own UI), no unhandled promise rejection or crash in broker's logs, `voiceSurface`/`voicePresence` are `null` afterward.
4. Call `setupDiscordVoice` again (simulating a workspace switch back) and confirm it boots a fresh, working connection — not a broken one poisoned by leftover state from the first.

Report exactly what you observed at each of these four points — this is a case where "the tests passed" is not sufficient evidence on its own.

- [ ] **Step 5: Run tests, typecheck, commit**

```bash
npm test
npm run typecheck
git add broker/src/main.ts
git commit -m "feat(broker): setupDiscordVoice returns a real teardown closure, callable again safely"
```

---

### Task 9: Session-activation lifecycle hook

**Files:**
- Modify: `broker/src/main.ts`

**Interfaces:**
- Consumes: `bootDiscordText`/`teardownDiscordText` (Task 7), `setupDiscordVoice`'s new return value + `voiceTeardown` (Task 8), `swarm.getWorkspaceDiscordConfig(name)` (Task 4).
- Produces: `async function switchDiscordForWorkspace(workspaceName: string): Promise<void>` — tears down whatever's currently connected (both surfaces), then boots whatever the new workspace has configured (if anything). Wired into the existing `sessions.activate` wrapper and into boot-time initialization, replacing the two unconditional env-based boot blocks Task 7/8 left as a temporary bridge.

**Read the current `sessions.activate` wrapper and the boot sequence in `main.ts` fresh before editing** — confirm the exact current line numbers (they've shifted since this plan's research pass, because Tasks 7-8 already touched this file once each).

- [ ] **Step 1: Write the failing test(s)** (same testability caveat as Tasks 7-8 — extract if needed)

```ts
// Illustrative
test('switchDiscordForWorkspace: tears down the previous connection before booting the new one', async () => {
  // fake swarm.getWorkspaceDiscordConfig returning different configs per workspace name;
  // spy on teardownDiscordText/voiceTeardown call order relative to the new boot calls
});

test('switchDiscordForWorkspace: a workspace with no Discord config tears down without booting anything new', async () => {
  // swarm.getWorkspaceDiscordConfig resolves null -> both boots skipped, both teardowns still run
});
```

- [ ] **Step 2: Implement `switchDiscordForWorkspace`**

```ts
// broker/src/main.ts
async function switchDiscordForWorkspace(workspaceName: string): Promise<void> {
  // Tear down whatever's currently connected first — never more than one live
  // connection per surface, regardless of what the new workspace has.
  await teardownDiscordText();
  if (voiceTeardown) {
    await voiceTeardown();
    voiceTeardown = null;
  }

  const config = await swarm.getWorkspaceDiscordConfig(workspaceName);
  if (!config) return; // no bot configured for this workspace — Discord simply isn't reachable this session

  activeDiscordText = await bootDiscordText(config.botToken, config.textChannels);

  if (config.voiceChannels.length > 0) {
    voiceTeardown = await setupDiscordVoice(config.voiceChannels).catch((err) => {
      console.error(`[discord-voice] failed to start for workspace "${workspaceName}": ${String(err)}`);
      return null;
    });
  }
}
```

Note: `setupDiscordVoice`'s existing internal logic (per Task 8, unmodified) reads `process.env.DISCORD_TOKEN` directly for its own `earToken` (line ~954) rather than taking a token parameter — **this needs to change as part of this task**, since the bot token is now workspace-sourced (`config.botToken`), not env-sourced. Update `setupDiscordVoice`'s signature to `async function setupDiscordVoice(allowlist: string[], botToken: string): Promise<...>` and replace its internal `const earToken = process.env.DISCORD_TOKEN;` read with the parameter. This is a small, mechanical change to a function Task 8 already modified once — re-read its current state before making it, don't assume Task 8 left `earToken`'s source untouched.

- [ ] **Step 3: Wire into session activation**

Find the `sessions.activate: (id) => {...}` wrapper (the object passed as the 6th positional constructor arg to `new TextChannel(...)`) and add the switch call, fire-and-forget (do not change `activate`'s synchronous `string | null` return contract — that would ripple into `text-channel.ts`'s type and its route handler, which this task doesn't touch):

```ts
activate: (id) => {
  const s = sessionManager.activate(id);
  if (!s) return `unknown session: ${id}`;
  brain.loadHistory(s.brainHistory);
  void switchDiscordForWorkspace(s.workspace).catch((err) =>
    console.error(`[discord] workspace switch failed for "${s.workspace}": ${String(err)}`),
  );
  textChannel.broadcast(sessionFrame());
  return null;
},
```

Also update the `create` branch of the same wrapper object — creating a new session also changes the active workspace (a new session can target a different workspace than the one just active) — it needs the identical `void switchDiscordForWorkspace(...)` call.

- [ ] **Step 4: Wire into boot-time initialization**

Replace the two temporary bridge calls Task 7/8 left in place (the inline "boot once at the bottom" code) with one call right after `sessionManager.init(...)`:

```ts
// broker/src/main.ts — right after: const activeSession = sessionManager.init(...); brain.loadHistory(activeSession.brainHistory);
void switchDiscordForWorkspace(activeSession.workspace).catch((err) =>
  console.error(`[discord] initial workspace connect failed: ${String(err)}`),
);
```

Remove the old unconditional `if (voiceChannelAllowlist.length > 0) { await setupDiscordVoice(voiceChannelAllowlist) }` top-level call and its `voiceChannelAllowlist`/env-based construction entirely — Discord boot is now always workspace-driven, with no direct env-var path left at all (`DISCORD_TOKEN`/`DISCORD_CHANNELS`/`DISCORD_VOICE_CHANNELS` in `.env.example` become dead documentation after this task — leave a note in your report; removing them from `.env.example` itself is a reasonable small cleanup to include here, not a separate task).

- [ ] **Step 5: Run tests, typecheck, manual verification, commit**

```bash
npm test
npm run typecheck
```

Manual verification: configure two workspaces with different Discord bot tokens/channels (via the Task 6 UI), switch between their sessions, and confirm (via broker's logs) that each switch tears down the previous connection and boots the new one — including switching to a workspace with no Discord config at all (confirm clean teardown, no new connection, no crash).

```bash
git add broker/src/main.ts .env.example
git commit -m "feat(broker): session activation drives Discord connection lifecycle per workspace"
```

---

### Task 10: Workspace-aware `discordConfigured`/`presence()`/`join()`

**Files:**
- Modify: `broker/src/main.ts`

**Interfaces:**
- Consumes: `activeDiscordText`, `voiceSurface` (both now correctly reflect live, workspace-scoped connection state after Tasks 7-9).
- Produces: the `surfaces` object literal's `presence()`, `info()`, and `join()` methods (currently all three read the single global `const discordConfigured = Boolean(process.env.DISCORD_TOKEN)`) read `activeDiscordText !== null` instead.

**This is a small, mechanical task** — everything it depends on already exists correctly after Task 9; this is purely swapping what boolean expression three existing call sites read.

- [ ] **Step 1: Write the failing test(s)** — same testability caveat as prior Phase 2 tasks.

```ts
// Illustrative
test('surfaces.info().configured reflects activeDiscordText, not an env var', () => {
  // activeDiscordText null -> configured: false; activeDiscordText set -> configured: true
});
```

- [ ] **Step 2: Remove the global `discordConfigured` const, update the three read sites**

```ts
// broker/src/main.ts — delete this line entirely:
// const discordConfigured = Boolean(process.env.DISCORD_TOKEN);
```

In the `surfaces` object literal (find it fresh — search for `info: () =>`):

```ts
presence: () => {
  const out: Record<string, Record<string, boolean>> = {};
  const voiceIds = new Set(voiceSurface?.connectedAgentIds() ?? []);
  for (const a of directory.list()) {
    out[a.id] = {
      tauri: policy.attends(a.id, 'tauri'),
      discord: activeDiscordText !== null && policy.attends(a.id, 'discord'),
      'discord-voice': voiceIds.has(a.id),
    };
  }
  return out;
},
info: () => ({ configured: activeDiscordText !== null, voiceReady: voiceSurface !== null }),
join: async (agentId, surface) => {
  // ...unchanged voice-branch...
  if (surface !== 'discord' && surface !== 'tauri') return { error: `unknown surface: ${surface}`, status: 404 };
  const decision = decideJoin(agentId, surface, policy.modeFor(agentId, surface));
  if (decision.type === 'reject') return { error: decision.error, status: decision.status };
  if (surface === 'discord' && activeDiscordText === null) return { error: 'Discord is not configured', status: 409 };
  if (decision.type === 'admit') policy.admit(agentId, surface);
  return { ok: true } as const;
},
```

- [ ] **Step 3: Run tests, typecheck, commit**

```bash
npm test
npm run typecheck
git add broker/src/main.ts
git commit -m "feat(broker): surfaces.presence/info/join read workspace-driven Discord state, not a global env check"
```

---

## Final Verification

- [ ] **Full swarm suite:** `cd swarm && npm test` → all green, including every test added in Tasks 1–3.
- [ ] **Full broker suite:** `cd broker && npm test` → all green, including every test added in Tasks 4–10.
- [ ] **Full control-plane suite + typecheck + lint:** `cd control-plane && pnpm run test && pnpm run typecheck && pnpm run lint` → all green, including `ChannelsManagerModal.test.tsx` from Task 6.
- [ ] **Manual e2e** (restated as a checklist):
  - [ ] Open "manage channels…" (next to "manage workspaces…" in the sessions panel), confirm it opens a distinct screen from the workspace connector form.
  - [ ] Pick a workspace, save a Discord bot token + a text channel ID; "Test connection" succeeds against a real bot token.
  - [ ] Switch to a session in a *different* workspace with its own Discord config; confirm (via broker logs) the first workspace's connection tears down and the second's boots.
  - [ ] Switch to a session in a workspace with *no* Discord config; confirm the previous connection tears down and nothing new boots — the crew is simply unreachable on Discord for that session, same as today's "DISCORD_TOKEN unset" behavior.
  - [ ] With voice channels configured for a workspace, join the voice channel as a human, then switch sessions away from that workspace mid-call — confirm the ear disconnects cleanly (Task 8's Step 4 manual verification, repeated here as the end-to-end version).
  - [ ] Switch back to the original workspace; confirm Discord (text and voice) reconnects correctly, not in a broken state from the teardown/reboot cycle.
  - [ ] `SurfacePolicyPopover` correctly grays out Discord rows for a workspace with no Discord configured, and shows them live for one that does.

## Self-Review Notes

- **Spec coverage:** §1 (data model) → Task 1. §2 (connection lifecycle) → Tasks 7–10. §3 (UI) → Task 6. §4 (API) → Tasks 3–5, including the internal raw-token route the spec didn't anticipate (documented inline in Task 3 with the reasoning, since it's a real deviation from what §4 described — broker needing the raw token at all is a consequence of *where* the Discord connection lives, not a choice this plan made). Settled decisions (own UI area, workspace ownership, tracked/untracked split, connects-only-when-active, both text+voice) are all reflected in Tasks 1, 6, and 7–10's design.
- **Placeholder scan:** no "TBD"/"add appropriate handling"-style steps. Task 8's manual-verification step is deliberately more open-ended than this plan's other steps ("report exactly what you observed") because the actual risk there is empirical (discord.js's own connection lifecycle), not something a fixed assertion list can fully cover — that's a stated, reasoned exception, not an unspecified gap.
- **Type consistency:** `WorkspaceChannels`/`ChannelsRecord`/`DiscordChannelsConfig` (Tasks 1, 4) are used with identical shapes across Tasks 3–10 — cross-checked `bootDiscordText`'s parameters (Task 7) against `switchDiscordForWorkspace`'s call to it (Task 9) and against `DiscordChannelsConfig`'s fields (Task 4); cross-checked `setupDiscordVoice`'s new signature (`allowlist, botToken`, changed mid-Task-9) against its Task 8 return-type change and its Task 9 call site.
- **Known open testability question, called out three times rather than assumed away:** Tasks 7, 8, and 9 all flag the same unresolved point — whether `main.ts`'s top-level-script structure permits direct unit testing of the new lifecycle functions, or whether they need extracting into a separately-importable module first. This wasn't resolved during planning because it depends on exactly how `main.ts` reads at implementation time (it's been modified by every task in this plan by the time Task 9 starts) — each task's implementer makes that call for their own piece and reports which way they went, rather than the plan guessing wrong and forcing a rewrite.
