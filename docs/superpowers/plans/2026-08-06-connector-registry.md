# Connector Registry (Extensible Vendor Connectors) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `User.atlassian?`/`User.github?` with a generic, extensible connector registry (any vendor, multiple named credentials per vendor per user), migrate Atlassian/GitHub into it with zero legacy special-casing left behind, add DataDog and Snyk as the first two new vendors (store + verify only), and replace the small Settings popover with a full-screen surface (General / Integrations / Channels / Themes).

**Architecture:** Three layers, built bottom-up. Swarm owns the registry (`connectors.ts`), per-user storage (`users.ts`), and the CRUD+verify API (`server.ts`); it also updates `workspaces.ts` (a `connectorId` pointer replacing direct credential access) and `dispatcher.ts` (resolves through that pointer). Broker adds a thin, origin-restricted proxy (`swarm-client.ts` + `text-channel.ts`, same pattern as every other credential-adjacent route). Control-plane replaces the small `SettingsPanel` popover with a full-screen shell containing four groups, the Integrations group being a new card grid + generic per-vendor connect form.

**Tech Stack:** swarm/broker: plain `npm`, `node:test` + `node:assert/strict`, plain `fetch` (no vendor SDKs). control-plane: `pnpm`, Vitest + `@testing-library/react`, Biome.

## Global Constraints

- **No vendor SDKs.** Every verify function is plain `fetch`, injectable via a trailing `fetchImpl: typeof fetch = fetch` parameter — matches `verify-atlassian.ts`/`verify-github.ts`/`verify-discord.ts` exactly.
- **Secrets never round-trip.** Every API response redacts `secret: true` fields to `has<Key>: boolean`; non-secret fields (site, region, email) pass through as their real value.
- **Untracked + owner-only storage.** `swarm/.smith/users/*.json` is already untracked (blanket `swarm/.smith/*` `.gitignore` rule) and written via `saveUser`'s existing `mkdir(dir, {mode:0o700})` + `open(path,'w',0o600)` pattern — unchanged by this plan, just holding a different shape.
- **Partial-update-preserves-existing-secret, uniformly.** Every merge function (`buildUserUpdate`, `buildConnectorUpdate`) trims a submitted value and falls back to the existing stored value on blank — applied to every field, not just some (this plan explicitly fixes the asymmetry in today's `buildUserUpdate`, which only trimmed Atlassian's two fields and not GitHub's single field).
- **CORS reuse, not reinvention.** New broker routes reuse `isAllowedOrigin`/`credentialCors`/`originBlocked`/`credJson`/`credFail` from `broker/src/text-channel.ts` verbatim — no new CORS logic.
- **Credential methods stay off `SwarmClientLike`.** Matches the existing precedent: `getMe`/`updateMe`/`verifyGithubToken`/`verifyWorkspaceAtlassian`/`verifyRepoGithub` are not on that interface; broker's conversational tools never need raw connector data, only `main.ts`'s concrete `SwarmClient` instance does.
- **`connectorId` is optional everywhere it appears**, resolving to "no credential for this vendor" (soft-fail, not a crash or a hard block) when unset or when it points at a since-deleted connector — the same invariant Discord's optional per-workspace config already follows.
- **Test commands:** swarm/broker: `npm test` from each package directory (`node --import tsx --test ...`). control-plane: `pnpm run test` (vitest), `pnpm run typecheck` (`tsc --noEmit`), `pnpm run lint` (`biome check .`).
- **Commit style:** terse, present-tense, `type(scope): summary`.

---

### Task 1: `swarm/src/connectors.ts` — registry types + Atlassian/GitHub/DataDog/Snyk vendor definitions

**Files:**
- Create: `swarm/src/connectors.ts`
- Create: `swarm/src/verify-datadog.ts`
- Create: `swarm/src/verify-snyk.ts`
- Test: `swarm/src/verify-datadog.test.ts`, `swarm/src/verify-snyk.test.ts`, `swarm/src/connectors.test.ts`

**Interfaces:**
- Produces: `ConnectorFieldDef`, `ConnectorVendorDef`, `VENDORS: ConnectorVendorDef[]`, `findVendor(id: string): ConnectorVendorDef | undefined` — consumed by Task 3 (`users.ts`'s migration doesn't need these, but Task 5's server routes and Task 6's dispatcher do), Task 5 (server.ts routes), and indirectly by every control-plane task via the `GET /connectors/vendors` route Task 5 builds from `VENDORS`.
- Consumes: `verifyAtlassian` (existing, `verify-atlassian.ts`), `verifyGithubToken` (existing, `verify-github.ts`), `verifyDatadog`/`verifySnyk` (new, this task).

Atlassian's verify has a real constraint discovered during design: Atlassian API tokens (`email`+`apiToken`) have **no site-independent validity check** — `api.atlassian.com/me` is OAuth-bearer-only and rejects Basic auth; there is no fixed global hostname the way GitHub's `api.github.com/user` works. So Atlassian's registry entry declares an extra **transient, never-persisted** `verifyExtraFields` array (`testSiteUrl`) — collected only at verify-time (add or re-check), passed to `verify()` as a second `extra` argument, never written to the saved `ConnectorInstance.fields`.

- [ ] **Step 1: Write `verify-datadog.ts`**

```ts
// swarm/src/verify-datadog.ts
// Live check for a DataDog API key + Application key pair. /api/v2/validate_keys
// is the only DataDog endpoint that validates both together (the app key has no
// standalone validation endpoint) — see docs.datadoghq.com/api/latest/key-management/.
export interface VerifyResult {
  ok: boolean;
  detail: string;
}

const SITE_HOSTS: Record<string, string> = {
  us1: 'api.datadoghq.com',
  us3: 'api.us3.datadoghq.com',
  us5: 'api.us5.datadoghq.com',
  eu1: 'api.datadoghq.eu',
  ap1: 'api.ap1.datadoghq.com',
  ap2: 'api.ap2.datadoghq.com',
  uk1: 'api.uk1.datadoghq.com',
  us1fed: 'api.ddog-gov.com',
  us2fed: 'api.us2.ddog-gov.com',
};

export async function verifyDatadog(
  site: string,
  apiKey: string,
  appKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  const host = SITE_HOSTS[site] ?? SITE_HOSTS.us1;
  try {
    const res = await fetchImpl(`https://${host}/api/v2/validate_keys`, {
      headers: { 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey },
    });
    const body = (await res.json().catch(() => ({}))) as { status?: string; errors?: string[] };
    if (!res.ok) return { ok: false, detail: `DataDog ${res.status}: ${body.errors?.join(', ') ?? 'unauthorized'}` };
    return { ok: true, detail: 'DataDog: API key + app key authenticated' };
  } catch (err) {
    return { ok: false, detail: `Could not reach DataDog: ${err instanceof Error ? err.message : String(err)}` };
  }
}
```

- [ ] **Step 2: Test `verify-datadog.ts`** — inject a fake `fetchImpl`, cover: success (`{status:'ok'}`, 200), failure (401 with `{errors:[...]}`), unknown site falls back to `us1`'s host, network throw is caught and returned as `{ok:false}` not rejected.

```ts
// swarm/src/verify-datadog.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyDatadog } from './verify-datadog.js';

test('verifyDatadog: success hits the site-correct host with both key headers', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers as Record<string, string> });
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
  }) as typeof fetch;
  const result = await verifyDatadog('eu1', 'key', 'app', fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(calls[0]!.url, 'https://api.datadoghq.eu/api/v2/validate_keys');
  assert.equal(calls[0]!.headers['DD-API-KEY'], 'key');
  assert.equal(calls[0]!.headers['DD-APPLICATION-KEY'], 'app');
});

test('verifyDatadog: 401 surfaces DataDog\'s error detail', async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ errors: ['Unauthorized'] }), { status: 401 })) as typeof fetch;
  const result = await verifyDatadog('us1', 'bad', 'bad', fetchImpl);
  assert.equal(result.ok, false);
  assert.match(result.detail, /401.*Unauthorized/);
});

test('verifyDatadog: unknown site falls back to us1\'s host', async () => {
  let calledUrl = '';
  const fetchImpl = (async (url: string) => {
    calledUrl = url;
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
  }) as typeof fetch;
  await verifyDatadog('not-a-real-site', 'key', 'app', fetchImpl);
  assert.equal(calledUrl, 'https://api.datadoghq.com/api/v2/validate_keys');
});

test('verifyDatadog: a network failure resolves to {ok:false}, does not reject', async () => {
  const fetchImpl = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  const result = await verifyDatadog('us1', 'k', 'a', fetchImpl);
  assert.equal(result.ok, false);
  assert.match(result.detail, /Could not reach DataDog/);
});
```

- [ ] **Step 3: Run the DataDog tests, confirm they fail (module doesn't exist), then implement.**

Run: `cd swarm && npm test` — Expected: fails to resolve `./verify-datadog.js`. After Step 1's implementation: all 4 pass.

- [ ] **Step 4: Write `verify-snyk.ts`**

```ts
// swarm/src/verify-snyk.ts
// Live check for a Snyk API token via the REST API's /self ("who am I") route.
// version is computed as today's date per Snyk's own guidance (the docs'
// stated "recommended" version lags behind what the API actually serves) —
// auth is checked before version parsing, so a validity check doesn't
// actually depend on getting the version string exactly right, but a real
// successful call benefits from a current one. See docs.snyk.io/developer-tools/snyk-api/.
export interface VerifyResult {
  ok: boolean;
  detail: string;
}

const REGION_HOSTS: Record<string, string> = {
  'us-01': 'api.snyk.io',
  'us-02': 'api.us.snyk.io',
  'eu-01': 'api.eu.snyk.io',
  'au-01': 'api.au.snyk.io',
};

export async function verifySnyk(
  region: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  const host = REGION_HOSTS[region] ?? REGION_HOSTS['us-01'];
  const version = new Date().toISOString().slice(0, 10);
  try {
    const res = await fetchImpl(`https://${host}/rest/self?version=${version}`, {
      headers: { authorization: `token ${token}`, 'content-type': 'application/vnd.api+json' },
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: { type?: string };
      errors?: Array<{ details?: string }>;
    };
    if (!res.ok) return { ok: false, detail: `Snyk ${res.status}: ${body.errors?.[0]?.details ?? 'unauthorized'}` };
    return { ok: true, detail: `Snyk: authenticated as ${body.data?.type ?? 'user'}` };
  } catch (err) {
    return { ok: false, detail: `Could not reach Snyk: ${err instanceof Error ? err.message : String(err)}` };
  }
}
```

- [ ] **Step 5: Test `verify-snyk.ts`** — same shape as DataDog's: success, 401 failure, unknown region falls back to `us-01`, network throw caught.

```ts
// swarm/src/verify-snyk.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySnyk } from './verify-snyk.js';

test('verifySnyk: success hits the region-correct host with a token header and a version query param', async () => {
  let calledUrl = '';
  let calledAuth = '';
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calledUrl = url;
    calledAuth = (init?.headers as Record<string, string>).authorization;
    return new Response(JSON.stringify({ data: { type: 'user' } }), { status: 200 });
  }) as typeof fetch;
  const result = await verifySnyk('eu-01', 'tok', fetchImpl);
  assert.equal(result.ok, true);
  assert.match(calledUrl, /^https:\/\/api\.eu\.snyk\.io\/rest\/self\?version=\d{4}-\d{2}-\d{2}$/);
  assert.equal(calledAuth, 'token tok');
});

test('verifySnyk: 401 surfaces Snyk\'s error detail', async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ errors: [{ details: 'Unauthorized' }] }), { status: 401 })) as typeof fetch;
  const result = await verifySnyk('us-01', 'bad', fetchImpl);
  assert.equal(result.ok, false);
  assert.match(result.detail, /401.*Unauthorized/);
});

test('verifySnyk: unknown region falls back to us-01\'s host', async () => {
  let calledUrl = '';
  const fetchImpl = (async (url: string) => {
    calledUrl = url;
    return new Response(JSON.stringify({ data: { type: 'user' } }), { status: 200 });
  }) as typeof fetch;
  await verifySnyk('not-a-real-region', 'tok', fetchImpl);
  assert.match(calledUrl, /^https:\/\/api\.snyk\.io/);
});

test('verifySnyk: a network failure resolves to {ok:false}, does not reject', async () => {
  const fetchImpl = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  const result = await verifySnyk('us-01', 't', fetchImpl);
  assert.equal(result.ok, false);
  assert.match(result.detail, /Could not reach Snyk/);
});
```

- [ ] **Step 6: Run the Snyk tests, confirm they fail, then implement.** Same run/expect shape as Step 3.

- [ ] **Step 7: Write `connectors.ts`** — the registry itself.

```ts
// swarm/src/connectors.ts
// The vendor registry: one shape drives storage (users.ts), the CRUD+verify
// API (server.ts), and the control-plane's card grid + connect form. Adding
// a vendor later is adding an entry here — not new routes/fields/redaction
// logic (design §"Settled decisions").
import { verifyAtlassian } from './verify-atlassian.js';
import { verifyGithubToken } from './verify-github.js';
import { verifyDatadog } from './verify-datadog.js';
import { verifySnyk } from './verify-snyk.js';

export interface ConnectorFieldDef {
  key: string;
  label: string;
  /** true -> password input; redacted as `has<Key>: boolean` in every API response. */
  secret: boolean;
  type?: 'text' | 'select';
  /** Required when type is 'select'. */
  options?: { value: string; label: string }[];
}

export interface ConnectorVendorDef {
  id: string;
  label: string;
  description: string;
  /** Persisted on the saved ConnectorInstance. */
  fields: ConnectorFieldDef[];
  /**
   * Transient, verify-time-only input — collected on the connect form and on
   * "Re-check", but NEVER written to the saved instance's `fields`. Exists
   * because some vendors (Atlassian) have no way to validate a credential
   * without also knowing something that isn't part of the credential itself
   * (which Jira/Confluence site to test against).
   */
  verifyExtraFields?: ConnectorFieldDef[];
  verify(
    fields: Record<string, string>,
    extra: Record<string, string>,
    fetchImpl?: typeof fetch,
  ): Promise<{ ok: boolean; detail: string }>;
}

const ATLASSIAN: ConnectorVendorDef = {
  id: 'atlassian',
  label: 'Atlassian',
  description: 'Jira issues and Confluence docs — lookup and search from a workspace.',
  fields: [
    { key: 'email', label: 'Atlassian account email', secret: false },
    { key: 'apiToken', label: 'API token', secret: true },
  ],
  // Atlassian API tokens have no site-independent validity check (researched
  // during design — api.atlassian.com/me is OAuth-bearer-only, rejects Basic
  // auth; no fixed global hostname exists the way GitHub's api.github.com
  // does). A site is required to test the credential at all, but the site
  // itself is workspace-owned, not part of this credential — so it's
  // collected here only transiently, for the test call, never saved.
  verifyExtraFields: [
    { key: 'testSiteUrl', label: 'Site URL (used only to test this connection — not saved)', secret: false },
  ],
  verify: (fields, extra, fetchImpl) =>
    verifyAtlassian(extra.testSiteUrl ?? '', fields.email ?? '', fields.apiToken ?? '', undefined, fetchImpl),
};

const GITHUB: ConnectorVendorDef = {
  id: 'github',
  label: 'GitHub',
  description: 'Repo access and pull requests.',
  fields: [{ key: 'token', label: 'Personal access token', secret: true }],
  verify: (fields, _extra, fetchImpl) => verifyGithubToken(fields.token ?? '', fetchImpl),
};

const DATADOG: ConnectorVendorDef = {
  id: 'datadog',
  label: 'Datadog',
  description: 'Monitors, dashboards, and observability data.',
  fields: [
    {
      key: 'site',
      label: 'Site',
      secret: false,
      type: 'select',
      options: [
        { value: 'us1', label: 'US1 (default)' },
        { value: 'us3', label: 'US3' },
        { value: 'us5', label: 'US5' },
        { value: 'eu1', label: 'EU1' },
        { value: 'ap1', label: 'AP1 (Japan)' },
        { value: 'ap2', label: 'AP2 (Australia)' },
        { value: 'uk1', label: 'UK1' },
        { value: 'us1fed', label: 'US1-FED' },
        { value: 'us2fed', label: 'US2-FED' },
      ],
    },
    { key: 'apiKey', label: 'API key', secret: true },
    { key: 'appKey', label: 'Application key', secret: true },
  ],
  verify: (fields, _extra, fetchImpl) =>
    verifyDatadog(fields.site || 'us1', fields.apiKey ?? '', fields.appKey ?? '', fetchImpl),
};

const SNYK: ConnectorVendorDef = {
  id: 'snyk',
  label: 'Snyk',
  description: 'Vulnerability and dependency data.',
  fields: [
    {
      key: 'region',
      label: 'Region',
      secret: false,
      type: 'select',
      options: [
        { value: 'us-01', label: 'US-01 (default)' },
        { value: 'us-02', label: 'US-02' },
        { value: 'eu-01', label: 'EU-01' },
        { value: 'au-01', label: 'AU-01' },
      ],
    },
    { key: 'token', label: 'API token', secret: true },
  ],
  verify: (fields, _extra, fetchImpl) => verifySnyk(fields.region || 'us-01', fields.token ?? '', fetchImpl),
};

export const VENDORS: ConnectorVendorDef[] = [ATLASSIAN, GITHUB, DATADOG, SNYK];

export function findVendor(id: string): ConnectorVendorDef | undefined {
  return VENDORS.find((v) => v.id === id);
}
```

- [ ] **Step 8: Test `connectors.ts`** — cover: `findVendor` finds each of the 4 by id and returns `undefined` for an unknown id; each vendor's `fields` array has the exact keys documented above (a cheap regression guard against a typo silently breaking the UI's field rendering); Atlassian is the only vendor with `verifyExtraFields` set.

```ts
// swarm/src/connectors.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VENDORS, findVendor } from './connectors.js';

