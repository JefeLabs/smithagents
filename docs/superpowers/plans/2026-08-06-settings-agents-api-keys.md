# Settings: Agents Section + API Keys Registry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Machine-level provider API key registry (store + live verify + settings UI), grouped settings nav (App / Agents / Workspace), and agy-first avatar generation with the google key as accelerator.

**Architecture:** Mirror of the CLI tool registry: a data-driven provider list + untracked 0600 store in `swarm/src/api-keys.ts`, thin swarm routes, broker text-channel passthrough, card-grid settings group. Avatar engine selection is a new broker seam (`avatar-engine.ts`) feeding the existing `AvatarGenerator`/`ImagesClient` interface: verified google key → Gemini API; agy active → `AgyImagesClient` subprocess wrapper; neither → guidance error.

**Tech Stack:** TypeScript ESM. Swarm: Fastify, `node --test` + tsx. Broker: plain `node:http` TextChannel, `node --test` + tsx, `@google/genai`, sharp (both already installed). Control-plane: React 19, vitest + testing-library.

**Spec:** `docs/superpowers/specs/2026-08-06-settings-agents-api-keys-design.md` — read it first; its Acceptance criteria section is the definition of done.

## Global Constraints

- **No new npm dependencies** in any package.
- Test commands: `npm test` inside `swarm/`, `broker/`, `control-plane/` respectively. To run one file: `node --import tsx --test src/api-keys.test.ts` (swarm/broker), `npx vitest run src/organisms/settings/ApiKeysGroup.test.tsx` (control-plane).
- **No biome/lint in swarm or broker** (control-plane has `npm run lint`).
- Store file `.smith/api-keys.json`: dir mode 0700, file mode 0600 — exact `saveCliToolsFile` idiom.
- **Raw keys never** appear in listings, logs, error messages, or any 7790 response. Keys go in headers, never URLs (google uses `x-goog-api-key`, not `?key=` — deliberate spec deviation for log hygiene, noted here as authoritative).
- Verify semantics: HTTP 401/403 → `verified: false`; any other failure (network, timeout, 429, 5xx) → `'unknown'`. Block/alarm only confirmed negatives.
- The credential route exists ONLY on the swarm (127.0.0.1:7777) and is deliberately ABSENT from the broker text-channel passthrough. Do not add it there.
- All git commits from the worktree root with `git -C` discipline; message style `feat(swarm): …` / `feat(broker): …` / `feat(control-plane): …`, ending with the Claude co-author trailer.

---

### Task 1: swarm — api-keys store, redaction, listings

**Files:**
- Create: `swarm/src/api-keys.ts`
- Test: `swarm/src/api-keys.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module; `PROVIDERS` arrives in Task 2 — this task stubs the registry as an empty array export that Task 2 fills).
- Produces (later tasks rely on these exact names):
  - `interface ApiKeyEntry { key: string; verified: boolean | 'unknown'; detail: string; lastCheckedAt: string }`
  - `interface ApiKeysFile { version: 1; providers: Record<string, ApiKeyEntry> }`
  - `interface ApiKeyListing { id: string; label: string; description: string; hasKey: boolean; last4: string | null; verified: boolean | 'unknown' | null; detail: string | null; lastCheckedAt: string | null }`
  - `interface ApiProviderDef { id: string; label: string; description: string; verify(key: string, fetchImpl?: typeof fetch): Promise<{ ok: boolean | 'unknown'; detail: string }> }`
  - `emptyApiKeysFile(): ApiKeysFile`, `loadApiKeysFile(path)`, `saveApiKeysFile(path, file)`, `last4(key): string`, `buildApiKeyListings(file): ApiKeyListing[]`, `PROVIDERS: ApiProviderDef[]`, `findProvider(id)`

- [ ] **Step 1: Write the failing test**

```ts
// swarm/src/api-keys.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildApiKeyListings,
  emptyApiKeysFile,
  last4,
  loadApiKeysFile,
  saveApiKeysFile,
  type ApiKeysFile,
} from './api-keys.js';

const entry = (over: Partial<ApiKeysFile['providers'][string]> = {}) => ({
  key: 'sk-test-abcd1234',
  verified: true as const,
  detail: 'key accepted',
  lastCheckedAt: '2026-08-06T00:00:00.000Z',
  ...over,
});

test('load: missing file -> empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apikeys-'));
  assert.deepEqual(await loadApiKeysFile(join(dir, 'nope.json')), emptyApiKeysFile());
});

test('load: corrupt file -> empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apikeys-'));
  const p = join(dir, 'api-keys.json');
  await writeFile(p, '{not json');
  assert.deepEqual(await loadApiKeysFile(p), emptyApiKeysFile());
});

test('save: round-trips and is 0600', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apikeys-'));
  const p = join(dir, 'sub', 'api-keys.json');
  const file: ApiKeysFile = { version: 1, providers: { google: entry() } };
  await saveApiKeysFile(p, file);
  assert.deepEqual(await loadApiKeysFile(p), file);
  assert.equal(((await stat(p)).mode & 0o777), 0o600);
});

test('last4', () => {
  assert.equal(last4('sk-test-abcd1234'), '1234');
});