test('findVendor: resolves each of the 4 shipped vendors by id', () => {
  for (const id of ['atlassian', 'github', 'datadog', 'snyk']) {
    assert.ok(findVendor(id), `expected a vendor def for "${id}"`);
  }
});

test('findVendor: unknown id resolves to undefined', () => {
  assert.equal(findVendor('not-a-vendor'), undefined);
});

test('field keys match the documented shape for each vendor', () => {
  assert.deepEqual(
    findVendor('atlassian')!.fields.map((f) => f.key),
    ['email', 'apiToken'],
  );
  assert.deepEqual(findVendor('github')!.fields.map((f) => f.key), ['token']);
  assert.deepEqual(findVendor('datadog')!.fields.map((f) => f.key), ['site', 'apiKey', 'appKey']);
  assert.deepEqual(findVendor('snyk')!.fields.map((f) => f.key), ['region', 'token']);
});

test('only Atlassian declares verifyExtraFields', () => {
  assert.deepEqual(
    findVendor('atlassian')!.verifyExtraFields?.map((f) => f.key),
    ['testSiteUrl'],
  );
  for (const id of ['github', 'datadog', 'snyk']) {
    assert.equal(findVendor(id)!.verifyExtraFields, undefined);
  }
});

test('VENDORS has exactly the 4 shipped vendors, no duplicates', () => {
  assert.equal(VENDORS.length, 4);
  assert.equal(new Set(VENDORS.map((v) => v.id)).size, 4);
});
```

- [ ] **Step 9: Run all of this task's tests, typecheck, commit.**

```bash
cd swarm && npm test
npx tsc --noEmit
git add src/connectors.ts src/connectors.test.ts src/verify-datadog.ts src/verify-datadog.test.ts src/verify-snyk.ts src/verify-snyk.test.ts
git commit -m "feat(swarm): connector registry — vendor defs for Atlassian, GitHub, Datadog, Snyk"
```

---

### Task 2: `swarm/src/users.ts` — `ConnectorInstance[]` storage, lazy migration off `atlassian?`/`github?`

**Files:**
- Modify: `swarm/src/users.ts`
- Test: `swarm/src/users.test.ts` (create if it doesn't exist — check first)

**Interfaces:**
- Consumes: nothing new from Task 1 (this task doesn't need the registry — migration only needs to know the two legacy field *shapes*, not vendor definitions).
- Produces: `ConnectorInstance { id, vendorId, label, fields }`, `User { id, name, default?, connectors?: ConnectorInstance[] }` (the `atlassian?`/`github?` fields are REMOVED from the public `User` type) — consumed by every later task in this plan.

**Current exact content** (65 lines, unchanged since the connectors feature):

```ts
// swarm/src/users.ts — current, before this task
import { readdir, readFile, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

export interface User {
  id: string;
  name: string;
  default?: boolean;
  atlassian?: { email: string; apiToken: string };
  github?: { token: string };
}

function assertUser(file: string, v: unknown): User {
  const o = v as Partial<User>;
  const ok = o && typeof o.id === 'string' && typeof o.name === 'string';
  if (!ok) {
    throw new Error(`Invalid user file ${file}: requires id and name`);
  }
  return o as User;
}

export async function loadUsersFromDir(dir: string): Promise<User[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const users: User[] = [];
  for (const file of entries.filter((f) => f.endsWith('.json'))) {
    const raw = await readFile(join(dir, file), 'utf8');
    users.push(assertUser(file, JSON.parse(raw)));
  }
  return users;
}

export async function saveUser(dir: string, user: User): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(user.id)) {
    throw new Error(`Invalid user id "${user.id}": use lowercase letters, digits and dashes`);
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = join(dir, `${user.id}.json`);
  const fh = await open(filePath, 'w', 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(user, null, 2)}\n`);
  } finally {
    await fh.close();
  }
}

export function resolveCurrentUser(users: User[]): User | null {
  return users.find((u) => u.default) ?? users[0] ?? null;
}
```

`saveUser`'s permission calls (`mkdir(dir, {recursive:true, mode:0o700})`, `open(filePath,'w',0o600)`) are unchanged by this task — leave them exactly as they are, just serializing a differently-shaped `User`.

- [ ] **Step 1: Write the failing tests** — cover the migration specifically, since that's this task's real risk (get it wrong and Edwin's own already-saved Atlassian/GitHub tokens silently vanish).

```ts
// swarm/src/users.test.ts (new, or add to it if it exists — check first)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadUsersFromDir, saveUser, resolveCurrentUser } from './users.js';

test('loadUsersFromDir: a legacy user file (atlassian + github fields, no connectors) is upgraded on load into two ConnectorInstance entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'users-legacy-'));
  await writeFile(
    join(dir, 'me.json'),
    JSON.stringify({
      id: 'me',
      name: 'Edwin',
      default: true,
      atlassian: { email: 'edwin@example.com', apiToken: 'atl-tok' },
      github: { token: 'gh-tok' },
    }),
  );
  const [user] = await loadUsersFromDir(dir);
  assert.equal(user!.connectors?.length, 2);
  const atlassian = user!.connectors!.find((c) => c.vendorId === 'atlassian');
  const github = user!.connectors!.find((c) => c.vendorId === 'github');
  assert.equal(atlassian?.label, 'default');
  assert.equal(atlassian?.fields.email, 'edwin@example.com');
  assert.equal(atlassian?.fields.apiToken, 'atl-tok');
  assert.equal(github?.label, 'default');
  assert.equal(github?.fields.token, 'gh-tok');
  assert.ok(atlassian?.id && github?.id && atlassian.id !== github.id, 'each gets its own generated id');
  // biome-ignore-next: the legacy fields must not survive onto the in-memory User
  assert.equal((user as unknown as { atlassian?: unknown }).atlassian, undefined);
});

test('loadUsersFromDir: a legacy user with only atlassian (no github) upgrades to exactly one connector', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'users-legacy-partial-'));
  await writeFile(
    join(dir, 'me.json'),
    JSON.stringify({ id: 'me', name: 'Edwin', atlassian: { email: 'e@x.com', apiToken: 'tok' } }),
  );
  const [user] = await loadUsersFromDir(dir);
  assert.equal(user!.connectors?.length, 1);
  assert.equal(user!.connectors![0]!.vendorId, 'atlassian');
});

test('loadUsersFromDir: a user with no legacy fields and no connectors loads with connectors undefined, no crash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'users-blank-'));
  await writeFile(join(dir, 'me.json'), JSON.stringify({ id: 'me', name: 'Edwin' }));
  const [user] = await loadUsersFromDir(dir);
  assert.equal(user!.connectors, undefined);
});

test('loadUsersFromDir: an already-migrated user (has connectors) is passed through untouched, even if stray legacy keys are also present', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'users-already-'));
  await writeFile(
    join(dir, 'me.json'),
    JSON.stringify({
      id: 'me',
      name: 'Edwin',
      connectors: [{ id: 'c1', vendorId: 'github', label: 'personal', fields: { token: 'tok' } }],
      github: { token: 'stray-legacy-value' }, // must be ignored, not merged in again
    }),
  );
  const [user] = await loadUsersFromDir(dir);
  assert.equal(user!.connectors?.length, 1);
  assert.equal(user!.connectors![0]!.fields.token, 'tok');
});

test('round-trip: saving a migrated user and reloading it produces the identical connectors array (no re-migration, no drift)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'users-roundtrip-'));
  const instance = { id: 'abc-123', vendorId: 'github', label: 'acme-corp', fields: { token: 'gh-tok' } };
  await saveUser(dir, { id: 'me', name: 'Edwin', default: true, connectors: [instance] });
  const [reloaded] = await loadUsersFromDir(dir);
  assert.deepEqual(reloaded!.connectors, [instance]);
});

test('saveUser: still writes with owner-only permissions (0o700 dir, 0o600 file) — unchanged by this task', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'users-perms-'));
  await saveUser(dir, { id: 'me', name: 'Edwin', connectors: [] });
  const { stat } = await import('node:fs/promises');
  const fileStat = await stat(join(dir, 'me.json'));
  assert.equal(fileStat.mode & 0o777, 0o600);
});

test('resolveCurrentUser: unchanged behavior — default-flagged user, else sole file, else null', () => {
  const a = { id: 'a', name: 'A', connectors: [] };
  const b = { id: 'b', name: 'B', default: true, connectors: [] };
  assert.equal(resolveCurrentUser([a, b]), b);
  assert.equal(resolveCurrentUser([a]), a);
  assert.equal(resolveCurrentUser([]), null);
});
```

- [ ] **Step 2: Run the tests, confirm they fail** (the migration logic doesn't exist yet — `connectors` will be `undefined` even for legacy input, or the module will throw on the stray `atlassian`/`github` keys once the type is narrowed).

Run: `cd swarm && npm test` — Expected: FAIL on the migration-specific assertions.

- [ ] **Step 3: Implement the migration**

```ts
// swarm/src/users.ts — full replacement
import { readdir, readFile, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ConnectorInstance {
  id: string;
  vendorId: string;
  /** User-chosen: "personal", "acme-corp" — how workspaces reference which one to use. */
  label: string;
  /** Raw values, including secrets — this file is already untracked + 0600. */
  fields: Record<string, string>;
}

export interface User {
  id: string;
  name: string;
  /** Mirrors Workspace's default-invariant pattern; single default user today. */
  default?: boolean;
  connectors?: ConnectorInstance[];
}

/** On-disk shape before migration — legacy files may still have these instead of `connectors`. */
interface LegacyUserFields {
  atlassian?: { email: string; apiToken: string };
  github?: { token: string };
}

/**
 * Lazy migration, no one-time script: a legacy `{atlassian, github}` file is
 * upgraded in memory to `connectors` the moment it's loaded. The file itself
 * is only rewritten in the new shape the next time anything about that user
 * is saved — existing tokens survive untouched, no re-entry required (design
 * §1). An already-migrated user (has `connectors`) is returned as-is, with
 * any stray legacy keys stripped defensively rather than re-merged.
 */
function upgradeLegacyConnectors(raw: User & LegacyUserFields): User {
  const { atlassian, github, ...rest } = raw;
  if (rest.connectors) return rest;
  const connectors: ConnectorInstance[] = [];
  if (atlassian) {
    connectors.push({ id: randomUUID(), vendorId: 'atlassian', label: 'default', fields: { ...atlassian } });
  }
  if (github) {
    connectors.push({ id: randomUUID(), vendorId: 'github', label: 'default', fields: { ...github } });
  }
  return connectors.length ? { ...rest, connectors } : rest;
}

function assertUser(file: string, v: unknown): User {
  const o = v as Partial<User> & LegacyUserFields;
  const ok = o && typeof o.id === 'string' && typeof o.name === 'string';
  if (!ok) {
    throw new Error(`Invalid user file ${file}: requires id and name`);
  }
  return upgradeLegacyConnectors(o as User & LegacyUserFields);
}

/** Load every *.json in `dir` as a User. Throws (naming the file) on malformed input. */
export async function loadUsersFromDir(dir: string): Promise<User[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const users: User[] = [];
  for (const file of entries.filter((f) => f.endsWith('.json'))) {
    const raw = await readFile(join(dir, file), 'utf8');
    users.push(assertUser(file, JSON.parse(raw)));
  }
  return users;
}

/** Write one user to `dir`. Mirror of workspaces.saveWorkspace. Writes credentials with owner-only permissions (0o600). */
export async function saveUser(dir: string, user: User): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(user.id)) {
    throw new Error(`Invalid user id "${user.id}": use lowercase letters, digits and dashes`);
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = join(dir, `${user.id}.json`);
  const fh = await open(filePath, 'w', 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(user, null, 2)}\n`);
  } finally {
    await fh.close();
  }
}

/**
 * "Current user" — trivially resolved today (single-operator, no auth in
 * all-local mode). Same fallback shape as Workspace's default resolution:
 * the `default`-flagged user, else the sole file present, else null.
 * This is the one seam a real auth system replaces later.
 */
export function resolveCurrentUser(users: User[]): User | null {
  return users.find((u) => u.default) ?? users[0] ?? null;
}
```

- [ ] **Step 4: Run the tests again, confirm they pass.**

Run: `cd swarm && npm test` — Expected: PASS, all 7 new tests plus every pre-existing test in this file.

- [ ] **Step 5: Typecheck, commit.**

```bash
cd swarm && npx tsc --noEmit
git add src/users.ts src/users.test.ts
git commit -m "feat(swarm): User.connectors[] replaces atlassian/github fields, lazy-migrates legacy files"
```

---

### Task 3: `swarm/src/workspaces.ts` — `connectorId` on `Workspace.atlassian` and `WorkspaceRepo.github`

**Files:**
- Modify: `swarm/src/workspaces.ts`
- Test: `swarm/src/workspaces.test.ts` (extend existing tests, don't restructure them)

**Interfaces:**
- Produces: `Workspace.atlassian?.connectorId?: string`, `WorkspaceRepo.github?.connectorId?: string` — consumed by Task 5 (server.ts's workspace-scoped verify routes), Task 6 (dispatcher.ts's `resolveConnections`), and Task 14 (`WorkspaceManagerModal`'s connector-picker dropdowns).

**Current exact content** (top of file, unchanged):

```ts
export interface WorkspaceRepo {
  name: string;
  path: string;
  repository?: string;
  branch?: string;
  github?: { owner: string; repo: string };
}

export interface Workspace {
  name: string;
  description?: string;
  repos: WorkspaceRepo[];
  default?: boolean;
  archived?: boolean;
  atlassian?: {
    siteUrl: string;
    jiraProjectKeys?: string[];
    confluenceSpaceKeys?: string[];
  };
}
```

- [ ] **Step 1: Write the failing test** — this is a small, additive, optional-field change; the test just confirms the field round-trips through `saveWorkspace`/`loadWorkspacesFromDir` and that `workspaceProblems` doesn't reject a `connectorId` it doesn't recognize (it's swarm-side-only validation; connector existence is checked at the point of use, not at workspace-save time — an unset or stale `connectorId` is explicitly allowed per this plan's soft-fail invariant).

```ts
// swarm/src/workspaces.test.ts — add these, alongside the existing tests
test('a workspace atlassian block with connectorId round-trips through save/load unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workspaces-connectorid-'));
  const repoDir = join(dir, 'repo');
  await mkdir(repoDir, { recursive: true });
  await execFileAsync('git', ['init', '-q'], { cwd: repoDir });
  const ws: Workspace = {
    name: 'acme',
    repos: [{ name: 'web', path: repoDir }],
    atlassian: { siteUrl: 'https://acme.atlassian.net', connectorId: 'conn-1' },
  };
  await saveWorkspace(dir, ws);
  const [reloaded] = await loadWorkspacesFromDir(dir);
  assert.equal(reloaded!.atlassian?.connectorId, 'conn-1');
});

test('a repo github block with connectorId round-trips through save/load unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workspaces-repo-connectorid-'));
  const repoDir = join(dir, 'repo');
  await mkdir(repoDir, { recursive: true });
  await execFileAsync('git', ['init', '-q'], { cwd: repoDir });
  const ws: Workspace = {
    name: 'acme',
    repos: [{ name: 'web', path: repoDir, github: { owner: 'acme', repo: 'web', connectorId: 'conn-2' } }],
  };
  await saveWorkspace(dir, ws);
  const [reloaded] = await loadWorkspacesFromDir(dir);
  assert.equal(reloaded!.repos[0]!.github?.connectorId, 'conn-2');
});

test('workspaceProblems does not require or validate connectorId — an unset one is fine', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workspaces-noconnid-'));
  const repoDir = join(dir, 'repo');
  await mkdir(repoDir, { recursive: true });
  await execFileAsync('git', ['init', '-q'], { cwd: repoDir });
  const problem = await workspaceProblems({
    name: 'acme',
    repos: [{ name: 'web', path: repoDir, github: { owner: 'acme', repo: 'web' } }],
  });
  assert.equal(problem, null);
});
```

(These reuse whatever `mkdtemp`/`execFileAsync`/`mkdir`/`join`/`tmpdir` imports and `promisify(execFile)` setup the existing `workspaces.test.ts` already has at its top — match that file's actual current import block rather than re-declaring a second copy.)

- [ ] **Step 2: Run, confirm failure** (TypeScript will reject `connectorId` as an unknown property before the test even runs — a compile-time failure, which is the expected "RED" state for a type-level change).

- [ ] **Step 3: Implement**

```ts
// swarm/src/workspaces.ts — only the two interfaces change
export interface WorkspaceRepo {
  name: string;
  path: string;
  repository?: string;
  branch?: string;
  /** GitHub API pointer — separate from `repository` (informational remote URL). connectorId is optional: unset means "no GitHub tool access resolved for this repo" (soft-fail, not a required field). */
  github?: { owner: string; repo: string; connectorId?: string };
}

export interface Workspace {
  name: string;
  description?: string;
  repos: WorkspaceRepo[];
  default?: boolean;
  archived?: boolean;
  /** Non-secret Jira/Confluence pointer. Credentials live on User.connectors, never here. connectorId is optional: unset means "no Atlassian tool access resolved for this workspace" (soft-fail). */
  atlassian?: {
    siteUrl: string;
    jiraProjectKeys?: string[];
    confluenceSpaceKeys?: string[];
    connectorId?: string;
  };
}
```

No change needed to `assertWorkspace`, `workspaceProblems`, `normalizeRepoBranch`, or `saveWorkspace` — `connectorId` is a plain optional string field, already covered by the existing structural typing and the fact that `workspaceProblems` never inspects it.

- [ ] **Step 4: Run tests again, confirm pass. Typecheck. Commit.**

```bash
cd swarm && npm test
npx tsc --noEmit
git add src/workspaces.ts src/workspaces.test.ts
git commit -m "feat(swarm): optional connectorId on Workspace.atlassian and WorkspaceRepo.github"
```

---

### Task 4: `swarm/src/server.ts` — connector CRUD+verify routes, `redactConnector`/`buildConnectorUpdate`, simplified `/me`, workspace-scoped verify routes resolve via `connectorId`

**Files:**
- Modify: `swarm/src/server.ts`
- Test: `swarm/src/server.test.ts` (extend — do not restructure existing tests)

**Interfaces:**
- Consumes: `VENDORS`, `findVendor` (Task 1), `ConnectorInstance`, `User`, `loadUsersFromDir`, `saveUser`, `resolveCurrentUser` (Task 2), `Workspace.atlassian.connectorId` / `WorkspaceRepo.github.connectorId` (Task 3).
- Produces: `redactConnector(instance): Record<string, unknown>`, `buildConnectorUpdate(existing, body): ConnectorInstance` — both module-level exported, unit-testable without booting the server, matching `buildUserUpdate`/`workspaceProblems`'s existing convention. Consumed by Task 7 (broker's `swarm-client.ts` mirrors these response shapes) and indirectly by every control-plane task.

This is the largest single change in the plan. Work through it in the four steps below, not all at once.

- [ ] **Step 1: Replace `redactUser` and simplify `PUT /me` to name-only**

Current (`server.ts:1319-1344`, exact):

```ts
const redactUser = (u: User | null) => ({
  id: u?.id ?? 'me',
  name: u?.name ?? 'You',
  hasAtlassianToken: Boolean(u?.atlassian?.apiToken),
  hasGithubToken: Boolean(u?.github?.token),
  atlassianEmail: u?.atlassian?.email,
});

this.app.get('/me', async () => {
  const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
  return redactUser(resolveCurrentUser(users));
});

this.app.put('/me', async (req, reply) => {
  const b = req.body as Partial<User>;
  const dir = resolve(process.cwd(), '.smith/users');
  const users = await loadUsersFromDir(dir);
  const existing = resolveCurrentUser(users);
  const merged = buildUserUpdate(existing, b);
  try {
    await saveUser(dir, merged);
  } catch (err) {
    return reply.status(400).send({ error: String((err as Error).message) });
  }
  return redactUser(merged);
});
```

Replace with (same three pieces, `connectors` now carries what `hasAtlassianToken`/`hasGithubToken`/`atlassianEmail` used to, and `PUT /me` only ever touches `name` — connector CRUD moves to its own routes in Step 2):

```ts
function redactConnector(instance: ConnectorInstance): Record<string, unknown> {
  const vendor = findVendor(instance.vendorId);
  const fields: Record<string, string | boolean> = {};
  for (const f of vendor?.fields ?? []) {
    const v = instance.fields[f.key];
    if (f.secret) fields[`has${f.key[0]!.toUpperCase()}${f.key.slice(1)}`] = Boolean(v);
    else fields[f.key] = v ?? '';
  }
  return { id: instance.id, vendorId: instance.vendorId, label: instance.label, fields };
}

const redactUser = (u: User | null) => ({
  id: u?.id ?? 'me',
  name: u?.name ?? 'You',
  connectors: (u?.connectors ?? []).map(redactConnector),
});

this.app.get('/me', async () => {
  const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
  return redactUser(resolveCurrentUser(users));
});

this.app.put('/me', async (req, reply) => {
  const b = req.body as { name?: string };
  const dir = resolve(process.cwd(), '.smith/users');
  const users = await loadUsersFromDir(dir);
  const existing = resolveCurrentUser(users);
  const merged: User = {
    id: existing?.id ?? 'me',
    name: b.name?.trim() || existing?.name || 'You',
    default: true,
    connectors: existing?.connectors,
  };
  try {
    await saveUser(dir, merged);
  } catch (err) {
    return reply.status(400).send({ error: String((err as Error).message) });
  }
  return redactUser(merged);
});
```

Delete `buildUserUpdate` (`server.ts:1915-1928`) entirely — its atlassian/github merge logic no longer applies to anything (`PUT /me` is now name-only, no merge needed beyond the trim-or-fallback already inlined above). Delete its test(s) in `server.test.ts` at the same time (Step 4 below covers what replaces them).

Delete `/me/verify-github` (`server.ts:1346-1351`) — superseded by the generic `POST /me/connectors/:id/verify` (Step 2).

- [ ] **Step 2: Add the connector CRUD + verify routes**

```ts
// swarm/src/server.ts — new routes, alongside the /me routes above
this.app.get('/connectors/vendors', async () => {
  return VENDORS.map((v) => ({
    id: v.id,
    label: v.label,
    description: v.description,
    fields: v.fields,
    verifyExtraFields: v.verifyExtraFields ?? [],
  }));
});

this.app.get('/me/connectors', async () => {
  const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
  const user = resolveCurrentUser(users);
  return (user?.connectors ?? []).map(redactConnector);
});

this.app.post('/me/connectors', async (req, reply) => {
  const b = req.body as { vendorId?: string; label?: string; fields?: Record<string, string> };
  if (!b.vendorId || !findVendor(b.vendorId)) return reply.status(400).send({ error: `Unknown vendor: ${b.vendorId}` });
  if (!b.label?.trim()) return reply.status(400).send({ error: 'A label is required' });
  const dir = resolve(process.cwd(), '.smith/users');
  const users = await loadUsersFromDir(dir);
  const existing = resolveCurrentUser(users) ?? { id: 'me', name: 'You', default: true, connectors: [] };
  const instance: ConnectorInstance = {
    id: randomUUID(),
    vendorId: b.vendorId,
    label: b.label.trim(),
    fields: b.fields ?? {},
  };
  const merged: User = { ...existing, connectors: [...(existing.connectors ?? []), instance] };
  await saveUser(dir, merged);
  return reply.status(201).send(redactConnector(instance));
});

this.app.put<{ Params: { id: string } }>('/me/connectors/:id', async (req, reply) => {
  const b = req.body as { label?: string; fields?: Record<string, string> };
  const dir = resolve(process.cwd(), '.smith/users');
  const users = await loadUsersFromDir(dir);
  const existing = resolveCurrentUser(users);
  const current = existing?.connectors?.find((c) => c.id === req.params.id);
  if (!current) return reply.status(404).send({ error: `Unknown connector: ${req.params.id}` });
  const updated = buildConnectorUpdate(current, b);
  const merged: User = {
    ...existing!,
    connectors: existing!.connectors!.map((c) => (c.id === current.id ? updated : c)),
  };
  await saveUser(dir, merged);
  return redactConnector(updated);
});

this.app.delete<{ Params: { id: string } }>('/me/connectors/:id', async (req, reply) => {
  const dir = resolve(process.cwd(), '.smith/users');
  const users = await loadUsersFromDir(dir);
  const existing = resolveCurrentUser(users);
  if (!existing?.connectors?.some((c) => c.id === req.params.id)) {
    return reply.status(404).send({ error: `Unknown connector: ${req.params.id}` });
  }
  const merged: User = { ...existing, connectors: existing.connectors.filter((c) => c.id !== req.params.id) };
  await saveUser(dir, merged);
  return { ok: true };
});

this.app.post<{ Params: { id: string } }>('/me/connectors/:id/verify', async (req, reply) => {
  const b = (req.body as { extra?: Record<string, string> } | undefined) ?? {};
  const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
  const user = resolveCurrentUser(users);
  const instance = user?.connectors?.find((c) => c.id === req.params.id);
  if (!instance) return reply.status(404).send({ error: `Unknown connector: ${req.params.id}` });
  const vendor = findVendor(instance.vendorId);
  if (!vendor) return reply.status(400).send({ error: `Unknown vendor: ${instance.vendorId}` });
  return vendor.verify(instance.fields, b.extra ?? {});
});
```

Add `import { randomUUID } from 'node:crypto';` and `import { VENDORS, findVendor } from './connectors.js';` and `import type { ConnectorInstance } from './users.js';` to `server.ts`'s import block (near the existing `users.js`/`verify-atlassian.js`/`verify-github.js` imports at lines 69-71).

- [ ] **Step 3: Add `buildConnectorUpdate` (module-level, exported, testable) and update the two workspace-scoped verify routes to resolve via `connectorId`**

```ts
// swarm/src/server.ts — module-level, near buildUserUpdate's old location (now deleted) /
// workspaceProblems, at the file's tail alongside the other testable helpers
/**
 * PUT /me/connectors/:id merge: every field (secret or not) trims a
 * submitted value and falls back to the existing stored value on blank —
 * applied uniformly, unlike the old buildUserUpdate, which only did this for
 * Atlassian's two fields and used a plain `??` (no trim, no fallback-on-
 * blank-string) for GitHub's single field. `vendorId` is immutable — never
 * read from `b`, even if a caller sends one.
 */
export function buildConnectorUpdate(
  existing: ConnectorInstance,
  b: { label?: string; fields?: Record<string, string> },
): ConnectorInstance {
  const vendor = findVendor(existing.vendorId);
  const fields = { ...existing.fields };
  if (b.fields) {
    for (const f of vendor?.fields ?? []) {
      const submitted = (b.fields[f.key] ?? '').trim();
      fields[f.key] = submitted || existing.fields[f.key] || '';
    }
  }
  return { id: existing.id, vendorId: existing.vendorId, label: b.label?.trim() || existing.label, fields };
}
```

Update `/workspaces/:name/verify-atlassian` (current, `server.ts:1353-1363`):

```ts
// before
this.app.post<{ Params: { name: string } }>('/workspaces/:name/verify-atlassian', async (req, reply) => {
  const ws = server.workspaces.find((w) => w.name === req.params.name);
  if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
  if (!ws.atlassian) return reply.status(400).send({ error: `Workspace "${ws.name}" has no Jira/Confluence site configured` });
  const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
  const user = resolveCurrentUser(users);
  if (!user?.atlassian) return reply.status(400).send({ error: 'You have not added your Atlassian credential in account settings' });
  return verifyAtlassian(ws.atlassian.siteUrl, user.atlassian.email, user.atlassian.apiToken, {
    confluenceSpaceKey: ws.atlassian.confluenceSpaceKeys?.[0],
  });
});
```

```ts
// after
this.app.post<{ Params: { name: string } }>('/workspaces/:name/verify-atlassian', async (req, reply) => {
  const ws = server.workspaces.find((w) => w.name === req.params.name);
  if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
  if (!ws.atlassian) return reply.status(400).send({ error: `Workspace "${ws.name}" has no Jira/Confluence site configured` });
  if (!ws.atlassian.connectorId) return reply.status(400).send({ error: 'Pick an Atlassian connector for this workspace first' });
  const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
  const user = resolveCurrentUser(users);
  const instance = user?.connectors?.find((c) => c.id === ws.atlassian!.connectorId && c.vendorId === 'atlassian');
  if (!instance) return reply.status(400).send({ error: 'The connector picked for this workspace no longer exists — pick another' });
  return verifyAtlassian(ws.atlassian.siteUrl, instance.fields.email ?? '', instance.fields.apiToken ?? '', {
    confluenceSpaceKey: ws.atlassian.confluenceSpaceKeys?.[0],
  });
});
```

Update `/workspaces/:name/repos/:repoName/verify-github` (current, `server.ts:1417-1430`) the same way:

```ts
// after
this.app.post<{ Params: { name: string; repoName: string } }>(
  '/workspaces/:name/repos/:repoName/verify-github',
  async (req, reply) => {
    const ws = server.workspaces.find((w) => w.name === req.params.name);
    if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
    const repo = ws.repos.find((r) => r.name === req.params.repoName);
    if (!repo) return reply.status(404).send({ error: `Unknown repo: ${req.params.repoName}` });
    if (!repo.github) return reply.status(400).send({ error: `Repo "${repo.name}" has no GitHub owner/repo configured` });
    if (!repo.github.connectorId) return reply.status(400).send({ error: 'Pick a GitHub connector for this repo first' });
    const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
    const user = resolveCurrentUser(users);
    const instance = user?.connectors?.find((c) => c.id === repo.github!.connectorId && c.vendorId === 'github');
    if (!instance) return reply.status(400).send({ error: 'The connector picked for this repo no longer exists — pick another' });
    return verifyGithubRepo(repo.github.owner, repo.github.repo, instance.fields.token ?? '');
  },
);
```

- [ ] **Step 4: Write the tests**

```ts
// swarm/src/server.test.ts — add these; DELETE the old buildUserUpdate tests entirely (Step 1 removed the function)
import { buildConnectorUpdate } from './server.js';

test('redactUser: connectors carry has<Field> booleans for secret fields, real values for non-secret fields, never the secret itself', async () => {
  // Exercise this through a real saveUser + GET /me round trip using the
  // server's actual redactUser/redactConnector closures — matches this
  // file's established two-tier convention (pure-function test AND a real
  // route/storage round-trip) rather than only unit-testing in isolation.
  // (Implementer: follow whichever of this file's existing test-harness
  // patterns — booting a real Fastify instance vs. importing the redaction
  // closure directly — this file already uses for /me; match it exactly
  // rather than introducing a third pattern.)
});

test('buildConnectorUpdate: a blank submitted secret field falls back to the existing stored value', () => {
  const existing = { id: 'c1', vendorId: 'github', label: 'personal', fields: { token: 'old-tok' } };
  const merged = buildConnectorUpdate(existing, { fields: { token: '' } });
  assert.equal(merged.fields.token, 'old-tok');
});

test('buildConnectorUpdate: a non-blank submitted field overrides the existing value', () => {
  const existing = { id: 'c1', vendorId: 'github', label: 'personal', fields: { token: 'old-tok' } };
  const merged = buildConnectorUpdate(existing, { fields: { token: 'new-tok' } });
  assert.equal(merged.fields.token, 'new-tok');
});

test('buildConnectorUpdate: omitting fields entirely leaves all existing fields untouched, only label changes', () => {
  const existing = { id: 'c1', vendorId: 'datadog', label: 'old-label', fields: { site: 'us1', apiKey: 'k', appKey: 'a' } };
  const merged = buildConnectorUpdate(existing, { label: 'new-label' });
  assert.equal(merged.label, 'new-label');
  assert.deepEqual(merged.fields, { site: 'us1', apiKey: 'k', appKey: 'a' });
});

test('buildConnectorUpdate: vendorId is immutable — even if the caller sends one, it never changes', () => {
  const existing = { id: 'c1', vendorId: 'github', label: 'x', fields: { token: 't' } };
  const merged = buildConnectorUpdate(existing, { fields: {} } as { label?: string; fields?: Record<string, string> } & {
    vendorId?: string;
  });
  assert.equal(merged.vendorId, 'github');
});

test('buildConnectorUpdate: applies trim-then-fallback uniformly to a non-secret field too (site/region), not just secrets', () => {
  const existing = { id: 'c1', vendorId: 'datadog', label: 'x', fields: { site: 'us1', apiKey: 'k', appKey: 'a' } };
  const merged = buildConnectorUpdate(existing, { fields: { site: '  ', apiKey: 'k', appKey: 'a' } });
  assert.equal(merged.fields.site, 'us1'); // blank (whitespace-only) submission falls back, doesn't wipe
});

test('POST /workspaces/:name/verify-atlassian: a workspace with atlassian config but no connectorId set returns 400, not a crash', async () => {
  // Boot the server the same way this file's other workspace-route tests do
  // (match the existing harness exactly); create a workspace with
  // atlassian: { siteUrl, connectorId: undefined }; POST the verify route;
  // assert 400 and the "Pick an Atlassian connector" error text.
});