test('listings: every provider present, raw key never serialized', () => {
  const listings = buildApiKeyListings({ version: 1, providers: { google: entry() } });
  assert.ok(listings.length >= 3); // anthropic, openai, google
  const google = listings.find((l) => l.id === 'google');
  assert.deepEqual(google, {
    id: 'google',
    label: 'Google',
    description: google?.description,
    hasKey: true,
    last4: '1234',
    verified: true,
    detail: 'key accepted',
    lastCheckedAt: '2026-08-06T00:00:00.000Z',
  });
  const keyless = listings.find((l) => l.id === 'anthropic');
  assert.deepEqual(keyless && { hasKey: keyless.hasKey, last4: keyless.last4, verified: keyless.verified }, {
    hasKey: false,
    last4: null,
    verified: null,
  });
  assert.ok(!JSON.stringify(listings).includes('sk-test-abcd1234'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd swarm && node --import tsx --test src/api-keys.test.ts`
Expected: FAIL — `Cannot find module './api-keys.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// swarm/src/api-keys.ts
// API key registry — machine-level provider keys for agent work that
// subscriptions can't cover (spec:
// docs/superpowers/specs/2026-08-06-settings-agents-api-keys-design.md).
// Sibling of cli-tools.ts: same untracked-0600-file idiom, same
// block-only-confirmed-negatives verify semantics. Raw keys never appear
// in listings; only the swarm-local credential route serves one.
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ApiKeyEntry {
  key: string;                    // raw key — file is 0600, never serialized to clients
  verified: boolean | 'unknown';  // last probe result
  detail: string;                 // human-readable probe outcome
  lastCheckedAt: string;          // ISO timestamp of last probe
}

export interface ApiKeysFile {
  version: 1;
  providers: Record<string, ApiKeyEntry>;
}

/** Registry entry joined with redacted machine state — drives the whole UI. */
export interface ApiKeyListing {
  id: string;
  label: string;
  description: string;
  hasKey: boolean;
  last4: string | null;
  verified: boolean | 'unknown' | null;
  detail: string | null;
  lastCheckedAt: string | null;
}

export interface ApiProviderDef {
  id: string;
  label: string;
  description: string;
  verify(key: string, fetchImpl?: typeof fetch): Promise<{ ok: boolean | 'unknown'; detail: string }>;
}

/** Filled in Task 2 — keep the export so listings can iterate it now. */
export const PROVIDERS: ApiProviderDef[] = [];

export const findProvider = (id: string): ApiProviderDef | undefined => PROVIDERS.find((p) => p.id === id);

export function emptyApiKeysFile(): ApiKeysFile {
  return { version: 1, providers: {} };
}

/** Corrupt or missing file -> empty (mirror of loadCliToolsFile). */
export async function loadApiKeysFile(path: string): Promise<ApiKeysFile> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as ApiKeysFile;
    if (parsed?.version === 1 && parsed.providers && typeof parsed.providers === 'object') return parsed;
    return emptyApiKeysFile();
  } catch {
    return emptyApiKeysFile();
  }
}

/** Owner-only permissions, mirror of saveCliToolsFile. */
export async function saveApiKeysFile(path: string, file: ApiKeysFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const fh = await open(path, 'w', 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(file, null, 2)}\n`);
  } finally {
    await fh.close();
  }
}

export const last4 = (key: string): string => key.slice(-4);

export function buildApiKeyListings(file: ApiKeysFile): ApiKeyListing[] {
  return PROVIDERS.map((p) => {
    const e = file.providers[p.id];
    return {
      id: p.id,
      label: p.label,
      description: p.description,
      hasKey: Boolean(e),
      last4: e ? last4(e.key) : null,
      verified: e ? e.verified : null,
      detail: e?.detail ?? null,
      lastCheckedAt: e?.lastCheckedAt ?? null,
    };
  });
}
```

Note: the `assert.ok(listings.length >= 3)` test stays red until Task 2 fills `PROVIDERS`. To keep Task 1 green on its own, Task 2's registry is added in the SAME commit series — run only the store tests here if needed. Simplest: implement Task 1 and Task 2 back-to-back, committing per task; the listings test moves to green at the end of Task 2. Mark the listings test `{ todo: true }`? No — instead order the suite: keep the listings test in the file now, expect it to fail at Step 4, and let Task 2 Step 4 be the moment the whole file passes. State this explicitly when committing Task 1 ("listings test red pending provider registry — Task 2").

- [ ] **Step 4: Run tests — store tests pass, listings test red (expected)**

Run: `cd swarm && node --import tsx --test src/api-keys.test.ts`
Expected: load/save/last4 PASS; the two listings assertions FAIL on `listings.length >= 3` (registry still empty).

- [ ] **Step 5: Commit**

```bash
git add swarm/src/api-keys.ts swarm/src/api-keys.test.ts
git commit -m "feat(swarm): api-key registry store + redacted listings

listings test red pending provider registry (next commit)"
```

---

### Task 2: swarm — provider registry + verify probes

**Files:**
- Modify: `swarm/src/api-keys.ts` (replace the empty `PROVIDERS`)
- Test: `swarm/src/api-keys.test.ts` (append)

**Interfaces:**
- Produces: `PROVIDERS` filled with `anthropic`, `openai`, `google` defs; internal `probe()` helper. Later tasks depend only on `findProvider(id)?.verify(key, fetchImpl)`.

- [ ] **Step 1: Append failing probe tests**

```ts
// append to swarm/src/api-keys.test.ts
import { findProvider } from './api-keys.js'; // merge into the existing import list

type FetchStub = typeof fetch;
const okFetch = (): FetchStub => (async () => new Response('{}', { status: 200 })) as unknown as FetchStub;
const statusFetch = (status: number): FetchStub => (async () => new Response('{}', { status })) as unknown as FetchStub;
const downFetch = (): FetchStub => (async () => { throw new Error('ECONNREFUSED'); }) as unknown as FetchStub;

test('probe mapping: 2xx true, 401/403 false, 5xx/network unknown', async () => {
  const p = findProvider('anthropic')!;
  assert.equal((await p.verify('k', okFetch())).ok, true);
  assert.equal((await p.verify('k', statusFetch(401))).ok, false);
  assert.equal((await p.verify('k', statusFetch(403))).ok, false);
  assert.equal((await p.verify('k', statusFetch(500))).ok, 'unknown');
  assert.equal((await p.verify('k', statusFetch(429))).ok, 'unknown');
  assert.equal((await p.verify('k', downFetch())).ok, 'unknown');
});

test('probe request shapes: header auth, key never in URL', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const spy: FetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response('{}', { status: 200 });
  }) as unknown as FetchStub;

  await findProvider('anthropic')!.verify('KEY_A', spy);
  await findProvider('openai')!.verify('KEY_B', spy);
  await findProvider('google')!.verify('KEY_C', spy);

  assert.equal(calls[0]!.url, 'https://api.anthropic.com/v1/models');
  assert.equal(calls[0]!.headers['x-api-key'], 'KEY_A');
  assert.equal(calls[0]!.headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[1]!.url, 'https://api.openai.com/v1/models');
  assert.equal(calls[1]!.headers.authorization, 'Bearer KEY_B');
  assert.equal(calls[2]!.url, 'https://generativelanguage.googleapis.com/v1beta/models');
  assert.equal(calls[2]!.headers['x-goog-api-key'], 'KEY_C');
  for (const c of calls) assert.ok(!c.url.includes('KEY_'), 'key must never appear in a URL');
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd swarm && node --import tsx --test src/api-keys.test.ts`
Expected: FAIL — `findProvider('anthropic')` is undefined.

- [ ] **Step 3: Implement the registry**

Replace `export const PROVIDERS: ApiProviderDef[] = [];` with:

```ts
const PROBE_TIMEOUT_MS = 10_000;

/** One probe idiom for every provider: cheapest authenticated GET; auth in
 *  headers only (keys in URLs leak into logs). 401/403 are the only
 *  confirmed negatives. */
async function probe(
  url: string,
  headers: Record<string, string>,
  label: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean | 'unknown'; detail: string }> {
  try {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (res.ok) return { ok: true, detail: 'key accepted' };
    if (res.status === 401 || res.status === 403) return { ok: false, detail: `${label} rejected the key (${res.status})` };
    return { ok: 'unknown', detail: `${label} answered ${res.status} — could not confirm` };
  } catch (err) {
    return { ok: 'unknown', detail: `could not reach ${label}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export const PROVIDERS: ApiProviderDef[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Claude models over the Messages API — future api-kind thinkers.',
    verify: (key, fetchImpl = fetch) =>
      probe('https://api.anthropic.com/v1/models', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, 'Anthropic', fetchImpl),
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT models over the OpenAI API — future api-kind thinkers.',
    verify: (key, fetchImpl = fetch) =>
      probe('https://api.openai.com/v1/models', { authorization: `Bearer ${key}` }, 'OpenAI', fetchImpl),
  },
  {
    id: 'google',
    label: 'Google',
    description: 'Gemini API — accelerates avatar generation; future api-kind thinkers.',
    verify: (key, fetchImpl = fetch) =>
      probe('https://generativelanguage.googleapis.com/v1beta/models', { 'x-goog-api-key': key }, 'Google', fetchImpl),
  },
];
```

- [ ] **Step 4: Run the whole file — everything green now (incl. Task 1's listings test)**

Run: `cd swarm && node --import tsx --test src/api-keys.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add swarm/src/api-keys.ts swarm/src/api-keys.test.ts
git commit -m "feat(swarm): api-key provider registry + verify probes (anthropic, openai, google)"
```

---

### Task 3: swarm — save/verify/delete/credential operations

**Files:**
- Modify: `swarm/src/api-keys.ts` (append)
- Test: `swarm/src/api-keys.test.ts` (append)

**Interfaces:**
- Produces (Task 4's routes are thin wrappers over exactly these):
  - `type ApiKeyOpResult = { listings: ApiKeyListing[] } | { error: string; status: 400 | 404 | 409 }`
  - `saveAndVerifyKey(path, providerId, key, fetchImpl?, now?): Promise<ApiKeyOpResult>`
  - `verifyStoredKey(path, providerId, fetchImpl?, now?): Promise<ApiKeyOpResult>`
  - `deleteKey(path, providerId): Promise<ApiKeyOpResult>` (idempotent)
  - `getCredential(path, providerId): Promise<{ key: string } | { error: string; status: 404 }>`

- [ ] **Step 1: Append failing operation tests**

```ts
// append to swarm/src/api-keys.test.ts — merge new names into the import list:
// deleteKey, getCredential, saveAndVerifyKey, verifyStoredKey
const NOW = () => '2026-08-06T12:00:00.000Z';

test('saveAndVerifyKey: 404 unknown provider, 400 blank key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apikeys-'));
  const p = join(dir, 'api-keys.json');
  assert.deepEqual(await saveAndVerifyKey(p, 'nope', 'k', okFetch(), NOW), { error: 'unknown provider: nope', status: 404 });
  assert.deepEqual(await saveAndVerifyKey(p, 'google', '   ', okFetch(), NOW), { error: 'key must not be blank', status: 400 });
});

test('saveAndVerifyKey: persists trimmed key + probe outcome, returns listings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apikeys-'));
  const p = join(dir, 'api-keys.json');
  const r = await saveAndVerifyKey(p, 'google', '  sk-live-9876  ', statusFetch(401), NOW);
  assert.ok('listings' in r);
  const g = r.listings.find((l) => l.id === 'google')!;
  assert.deepEqual({ hasKey: g.hasKey, last4: g.last4, verified: g.verified }, { hasKey: true, last4: '9876', verified: false });
  const stored = (await loadApiKeysFile(p)).providers.google!;
  assert.equal(stored.key, 'sk-live-9876');
  assert.equal(stored.lastCheckedAt, NOW());
});