test('POST /workspaces/:name/verify-atlassian: a connectorId pointing at a deleted connector returns 400, not a crash', async () => {
  // Same harness; connectorId set to a value not present in the user's
  // connectors[]; assert 400 and the "no longer exists" error text.
});
```

(The two tests left as harness-matching prose rather than full code — `redactUser`'s route-level test and the two verify-atlassian 400-path tests — are deliberately left for the implementer to fill in against this file's ACTUAL current server-boot test harness, since `server.test.ts` is large and its exact boot-a-real-instance-for-route-tests pattern needs to be read fresh rather than guessed at plan-writing time. Read 2-3 of the file's existing route-level tests first, match that harness precisely, do not invent a new one.)

- [ ] **Step 5: Run tests, typecheck, commit.**

```bash
cd swarm && npm test
npx tsc --noEmit
git add src/server.ts src/server.test.ts
git commit -m "feat(swarm): connector CRUD+verify routes; workspace-scoped verify resolves via connectorId"
```

---

### Task 5: `swarm/src/dispatcher.ts` — `resolveConnections()` resolves through `connectorId`

**Files:**
- Modify: `swarm/src/dispatcher.ts`
- Test: `swarm/src/dispatcher.test.ts` (extend existing tests)

**Interfaces:**
- Consumes: `User.connectors` (Task 2), `Workspace.atlassian.connectorId` / `WorkspaceRepo.github.connectorId` (Task 3).
- Produces: same return shape as today — `{ atlassian?: {siteUrl, jiraProjectKeys?, confluenceSpaceKeys?}; env: Record<string,string> }` — **unchanged**, so `drivers/claude.ts`'s `materialize()` needs ZERO changes (it already only reads `atlassian?.siteUrl`/`.jiraProjectKeys`/`.confluenceSpaceKeys`, and those field names/shapes don't change). Do not touch `drivers/claude.ts` in this task.

Current exact content (`dispatcher.ts:182-222`):

```ts
async resolveConnections(
  manifest: TaskManifest,
  root: string = process.cwd(),
): Promise<{
  atlassian?: { siteUrl: string; jiraProjectKeys?: string[]; confluenceSpaceKeys?: string[] };
  env: Record<string, string>;
}> {
  const env: Record<string, string> = {};
  if (!manifest.context.repoPath) return { env };

  const workspaces = await loadWorkspacesFromDir(resolve(root, '.smith/workspaces'));
  const workspace = workspaces.find((w) => w.repos.some((r) => r.path === manifest.context.repoPath));
  if (!workspace) return { env };
  const repo = workspace.repos.find((r) => r.path === manifest.context.repoPath);

  const users = await loadUsersFromDir(resolve(root, '.smith/users'));
  const user = resolveCurrentUser(users);

  const atlassian = workspace.atlassian && user?.atlassian ? workspace.atlassian : undefined;
  if (atlassian && user?.atlassian) {
    env.SMITH_ATLASSIAN_EMAIL = user.atlassian.email;
    env.SMITH_ATLASSIAN_TOKEN = user.atlassian.apiToken;
  }
  // GH_TOKEN gates purely on the user having a token — gh infers the repo
  // from the worktree's git remote, so repo.github config isn't required
  // for this (it exists for the precise per-repo verify check in Task 5,
  // not as a gate here).
  if (user?.github?.token) {
    env.GH_TOKEN = user.github.token;
  }
  return { atlassian, env };
}
```

Note the old comment's "it exists for the precise per-repo verify check in Task 5, not as a gate here" — that was a forward-reference to the *original connectors feature's* Task 5, unrelated to this plan. This task makes that gate real: `GH_TOKEN` now resolves through the SAME `repo.github.connectorId` the verify route already uses, rather than "any GitHub token the user has."

- [ ] **Step 1: Write the failing tests**

```ts
// swarm/src/dispatcher.test.ts — add these; the two existing resolveConnections
// tests ('pairs the current user credential...' and 'missing workspace
// atlassian config or missing user credential both skip injection cleanly')
// need their fixture User objects updated from {atlassian: {...}, github:
// {...}} to {connectors: [...]} shape, or they'll fail to compile — do that
// update as part of this task, not a separate pass.

test('resolveConnections: resolves Atlassian env vars through workspace.atlassian.connectorId, not "any atlassian connector the user has"', async () => {
  // Fixture: a user with TWO atlassian connectors (different labels/tokens);
  // a workspace whose atlassian.connectorId names the SECOND one. Assert
  // env.SMITH_ATLASSIAN_EMAIL/TOKEN come from the second connector's fields,
  // not the first (proves this isn't accidentally falling back to
  // "whichever atlassian connector comes first").
});

test('resolveConnections: an unset connectorId resolves to no Atlassian injection, not a crash and not a guess', async () => {
  // Fixture: user has an atlassian connector; workspace.atlassian exists but
  // .connectorId is undefined. Assert `atlassian` is undefined in the
  // result and neither SMITH_ATLASSIAN_EMAIL nor SMITH_ATLASSIAN_TOKEN is set.
});

test('resolveConnections: a connectorId pointing at a deleted/nonexistent connector resolves to no injection, same as unset', async () => {
  // Fixture: workspace.atlassian.connectorId = "does-not-exist"; user's
  // connectors[] has no matching id. Assert same result as the unset case.
});

test('resolveConnections: GH_TOKEN resolves through repo.github.connectorId, per-repo — two repos in the same workspace can resolve different GitHub tokens', async () => {
  // Fixture: a user with two GitHub connectors ("personal" tok-a,
  // "acme-corp" tok-b); a workspace with two repos, each repoPath matching
  // manifest.context.repoPath in separate calls, each repo.github.connectorId
  // naming a different one of the two connectors. Assert the resolved
  // env.GH_TOKEN differs per call, matching each repo's own pick.
});

test('resolveConnections: a repo with no github.connectorId set resolves no GH_TOKEN, even if the user has GitHub connectors', async () => {
  // Fixture: repo.github is present but connectorId is undefined (or
  // repo.github itself is undefined). Assert env.GH_TOKEN is not set — this
  // is the behavior CHANGE from before this task (old code gated purely on
  // "does the user have any github token", ignoring repo config entirely).
});
```

- [ ] **Step 2: Run, confirm failure.** Run: `cd swarm && npm test` — the two pre-existing tests fail to compile against the new `User`/`Workspace` shapes; the five new tests fail on missing per-connector resolution logic.

- [ ] **Step 3: Implement**

```ts
// swarm/src/dispatcher.ts — resolveConnections, full replacement
async resolveConnections(
  manifest: TaskManifest,
  root: string = process.cwd(),
): Promise<{
  atlassian?: { siteUrl: string; jiraProjectKeys?: string[]; confluenceSpaceKeys?: string[] };
  env: Record<string, string>;
}> {
  const env: Record<string, string> = {};
  if (!manifest.context.repoPath) return { env };

  const workspaces = await loadWorkspacesFromDir(resolve(root, '.smith/workspaces'));
  const workspace = workspaces.find((w) => w.repos.some((r) => r.path === manifest.context.repoPath));
  if (!workspace) return { env };
  const repo = workspace.repos.find((r) => r.path === manifest.context.repoPath);

  const users = await loadUsersFromDir(resolve(root, '.smith/users'));
  const user = resolveCurrentUser(users);

  const atlassianConnector = workspace.atlassian?.connectorId
    ? user?.connectors?.find((c) => c.id === workspace.atlassian!.connectorId && c.vendorId === 'atlassian')
    : undefined;
  const atlassian = workspace.atlassian && atlassianConnector ? workspace.atlassian : undefined;
  if (atlassian && atlassianConnector) {
    env.SMITH_ATLASSIAN_EMAIL = atlassianConnector.fields.email ?? '';
    env.SMITH_ATLASSIAN_TOKEN = atlassianConnector.fields.apiToken ?? '';
  }

  // GH_TOKEN now resolves per-repo through repo.github.connectorId — a real
  // gate, unlike before this task (which granted GH_TOKEN from "any github
  // token the user has", ignoring repo config). Two repos in the same
  // workspace can legitimately resolve to two different tokens.
  const githubConnector = repo?.github?.connectorId
    ? user?.connectors?.find((c) => c.id === repo.github!.connectorId && c.vendorId === 'github')
    : undefined;
  if (githubConnector?.fields.token) {
    env.GH_TOKEN = githubConnector.fields.token;
  }
  return { atlassian, env };
}
```

- [ ] **Step 4: Run tests again, confirm pass.**

- [ ] **Step 5: Typecheck, commit.**

```bash
cd swarm && npm test
npx tsc --noEmit
git add src/dispatcher.ts src/dispatcher.test.ts
git commit -m "feat(swarm): resolveConnections resolves Atlassian/GitHub credentials via connectorId, per-repo for GitHub"
```

---

## PHASE 2 — Broker proxy layer

### Task 6: `broker/src/swarm-client.ts` — connector types + methods, `MeRecord`/`WorkspaceBody` updated

**Files:**
- Modify: `broker/src/swarm-client.ts`
- Test: `broker/src/swarm-client.test.ts` (extend existing tests)

**Interfaces:**
- Produces: `ConnectorFieldDef`, `ConnectorVendorMeta`, `ConnectorInstanceRecord`, and methods `getConnectorVendors()`, `getMyConnectors()`, `addConnector(body)`, `updateConnector(id, body)`, `deleteConnector(id)`, `verifyConnector(id, extra?)` — all on the concrete `SwarmClient` class, **not added to `SwarmClientLike`** (`broker.ts:15-39`), matching the established precedent that `getMe`/`updateMe`/`verifyGithubToken`/`verifyWorkspaceAtlassian`/`verifyRepoGithub` are already off that interface — broker's conversational tools never need raw connector data.
- Modifies: `MeRecord` (drops `hasAtlassianToken`/`hasGithubToken`/`atlassianEmail`, gains `connectors: ConnectorInstanceRecord[]`), `updateMe`'s body type (drops `atlassian`/`github`, name-only), `WorkspaceBody`'s nested `atlassian`/`repos[].github` types (gain optional `connectorId?: string`), removes `verifyGithubToken` (superseded by generic `verifyConnector`).

Current exact content of the pieces that change (`swarm-client.ts:37-73`, `:262-276`):

```ts
// current
export interface WorkspaceBody {
  name: string;
  description?: string;
  repos: Array<{ name: string; path: string; repository?: string; branch?: string; github?: { owner: string; repo: string } }>;
  default?: boolean;
  atlassian?: { siteUrl: string; jiraProjectKeys?: string[]; confluenceSpaceKeys?: string[] };
}

export interface SwarmWorkspace extends WorkspaceBody {
  default: boolean;
  archived?: boolean;
}

export interface MeRecord {
  id: string;
  name: string;
  hasAtlassianToken: boolean;
  hasGithubToken: boolean;
}

export interface VerifyResult {
  ok: boolean;
  detail: string;
}

// ...

async getMe(): Promise<MeRecord> {
  return this.http('GET', '/me') as unknown as Promise<MeRecord>;
}

async updateMe(body: {
  name?: string;
  atlassian?: { email: string; apiToken: string };
  github?: { token: string };
}): Promise<MeRecord> {
  return this.http('PUT', '/me', body) as unknown as Promise<MeRecord>;
}

async verifyGithubToken(): Promise<VerifyResult> {
  return this.http('POST', '/me/verify-github', {}) as unknown as Promise<VerifyResult>;
}
```

- [ ] **Step 1: Write the failing test** — model exactly on `swarm-client.test.ts:116-137`'s existing `'me/verify methods hit the right swarm routes'` test (fake `fetchImpl` pushing `"${method} ${path}"` strings, asserting the exact call sequence):

```ts
// broker/src/swarm-client.test.ts
test('connector methods hit the right swarm routes', async () => {
  const calls: string[] = [];
  const client = new SwarmClient({
    baseUrl: 'http://s',
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url).replace('http://s', '')}`);
      return new Response(
        JSON.stringify({ id: 'c1', vendorId: 'github', label: 'personal', fields: {}, ok: true, detail: 'x' }),
      );
    }) as typeof fetch,
  });
  await client.getConnectorVendors();
  await client.getMyConnectors();
  await client.addConnector({ vendorId: 'github', label: 'personal', fields: { token: 'tok' } });
  await client.updateConnector('c1', { label: 'renamed' });
  await client.deleteConnector('c1');
  await client.verifyConnector('c1', { testSiteUrl: 'https://x.atlassian.net' });
  assert.deepEqual(calls, [
    'GET /connectors/vendors',
    'GET /me/connectors',
    'POST /me/connectors',
    'PUT /me/connectors/c1',
    'DELETE /me/connectors/c1',
    'POST /me/connectors/c1/verify',
  ]);
});

test('getMe/updateMe still hit /me — updateMe body is name-only now', async () => {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const client = new SwarmClient({
    baseUrl: 'http://s',
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      calls.push({ path: String(url).replace('http://s', ''), body: init?.body ? JSON.parse(init.body as string) : undefined });
      return new Response(JSON.stringify({ id: 'me', name: 'Edwin', connectors: [] }));
    }) as typeof fetch,
  });
  await client.getMe();
  await client.updateMe({ name: 'Edwin' });
  assert.deepEqual(calls, [{ path: '/me', body: undefined }, { path: '/me', body: { name: 'Edwin' } }]);
});
```

- [ ] **Step 2: Run, confirm failure.** Run: `cd broker && npm test`.

- [ ] **Step 3: Implement**

```ts
// broker/src/swarm-client.ts — type changes
export interface ConnectorFieldDef {
  key: string;
  label: string;
  secret: boolean;
  type?: 'text' | 'select';
  options?: { value: string; label: string }[];
}

export interface ConnectorVendorMeta {
  id: string;
  label: string;
  description: string;
  fields: ConnectorFieldDef[];
  verifyExtraFields: ConnectorFieldDef[];
}

export interface ConnectorInstanceRecord {
  id: string;
  vendorId: string;
  label: string;
  fields: Record<string, string | boolean>;
}

export interface WorkspaceBody {
  name: string;
  description?: string;
  repos: Array<{
    name: string;
    path: string;
    repository?: string;
    branch?: string;
    github?: { owner: string; repo: string; connectorId?: string };
  }>;
  default?: boolean;
  atlassian?: { siteUrl: string; jiraProjectKeys?: string[]; confluenceSpaceKeys?: string[]; connectorId?: string };
}

export interface SwarmWorkspace extends WorkspaceBody {
  default: boolean;
  archived?: boolean;
}

export interface MeRecord {
  id: string;
  name: string;
  connectors: ConnectorInstanceRecord[];
}

export interface VerifyResult {
  ok: boolean;
  detail: string;
}
```

```ts
// broker/src/swarm-client.ts — method changes (replace getMe/updateMe/verifyGithubToken)
async getMe(): Promise<MeRecord> {
  return this.http('GET', '/me') as unknown as Promise<MeRecord>;
}

async updateMe(body: { name?: string }): Promise<MeRecord> {
  return this.http('PUT', '/me', body) as unknown as Promise<MeRecord>;
}

async getConnectorVendors(): Promise<ConnectorVendorMeta[]> {
  return this.http('GET', '/connectors/vendors') as unknown as Promise<ConnectorVendorMeta[]>;
}

async getMyConnectors(): Promise<ConnectorInstanceRecord[]> {
  return this.http('GET', '/me/connectors') as unknown as Promise<ConnectorInstanceRecord[]>;
}

async addConnector(body: { vendorId: string; label: string; fields: Record<string, string> }): Promise<ConnectorInstanceRecord> {
  return this.http('POST', '/me/connectors', body) as unknown as Promise<ConnectorInstanceRecord>;
}

async updateConnector(id: string, body: { label?: string; fields?: Record<string, string> }): Promise<ConnectorInstanceRecord> {
  return this.http('PUT', `/me/connectors/${encodeURIComponent(id)}`, body) as unknown as Promise<ConnectorInstanceRecord>;
}

async deleteConnector(id: string): Promise<{ ok: boolean }> {
  return this.http('DELETE', `/me/connectors/${encodeURIComponent(id)}`) as unknown as Promise<{ ok: boolean }>;
}

async verifyConnector(id: string, extra?: Record<string, string>): Promise<VerifyResult> {
  return this.http('POST', `/me/connectors/${encodeURIComponent(id)}/verify`, { extra }) as unknown as Promise<VerifyResult>;
}
```

Remove `verifyGithubToken` entirely (superseded by `verifyConnector`). `verifyWorkspaceAtlassian`/`verifyRepoGithub` (`swarm-client.ts:278-288`) are **unchanged** — they still proxy to the same two swarm routes, which Task 4 already updated server-side to resolve via `connectorId`; nothing about their broker-side signature changes.

- [ ] **Step 4: Run tests again, confirm pass. Typecheck. Commit.**

```bash
cd broker && npm test
npx tsc --noEmit
git add src/swarm-client.ts src/swarm-client.test.ts
git commit -m "feat(broker): SwarmClient connector methods; MeRecord/WorkspaceBody updated for connectorId"
```

---

### Task 7: `broker/src/text-channel.ts` + `broker/src/main.ts` — `connectors` constructor param + routes, wired through

**Files:**
- Modify: `broker/src/text-channel.ts`
- Modify: `broker/src/main.ts`
- Test: `broker/src/text-channel.test.ts` (extend existing tests, including the `channelWith()` harness helper)

**Interfaces:**
- Consumes: Task 6's new `SwarmClient` methods.
- Produces: a 14th constructor param on `TextChannel` (index `[13]`, after `channels` at `[12]`) shaped `{ vendors(): Promise<Record<string,unknown>[]>; list(): Promise<Record<string,unknown>[]>; add(body): Promise<Record<string,unknown>>; update(id, body): Promise<Record<string,unknown>>; remove(id): Promise<Record<string,unknown>>; verify(id, extra?): Promise<Record<string,unknown>>; }`, five new routes reusing the existing CORS mechanism verbatim.

- [ ] **Step 1: Write the failing test** — extend `text-channel.test.ts`'s existing `channelWith()` harness (which already types every optional dependency as `ConstructorParameters<typeof TextChannel>[N]`) with a `connectors` field at index `[13]`, and add route tests modeled exactly on the existing channels-route tests in that file (same fake, same assertion shape — read 1-2 of those first, match the pattern, don't invent a new one). Cover: each of the 5 new routes calls the right underlying method with the right args; a disallowed `Origin` header gets a 403 from every one of them (the `originBlocked()` check), matching the existing `/me` origin-restriction tests.

```ts
// broker/src/text-channel.test.ts — extend channelWith()'s opts type with:
//   connectors?: ConstructorParameters<typeof TextChannel>[13];
// and its `new TextChannel(...)` call with a 14th positional arg: opts.connectors.
// Then add tests following this file's exact existing style for the channels
// routes (GET/PUT/POST patterns already present) — one test per new route,
// plus one origin-restriction test reusing whatever fake-Origin-header
// mechanism the file's existing /me-origin-restriction test already uses.
```

- [ ] **Step 2: Run, confirm failure.** Run: `cd broker && npm test`.

- [ ] **Step 3: Implement — constructor param**

Add as the 14th positional parameter in `TextChannel`'s constructor (`text-channel.ts:92-162`), immediately after `channels` (index `[12]`):

```ts
/** Connector registry (Integrations settings group): vendor metadata, CRUD, and verify. Origin-restricted like /me and channels. */
private readonly connectors?: {
  vendors(): Promise<Record<string, unknown>[]>;
  list(): Promise<Record<string, unknown>[]>;
  add(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  update(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  remove(id: string): Promise<Record<string, unknown>>;
  verify(id: string, extra?: Record<string, string>): Promise<Record<string, unknown>>;
},
```

- [ ] **Step 4: Implement — routes**

Add inside the same `if (this.creation) { ... }` block (`text-channel.ts:234-501`) every other credential-adjacent route lives in, reusing `originBlocked`/`credJson`/`credFail` verbatim:

```ts
// broker/src/text-channel.ts — new routes, same block as /me and channels
if (req.method === 'GET' && url.pathname === '/connectors/vendors' && this.connectors) {
  if (originBlocked()) return;
  void this.connectors.vendors().then((r) => credJson(200, r), credFail);
  return;
}
if (req.method === 'GET' && url.pathname === '/me/connectors' && this.connectors) {
  if (originBlocked()) return;
  void this.connectors.list().then((r) => credJson(200, r), credFail);
  return;
}
if (req.method === 'POST' && url.pathname === '/me/connectors' && this.connectors) {
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
    void this.connectors!.add(parsed).then((r) => credJson((r as { error?: string }).error ? 400 : 201, r), credFail);
  });
  return;
}
const connectorIdMatch = /^\/me\/connectors\/([^/]+)$/.exec(url.pathname);
if (req.method === 'PUT' && connectorIdMatch && this.connectors) {
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
    void this.connectors!
      .update(decodeURIComponent(connectorIdMatch[1]!), parsed)
      .then((r) => credJson((r as { error?: string }).error ? 400 : 200, r), credFail);
  });
  return;
}
if (req.method === 'DELETE' && connectorIdMatch && this.connectors) {
  if (originBlocked()) return;
  void this.connectors
    .remove(decodeURIComponent(connectorIdMatch[1]!))
    .then((r) => credJson((r as { error?: string }).error ? 400 : 200, r), credFail);
  return;
}
const connectorVerifyMatch = /^\/me\/connectors\/([^/]+)\/verify$/.exec(url.pathname);
if (req.method === 'POST' && connectorVerifyMatch && this.connectors) {
  if (originBlocked()) return;
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    let parsed: { extra?: Record<string, string> } = {};
    try {
      parsed = body ? (JSON.parse(body) as { extra?: Record<string, string> }) : {};
    } catch {
      return credJson(400, { error: 'body must be JSON' });
    }
    void this.connectors!
      .verify(decodeURIComponent(connectorVerifyMatch[1]!), parsed.extra)
      .then((r) => credJson((r as { error?: string }).error ? 400 : 200, r), credFail);
  });
  return;
}
```

Note the `/me/connectors/:id` regex (`connectorIdMatch`) must be checked AFTER the more specific `/me/connectors/:id/verify` regex would ever collide — it doesn't here since `[^/]+` doesn't match a path containing `/verify`, but place the `PUT`/`DELETE` block and the `/verify` block as written above (verify's own regex is independent, order doesn't matter here) — just don't accidentally write `connectorIdMatch` with a pattern loose enough to also match `.../verify`.

- [ ] **Step 5: Wire `main.ts`** — new passthrough object modeled exactly on `me`/`channels` (`main.ts:497-518`), appended to the `new TextChannel(...)` call tail (`main.ts:817-818`):

```ts
// broker/src/main.ts — new passthrough, alongside `me`/`channels`
// Connector registry (Integrations settings group): same thin passthrough
// shape as `me`/`channels`, origin-restricted the same way.
const connectors = {
  vendors: () => swarm.getConnectorVendors() as unknown as Promise<Record<string, unknown>[]>,
  list: () => swarm.getMyConnectors() as unknown as Promise<Record<string, unknown>[]>,
  add: (body: Record<string, unknown>) =>
    swarm.addConnector(body as { vendorId: string; label: string; fields: Record<string, string> }) as unknown as Promise<
      Record<string, unknown>
    >,
  update: (id: string, body: Record<string, unknown>) =>
    swarm.updateConnector(id, body as { label?: string; fields?: Record<string, string> }) as unknown as Promise<
      Record<string, unknown>
    >,
  remove: (id: string) => swarm.deleteConnector(id) as unknown as Promise<Record<string, unknown>>,
  verify: (id: string, extra?: Record<string, string>) =>
    swarm.verifyConnector(id, extra) as unknown as Promise<Record<string, unknown>>,
};
```

Append `connectors,` as a new final line inside the `new TextChannel(...)` call, right after `channels,` (`main.ts:817`) and before the closing `);` (`main.ts:818`).

- [ ] **Step 6: Run tests again, confirm pass. Typecheck. Commit.**

```bash
cd broker && npm test
npx tsc --noEmit
git add src/text-channel.ts src/text-channel.test.ts src/main.ts
git commit -m "feat(broker): /connectors/vendors and /me/connectors routes, origin-restricted, wired to swarm"
```

---

## PHASE 3 — Control-plane UI

### Task 8: `styles/components.css` — full-screen Settings shell + Integrations card grid

**Files:**
- Modify: `control-plane/src/styles/components.css`

**Interfaces:**
- Produces: `.settings-screen`, `.settings-screen__nav`, `.settings-screen__back`, `.settings-screen__group` (+ `.is-active`), `.settings-screen__content`, `.connector-grid`, `.connector-card` (+ `__head`), `.connector-instance`, `.connector-status` (+ `--connected`/`--unconnected`) — consumed by every remaining control-plane task. No existing class is a full-screen surface or a card grid (confirmed: nothing in this file today uses `position: fixed; inset: 0` as a filled screen, and nothing uses a `grid-template-columns: repeat(auto-fill, ...)` card layout) — this is genuinely new CSS, not a reskin.

This task has no tests (pure CSS) — verify visually via `pnpm tauri dev` once Task 10 mounts something using these classes, and via `pnpm run lint`/`pnpm run typecheck` staying clean (no TS changes in this task, so typecheck is a no-op confirmation nothing else broke).

- [ ] **Step 1: Add the new rules** — append to `components.css` (a natural spot: right after the existing `.settings-panel` block, since this supersedes it — do not delete `.settings-panel`'s rules yet, Task 10 removes the now-dead ones once nothing references them):

```css
/* --- settings: full-screen shell (replaces the small anchored popover) --- */
.settings-screen {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  background: var(--bg);
}
.settings-screen__nav {
  width: 220px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 20px 12px;
  border-right: 1px solid var(--pill-br);
  overflow-y: auto;
}
.settings-screen__back {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 10px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  margin-bottom: 12px;
}
.settings-screen__back:hover { color: var(--text); }
.settings-screen__group {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  border: none;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.settings-screen__group:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.settings-screen__group.is-active {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--text);
}
.settings-screen__content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 32px 40px;
}
.settings-screen__content h1 {
  margin: 0 0 20px;
  font-size: 20px;
  font-weight: 600;
}
@media (max-width: 720px) {
  .settings-screen { flex-direction: column; }
  .settings-screen__nav { width: 100%; flex-direction: row; flex-wrap: wrap; border-right: none; border-bottom: 1px solid var(--pill-br); }
}

/* --- settings: Integrations card grid --- */
.connector-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
}
.connector-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border-radius: 14px;
  background: var(--pill);
  border: 1px solid var(--pill-br);
}
.connector-card__head { display: flex; flex-direction: column; gap: 2px; }
.connector-card__head b { font-size: 14px; font-weight: 600; }
.connector-card__head em { font-size: 11.5px; font-style: normal; color: var(--text-dim); }
.connector-instance {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  font-size: 12px;
}
.connector-status {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10.5px;
  border: 1px solid;
  flex: none;
}
.connector-status--connected { color: #4caf7d; border-color: color-mix(in srgb, #4caf7d 45%, transparent); }
.connector-status--unconnected { color: #d9a441; border-color: color-mix(in srgb, #d9a441 45%, transparent); }
```

- [ ] **Step 2: Confirm no regressions.**

```bash
cd control-plane && pnpm run lint
pnpm run typecheck
```

- [ ] **Step 3: Commit.**

```bash
git add src/styles/components.css
git commit -m "feat(control-plane): CSS for full-screen Settings shell and Integrations card grid"
```

---

### Task 9: `hooks/useBrokerChat.ts` — connector types + fetch functions, `MeRecord`/`WorkspaceRecord` updated

**Files:**
- Modify: `control-plane/src/hooks/useBrokerChat.ts`

**Interfaces:**
- Produces: `ConnectorFieldDef`, `ConnectorVendorMeta`, `ConnectorInstanceRecord` types; `listConnectorVendors()`, `listMyConnectors()`, `addConnector(body)`, `updateConnector(id, body)`, `deleteConnector(id)`, `verifyConnector(id, extra?)` functions — consumed by Tasks 11-13. Updated `MeRecord` (drops `hasAtlassianToken`/`hasGithubToken`/`atlassianEmail`, gains `connectors: ConnectorInstanceRecord[]`), updated `WorkspaceRecord`'s nested `atlassian`/`repos[].github` (gain `connectorId?: string`), updated `updateMe` (name-only body), `verifyGithubToken` removed.
- Consumes: Task 7's broker routes.

Current exact content of the pieces that change (`useBrokerChat.ts:53-77`, plus `getMe`/`updateMe`/`verifyGithubToken` at lines 307-331):

```ts
// current
export interface WorkspaceRecord {
  name: string;
  description?: string;
  default: boolean;
  archived?: boolean;
  repos: Array<{ name: string; path: string; branch: string; github?: { owner: string; repo: string } }>;
  atlassian?: { siteUrl: string; jiraProjectKeys?: string[]; confluenceSpaceKeys?: string[] };
}

export interface MeRecord {
  id: string;
  name: string;
  hasAtlassianToken: boolean;
  hasGithubToken: boolean;
  atlassianEmail?: string;
}
```

- [ ] **Step 1: Write the failing test** — this hook has no dedicated test file today (confirmed: only `useSurfacePolicy.test.ts` exists under `hooks/`); a new one is reasonable here, but ONLY if it can mirror an existing hook-testing pattern in this codebase — check for one first. If no clean hook-testing precedent exists for a hook this shape (many interdependent `useCallback`s reading a shared `base` closure), it's acceptable to skip a dedicated test file for this task and instead cover the new functions indirectly through the *consuming* components' own tests (Tasks 11-13) — same call every other `useBrokerChat` fetch function already made (none of `getWorkspaceChannels`/`saveWorkspaceChannels`/`verifyWorkspaceDiscord` etc. have a hook-level test today; they're covered by `ChannelsManagerModal.test.tsx`'s mocked-prop tests instead). Match that established precedent — don't invent hook-level testing infrastructure that doesn't already exist. State which way you went in this task's completion note.

- [ ] **Step 2: Implement**

```ts
// control-plane/src/hooks/useBrokerChat.ts — new types
export interface ConnectorFieldDef {
  key: string;
  label: string;
  secret: boolean;
  type?: "text" | "select";
  options?: { value: string; label: string }[];
}

export interface ConnectorVendorMeta {
  id: string;
  label: string;
  description: string;
  fields: ConnectorFieldDef[];
  verifyExtraFields: ConnectorFieldDef[];
}

export interface ConnectorInstanceRecord {
  id: string;
  vendorId: string;
  label: string;
  fields: Record<string, string | boolean>;
}

/** Full workspace record, as the manager UI reads and writes it. */
export interface WorkspaceRecord {
  name: string;
  description?: string;
  default: boolean;
  archived?: boolean;
  repos: Array<{
    name: string;
    path: string;
    branch: string;
    github?: { owner: string; repo: string; connectorId?: string };
  }>;
  atlassian?: { siteUrl: string; jiraProjectKeys?: string[]; confluenceSpaceKeys?: string[]; connectorId?: string };
}

/** The operator's own profile — connector credentials read back redacted, never the secret itself. */
export interface MeRecord {
  id: string;
  name: string;
  connectors: ConnectorInstanceRecord[];
}
```

```ts
// control-plane/src/hooks/useBrokerChat.ts — replace getMe/updateMe/verifyGithubToken, add 6 new functions
const getMe = useCallback(async (): Promise<MeRecord> => {
  const res = await fetch(`http://${base}/me`);
  return (await res.json()) as MeRecord;
}, [base]);