test('verifyStoredKey: 409 without key, re-probes with stored key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apikeys-'));
  const p = join(dir, 'api-keys.json');
  assert.deepEqual(await verifyStoredKey(p, 'google', okFetch(), NOW), { error: 'no key stored for google', status: 409 });
  await saveAndVerifyKey(p, 'google', 'sk-live-9876', downFetch(), NOW); // saved as 'unknown'
  const r = await verifyStoredKey(p, 'google', okFetch(), NOW);
  assert.ok('listings' in r && r.listings.find((l) => l.id === 'google')!.verified === true);
});

test('deleteKey: removes, idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apikeys-'));
  const p = join(dir, 'api-keys.json');
  await saveAndVerifyKey(p, 'google', 'sk-live-9876', okFetch(), NOW);
  const r1 = await deleteKey(p, 'google');
  assert.ok('listings' in r1 && r1.listings.find((l) => l.id === 'google')!.hasKey === false);
  const r2 = await deleteKey(p, 'google'); // absent -> still ok
  assert.ok('listings' in r2);
  assert.deepEqual(await deleteKey(p, 'nope'), { error: 'unknown provider: nope', status: 404 });
});

test('getCredential: raw key for broker hop; 404 when absent/unknown provider', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apikeys-'));
  const p = join(dir, 'api-keys.json');
  assert.deepEqual(await getCredential(p, 'google'), { error: 'no key stored for google', status: 404 });
  assert.deepEqual(await getCredential(p, 'nope'), { error: 'unknown provider: nope', status: 404 });
  await saveAndVerifyKey(p, 'google', 'sk-live-9876', okFetch(), NOW);
  assert.deepEqual(await getCredential(p, 'google'), { key: 'sk-live-9876' });
});
```

- [ ] **Step 2: Run to verify failure** — `cd swarm && node --import tsx --test src/api-keys.test.ts` — FAIL: names not exported.

- [ ] **Step 3: Implement the operations (append to api-keys.ts)**

```ts
export type ApiKeyOpResult = { listings: ApiKeyListing[] } | { error: string; status: 400 | 404 | 409 };

export async function saveAndVerifyKey(
  path: string,
  providerId: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
  now: () => string = () => new Date().toISOString(),
): Promise<ApiKeyOpResult> {
  const provider = findProvider(providerId);
  if (!provider) return { error: `unknown provider: ${providerId}`, status: 404 };
  const trimmed = key.trim();
  if (!trimmed) return { error: 'key must not be blank', status: 400 };
  const result = await provider.verify(trimmed, fetchImpl);
  const file = await loadApiKeysFile(path);
  file.providers[providerId] = { key: trimmed, verified: result.ok, detail: result.detail, lastCheckedAt: now() };
  await saveApiKeysFile(path, file);
  return { listings: buildApiKeyListings(file) };
}

export async function verifyStoredKey(
  path: string,
  providerId: string,
  fetchImpl: typeof fetch = fetch,
  now: () => string = () => new Date().toISOString(),
): Promise<ApiKeyOpResult> {
  const provider = findProvider(providerId);
  if (!provider) return { error: `unknown provider: ${providerId}`, status: 404 };
  const file = await loadApiKeysFile(path);
  const entry = file.providers[providerId];
  if (!entry) return { error: `no key stored for ${providerId}`, status: 409 };
  const result = await provider.verify(entry.key, fetchImpl);
  file.providers[providerId] = { ...entry, verified: result.ok, detail: result.detail, lastCheckedAt: now() };
  await saveApiKeysFile(path, file);
  return { listings: buildApiKeyListings(file) };
}

export async function deleteKey(path: string, providerId: string): Promise<ApiKeyOpResult> {
  if (!findProvider(providerId)) return { error: `unknown provider: ${providerId}`, status: 404 };
  const file = await loadApiKeysFile(path);
  delete file.providers[providerId];
  await saveApiKeysFile(path, file);
  return { listings: buildApiKeyListings(file) };
}

/** Raw-key hop for the broker's avatar generator ONLY — served by the
 *  swarm's localhost route, never through the broker's 7790 surface. */
export async function getCredential(
  path: string,
  providerId: string,
): Promise<{ key: string } | { error: string; status: 404 }> {
  if (!findProvider(providerId)) return { error: `unknown provider: ${providerId}`, status: 404 };
  const entry = (await loadApiKeysFile(path)).providers[providerId];
  if (!entry) return { error: `no key stored for ${providerId}`, status: 404 };
  return { key: entry.key };
}
```

- [ ] **Step 4: Run — all green.** `cd swarm && node --import tsx --test src/api-keys.test.ts`

- [ ] **Step 5: Commit**

```bash
git add swarm/src/api-keys.ts swarm/src/api-keys.test.ts
git commit -m "feat(swarm): api-key save/verify/delete/credential operations"
```

---

### Task 4: swarm — routes

**Files:**
- Modify: `swarm/src/server.ts` — add imports and five routes beside the `/cli-tools` block (search for `'.smith/cli-tools.json'` to find it).

**Interfaces:**
- Consumes: Task 3's operations verbatim.
- Produces HTTP surface (broker passthrough in Task 5 relies on these exact paths/shapes):
  - `GET /api-keys` → `{ providers: ApiKeyListing[] }`
  - `PUT /api-keys/:provider` body `{ key }` → `{ providers }` | error
  - `POST /api-keys/:provider/verify` → `{ providers }` | error
  - `DELETE /api-keys/:provider` → `{ providers }` | error
  - `GET /api-keys/:provider/credential` → `{ key }` | 404 — swarm-local only

Route logic is fully covered by Task 3's module tests (repo convention: swarm route handlers stay thin and untested at the HTTP layer — see the header comments in `server.test.ts`).

- [ ] **Step 1: Add the import** (extend the existing `./cli-tools.js` import area):

```ts
import {
  buildApiKeyListings,
  deleteKey,
  getCredential,
  loadApiKeysFile,
  saveAndVerifyKey,
  verifyStoredKey,
  type ApiKeyOpResult,
} from './api-keys.js';
```

- [ ] **Step 2: Register the routes** (place directly after the `/cli-tools` routes):

```ts
// ── API key registry (Settings → API Keys; spec 2026-08-06) ────────────
const apiKeysPath = () => resolve(process.cwd(), '.smith/api-keys.json');
const sendKeyOp = (reply: { status(code: number): { send(body: unknown): unknown } }, r: ApiKeyOpResult) =>
  'error' in r ? reply.status(r.status).send({ error: r.error }) : { providers: r.listings };

this.app.get('/api-keys', async () => ({ providers: buildApiKeyListings(await loadApiKeysFile(apiKeysPath())) }));

this.app.put<{ Params: { provider: string } }>('/api-keys/:provider', async (req, reply) =>
  sendKeyOp(reply, await saveAndVerifyKey(apiKeysPath(), req.params.provider, ((req.body ?? {}) as { key?: string }).key ?? '')),
);

this.app.post<{ Params: { provider: string } }>('/api-keys/:provider/verify', async (req, reply) =>
  sendKeyOp(reply, await verifyStoredKey(apiKeysPath(), req.params.provider)),
);

this.app.delete<{ Params: { provider: string } }>('/api-keys/:provider', async (req, reply) =>
  sendKeyOp(reply, await deleteKey(apiKeysPath(), req.params.provider)),
);