const updateMe = useCallback(
  async (body: { name?: string }): Promise<MeRecord & { error?: string }> => {
    const res = await fetch(`http://${base}/me`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as MeRecord & { error?: string };
  },
  [base],
);

const listConnectorVendors = useCallback(async (): Promise<ConnectorVendorMeta[]> => {
  const res = await fetch(`http://${base}/connectors/vendors`);
  return (await res.json()) as ConnectorVendorMeta[];
}, [base]);

const listMyConnectors = useCallback(async (): Promise<ConnectorInstanceRecord[]> => {
  const res = await fetch(`http://${base}/me/connectors`);
  return (await res.json()) as ConnectorInstanceRecord[];
}, [base]);

const addConnector = useCallback(
  async (body: { vendorId: string; label: string; fields: Record<string, string> }): Promise<ConnectorInstanceRecord & { error?: string }> => {
    const res = await fetch(`http://${base}/me/connectors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as ConnectorInstanceRecord & { error?: string };
  },
  [base],
);

const updateConnector = useCallback(
  async (id: string, body: { label?: string; fields?: Record<string, string> }): Promise<ConnectorInstanceRecord & { error?: string }> => {
    const res = await fetch(`http://${base}/me/connectors/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as ConnectorInstanceRecord & { error?: string };
  },
  [base],
);

const deleteConnector = useCallback(
  async (id: string): Promise<{ ok?: boolean; error?: string }> => {
    const res = await fetch(`http://${base}/me/connectors/${encodeURIComponent(id)}`, { method: "DELETE" });
    return (await res.json()) as { ok?: boolean; error?: string };
  },
  [base],
);

const verifyConnector = useCallback(
  async (id: string, extra?: Record<string, string>): Promise<{ ok?: boolean; detail?: string; error?: string }> => {
    const res = await fetch(`http://${base}/me/connectors/${encodeURIComponent(id)}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ extra }),
    });
    return (await res.json()) as { ok?: boolean; detail?: string; error?: string };
  },
  [base],
);
```

Remove `verifyGithubToken` entirely. Add the 6 new functions and `MeRecord`/`ConnectorFieldDef`/`ConnectorVendorMeta`/`ConnectorInstanceRecord` to this hook's return object / exports, matching however the existing functions (`getWorkspaceChannels` etc.) are already threaded into the hook's returned object.

- [ ] **Step 3: Typecheck** (this task has no runtime test per Step 1's finding, unless a hook-test precedent was found — in which case run it).

```bash
cd control-plane && pnpm run typecheck
```

- [ ] **Step 4: Commit.**

```bash
git add src/hooks/useBrokerChat.ts
git commit -m "feat(control-plane): connector vendor/instance types and fetch functions in useBrokerChat"
```

---

### Task 10: `SettingsPanel.tsx` — full-screen shell + `settings/GeneralGroup.tsx` + `settings/ThemesGroup.tsx`

**Files:**
- Modify: `control-plane/src/organisms/SettingsPanel.tsx` (full rewrite — becomes the shell only)
- Create: `control-plane/src/organisms/settings/GeneralGroup.tsx`
- Create: `control-plane/src/organisms/settings/ThemesGroup.tsx`
- Test: `control-plane/src/organisms/SettingsPanel.test.tsx` (new — no test file exists for this component today)

**Interfaces:**
- Produces: `SettingsPanel` — same `open`/`onClose` contract as today, but renders full-screen with a left-nav group switcher. New prop: `initialGroup?: 'general' | 'integrations' | 'channels' | 'themes'` (default `'general'`) — lets the avatar deep-link straight to Integrations (Task 15).
- `GeneralGroup` — extracted verbatim: today's `ResetScope`, `OPTIONS`, and the reset-confirmation flow, taking `onReset`/`theme` is NOT needed here (theme moves to `ThemesGroup`).
- `ThemesGroup` — extracted verbatim: today's `THEMES.map(...)` picker.
- Consumes nothing new from earlier tasks — this task is a pure decomposition/reshell of existing, already-shipped functionality. `IntegrationsGroup`/`ChannelsGroup` (Tasks 11-13) are stubbed here as placeholders and wired for real in their own tasks — this task's job is the shell + the two straightforward group migrations.

- [ ] **Step 1: Write `GeneralGroup.tsx`** — lift `ResetScope`, `OPTIONS`, and the whole reset UI/state (`scope`/`confirming`/`busy`/`result`, `run()`) out of today's `SettingsPanel.tsx` verbatim, as its own component:

```tsx
// control-plane/src/organisms/settings/GeneralGroup.tsx
import { AlertTriangle } from "lucide-react";
import { useState } from "react";

export interface ResetScope {
  runtime: boolean;
  conversations: boolean;
  worktrees: boolean;
  agents: boolean;
}

interface GeneralGroupProps {
  onReset: (scope: ResetScope) => Promise<{ ok?: boolean; error?: string; swarm?: unknown }>;
}

const OPTIONS: Array<{ key: keyof ResetScope; label: string; detail: string; danger?: boolean }> = [
  {
    key: "runtime",
    label: "Kill running instances",
    detail: "Stops every local session and task — warm sessions, running CLIs, the queue. Remote workers are never touched.",
  },
  {
    key: "conversations",
    label: "Clear conversations",
    detail: "Deletes all sessions (transcripts + agent memory) and resets squad arrangements to the configured roster.",
  },
  {
    key: "worktrees",
    label: "Prune worktrees",
    detail: "Removes orphaned task worktrees. Branches and pull requests are kept — committed work is never destroyed.",
  },
  {
    key: "agents",
    label: "Remove all agents & squads",
    detail: "Empties the roster completely. Persona and squad files are archived on disk (not deleted) — restore by moving them back.",
    danger: true,
  },
];

/** General: the reset surface. Tiered, explicit, and confirmed before it fires. Unchanged behavior from the old SettingsPanel popover — just its own group now. */
export function GeneralGroup({ onReset }: GeneralGroupProps) {
  const [scope, setScope] = useState<ResetScope>({ runtime: true, conversations: true, worktrees: false, agents: false });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const chosen = OPTIONS.filter((o) => scope[o.key]);

  const run = async () => {
    setBusy(true);
    const report = await onReset(scope).catch((err: unknown) => ({ error: String(err) }));
    setBusy(false);
    setConfirming(false);
    setResult(report.error ? `Reset failed: ${report.error}` : `Reset complete — ${chosen.map((o) => o.label.toLowerCase()).join(", ")}.`);
  };

  return (
    <>
      <h1>general</h1>
      <div className="settings-panel__options">
        {OPTIONS.map((option) => (
          <label key={option.key} className={`settings-option${option.danger ? " settings-option--danger" : ""}`}>
            <input
              type="checkbox"
              checked={scope[option.key]}
              onChange={(e) => {
                setScope((s) => ({ ...s, [option.key]: e.target.checked }));
                setConfirming(false);
                setResult(null);
              }}
            />
            <span>
              <b>{option.label}</b>
              <em>{option.detail}</em>
            </span>
          </label>
        ))}
      </div>
      {result && <div className="settings-panel__result">{result}</div>}
      {confirming ? (
        <div className="settings-panel__confirm">
          <AlertTriangle size={13} strokeWidth={2} />
          <span>This cannot be undone. Proceed?</span>
          <button type="button" className="settings-btn settings-btn--danger" onClick={() => void run()} disabled={busy}>
            {busy ? "resetting…" : "yes, reset"}
          </button>
          <button type="button" className="settings-btn" onClick={() => setConfirming(false)} disabled={busy}>
            cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="settings-btn settings-btn--danger settings-btn--wide"
          onClick={() => setConfirming(true)}
          disabled={chosen.length === 0}
        >
          reset {chosen.length > 0 ? `(${chosen.length} selected)` : "— nothing selected"}
        </button>
      )}
      <footer className="settings-panel__note">Remote workers, git branches, and pull requests always survive a reset.</footer>
    </>
  );
}
```

- [ ] **Step 2: Write `ThemesGroup.tsx`**

```tsx
// control-plane/src/organisms/settings/ThemesGroup.tsx
import { THEMES, type ThemeId } from "../../hooks/useTheme";

interface ThemesGroupProps {
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
}

export function ThemesGroup({ theme, onThemeChange }: ThemesGroupProps) {
  return (
    <>
      <h1>themes</h1>
      <div className="theme-row">
        {THEMES.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`theme-chip${theme === t.id ? " is-picked" : ""}`}
            onClick={() => onThemeChange(t.id)}
            title={t.label}
            aria-pressed={theme === t.id}
          >
            <span className="theme-chip__swatch" style={{ background: t.swatch }} />
            {t.label}
          </button>
        ))}
      </div>
    </>
  );
}
```

- [ ] **Step 3: Rewrite `SettingsPanel.tsx` as the shell**

```tsx
// control-plane/src/organisms/SettingsPanel.tsx — full replacement
import { ArrowLeft, Blocks, MessageSquare, Palette, Settings as SettingsIcon } from "lucide-react";
import { useState } from "react";
import type { ThemeId } from "../hooks/useTheme";
import { GeneralGroup, type ResetScope } from "./settings/GeneralGroup";
import { ThemesGroup } from "./settings/ThemesGroup";
// IntegrationsGroup/ChannelsGroup: wired in Tasks 11-13. Import + render them
// the same way once those files exist — do not stub with placeholder JSX,
// this task ends with General/Themes fully working and Integrations/Channels
// left as the NEXT task's job, not a fake placeholder shipped in between.

export type SettingsGroupId = "general" | "integrations" | "channels" | "themes";

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  onReset: (scope: ResetScope) => Promise<{ ok?: boolean; error?: string; swarm?: unknown }>;
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
  initialGroup?: SettingsGroupId;
}

const GROUPS: Array<{ id: SettingsGroupId; label: string; icon: typeof SettingsIcon }> = [
  { id: "general", label: "General", icon: SettingsIcon },
  { id: "integrations", label: "Integrations", icon: Blocks },
  { id: "channels", label: "Channels", icon: MessageSquare },
  { id: "themes", label: "Themes", icon: Palette },
];

/** Full-screen settings: General / Integrations / Channels / Themes. Replaces the old small anchored popover. */
export function SettingsPanel({ open, onClose, onReset, theme, onThemeChange, initialGroup = "general" }: SettingsPanelProps) {
  const [active, setActive] = useState<SettingsGroupId>(initialGroup);

  if (!open) return null;

  return (
    <div className="settings-screen" role="dialog" aria-modal="true" aria-label="Settings">
      <nav className="settings-screen__nav">
        <button type="button" className="settings-screen__back" onClick={onClose}>
          <ArrowLeft size={13} strokeWidth={2} /> back to app
        </button>
        {GROUPS.map((g) => (
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
      </nav>
      <div className="settings-screen__content">
        {active === "general" && <GeneralGroup onReset={onReset} />}
        {active === "themes" && <ThemesGroup theme={theme} onThemeChange={onThemeChange} />}
        {active === "integrations" && <p className="wizard__hint">Integrations — coming in the next task.</p>}
        {active === "channels" && <p className="wizard__hint">Channels — coming in the next task.</p>}
      </div>
    </div>
  );
}
```

Note: `initialGroup` seeds the INITIAL `useState` value only — React's `useState(initialGroup)` doesn't react to a changed prop on a later re-render while `open` stays true, which is correct here (the shell should remember whatever group the operator navigated to during one open session), but does mean each `open: true` mount starts fresh at `initialGroup`. Confirm this matches the intended avatar-deep-link behavior (Task 15) — reopening via the avatar should always land on Integrations, reopening via the Settings button should always land on General — both true under `useState`'s mount-time-only semantics, since `SettingsPanel` fully unmounts (`if (!open) return null`) between opens.

- [ ] **Step 4: Write `SettingsPanel.test.tsx`** — model on `ChannelsManagerModal.test.tsx`'s exact style (`@testing-library/react` + `user-event` + `vitest`):

```tsx
// control-plane/src/organisms/SettingsPanel.test.tsx
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";

describe("SettingsPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("opens on the General group by default and renders reset options", () => {
    render(<SettingsPanel open onClose={() => {}} onReset={vi.fn()} theme="dark" onThemeChange={vi.fn()} />);
    expect(screen.getByText(/general/i)).toBeDefined();
    expect(screen.getByText(/kill running instances/i)).toBeDefined();
  });

  it("opens on Integrations directly when initialGroup is set (avatar deep-link)", () => {
    render(
      <SettingsPanel
        open
        onClose={() => {}}
        onReset={vi.fn()}
        theme="dark"
        onThemeChange={vi.fn()}
        initialGroup="integrations"
      />,
    );
    expect(screen.getByText(/coming in the next task/i)).toBeDefined();
  });

  it("clicking a nav group switches the visible content", async () => {
    render(<SettingsPanel open onClose={() => {}} onReset={vi.fn()} theme="dark" onThemeChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /themes/i }));
    expect(screen.getByText(/dark|light/i)).toBeDefined(); // a theme chip renders
  });

  it("back to app calls onClose", async () => {
    const onClose = vi.fn();
    render(<SettingsPanel open onClose={onClose} onReset={vi.fn()} theme="dark" onThemeChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /back to app/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <SettingsPanel open={false} onClose={() => {}} onReset={vi.fn()} theme="dark" onThemeChange={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 5: Run, typecheck, lint, commit.**

```bash
cd control-plane
pnpm run test
pnpm run typecheck
pnpm run lint
git add src/organisms/SettingsPanel.tsx src/organisms/SettingsPanel.test.tsx src/organisms/settings/GeneralGroup.tsx src/organisms/settings/ThemesGroup.tsx
git commit -m "feat(control-plane): full-screen Settings shell with General/Themes groups, Integrations/Channels stubbed"
```

(`HomePage.tsx` isn't updated to pass `initialGroup`/mount the new shell's full behavior until Task 15 — this task's `SettingsPanel` change is a drop-in-compatible superset of its old props for `open`/`onClose`/`onReset`/`theme`/`onThemeChange`, so `HomePage.tsx`'s existing usage keeps compiling and working, just landing on a full-screen General/Themes-only view with two "coming in the next task" placeholders in between this task and Task 15.)

---

### Task 11: `settings/ConnectorFormModal.tsx` — generic per-vendor connect form

**Files:**
- Create: `control-plane/src/organisms/settings/ConnectorFormModal.tsx`
- Test: `control-plane/src/organisms/settings/ConnectorFormModal.test.tsx`

**Interfaces:**
- Consumes: `ConnectorVendorMeta`, `ConnectorInstanceRecord` (Task 9).
- Produces: `ConnectorFormModal` — a scrim-wrapped modal (matching `AccountPanel`'s/`WorkspaceManagerModal`'s existing `.scrim` + click-outside-dismiss pattern), rendering one input per `vendor.fields` (secret → password input, `type: 'select'` → a `<select>`) plus, when present, `vendor.verifyExtraFields` as a visually-separated "test only, not saved" section. Props: `open`, `vendor: ConnectorVendorMeta | null`, `existing?: ConnectorInstanceRecord` (present when editing/re-checking an already-saved instance, absent when adding new), `onClose`, `onSave: (body: {vendorId, label, fields}) => Promise<{error?: string}>`, `onVerify?: (extra: Record<string,string>) => Promise<{ok?: boolean; detail?: string; error?: string}>` (only meaningful once an instance is saved — omitted/disabled for a brand-new, not-yet-saved form). Consumed by Task 12 (`IntegrationsGroup`).

- [ ] **Step 1: Write the failing test**

```tsx
// control-plane/src/organisms/settings/ConnectorFormModal.test.tsx
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorFormModal } from "./ConnectorFormModal";

const GITHUB_VENDOR = {
  id: "github",
  label: "GitHub",
  description: "Repo access and pull requests.",
  fields: [{ key: "token", label: "Personal access token", secret: true }],
  verifyExtraFields: [],
};

const DATADOG_VENDOR = {
  id: "datadog",
  label: "Datadog",
  description: "Monitors and dashboards.",
  fields: [
    { key: "site", label: "Site", secret: false, type: "select", options: [{ value: "us1", label: "US1" }, { value: "eu1", label: "EU1" }] },
    { key: "apiKey", label: "API key", secret: true },
    { key: "appKey", label: "Application key", secret: true },
  ],
  verifyExtraFields: [],
};

const ATLASSIAN_VENDOR = {
  id: "atlassian",
  label: "Atlassian",
  description: "Jira and Confluence.",
  fields: [
    { key: "email", label: "Atlassian account email", secret: false },
    { key: "apiToken", label: "API token", secret: true },
  ],
  verifyExtraFields: [{ key: "testSiteUrl", label: "Site URL (used only to test this connection — not saved)", secret: false }],
};

describe("ConnectorFormModal", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders one input per vendor field — text for non-secret, password for secret, select for type:select", () => {
    render(<ConnectorFormModal open vendor={DATADOG_VENDOR} onClose={() => {}} onSave={vi.fn()} />);
    expect(screen.getByRole("combobox")).toBeDefined(); // the site select
    expect(screen.getByPlaceholderText(/api key/i)).toHaveProperty("type", "password");
    expect(screen.getByPlaceholderText(/application key/i)).toHaveProperty("type", "password");
  });

  it("submitting a new connector calls onSave with vendorId, label, and the typed field values", async () => {
    const onSave = vi.fn(async () => ({}));
    render(<ConnectorFormModal open vendor={GITHUB_VENDOR} onClose={() => {}} onSave={onSave} />);
    await userEvent.type(screen.getByPlaceholderText(/label/i), "personal");
    await userEvent.type(screen.getByPlaceholderText(/personal access token/i), "gh-tok");
    await userEvent.click(screen.getByRole("button", { name: /^connect$/i }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ vendorId: "github", label: "personal", fields: { token: "gh-tok" } }),
    );
  });

  it("Atlassian's verifyExtraFields render as a separate, clearly-labeled 'not saved' section, not merged into the saved fields", async () => {
    const onSave = vi.fn(async () => ({}));
    render(<ConnectorFormModal open vendor={ATLASSIAN_VENDOR} onClose={() => {}} onSave={onSave} />);
    expect(screen.getByText(/not saved/i)).toBeDefined();
    await userEvent.type(screen.getByPlaceholderText(/label/i), "default");
    await userEvent.type(screen.getByPlaceholderText(/atlassian account email/i), "e@x.com");
    await userEvent.type(screen.getByPlaceholderText(/^api token/i), "atl-tok");
    await userEvent.click(screen.getByRole("button", { name: /^connect$/i }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        vendorId: "atlassian",
        label: "default",
        fields: { email: "e@x.com", apiToken: "atl-tok" }, // testSiteUrl must NOT appear here
      }),
    );
  });

  it("Re-check on an existing instance calls onVerify with the transient extra fields, not onSave", async () => {
    const onVerify = vi.fn(async () => ({ ok: true, detail: "Jira: authenticated" }));
    render(
      <ConnectorFormModal
        open
        vendor={ATLASSIAN_VENDOR}
        existing={{ id: "c1", vendorId: "atlassian", label: "default", fields: { email: "e@x.com", hasApiToken: true } }}
        onClose={() => {}}
        onSave={vi.fn()}
        onVerify={onVerify}
      />,
    );
    await userEvent.type(screen.getByPlaceholderText(/site url/i), "https://acme.atlassian.net");
    await userEvent.click(screen.getByRole("button", { name: /re-check/i }));
    await waitFor(() => expect(onVerify).toHaveBeenCalledWith({ testSiteUrl: "https://acme.atlassian.net" }));
    expect(await screen.findByText(/authenticated/i)).toBeDefined();
  });

  it("renders nothing when closed or when vendor is null", () => {
    const { container } = render(<ConnectorFormModal open={false} vendor={GITHUB_VENDOR} onClose={() => {}} onSave={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm failure.**

- [ ] **Step 3: Implement**

```tsx
// control-plane/src/organisms/settings/ConnectorFormModal.tsx
import type { MouseEvent } from "react";
import { useEffect, useState } from "react";
import type { ConnectorInstanceRecord, ConnectorVendorMeta } from "../../hooks/useBrokerChat";

interface ConnectorFormModalProps {
  open: boolean;
  vendor: ConnectorVendorMeta | null;
  /** Present when editing/re-checking an already-saved instance; absent for a brand-new one. */
  existing?: ConnectorInstanceRecord;
  onClose: () => void;
  onSave: (body: { vendorId: string; label: string; fields: Record<string, string> }) => Promise<{ error?: string }>;
  onVerify?: (extra: Record<string, string>) => Promise<{ ok?: boolean; detail?: string; error?: string }>;
}

/** Generic per-vendor connect form: one input per vendor.fields, driven entirely by the registry — no vendor-specific JSX. */
export function ConnectorFormModal({ open, vendor, existing, onClose, onSave, onVerify }: ConnectorFormModalProps) {
  const [label, setLabel] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [testing, setTesting] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-seed when the modal opens on a (possibly different) vendor/instance
  useEffect(() => {
    if (!open) return;
    setLabel(existing?.label ?? "");
    setFields({}); // secrets never round-trip — always start blank, same discipline as AccountPanel/ChannelsManagerModal
    setExtra({});
    setError(null);
    setTestResult(null);
  }, [open, vendor?.id, existing?.id]);

  if (!open || !vendor) return null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const result = await onSave({ vendorId: vendor.id, label: label.trim(), fields }).catch((err: unknown): { error?: string } => ({
      error: String(err),
    }));
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onClose();
  };

  const runVerify = async () => {
    if (!onVerify) return;
    setTesting(true);
    const r = await onVerify(extra);
    setTesting(false);
    setTestResult({ ok: Boolean(r.ok), detail: r.detail ?? r.error ?? "unknown" });
  };

  const onScrimClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click-outside dismiss, same pattern as WorkspaceManagerModal/AccountPanel
    <div className="scrim" data-open="true" role="dialog" aria-modal="true" aria-label={`Connect ${vendor.label}`} onClick={onScrimClick}>
      <section className="account-panel">
        <header className="workspace-manager__head">
          <h2>{existing ? `edit ${vendor.label.toLowerCase()} connection` : `connect ${vendor.label.toLowerCase()}`}</h2>
        </header>
        <div className="account-panel__form">
          <label>
            Label
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. personal, acme-corp)" />
          </label>
          {vendor.fields.map((f) => (
            <label key={f.key}>
              {f.label}
              {f.type === "select" ? (
                <select value={fields[f.key] ?? f.options?.[0]?.value ?? ""} onChange={(e) => setFields((s) => ({ ...s, [f.key]: e.target.value }))}>
                  {f.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={f.secret ? "password" : "text"}
                  value={fields[f.key] ?? ""}
                  onChange={(e) => setFields((s) => ({ ...s, [f.key]: e.target.value }))}
                  placeholder={f.label}
                />
              )}
            </label>
          ))}

          {vendor.verifyExtraFields.length > 0 && (
            <>
              <span className="wizard__hint">Used only to test this connection — not saved</span>
              {vendor.verifyExtraFields.map((f) => (
                <input
                  key={f.key}
                  value={extra[f.key] ?? ""}
                  onChange={(e) => setExtra((s) => ({ ...s, [f.key]: e.target.value }))}
                  placeholder={f.label}
                />
              ))}
            </>
          )}

          {existing && onVerify && (
            <button type="button" className="settings-btn" onClick={() => void runVerify()} disabled={testing}>
              {testing ? "testing…" : "Re-check"}
            </button>
          )}
          {testResult && <p className={testResult.ok ? "wizard__hint" : "wizard__error"}>{testResult.detail}</p>}

          {error && <p className="wizard__error">{error}</p>}

          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="settings-btn" onClick={onClose} disabled={busy}>
              cancel
            </button>
            <button
              type="button"
              className="settings-btn settings-btn--primary settings-btn--wide"
              onClick={() => void submit()}
              disabled={busy || !label.trim()}
            >
              {busy ? "saving…" : existing ? "save changes" : "connect"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Run tests, typecheck, lint, commit.**

```bash
cd control-plane
pnpm run test
pnpm run typecheck
pnpm run lint
git add src/organisms/settings/ConnectorFormModal.tsx src/organisms/settings/ConnectorFormModal.test.tsx
git commit -m "feat(control-plane): generic per-vendor connect form, driven entirely by the registry"
```

---

### Task 12: `settings/IntegrationsGroup.tsx` — vendor card grid, wired into `SettingsPanel`

**Files:**
- Create: `control-plane/src/organisms/settings/IntegrationsGroup.tsx`
- Modify: `control-plane/src/organisms/SettingsPanel.tsx` (replace the Integrations placeholder with the real component)
- Test: `control-plane/src/organisms/settings/IntegrationsGroup.test.tsx`

**Interfaces:**
- Consumes: `listConnectorVendors`, `listMyConnectors`, `addConnector`, `updateConnector`, `deleteConnector`, `verifyConnector` (Task 9), `ConnectorFormModal` (Task 11).
- Produces: `IntegrationsGroup` — fetches vendors + the user's saved instances on mount, renders one `.connector-card` per vendor (icon-free for now — `label`/`description` from the registry, a `.connector-status` pill, a list of saved `.connector-instance` rows with a Remove action, and a "+ add another"/"Connect {vendor}" button that opens `ConnectorFormModal`).

- [ ] **Step 1: Write the failing test**

```tsx
// control-plane/src/organisms/settings/IntegrationsGroup.test.tsx
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationsGroup } from "./IntegrationsGroup";

const VENDORS = [
  { id: "github", label: "GitHub", description: "Repo access.", fields: [{ key: "token", label: "Token", secret: true }], verifyExtraFields: [] },
  { id: "datadog", label: "Datadog", description: "Monitors.", fields: [{ key: "apiKey", label: "API key", secret: true }], verifyExtraFields: [] },
];

describe("IntegrationsGroup", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders one card per vendor, each showing its description", async () => {
    render(
      <IntegrationsGroup
        listVendors={vi.fn(async () => VENDORS)}
        listConnectors={vi.fn(async () => [])}
        addConnector={vi.fn()}
        updateConnector={vi.fn()}
        deleteConnector={vi.fn()}
        verifyConnector={vi.fn()}
      />,
    );
    expect(await screen.findByText("GitHub")).toBeDefined();
    expect(await screen.findByText("Datadog")).toBeDefined();
    expect(screen.getByText(/repo access/i)).toBeDefined();
  });

  it("a vendor with a saved instance shows it with a connected status, not a bare Connect button", async () => {
    render(
      <IntegrationsGroup
        listVendors={vi.fn(async () => VENDORS)}
        listConnectors={vi.fn(async () => [{ id: "c1", vendorId: "github", label: "personal", fields: { hasToken: true } }])}
        addConnector={vi.fn()}
        updateConnector={vi.fn()}
        deleteConnector={vi.fn()}
        verifyConnector={vi.fn()}
      />,
    );
    expect(await screen.findByText("personal")).toBeDefined();
    expect(screen.getByText(/add another/i)).toBeDefined();
  });

  it("clicking Connect on a vendor with zero instances opens the connect form for that vendor", async () => {
    render(
      <IntegrationsGroup
        listVendors={vi.fn(async () => VENDORS)}
        listConnectors={vi.fn(async () => [])}
        addConnector={vi.fn()}
        updateConnector={vi.fn()}
        deleteConnector={vi.fn()}
        verifyConnector={vi.fn()}
      />,
    );
    await userEvent.click((await screen.findAllByRole("button", { name: /^connect/i }))[0]!);
    expect(await screen.findByPlaceholderText(/label/i)).toBeDefined();
  });

  it("adding a connector calls addConnector and the new instance appears without a manual page reload", async () => {
    const addConnector = vi.fn(async () => ({ id: "c2", vendorId: "github", label: "acme-corp", fields: { hasToken: true } }));
    render(
      <IntegrationsGroup
        listVendors={vi.fn(async () => VENDORS)}
        listConnectors={vi.fn(async () => [])}
        addConnector={addConnector}
        updateConnector={vi.fn()}
        deleteConnector={vi.fn()}
        verifyConnector={vi.fn()}
      />,
    );
    await userEvent.click((await screen.findAllByRole("button", { name: /^connect/i }))[0]!);
    await userEvent.type(await screen.findByPlaceholderText(/label/i), "acme-corp");
    await userEvent.type(screen.getByPlaceholderText(/token/i), "gh-tok");
    await userEvent.click(screen.getByRole("button", { name: /^connect$/i }));
    await waitFor(() => expect(addConnector).toHaveBeenCalled());
    expect(await screen.findByText("acme-corp")).toBeDefined();
  });

  it("removing a saved instance calls deleteConnector and it disappears from the card", async () => {
    const deleteConnector = vi.fn(async () => ({ ok: true }));
    render(
      <IntegrationsGroup
        listVendors={vi.fn(async () => VENDORS)}
        listConnectors={vi.fn(async () => [{ id: "c1", vendorId: "github", label: "personal", fields: { hasToken: true } }])}
        addConnector={vi.fn()}
        updateConnector={vi.fn()}
        deleteConnector={deleteConnector}
        verifyConnector={vi.fn()}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /remove personal/i }));
    await waitFor(() => expect(deleteConnector).toHaveBeenCalledWith("c1"));
    await waitFor(() => expect(screen.queryByText("personal")).toBeNull());
  });
});
```

- [ ] **Step 2: Run, confirm failure.**

- [ ] **Step 3: Implement**

```tsx
// control-plane/src/organisms/settings/IntegrationsGroup.tsx
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ConnectorInstanceRecord, ConnectorVendorMeta } from "../../hooks/useBrokerChat";
import { ConnectorFormModal } from "./ConnectorFormModal";