// Raw-key hop for the broker's avatar generator ONLY. Guard: the swarm
// binds 127.0.0.1, and this route is deliberately absent from the broker's
// text-channel passthrough — 7790 can never serve it (spec invariant).
this.app.get<{ Params: { provider: string } }>('/api-keys/:provider/credential', async (req, reply) => {
  const r = await getCredential(apiKeysPath(), req.params.provider);
  return 'error' in r ? reply.status(r.status).send({ error: r.error }) : r;
});
```

- [ ] **Step 3: Full swarm suite green** — `cd swarm && npm test` (expect the 2 known pre-existing agent-sessions environmental failures at most; nothing new).

- [ ] **Step 4: Smoke it live** (optional but cheap): `node --import tsx src/index.ts` isn't needed — the running dev swarm restarts later; skip live smoke here.

- [ ] **Step 5: Commit**

```bash
git add swarm/src/server.ts
git commit -m "feat(swarm): api-keys routes + swarm-local credential hop"
```

---

### Task 5: broker — swarm-client methods, passthrough, origin tests

**Files:**
- Modify: `broker/src/swarm-client.ts` (beside `listCliTools`, ~line 369)
- Modify: `broker/src/main.ts` (beside the `cliTools` handler object, ~line 594, and the `TextChannel` construction arg list ~line 900)
- Modify: `broker/src/text-channel.ts` (constructor param beside `cliTools` ~line 182; routes beside the `/cli-tools` block ~line 612)
- Test: `broker/src/text-channel.test.ts` (append)

**Interfaces:**
- Consumes: Task 4's HTTP surface.
- Produces:
  - `SwarmClient` methods: `listApiKeys()`, `saveApiKey(id, key)`, `verifyApiKey(id)`, `deleteApiKey(id)`, `getApiKeyCredential(id): Promise<{ key?: string; error?: string }>`
  - `TextChannel` constructor gains optional `apiKeys?: { list(): Promise<unknown>; save(id: string, key: string): Promise<unknown>; verify(id: string): Promise<unknown>; remove(id: string): Promise<unknown> }` — placed directly after the existing `cliTools` param.
  - 7790 routes: `GET /api-keys`, `PUT /api-keys/:id`, `POST /api-keys/:id/verify`, `DELETE /api-keys/:id`. **No credential route.**

- [ ] **Step 1: swarm-client methods** (mirror the `listCliTools` trio):

```ts
async listApiKeys() {
  return this.http('GET', '/api-keys') as unknown as Promise<Record<string, unknown>>;
}
async saveApiKey(id: string, key: string) {
  return this.http('PUT', `/api-keys/${encodeURIComponent(id)}`, { key }) as unknown as Promise<Record<string, unknown>>;
}
async verifyApiKey(id: string) {
  return this.http('POST', `/api-keys/${encodeURIComponent(id)}/verify`) as unknown as Promise<Record<string, unknown>>;
}
async deleteApiKey(id: string) {
  return this.http('DELETE', `/api-keys/${encodeURIComponent(id)}`) as unknown as Promise<Record<string, unknown>>;
}
async getApiKeyCredential(id: string) {
  return this.http('GET', `/api-keys/${encodeURIComponent(id)}/credential`) as unknown as Promise<{ key?: string; error?: string }>;
}
```

- [ ] **Step 2: main.ts handler + wiring** — after the `cliTools` object:

```ts
// API key registry (Settings → API Keys): same thin passthrough shape as
// cliTools, origin-restricted the same way. The credential route is
// deliberately NOT passed through (spec invariant).
const apiKeys = {
  list: () => swarm.listApiKeys(),
  save: (id: string, key: string) => swarm.saveApiKey(id, key),
  verify: (id: string) => swarm.verifyApiKey(id),
  remove: (id: string) => swarm.deleteApiKey(id),
};
```

and add `apiKeys,` to the `new TextChannel(...)` argument list directly after `cliTools,` (keep parameter order in the constructor identical).

- [ ] **Step 3: Write the failing passthrough + origin tests**

`text-channel.test.ts` already contains a channel-boot helper used by the cli-tools/connectors passthrough tests — reuse that exact helper (name/arity per the file), passing an `apiKeys` stub. The test bodies:

```ts
test('api-keys passthrough: list/save/verify/remove reach handlers and return JSON', async () => {
  const calls: string[] = [];
  const apiKeys = {
    list: async () => { calls.push('list'); return { providers: [] }; },
    save: async (id: string, key: string) => { calls.push(`save:${id}:${key.length}`); return { providers: [] }; },
    verify: async (id: string) => { calls.push(`verify:${id}`); return { providers: [] }; },
    remove: async (id: string) => { calls.push(`remove:${id}`); return { providers: [] }; },
  };
  // boot channel with { apiKeys } via the file's existing helper; port in `port`
  const list = await fetch(`http://127.0.0.1:${port}/api-keys`);
  assert.equal(list.status, 200);
  const save = await fetch(`http://127.0.0.1:${port}/api-keys/google`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'sk-x' }),
  });
  assert.equal(save.status, 200);
  const verify = await fetch(`http://127.0.0.1:${port}/api-keys/google/verify`, { method: 'POST' });
  assert.equal(verify.status, 200);
  const del = await fetch(`http://127.0.0.1:${port}/api-keys/google`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.deepEqual(calls, ['list', 'save:google:4', 'verify:google', 'remove:google']);
});

test('api-keys passthrough: browser Origin is refused (403)', async () => {
  // same boot; every route with an Origin header must 403 and never call the handler
  for (const [method, path] of [
    ['GET', '/api-keys'],
    ['PUT', '/api-keys/google'],
    ['POST', '/api-keys/google/verify'],
    ['DELETE', '/api-keys/google'],
  ] as const) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      ...(method === 'PUT' ? { body: '{"key":"x"}' } : {}),
    });
    assert.equal(res.status, 403, `${method} ${path}`);
  }
});

test('api-keys: credential route is NOT proxied on 7790', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api-keys/google/credential`);
  assert.equal(res.status, 404);
});
```

Adapt the origin-refusal expectation to the file's existing `originBlocked()` behavior (it returns 403 via `credJson` — assert whatever status the existing connectors origin test asserts; if none exists, 403 is correct per `originBlocked`'s implementation).

- [ ] **Step 4: Run to verify failures** — `cd broker && node --import tsx --test src/text-channel.test.ts` — FAIL (routes missing).

- [ ] **Step 5: text-channel.ts implementation** — constructor param after `cliTools`:

```ts
private readonly apiKeys?: {
  list(): Promise<unknown>;
  save(id: string, key: string): Promise<unknown>;
  verify(id: string): Promise<unknown>;
  remove(id: string): Promise<unknown>;
},
```

Routes, placed directly after the cli-tools block, mirroring its style (`originBlocked()` guard, `credJson`/`credFail` helpers, body accumulation for PUT):

```ts
if (req.method === 'GET' && url.pathname === '/api-keys' && this.apiKeys) {
  if (originBlocked()) return;
  void this.apiKeys.list().then((r) => credJson(200, r), credFail);
  return;
}
const apiKeyVerifyMatch = /^\/api-keys\/([^/]+)\/verify$/.exec(url.pathname);
if (req.method === 'POST' && apiKeyVerifyMatch && this.apiKeys) {
  if (originBlocked()) return;
  void this.apiKeys
    .verify(decodeURIComponent(apiKeyVerifyMatch[1]!))
    .then((r) => credJson((r as { error?: string }).error ? 400 : 200, r), credFail);
  return;
}
const apiKeyMatch = /^\/api-keys\/([^/]+)$/.exec(url.pathname);
if (req.method === 'PUT' && apiKeyMatch && this.apiKeys) {
  if (originBlocked()) return;
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    let parsed: { key?: string } = {};
    try {
      parsed = JSON.parse(body || '{}') as { key?: string };
    } catch {
      return credJson(400, { error: 'body must be JSON' });
    }
    void this.apiKeys!
      .save(decodeURIComponent(apiKeyMatch[1]!), parsed.key ?? '')
      .then((r) => credJson((r as { error?: string }).error ? 400 : 200, r), credFail);
  });
  return;
}
if (req.method === 'DELETE' && apiKeyMatch && this.apiKeys) {
  if (originBlocked()) return;
  void this.apiKeys
    .remove(decodeURIComponent(apiKeyMatch[1]!))
    .then((r) => credJson((r as { error?: string }).error ? 400 : 200, r), credFail);
  return;
}
// NOTE: /api-keys/:id/credential is deliberately absent — raw keys never
// transit 7790 (spec invariant). The verify-match must run BEFORE the bare
// /api-keys/:id match so PUT/DELETE never swallow /verify; keep this order.
```

Note the swarm's error statuses (404/409) surface here as 400 from the passthrough — same flattening the connectors passthrough performs; the UI only needs `{ error }`.

- [ ] **Step 6: Run tests — green.** `cd broker && node --import tsx --test src/text-channel.test.ts`, then full `npm test`.

- [ ] **Step 7: Commit**

```bash
git add broker/src/swarm-client.ts broker/src/main.ts broker/src/text-channel.ts broker/src/text-channel.test.ts
git commit -m "feat(broker): api-keys passthrough on 7790 — credential route deliberately absent"
```