interface IntegrationsGroupProps {
  listVendors: () => Promise<ConnectorVendorMeta[]>;
  listConnectors: () => Promise<ConnectorInstanceRecord[]>;
  addConnector: (body: { vendorId: string; label: string; fields: Record<string, string> }) => Promise<{ error?: string }>;
  updateConnector: (id: string, body: { label?: string; fields?: Record<string, string> }) => Promise<{ error?: string }>;
  deleteConnector: (id: string) => Promise<{ ok?: boolean; error?: string }>;
  verifyConnector: (id: string, extra?: Record<string, string>) => Promise<{ ok?: boolean; detail?: string; error?: string }>;
}

/** Card grid, one per registered vendor — a vendor's saved instances list inline, "+ add another" opens the generic connect form. */
export function IntegrationsGroup({
  listVendors,
  listConnectors,
  addConnector,
  updateConnector,
  deleteConnector,
  verifyConnector,
}: IntegrationsGroupProps) {
  const [vendors, setVendors] = useState<ConnectorVendorMeta[]>([]);
  const [connectors, setConnectors] = useState<ConnectorInstanceRecord[]>([]);
  const [formVendor, setFormVendor] = useState<ConnectorVendorMeta | null>(null);
  const [formExisting, setFormExisting] = useState<ConnectorInstanceRecord | undefined>(undefined);

  const refresh = async () => {
    setConnectors(await listConnectors());
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once load, same convention as ChannelsManagerModal's open-effect
  useEffect(() => {
    void listVendors().then(setVendors);
    void refresh();
  }, []);

  const openConnect = (vendor: ConnectorVendorMeta, existing?: ConnectorInstanceRecord) => {
    setFormVendor(vendor);
    setFormExisting(existing);
  };

  const closeForm = () => {
    setFormVendor(null);
    setFormExisting(undefined);
  };

  const handleSave = async (body: { vendorId: string; label: string; fields: Record<string, string> }) => {
    const result = formExisting
      ? await updateConnector(formExisting.id, { label: body.label, fields: body.fields })
      : await addConnector(body);
    if (!result.error) await refresh();
    return result;
  };

  const handleRemove = async (id: string) => {
    await deleteConnector(id);
    await refresh();
  };

  return (
    <>
      <h1>integrations</h1>
      <div className="connector-grid">
        {vendors.map((vendor) => {
          const instances = connectors.filter((c) => c.vendorId === vendor.id);
          return (
            <div key={vendor.id} className="connector-card">
              <div className="connector-card__head">
                <b>{vendor.label}</b>
                <em>{vendor.description}</em>
              </div>
              {instances.map((inst) => (
                <div key={inst.id} className="connector-instance">
                  <span
                    className={`connector-status ${Object.values(inst.fields).some((v) => v === true) ? "connector-status--connected" : "connector-status--unconnected"}`}
                  >
                    {Object.values(inst.fields).some((v) => v === true) ? "connected" : "not connected"}
                  </span>
                  <span>{inst.label}</span>
                  <button type="button" className="settings-btn" onClick={() => openConnect(vendor, inst)}>
                    edit
                  </button>
                  <button
                    type="button"
                    className="repo-row__remove"
                    onClick={() => void handleRemove(inst.id)}
                    aria-label={`Remove ${inst.label}`}
                  >
                    <X size={12} strokeWidth={2} />
                  </button>
                </div>
              ))}
              <button type="button" className="settings-btn settings-btn--wide" onClick={() => openConnect(vendor)}>
                {instances.length > 0 ? "+ add another" : `Connect ${vendor.label}`}
              </button>
            </div>
          );
        })}
      </div>
      <ConnectorFormModal
        open={formVendor !== null}
        vendor={formVendor}
        existing={formExisting}
        onClose={closeForm}
        onSave={handleSave}
        onVerify={formExisting ? (extra) => verifyConnector(formExisting.id, extra) : undefined}
      />
    </>
  );
}
```

- [ ] **Step 4: Wire into `SettingsPanel.tsx`, with OPTIONAL props so this task ends green without touching `HomePage.tsx`**

Every prop `IntegrationsGroup` needs becomes an **optional** addition to `SettingsPanelProps` (mirroring the exact pattern the old popover already used for `onManageChannels?`/`onManageConnectors?` before Task 10's rewrite) — this keeps `HomePage.tsx`'s existing call site compiling untouched until Task 15 actually wires it for real, so typecheck stays clean at the end of every task, not just the last one:

```tsx
// control-plane/src/organisms/SettingsPanel.tsx — diff
  interface SettingsPanelProps {
    open: boolean;
    onClose: () => void;
    onReset: (scope: ResetScope) => Promise<{ ok?: boolean; error?: string; swarm?: unknown }>;
    theme: ThemeId;
    onThemeChange: (theme: ThemeId) => void;
    initialGroup?: SettingsGroupId;
+   listConnectorVendors?: () => Promise<ConnectorVendorMeta[]>;
+   listMyConnectors?: () => Promise<ConnectorInstanceRecord[]>;
+   addConnector?: (body: { vendorId: string; label: string; fields: Record<string, string> }) => Promise<{ error?: string }>;
+   updateConnector?: (id: string, body: { label?: string; fields?: Record<string, string> }) => Promise<{ error?: string }>;
+   deleteConnector?: (id: string) => Promise<{ ok?: boolean; error?: string }>;
+   verifyConnector?: (id: string, extra?: Record<string, string>) => Promise<{ ok?: boolean; detail?: string; error?: string }>;
  }
```

```tsx
- {active === "integrations" && <p className="wizard__hint">Integrations — coming in the next task.</p>}
+ {active === "integrations" &&
+   (listConnectorVendors && listMyConnectors && addConnector && updateConnector && deleteConnector && verifyConnector ? (
+     <IntegrationsGroup
+       listVendors={listConnectorVendors}
+       listConnectors={listMyConnectors}
+       addConnector={addConnector}
+       updateConnector={updateConnector}
+       deleteConnector={deleteConnector}
+       verifyConnector={verifyConnector}
+     />
+   ) : (
+     <p className="wizard__hint">Integrations — not wired up yet.</p>
+   ))}
```

Add the 6 new params to the destructured prop list and import `IntegrationsGroup`, `ConnectorVendorMeta`, `ConnectorInstanceRecord`. `HomePage.tsx` isn't updated to pass these until Task 15 — until then `SettingsPanel` compiles and runs exactly as it did after Task 10, just with `IntegrationsGroup` itself fully built, tested, and ready for Task 15 to flip on.

- [ ] **Step 5: Run tests, typecheck, lint, commit.**

```bash
cd control-plane
pnpm run test
pnpm run typecheck
pnpm run lint
git add src/organisms/settings/IntegrationsGroup.tsx src/organisms/settings/IntegrationsGroup.test.tsx src/organisms/SettingsPanel.tsx
git commit -m "feat(control-plane): Integrations card grid, wired into the Settings shell behind optional props"
```

---

### Task 13: `settings/ChannelsGroup.tsx` — adapted from `ChannelsManagerModal`, wired into `SettingsPanel`; delete the old modal

**Files:**
- Create: `control-plane/src/organisms/settings/ChannelsGroup.tsx`
- Modify: `control-plane/src/organisms/SettingsPanel.tsx` (replace the Channels placeholder)
- Delete: `control-plane/src/organisms/ChannelsManagerModal.tsx`
- Delete: `control-plane/src/organisms/ChannelsManagerModal.test.tsx`
- Create: `control-plane/src/organisms/settings/ChannelsGroup.test.tsx`

**Interfaces:**
- Consumes: `listWorkspaceRecords`, `getWorkspaceChannels`, `saveWorkspaceChannels`, `verifyWorkspaceDiscord` — same functions `ChannelsManagerModal` already used, unchanged by this plan.
- Produces: `ChannelsGroup` — the SAME internal behavior as `ChannelsManagerModal` (workspace picker + Discord bot token/channel-list form + Test connection), re-parented into a plain container instead of its own `.scrim`/header/close-button, since the full-screen shell now owns that chrome.

- [ ] **Step 1: Write `ChannelsGroup.tsx`** — this is a re-parenting, not a rewrite: strip `ChannelsManagerModal`'s `open`/`onClose` props, its `if (!open) return null` early return, its outer `<div className="scrim">` wrapper and its own `<header>` (title + close button), and its `<section className="workspace-manager">` wrapper (the full-screen shell already provides the surrounding chrome) — keep every other line (state, `selectWorkspace`, `submit`, `testDiscord`, `updateList`/`addToList`/`removeFromList`, and the two-column `.workspace-manager__body` → `.workspace-manager__list` + `.account-panel__form` JSX) verbatim:

```tsx
// control-plane/src/organisms/settings/ChannelsGroup.tsx
import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ChannelsRecord, WorkspaceRecord } from "../../hooks/useBrokerChat";

interface ChannelsGroupProps {
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
  botToken: string;
  textChannels: string[];
  voiceChannels: string[];
}

const blankForm = (): FormState => ({ hasDiscordToken: false, botToken: "", textChannels: [""], voiceChannels: [""] });