---

### Task 6: broker — AgyImagesClient

**Files:**
- Create: `broker/src/agy-images-client.ts`
- Test: `broker/src/agy-images-client.test.ts`

**Interfaces:**
- Consumes: `ImagesClient` interface from `./avatar-generator.ts` (already exported).
- Produces: `class AgyImagesClient implements ImagesClient` with constructor `(binary = 'agy', run: AgyRunner = defaultRunner)`; `type AgyRunner = (argv: string[], cwd: string, timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>`. Task 7 constructs it with defaults.

- [ ] **Step 1: Write the failing tests**

```ts
// broker/src/agy-images-client.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgyImagesClient, type AgyRunner } from './agy-images-client.ts';

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d', 'hex'); // enough to be readable bytes

test('collects the produced image even when misnamed, returns ImagesClient shape', async () => {
  let seenArgv: string[] = [];
  const runner: AgyRunner = async (argv, cwd) => {
    seenArgv = argv;
    await writeFile(join(cwd, 'whatever-agy-called-it.jpeg'), PNG_BYTES); // wrong ext, wrong name — must still be found
    return { code: 0, stdout: 'done', stderr: '' };
  };
  const client = new AgyImagesClient('agy', runner);
  const res = await client.models.generateContent({ model: 'ignored', contents: 'portrait prompt' });
  const data = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
  assert.equal(data, PNG_BYTES.toString('base64'));
  assert.equal(seenArgv[0], 'agy');
  assert.equal(seenArgv[1], '-p');
  assert.ok(seenArgv[2]!.includes('portrait prompt'), 'house prompt must reach agy verbatim');
  assert.ok(seenArgv.includes('--dangerously-skip-permissions'));
});

test('no image produced -> typed error the wizard can show verbatim', async () => {
  const runner: AgyRunner = async () => ({ code: 0, stdout: '', stderr: '' });
  const client = new AgyImagesClient('agy', runner);
  await assert.rejects(
    () => client.models.generateContent({ model: 'x', contents: 'p' }),
    /agy produced no image/,
  );
});

test('nonzero exit -> error mentions exit code', async () => {
  const runner: AgyRunner = async () => ({ code: 1, stdout: '', stderr: 'boom' });
  const client = new AgyImagesClient('agy', runner);
  await assert.rejects(() => client.models.generateContent({ model: 'x', contents: 'p' }), /exit 1/);
});
```

- [ ] **Step 2: Run to verify failure** — `cd broker && node --import tsx --test src/agy-images-client.test.ts` — FAIL: module missing.

- [ ] **Step 3: Implement**

```ts
// broker/src/agy-images-client.ts
// Subscription-path avatar engine: drives headless `agy -p` (Antigravity's
// native Nano Banana) and adapts its file output to the ImagesClient shape
// AvatarGenerator already consumes. Empirics behind the wrapper (spec
// §Avatar generation): ~60–90s per image, imperfect path discipline, and
// JPEG output mislabeled .png — so the run is contained in a fresh temp
// dir, whatever image lands there is collected regardless of name, and
// sharp downstream normalizes size/format.
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImagesClient } from './avatar-generator.ts';

export type AgyRunner = (
  argv: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const defaultRunner: AgyRunner = (argv, cwd, timeoutMs) =>
  new Promise((done) => {
    execFile(argv[0]!, argv.slice(1), { cwd, timeout: timeoutMs }, (err, stdout, stderr) => {
      const code = err
        ? typeof (err as { code?: unknown }).code === 'number'
          ? ((err as { code: number }).code)
          : null // killed by timeout/signal
        : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const TIMEOUT_MS = 180_000; // spec: 3 minutes

export class AgyImagesClient implements ImagesClient {
  constructor(
    private readonly binary = 'agy',
    private readonly run: AgyRunner = defaultRunner,
  ) {}

  readonly models = {
    generateContent: async ({ contents }: { model: string; contents: string; config?: Record<string, unknown> }) => {
      const dir = await mkdtemp(join(tmpdir(), 'smith-avatar-'));
      try {
        const prompt =
          `${contents} Generate exactly one image and save it into the current working directory (${dir}). ` +
          'Write no other files anywhere else.';
        const res = await this.run(
          [this.binary, '-p', prompt, '--dangerously-skip-permissions', '--add-dir', dir],
          dir,
          TIMEOUT_MS,
        );
        const images = (await readdir(dir)).filter((f) => IMAGE_EXT.test(f));
        if (res.code !== 0 || images.length === 0) {
          throw new Error(
            `agy produced no image${res.code !== 0 ? ` (exit ${res.code})` : ''} — try again, or add a Google key in Settings → API Keys`,
          );
        }
        const data = (await readFile(join(dir, images[0]!))).toString('base64');
        // mimeType is advisory — AvatarGenerator pipes bytes through sharp,
        // which sniffs the real format (the JPEG-named-.png case).
        return { candidates: [{ content: { parts: [{ inlineData: { data, mimeType: 'image/png' } }] } }] };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
```

- [ ] **Step 4: Run — green.** `cd broker && node --import tsx --test src/agy-images-client.test.ts`

- [ ] **Step 5: Commit**

```bash
git add broker/src/agy-images-client.ts broker/src/agy-images-client.test.ts
git commit -m "feat(broker): AgyImagesClient — subscription-path avatar engine via headless agy"
```

---

### Task 7: broker — avatar engine selection

**Files:**
- Create: `broker/src/avatar-engine.ts`
- Test: `broker/src/avatar-engine.test.ts`
- Modify: `broker/src/main.ts` — replace the boot-time `avatarGenerator` const (~line 56), the `generateAvatar` handler (~line 765), and the catalog's `avatarGen` flag (~line 609).

**Interfaces:**
- Consumes: `AgyImagesClient` (Task 6), `swarm.getApiKeyCredential` + `swarm.listCliTools` (Task 5), `GoogleGenAI`, `AvatarGenerator`/`ImagesClient`.
- Produces:
  - `type AvatarEngine = { kind: 'api' | 'agy'; client: ImagesClient } | null`
  - `resolveAvatarEngine(deps: AvatarEngineDeps): Promise<AvatarEngine>` where `AvatarEngineDeps = { getGoogleKey(): Promise<string | null>; isAgyActive(): Promise<boolean>; makeApiClient?(key: string): ImagesClient; makeAgyClient?(): ImagesClient }`
  - Catalog field becomes `avatarGen: 'api' | 'agy' | null` (was `boolean`) — Task 10 consumes this in the wizard.
  - `generateAvatar` response gains `engine: 'api' | 'agy'` beside `imageData`.

- [ ] **Step 1: Write the failing tests**

```ts
// broker/src/avatar-engine.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveAvatarEngine } from './avatar-engine.ts';
import type { ImagesClient } from './avatar-generator.ts';

const fakeClient = (tag: string): ImagesClient =>
  ({ models: { generateContent: async () => ({ candidates: [], tag }) } }) as unknown as ImagesClient;

test('verified google key wins -> api engine with that key', async () => {
  let seenKey = '';
  const engine = await resolveAvatarEngine({
    getGoogleKey: async () => 'sk-g-123',
    isAgyActive: async () => true, // even with agy available, key accelerates
    makeApiClient: (key) => {
      seenKey = key;
      return fakeClient('api');
    },
    makeAgyClient: () => fakeClient('agy'),
  });
  assert.equal(engine?.kind, 'api');
  assert.equal(seenKey, 'sk-g-123');
});

test('no key, agy active -> agy engine', async () => {
  const engine = await resolveAvatarEngine({
    getGoogleKey: async () => null,
    isAgyActive: async () => true,
    makeAgyClient: () => fakeClient('agy'),
  });
  assert.equal(engine?.kind, 'agy');
});

test('neither -> null', async () => {
  assert.equal(
    await resolveAvatarEngine({ getGoogleKey: async () => null, isAgyActive: async () => false }),
    null,
  );
});
```

- [ ] **Step 2: Run to verify failure** — module missing.

- [ ] **Step 3: Implement**

```ts
// broker/src/avatar-engine.ts
// Per-request avatar engine selection (spec §Avatar generation):
// verified google key → Gemini API (~3–5s); agy active per the CLI
// registry → AgyImagesClient (~60–90s); neither → null, caller shows the
// two remedies. Subscription-first: the key is the accelerator, not the
// requirement.
import { GoogleGenAI } from '@google/genai';
import { AgyImagesClient } from './agy-images-client.ts';
import type { ImagesClient } from './avatar-generator.ts';

export interface AvatarEngineDeps {
  /** google credential (api-keys store via swarm, or legacy env) — null on any failure. */
  getGoogleKey(): Promise<string | null>;
  /** agy row of the swarm's /cli-tools listing — active means launchable. */
  isAgyActive(): Promise<boolean>;
  makeApiClient?(key: string): ImagesClient;
  makeAgyClient?(): ImagesClient;
}

export type AvatarEngine = { kind: 'api' | 'agy'; client: ImagesClient } | null;

export async function resolveAvatarEngine(deps: AvatarEngineDeps): Promise<AvatarEngine> {
  const key = await deps.getGoogleKey();
  if (key) {
    const make = deps.makeApiClient ?? ((k: string) => new GoogleGenAI({ apiKey: k }) as unknown as ImagesClient);
    return { kind: 'api', client: make(key) };
  }
  if (await deps.isAgyActive()) {
    const make = deps.makeAgyClient ?? (() => new AgyImagesClient());
    return { kind: 'agy', client: make() };
  }
  return null;
}
```

- [ ] **Step 4: Run — green**, then wire `main.ts`:

Replace the boot-time construction (`const avatarGenerator = config.geminiApiKey ? … : null`) with:

```ts
const avatarEngine = () =>
  resolveAvatarEngine({
    getGoogleKey: async () => {
      if (config.geminiApiKey) return config.geminiApiKey; // legacy .env still honored
      const r = await swarm.getApiKeyCredential('google').catch(() => ({ error: 'swarm unreachable' }) as const);
      return 'key' in r && r.key ? r.key : null;
    },
    isAgyActive: async () => {
      const r = (await swarm.listCliTools().catch(() => null)) as { tools?: Array<{ cli: string; active: boolean }> } | null;
      return Boolean(r?.tools?.find((t) => t.cli === 'agy')?.active);
    },
  });
```

Catalog line (was `avatarGen: avatarGenerator !== null`):

```ts
catalog: async () => ({ ...(await swarm.agentCatalog()), avatarGen: (await avatarEngine())?.kind ?? null }),
```

`generateAvatar` handler (was `if (!avatarGenerator) return { error: 'no Gemini key configured' }`):

```ts
generateAvatar: async (body) => {
  const engine = await avatarEngine();
  if (!engine) {
    return { error: 'no image engine available — add a Google key in Settings → API Keys, or install Antigravity (agy)' };
  }
  try {
    const generator = new AvatarGenerator(engine.client, config.geminiImageModel);
    return { imageData: await generator.generate(body as AvatarRequest), engine: engine.kind };
  } catch (err) {
    return { error: String((err as Error).message) };
  }
},
```

Remove the now-unused `GoogleGenAI` import from `main.ts` if the only remaining use was the deleted const (`avatar-engine.ts` imports it instead).

- [ ] **Step 5: Full broker suite green** — `cd broker && npm test`

- [ ] **Step 6: Commit**

```bash
git add broker/src/avatar-engine.ts broker/src/avatar-engine.test.ts broker/src/main.ts
git commit -m "feat(broker): agy-first avatar engine selection, google key accelerates"
```

---

### Task 8: control-plane — client functions

**Files:**
- Modify: `control-plane/src/hooks/useBrokerChat.ts` — add the `ApiKeyListing` type beside `CliToolListing` (~line 126) and four callbacks beside `listCliTools` (~line 445); export all through the hook's return object (beside `listCliTools`, ~line 549).
- Test: `control-plane/src/hooks/useCliToolHealth.test.ts` is the fetch-mock precedent; API-key client fns get exercised through `ApiKeysGroup.test.tsx` (Task 9) — no standalone hook test (matches how `listCliTools` is covered today).

**Interfaces:**
- Produces (Task 9 consumes exactly these):
  - `export interface ApiKeyListing { id: string; label: string; description: string; hasKey: boolean; last4: string | null; verified: boolean | 'unknown' | null; detail: string | null; lastCheckedAt: string | null }`
  - `listApiKeys(): Promise<ApiKeyListing[]>`
  - `saveApiKey(id: string, key: string): Promise<ApiKeyListing[] | { error: string }>`
  - `verifyApiKey(id: string): Promise<ApiKeyListing[] | { error: string }>`
  - `deleteApiKey(id: string): Promise<ApiKeyListing[] | { error: string }>`

- [ ] **Step 1: Implement** (mirror the `listCliTools`/`setCliToolEnabled` idiom exactly):

```ts
/** Provider key joined with redacted machine state — drives the API Keys settings cards. */
export interface ApiKeyListing {
  id: string;
  label: string;
  description: string;
  hasKey: boolean;
  last4: string | null;
  verified: boolean | 'unknown' | null;
  detail: string | null;
  lastCheckedAt: string | null;
}

const listApiKeys = useCallback(async (): Promise<ApiKeyListing[]> => {
  const res = await fetch(`http://${base}/api-keys`);
  return ((await res.json()) as { providers?: ApiKeyListing[] }).providers ?? [];
}, [base]);