/** Discord channel config, now a Settings group — same behavior as the old standalone ChannelsManagerModal, just re-parented. */
export function ChannelsGroup({ listWorkspaces, getChannels, saveChannels, verifyDiscord }: ChannelsGroupProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(blankForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [testing, setTesting] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once load, same convention as IntegrationsGroup
  useEffect(() => {
    void listWorkspaces().then(setWorkspaces, (err: unknown) => setLoadError(`Could not load workspaces — ${String(err)}`));
  }, []);

  const selectWorkspace = (name: string) => {
    setSelected(name);
    setError(null);
    setTestResult(null);
    void getChannels(name).then((c) =>
      setForm({
        hasDiscordToken: c.hasDiscordToken,
        botToken: "",
        textChannels: c.textChannels.length ? c.textChannels : [""],
        voiceChannels: c.voiceChannels.length ? c.voiceChannels : [""],
      }),
    );
  };

  const submit = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
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

  return (
    <>
      <h1>channels</h1>
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
              <input type="password" value={form.botToken} onChange={(e) => setForm((f) => ({ ...f, botToken: e.target.value }))} placeholder="Discord bot token" />

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
    </>
  );
}
```

- [ ] **Step 2: Port `ChannelsManagerModal.test.tsx`'s two existing tests to `ChannelsGroup.test.tsx`**, dropping the `open`/`onClose` props (component no longer has them) and the outer scrim assertions — the two behaviors themselves ("picking a workspace loads its channel config; saving submits the bot token and channel lists" and "Test connection calls verifyDiscord…") stay, just against `ChannelsGroup` with `listWorkspaces`/`getChannels`/`saveChannels`/`verifyDiscord` props (same names as before, minus `listWorkspaces` — wait, the prop is already called `listWorkspaces` in both — no rename needed there). Read the deleted file's two tests first (still in git history: `git show HEAD:control-plane/src/organisms/ChannelsManagerModal.test.tsx`) and adapt them mechanically rather than rewriting from scratch.

- [ ] **Step 3: Wire into `SettingsPanel.tsx`, same optional-props pattern as Task 12** — add `listWorkspaceRecords?`, `getWorkspaceChannels?`, `saveWorkspaceChannels?`, `verifyWorkspaceDiscord?` to `SettingsPanelProps`, render `ChannelsGroup` when all four are present, else the same "not wired up yet" fallback:

```tsx
// control-plane/src/organisms/SettingsPanel.tsx — diff
- {active === "channels" && <p className="wizard__hint">Channels — coming in the next task.</p>}
+ {active === "channels" &&
+   (listWorkspaceRecords && getWorkspaceChannels && saveWorkspaceChannels && verifyWorkspaceDiscord ? (
+     <ChannelsGroup
+       listWorkspaces={listWorkspaceRecords}
+       getChannels={getWorkspaceChannels}
+       saveChannels={saveWorkspaceChannels}
+       verifyDiscord={verifyWorkspaceDiscord}
+     />
+   ) : (
+     <p className="wizard__hint">Channels — not wired up yet.</p>
+   ))}
```

- [ ] **Step 4: Delete the old files, run tests, typecheck, lint, commit.**

```bash
cd control-plane
rm src/organisms/ChannelsManagerModal.tsx src/organisms/ChannelsManagerModal.test.tsx
pnpm run test
pnpm run typecheck
pnpm run lint
git add -A
git commit -m "feat(control-plane): Channels settings group replaces the standalone ChannelsManagerModal"
```

---

### Task 14: `WorkspaceManagerModal.tsx` — connector-picker dropdown added to the Atlassian fieldset and each repo row

**Files:**
- Modify: `control-plane/src/organisms/WorkspaceManagerModal.tsx`
- Test: `control-plane/src/organisms/WorkspaceManagerModal.test.tsx` (create — none exists today, confirmed by research)

**Interfaces:**
- Consumes: `listMyConnectors` (Task 9).
- Produces: `WorkspaceManagerModal` gains one new prop, `listMyConnectors: () => Promise<ConnectorInstanceRecord[]>`, fetched once on open. `form.atlassian.connectorId` and each `form.repos[i].github.connectorId` become settable via a new `<select>` in each spot.

**Correction to the design spec's phrasing:** the spec said this task "replaces inline email/token inputs" — that's not accurate to the actual current component (confirmed by research): `WorkspaceManagerModal`'s Atlassian fieldset has never had email/token inputs (those only ever lived in the old `AccountPanel`, now gone) — it only has `siteUrl`/`jiraProjectKeys[0]`/`confluenceSpaceKeys[0]`. Per-repo GitHub fields are `owner`/`repo` (repo *identity*, not a credential). This task **adds** a connector-picker dropdown alongside those existing fields — it does not replace anything.

- [ ] **Step 1: Write the failing test**

```tsx
// control-plane/src/organisms/WorkspaceManagerModal.test.tsx
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceManagerModal } from "./WorkspaceManagerModal";

const CONNECTORS = [
  { id: "conn-a", vendorId: "atlassian", label: "personal", fields: {} },
  { id: "conn-b", vendorId: "github", label: "acme-corp", fields: {} },
  { id: "conn-c", vendorId: "github", label: "personal", fields: {} },
];

describe("WorkspaceManagerModal — connector pickers", () => {
  afterEach(() => {
    cleanup();
  });

  it("the Atlassian fieldset's connector dropdown lists only atlassian-vendor connectors, by label", async () => {
    render(
      <WorkspaceManagerModal
        open
        onClose={() => {}}
        list={vi.fn(async () => [])}
        save={vi.fn()}
        remove={vi.fn()}
        verifyAtlassian={vi.fn()}
        verifyRepoGithub={vi.fn()}
        listMyConnectors={vi.fn(async () => CONNECTORS)}
      />,
    );
    const atlassianSelect = await screen.findByLabelText(/atlassian connector/i);
    const options = Array.from(atlassianSelect.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toContain("personal");
    expect(options).not.toContain("acme-corp"); // that's a github-vendor connector, must not appear here
  });

  it("each repo row's connector dropdown lists only github-vendor connectors, and two repos can pick different ones", async () => {
    render(
      <WorkspaceManagerModal
        open
        onClose={() => {}}
        list={vi.fn(async () => [])}
        save={vi.fn()}
        remove={vi.fn()}
        verifyAtlassian={vi.fn()}
        verifyRepoGithub={vi.fn()}
        listMyConnectors={vi.fn(async () => CONNECTORS)}
      />,
    );
    const repoSelects = await screen.findAllByLabelText(/github connector/i);
    expect(repoSelects.length).toBeGreaterThanOrEqual(1);
    const options = Array.from(repoSelects[0]!.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(["acme-corp", "personal"]));
    expect(options).not.toContain("personal (atlassian)"); // no atlassian connector leaks into a github picker
  });

  it("picking a connector for a repo and saving includes that repo's connectorId in the saved payload", async () => {
    const save = vi.fn(async () => ({}));
    render(
      <WorkspaceManagerModal
        open
        onClose={() => {}}
        list={vi.fn(async () => [])}
        save={save}
        remove={vi.fn()}
        verifyAtlassian={vi.fn()}
        verifyRepoGithub={vi.fn()}
        listMyConnectors={vi.fn(async () => CONNECTORS)}
      />,
    );
    await userEvent.type(screen.getByPlaceholderText("acme-web"), "web");
    await userEvent.type(screen.getByPlaceholderText(/Users\/me\/code/i), "/tmp/web");
    await userEvent.type(screen.getByPlaceholderText("GitHub owner"), "acme");
    await userEvent.type(screen.getByPlaceholderText("GitHub repo"), "web");
    const repoSelect = (await screen.findAllByLabelText(/github connector/i))[0]!;
    await userEvent.selectOptions(repoSelect, "conn-b");
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          repos: [expect.objectContaining({ github: expect.objectContaining({ connectorId: "conn-b" }) })],
        }),
        true,
      ),
    );
  });
});
```

- [ ] **Step 2: Run, confirm failure.**

- [ ] **Step 3: Implement**

Add the prop and a fetch-on-open effect:

```tsx
// control-plane/src/organisms/WorkspaceManagerModal.tsx — new prop + state
interface WorkspaceManagerModalProps {
  // ...existing props unchanged...
  listMyConnectors: () => Promise<ConnectorInstanceRecord[]>;
}
```

```tsx
// inside the component, alongside the existing `refresh`/open-effect
const [connectors, setConnectors] = useState<ConnectorInstanceRecord[]>([]);
// biome-ignore lint/correctness/useExhaustiveDependencies: see the existing open-effect above this one for the same reasoning
useEffect(() => {
  if (!open) return;
  void listMyConnectors().then(setConnectors);
}, [open]);
```

Add the Atlassian connector picker inside `.workspace-manager__atlassian`, right after the existing `siteUrl` input:

```tsx
<label htmlFor="atlassian-connector">
  Atlassian connector
  <select
    id="atlassian-connector"
    aria-label="Atlassian connector"
    value={form.atlassian?.connectorId ?? ""}
    onChange={(e) =>
      setForm((f) => ({ ...f, atlassian: { siteUrl: f.atlassian?.siteUrl ?? "", ...f.atlassian, connectorId: e.target.value || undefined } }))
    }
  >
    <option value="">— none picked —</option>
    {connectors.filter((c) => c.vendorId === "atlassian").map((c) => (
      <option key={c.id} value={c.id}>
        {c.label}
      </option>
    ))}
  </select>
</label>
```

Add a per-repo GitHub connector picker inside the `.repo-row` map, right after the existing `repo`/`owner` inputs:

```tsx
<select
  aria-label="GitHub connector"
  value={repo.github?.connectorId ?? ""}
  onChange={(e) =>
    updateRepo(i, { github: { owner: repo.github?.owner ?? "", repo: repo.github?.repo ?? "", connectorId: e.target.value || undefined } })
  }
>
  <option value="">— none picked —</option>
  {connectors.filter((c) => c.vendorId === "github").map((c) => (
    <option key={c.id} value={c.id}>
      {c.label}
    </option>
  ))}
</select>
```

Import `ConnectorInstanceRecord` from `../hooks/useBrokerChat`.

- [ ] **Step 4: Run tests, typecheck, lint, commit.**

```bash
cd control-plane
pnpm run test
pnpm run typecheck
pnpm run lint
git add src/organisms/WorkspaceManagerModal.tsx src/organisms/WorkspaceManagerModal.test.tsx
git commit -m "feat(control-plane): WorkspaceManagerModal gets per-vendor connector pickers for Atlassian and per-repo GitHub"
```

---

### Task 15: `HomePage.tsx` — final wiring, delete `AccountPanel.tsx`

**Files:**
- Modify: `control-plane/src/pages/HomePage.tsx`
- Delete: `control-plane/src/organisms/AccountPanel.tsx`
- Delete: `control-plane/src/organisms/AccountPanel.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 9-14.
- Produces: `HomePage` mounts the full-screen `SettingsPanel` with all 10 connector/channels functions actually passed (flipping on Tasks 12/13's optional-prop-gated groups); `AccountPanel`'s mount is removed entirely (its functionality is now the Integrations group, reachable through the same shell); `ToolRail`'s avatar (`onAccount`) opens `SettingsPanel` with `initialGroup="integrations"` instead of a separate `AccountPanel`.

- [ ] **Step 1: Update `HomePage.tsx`**

Remove the `AccountPanel` import and its JSX mount (current `main.ts:9`, `:250-256`... actually `HomePage.tsx:9` and `:250-256` per the research above). Remove the now-obsolete `accountOpen`/`channelsOpen` split — a single `settingsOpen` boolean plus an `initialSettingsGroup` piece of state covers both entry points:

```tsx
// control-plane/src/pages/HomePage.tsx — state changes
- const [settingsOpen, setSettingsOpen] = useState(false);
- const [workspacesOpen, setWorkspacesOpen] = useState(false);
- const [channelsOpen, setChannelsOpen] = useState(false);
- const [accountOpen, setAccountOpen] = useState(false);
+ const [settingsOpen, setSettingsOpen] = useState(false);
+ const [settingsInitialGroup, setSettingsInitialGroup] = useState<"general" | "integrations" | "channels" | "themes">("general");
+ const [workspacesOpen, setWorkspacesOpen] = useState(false);
```

```tsx
// ToolRail wiring
<ToolRail
  onSessions={() => setSessionsOpen((open) => !open)}
- onSettings={() => setSettingsOpen((open) => !open)}
- onAccount={() => setAccountOpen(true)}
+ onSettings={() => {
+   setSettingsInitialGroup("general");
+   setSettingsOpen(true);
+ }}
+ onAccount={() => {
+   setSettingsInitialGroup("integrations");
+   setSettingsOpen(true);
+ }}
/>
```

```tsx
// SettingsPanel mount — all 10 functions now actually passed, flipping on Tasks 12/13's groups
<SettingsPanel
  open={settingsOpen}
  onClose={() => setSettingsOpen(false)}
  onReset={resetSetup}
  theme={theme}
  onThemeChange={setTheme}
  initialGroup={settingsInitialGroup}
  listConnectorVendors={listConnectorVendors}
  listMyConnectors={listMyConnectors}
  addConnector={addConnector}
  updateConnector={updateConnector}
  deleteConnector={deleteConnector}
  verifyConnector={verifyConnector}
  listWorkspaceRecords={listWorkspaceRecords}
  getWorkspaceChannels={getWorkspaceChannels}
  saveWorkspaceChannels={saveWorkspaceChannels}
  verifyWorkspaceDiscord={verifyWorkspaceDiscord}
/>
```

Remove the `<ChannelsManagerModal ... />` mount and `<AccountPanel ... />` mount entirely (both blocks, currently `HomePage.tsx:241-256`) — their functionality now lives inside `SettingsPanel`'s Channels/Integrations groups. `WorkspaceManagerModal`'s mount gains the one new prop from Task 14:

```tsx
<WorkspaceManagerModal
  open={workspacesOpen}
  onClose={() => setWorkspacesOpen(false)}
  list={listWorkspaceRecords}
  save={saveWorkspace}
  remove={removeWorkspace}
  verifyAtlassian={verifyWorkspaceAtlassian}
  verifyRepoGithub={verifyRepoGithub}
  listMyConnectors={listMyConnectors}
/>
```

Remove the now-unused `AccountPanel`/`ChannelsManagerModal` imports, and remove `getMe`/`updateMe`/`verifyGithubToken` from the `useBrokerChat()` destructure if nothing else in this file still uses them (check — `getMe`/`updateMe` may still be needed if any other part of `HomePage` reads the operator's name; if so, keep those two, only `verifyGithubToken` is fully gone per Task 9).

- [ ] **Step 2: Delete `AccountPanel.tsx` and its test.**

```bash
cd control-plane
rm src/organisms/AccountPanel.tsx src/organisms/AccountPanel.test.tsx
```

- [ ] **Step 3: Run the full suite, typecheck, lint.**

```bash
pnpm run test
pnpm run typecheck
pnpm run lint
```

- [ ] **Step 4: Manual verification** (this is the point where all three layers are finally wired together end-to-end):
  - Launch `pnpm tauri dev` (or the already-running dev instance).
  - Click the avatar → confirm the full-screen Settings surface opens directly on Integrations.
  - Click Settings in the rail → confirm it opens on General.
  - Add a GitHub connector labeled "personal" with a real PAT → confirm the card shows it as connected, "Test connection"/Re-check via the card's edit flow confirms a real GitHub identity.
  - Add a second GitHub connector labeled "acme-corp" → confirm both appear under the same GitHub card, independently.
  - Add an Atlassian connector, using the transient "Site URL (used only to test this connection)" field to Re-check it → confirm the check succeeds against a real Jira site and that reopening the card's edit form does NOT show a remembered site URL (proving it truly wasn't persisted).
  - Open "manage workspaces…" → confirm the Atlassian fieldset and each repo row now show a connector-picker dropdown populated with the connectors just added, filtered correctly by vendor.
  - Pick connectors for a workspace's Atlassian block and a repo's GitHub block, save, reopen the workspace → confirm the picks persisted.
  - Click "Test connection" on the workspace's Atlassian fieldset and on a repo's GitHub row → confirm both succeed, now resolving through the picked connector.
  - Switch to the Channels group from the same Settings surface → confirm it behaves identically to the old standalone Channels modal (pick a workspace, save a Discord token + channels, Test connection).
  - Delete a connector from a card → confirma workspace that had picked it now shows "— none picked —" on reopen (soft-fail, not a crash) — per the spec's explicit design for a stale `connectorId`.

- [ ] **Step 5: Commit.**

```bash
git add -A
git commit -m "feat(control-plane): wire full-screen Settings end-to-end; remove AccountPanel, absorbed into Integrations"
```

---

## Final Verification

- [ ] **Full swarm suite:** `cd swarm && npm test` → all green, including every test added in Tasks 1-5. (The 2 pre-existing, unrelated `agent-sessions.test.ts` turn-timeout failures from prior features are a known baseline gap — confirm the count doesn't grow beyond that.)
- [ ] **Full broker suite:** `cd broker && npm test` → all green, including every test added in Tasks 6-7.
- [ ] **Full control-plane suite + typecheck + lint:** `cd control-plane && pnpm run test && pnpm run typecheck && pnpm run lint` → all green, including every `*.test.tsx` added in Tasks 10-14.
- [ ] **Manual e2e:** the full checklist in Task 15, Step 4, above.

## Self-Review Notes

- **Spec coverage:** §1 (data model) → Tasks 1-2. §2 (verification, including the Atlassian site-independent-check gap discovered and resolved during planning) → Task 1. §3 (workspace-side resolution) → Tasks 3, 5, 14. §4 (API) → Tasks 4, 6-7. §5 (UI — full-screen Settings, Integrations card grid, connect-form modal, Channels/General/Themes groups) → Tasks 8, 10-13, 15. Every "Settled decision" in the spec (generic registry, per-vendor fields, live verify for every vendor including the Atlassian carve-out, full Atlassian/GitHub migration with no legacy path, multi-credential with explicit per-workspace/per-repo pick, store+verify-only scope for new vendors, full-screen Settings shell replacing the popover, Workspaces staying separate) is reflected in a task above.
- **Placeholder scan:** no "TBD"/"add appropriate handling"-style steps. Task 4's Step 4 deliberately leaves two tests as harness-matching prose rather than full code (the route-level `redactUser`/verify-400-path tests) — a stated, reasoned exception (this file's actual server-boot-for-route-tests pattern needs to be read fresh, not guessed at plan-writing time), matching the same kind of exception the original workspace-channels plan made for its highest-risk task's manual-verification step.
- **Type consistency:** `ConnectorFieldDef`/`ConnectorVendorDef` (Task 1, swarm) vs. `ConnectorFieldDef`/`ConnectorVendorMeta` (Task 6, broker) vs. `ConnectorFieldDef`/`ConnectorVendorMeta` (Task 9, control-plane) — cross-checked field names (`key`, `label`, `secret`, `type?`, `options?`) match exactly across all three layers' redaction boundary; `ConnectorInstance` (swarm, raw) vs. `ConnectorInstanceRecord` (broker + control-plane, redacted `fields: Record<string, string | boolean>`) — cross-checked the redaction shape Task 4 produces (`has<Key>` for secrets, real value for non-secrets) is exactly what Tasks 11-12's UI code reads.
- **Known open questions resolved during planning, not assumed away:** the Atlassian site-independent-verification gap (researched, then a real design decision made with Edwin rather than guessed) is the clearest example — discovered mid-plan-writing, not before, and handled the same way this session has handled every other genuine unknown: research first, present the real trade-off, let the human decide.
- **A note for the eventual final whole-branch review**, not something to act on now: this plan's control-plane tasks lean on an "optional props, gated rendering" staging technique (Tasks 12-13) specifically so every task ends with a fully green test/typecheck/lint run — worth the final reviewer double-checking that Task 15 actually flips every one of those optional props on, and that no group is left silently showing its "not wired up yet" fallback in the shipped app.