const saveApiKey = useCallback(
  async (id: string, key: string): Promise<ApiKeyListing[] | { error: string }> => {
    const res = await fetch(`http://${base}/api-keys/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
    const body = (await res.json()) as { providers?: ApiKeyListing[]; error?: string };
    return body.error ? { error: body.error } : (body.providers ?? []);
  },
  [base],
);

const verifyApiKey = useCallback(
  async (id: string): Promise<ApiKeyListing[] | { error: string }> => {
    const res = await fetch(`http://${base}/api-keys/${encodeURIComponent(id)}/verify`, { method: "POST" });
    const body = (await res.json()) as { providers?: ApiKeyListing[]; error?: string };
    return body.error ? { error: body.error } : (body.providers ?? []);
  },
  [base],
);

const deleteApiKey = useCallback(
  async (id: string): Promise<ApiKeyListing[] | { error: string }> => {
    const res = await fetch(`http://${base}/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
    const body = (await res.json()) as { providers?: ApiKeyListing[]; error?: string };
    return body.error ? { error: body.error } : (body.providers ?? []);
  },
  [base],
);
```

Add `listApiKeys, saveApiKey, verifyApiKey, deleteApiKey,` to the hook's returned object beside `listCliTools`.

Also update the catalog type: find `avatarGen?: boolean` in `useBrokerChat.ts`'s catalog interface (if typed there) and in `AddAgentModal.tsx:57`, change to `avatarGen?: 'api' | 'agy' | null` — the wizard adaptation itself is Task 10.

- [ ] **Step 2: Typecheck** — `cd control-plane && npm run typecheck`. Expected: errors ONLY at `AddAgentModal.tsx:715` (`enabled={catalog?.avatarGen ?? false}` now type-mismatched). Fix minimally for now: `enabled={Boolean(catalog?.avatarGen)}` — Task 10 replaces it properly.

- [ ] **Step 3: Run the suite** — `cd control-plane && npm test` — green.

- [ ] **Step 4: Commit**

```bash
git add control-plane/src/hooks/useBrokerChat.ts control-plane/src/organisms/AddAgentModal.tsx
git commit -m "feat(control-plane): api-keys client functions + tri-state avatarGen type"
```

---

### Task 9: control-plane — grouped nav + ApiKeysGroup

**Files:**
- Create: `control-plane/src/organisms/settings/ApiKeysGroup.tsx`
- Test: `control-plane/src/organisms/settings/ApiKeysGroup.test.tsx`
- Modify: `control-plane/src/organisms/SettingsPanel.tsx` (nav → sections; new group), `control-plane/src/organisms/SettingsPanel.test.tsx` (append), `control-plane/src/pages/HomePage.tsx` (pass the four fns), `control-plane/src/styles/components.css` (heading style)

**Interfaces:**
- Consumes: Task 8's `ApiKeyListing` + four functions.
- Produces: `SettingsGroupId` union gains `"api-keys"`; `SettingsPanel` props gain `listApiKeys? / saveApiKey? / verifyApiKey? / deleteApiKey?` with the Task 8 signatures; exported `pillForApiKey(l: ApiKeyListing)` for tests.

- [ ] **Step 1: Write failing ApiKeysGroup tests**

```tsx
// control-plane/src/organisms/settings/ApiKeysGroup.test.tsx
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiKeyListing } from "../../hooks/useBrokerChat";
import { ApiKeysGroup, pillForApiKey } from "./ApiKeysGroup";

const listing = (over: Partial<ApiKeyListing> = {}): ApiKeyListing => ({
  id: "google",
  label: "Google",
  description: "Gemini API — accelerates avatar generation.",
  hasKey: false,
  last4: null,
  verified: null,
  detail: null,
  lastCheckedAt: null,
  ...over,
});

describe("pillForApiKey", () => {
  it("maps the four states", () => {
    expect(pillForApiKey(listing()).label).toBe("no key");
    expect(pillForApiKey(listing({ hasKey: true, verified: false })).label).toBe("needs valid key");
    expect(pillForApiKey(listing({ hasKey: true, verified: "unknown" })).label).toBe("unverified");
    expect(pillForApiKey(listing({ hasKey: true, verified: true })).label).toBe("valid");
  });
});

describe("ApiKeysGroup", () => {
  afterEach(() => cleanup());

  it("renders a card per provider with masked last4, never the key", async () => {
    render(
      <ApiKeysGroup
        listApiKeys={async () => [listing({ hasKey: true, last4: "9876", verified: true })]}
        saveApiKey={vi.fn()}
        verifyApiKey={vi.fn()}
        deleteApiKey={vi.fn()}
      />,
    );
    await screen.findByText(/•••• 9876/);
    expect(screen.getByText("valid")).toBeDefined();
  });

  it("save sends the typed key and re-renders from the response", async () => {
    const saveApiKey = vi.fn(async () => [listing({ hasKey: true, last4: "4321", verified: true })]);
    render(
      <ApiKeysGroup listApiKeys={async () => [listing()]} saveApiKey={saveApiKey} verifyApiKey={vi.fn()} deleteApiKey={vi.fn()} />,
    );
    await screen.findByText("no key");
    await userEvent.type(screen.getByLabelText(/api key/i), "sk-new-4321");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(saveApiKey).toHaveBeenCalledWith("google", "sk-new-4321");
    await screen.findByText(/•••• 4321/);
  });

  it("surfaces errors inline", async () => {
    render(
      <ApiKeysGroup
        listApiKeys={async () => [listing({ hasKey: true, last4: "9876", verified: "unknown" })]}
        saveApiKey={vi.fn()}
        verifyApiKey={vi.fn(async () => ({ error: "no key stored for google" }))}
        deleteApiKey={vi.fn()}
      />,
    );
    await screen.findByText("unverified");
    await userEvent.click(screen.getByRole("button", { name: /verify/i }));
    await screen.findByText(/no key stored for google/);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd control-plane && npx vitest run src/organisms/settings/ApiKeysGroup.test.tsx` — FAIL: module missing.

- [ ] **Step 3: Implement ApiKeysGroup** (structure mirrors `CliToolsGroup`, same CSS classes):

```tsx
// control-plane/src/organisms/settings/ApiKeysGroup.tsx
import { useEffect, useState } from "react";
import type { ApiKeyListing } from "../../hooks/useBrokerChat";

interface ApiKeysGroupProps {
  listApiKeys: () => Promise<ApiKeyListing[]>;
  saveApiKey: (id: string, key: string) => Promise<ApiKeyListing[] | { error: string }>;
  verifyApiKey: (id: string) => Promise<ApiKeyListing[] | { error: string }>;
  deleteApiKey: (id: string) => Promise<ApiKeyListing[] | { error: string }>;
}

/** Status pill precedence mirrors CliToolsGroup: reality before preference. Exported for tests. */
export function pillForApiKey(l: ApiKeyListing): { label: string; cls: string } {
  if (!l.hasKey) return { label: "no key", cls: "connector-status--unconnected" };
  if (l.verified === false) return { label: "needs valid key", cls: "connector-status--unconnected" };
  if (l.verified === "unknown") return { label: "unverified", cls: "connector-status--unconnected" };
  return { label: "valid", cls: "connector-status--connected" };
}

/** Card grid, one per registry provider — masked key state, save/verify/remove. */
export function ApiKeysGroup({ listApiKeys, saveApiKey, verifyApiKey, deleteApiKey }: ApiKeysGroupProps) {
  const [keys, setKeys] = useState<ApiKeyListing[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once load, same convention as CliToolsGroup
  useEffect(() => {
    void listApiKeys().then(setKeys, (err: unknown) => setError(`Could not load API keys — ${String(err)}`));
  }, []);

  const apply = async (id: string, op: () => Promise<ApiKeyListing[] | { error: string }>) => {
    setBusy(id);
    setError(null);
    const result = await op();
    setBusy(null);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setKeys(result);
  };

  return (
    <>
      <h1>api keys</h1>
      <p className="wizard__hint">
        Provider keys for what subscriptions can’t cover — verified live, stored on this machine only, never shown
        back. Subscription CLIs stay the default for agent work; a Google key here accelerates avatar generation.
      </p>
      {error && <p className="wizard__error">{error}</p>}
      <div className="connector-grid">
        {keys.map((l) => {
          const pill = pillForApiKey(l);
          return (
            <div key={l.id} className="connector-card">
              <div className="connector-card__head">
                <b>{l.label}</b>
                <em>{l.description}</em>
              </div>
              <div className="connector-instance">
                <span className={`connector-status ${pill.cls}`}>{pill.label}</span>
                <span>
                  {l.hasKey ? `•••• ${l.last4}` : "no key on this machine"}
                  {l.detail ? ` — ${l.detail}` : ""}
                </span>
              </div>
              {l.lastCheckedAt && (
                <p className="wizard__hint">last checked {new Date(l.lastCheckedAt).toLocaleString()}</p>
              )}
              <label>
                API key
                <input
                  type="password"
                  value={drafts[l.id] ?? ""}
                  placeholder={l.hasKey ? "paste a new key to replace" : "paste key"}
                  onChange={(e) => setDrafts((d) => ({ ...d, [l.id]: e.target.value }))}
                />
              </label>
              <div className="connector-instance">
                <button
                  type="button"
                  className="settings-btn"
                  disabled={busy !== null || !(drafts[l.id] ?? "").trim()}
                  onClick={() =>
                    void apply(l.id, () => saveApiKey(l.id, (drafts[l.id] ?? "").trim())).then(() =>
                      setDrafts((d) => ({ ...d, [l.id]: "" })),
                    )
                  }
                >
                  {busy === l.id ? "saving…" : "save"}
                </button>
                {l.hasKey && (
                  <>
                    <button type="button" className="settings-btn" disabled={busy !== null} onClick={() => void apply(l.id, () => verifyApiKey(l.id))}>
                      verify
                    </button>
                    <button type="button" className="settings-btn" disabled={busy !== null} onClick={() => void apply(l.id, () => deleteApiKey(l.id))}>
                      remove
                    </button>
                  </>
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

- [ ] **Step 4: Run ApiKeysGroup tests — green.**

- [ ] **Step 5: SettingsPanel sections + wiring — failing test first** (append to `SettingsPanel.test.tsx`):

```tsx
it("groups the nav under App / Agents / Workspace headings with API Keys under Agents", () => {
  render(<SettingsPanel open onClose={() => {}} onReset={vi.fn()} theme="dark" onThemeChange={vi.fn()} />);
  for (const heading of ["App", "Agents", "Workspace"]) {
    expect(screen.getByText(heading)).toBeDefined();
  }
  expect(screen.getByRole("button", { name: /api keys/i })).toBeDefined();
});

it("opens the API Keys group and renders its cards when wired", async () => {
  render(
    <SettingsPanel
      open
      onClose={() => {}}
      onReset={vi.fn()}
      theme="dark"
      onThemeChange={vi.fn()}
      initialGroup="api-keys"
      listApiKeys={async () => []}
      saveApiKey={vi.fn()}
      verifyApiKey={vi.fn()}
      deleteApiKey={vi.fn()}
    />,
  );
  expect(await screen.findByRole("heading", { name: /api keys/i })).toBeDefined();
});
```

- [ ] **Step 6: Implement the nav sections** in `SettingsPanel.tsx`:

Change the id union: `export type SettingsGroupId = "general" | "integrations" | "cli-tools" | "api-keys" | "channels" | "themes";`

Add `KeyRound` to the lucide import. Replace the flat `GROUPS` with:

```tsx
const SECTIONS: Array<{
  heading: string;
  groups: Array<{ id: SettingsGroupId; label: string; icon: typeof SettingsIcon }>;
}> = [
  {
    heading: "App",
    groups: [
      { id: "general", label: "General", icon: SettingsIcon },
      { id: "themes", label: "Themes", icon: Palette },
    ],
  },
  {
    heading: "Agents",
    groups: [
      { id: "cli-tools", label: "CLI Tools", icon: Terminal },
      { id: "api-keys", label: "API Keys", icon: KeyRound },
    ],
  },
  {
    heading: "Workspace",
    groups: [
      { id: "integrations", label: "Integrations", icon: Blocks },
      { id: "channels", label: "Channels", icon: MessageSquare },
    ],
  },
];
```

Nav render (replace the `GROUPS.map` block):

```tsx
{SECTIONS.map((s) => (
  <div key={s.heading} className="settings-screen__section">
    <span className="settings-screen__heading">{s.heading}</span>
    {s.groups.map((g) => (
      <button
        key={g.id}
        type="button"
        className={`settings-screen__group${active === g.id ? " is-active" : ""}`}
        onClick={() => setActive(g.id)}
        aria-pressed={active === g.id}
      >
        <g.icon size={14} strokeWidth={2} /> {g.label}
      </button>
    ))}
  </div>
))}
```

Props: add `listApiKeys?`, `saveApiKey?`, `verifyApiKey?`, `deleteApiKey?` (Task 8 signatures) to `SettingsPanelProps` and destructure them. Content block beside the cli-tools one:

```tsx
{active === "api-keys" &&
  (listApiKeys && saveApiKey && verifyApiKey && deleteApiKey ? (
    <ApiKeysGroup listApiKeys={listApiKeys} saveApiKey={saveApiKey} verifyApiKey={verifyApiKey} deleteApiKey={deleteApiKey} />
  ) : (
    <p className="wizard__hint">API Keys — not wired up yet.</p>
  ))}
```

CSS (`components.css`, beside the existing `.settings-screen__group` rules):

```css
.settings-screen__section {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.settings-screen__heading {
  margin: 10px 8px 2px;
  font-size: 0.62rem;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  opacity: 0.55;
}
```

`HomePage.tsx`: destructure `listApiKeys, saveApiKey, verifyApiKey, deleteApiKey` from `useBrokerChat` (beside `listCliTools`) and pass all four into `<SettingsPanel …>` beside the cliTools props.

- [ ] **Step 7: Run — green.** `cd control-plane && npm test && npm run typecheck`

- [ ] **Step 8: Commit**

```bash
git add control-plane/src/organisms/settings/ApiKeysGroup.tsx control-plane/src/organisms/settings/ApiKeysGroup.test.tsx control-plane/src/organisms/SettingsPanel.tsx control-plane/src/organisms/SettingsPanel.test.tsx control-plane/src/pages/HomePage.tsx control-plane/src/styles/components.css
git commit -m "feat(control-plane): grouped settings nav (App/Agents/Workspace) + API Keys cards"
```

---

### Task 10: wizard brewing state, docs, integration verify

**Files:**
- Modify: `control-plane/src/molecules/AvatarGeneratorBlock.tsx` (prop `enabled: boolean` → `engine: 'api' | 'agy' | null | undefined`), `control-plane/src/organisms/AddAgentModal.tsx:715` (pass `engine={catalog?.avatarGen ?? null}`)
- Modify: `docs/FEATURES.md`, `docs/MANUAL-TESTING.md`, `PRD.md`
- Test: `control-plane/src/molecules/AvatarGeneratorBlock.test.tsx` (create if absent; the component currently has no test file)

**Interfaces:**
- Consumes: Task 7's tri-state `avatarGen` through the catalog; Task 8's type change.

- [ ] **Step 1: Failing test for the brewing state**

```tsx
// control-plane/src/molecules/AvatarGeneratorBlock.test.tsx
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AvatarGeneratorBlock } from "./AvatarGeneratorBlock";

const base = { base: "127.0.0.1:7790", name: "Test", onGenerated: () => {} };

describe("AvatarGeneratorBlock engines", () => {
  afterEach(() => cleanup());

  it("hidden when no engine", () => {
    render(<AvatarGeneratorBlock {...base} engine={null} />);
    expect(screen.queryByRole("button", { name: /portrait/i })).toBeNull();
  });

  it("api engine: plain generate copy", () => {
    render(<AvatarGeneratorBlock {...base} engine="api" />);
    expect(screen.getByRole("button", { name: /generate portrait/i })).toBeDefined();
  });

  it("agy engine: slow-path copy warns about brewing time", () => {
    render(<AvatarGeneratorBlock {...base} engine="agy" />);
    expect(screen.getByRole("button", { name: /generate portrait/i })).toBeDefined();
    expect(screen.getByText(/1–2 min/i)).toBeDefined();
  });
});
```

Adapt `base` props to the component's actual required props (open the file first — it takes `base`, `name`, `gender`, `role`, `backstory`, `stereotype`, `ring`, `value`, `onGenerated`; only `base`/`name`/`onGenerated` matter for these render tests, pass the rest as undefined-safe).

- [ ] **Step 2: Run to verify failure** — prop `engine` doesn't exist yet.

- [ ] **Step 3: Implement**

In `AvatarGeneratorBlock.tsx`: rename the prop `enabled: boolean` → `engine: 'api' | 'agy' | null | undefined`; change the guard `if (!enabled) return null;` → `if (!engine) return null;`. Ensure the generate button's accessible name includes "generate portrait" (adjust the label if it's currently just "generate"). Below the button, when `engine === 'agy'`, add:

```tsx
{engine === "agy" && (
  <p className="wizard__hint">
    Subscription path (Antigravity) — a portrait brews for ~1–2 min. Add a Google key in Settings → API Keys for
    seconds-fast rerolls.
  </p>
)}
```

And while generating (`genBusy`) with `engine === 'agy'`, swap the button text to `brewing…` (api path keeps its current busy copy). In `AddAgentModal.tsx:715`, replace `enabled={Boolean(catalog?.avatarGen)}` (Task 8's shim) with `engine={catalog?.avatarGen ?? null}`.

- [ ] **Step 4: Run — green.** `cd control-plane && npm test && npm run typecheck`

- [ ] **Step 5: Docs.** Append to `docs/FEATURES.md` (match its existing entry style): a "Settings: Agents section + API Keys" entry — grouped nav, provider cards, verify semantics, agy-first avatar generation with key acceleration. Append to `docs/MANUAL-TESTING.md`: the spec's nine acceptance criteria as a checklist section titled "API Keys + avatar engines (2026-08-06)", each criterion one checkbox line, copied verbatim from the spec. Add one sentence to `PRD.md` §5 Shipped & Verified: "Agent work is subscription-first; provider API keys (Anthropic/OpenAI/Google) are managed and live-verified in Settings → API Keys, and avatar generation runs agy-first with the google key as accelerator."

- [ ] **Step 6: Full verify across packages**

```bash
(cd swarm && npm test) && (cd broker && npm test) && (cd control-plane && npm test && npm run typecheck && npm run lint)
```

Expected: all green (allowing only the 2 known pre-existing agent-sessions environmental failures in swarm).

- [ ] **Step 7: Commit**

```bash
git add control-plane/src/molecules/AvatarGeneratorBlock.tsx control-plane/src/molecules/AvatarGeneratorBlock.test.tsx control-plane/src/organisms/AddAgentModal.tsx docs/FEATURES.md docs/MANUAL-TESTING.md PRD.md
git commit -m "feat(control-plane): agy brewing state in the wizard; docs + manual-test checklist"
```

---

## Post-plan (not tasks — session-level follow-through)

- Merge `settings-agents-api-keys` → main per `superpowers:finishing-a-development-branch`.
- Merge main → the `premade-agent-cards` worktree if it still hosts the live services, then restart `smith-swarm`, `smith-broker`, and `smith-ui` tmux sessions (kill-session + `npm run serve 2>&1 | tee /tmp/<name>-boot.log; exec zsh` — never C-c, never pkill).
- Live acceptance pass: walk `docs/MANUAL-TESTING.md`'s new section against http://localhost:1420 — including one real agy portrait (expect ~60–90s) and, if Edwin has pasted a key, one API portrait (~seconds).
