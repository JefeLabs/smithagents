# Workspace External Connections (Jira, Confluence, GitHub) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Workspace point at a Jira/Confluence site and a WorkspaceRepo point at a GitHub repo, store the actual credentials on a new per-user `User` record, and use the pairing of the two — both from delegated coding work (swarm) and live in conversation (broker) — so the crew never has more access than the human it's acting for.

**Architecture:** Config (site URL, project/space keys, owner/repo) rides inline on the existing `Workspace`/`WorkspaceRepo` records in `swarm/.smith/workspaces/`. Credentials live on a new, untracked `User` record in `swarm/.smith/users/`. Nothing stores the pairing — every consumer (a verify route, a delegated task, a broker tool call) resolves `resolveCurrentUser()` fresh and pairs it with the relevant workspace/repo config at the moment of use.

**Tech Stack:** TypeScript, Fastify (swarm), plain Node `http`/`ws` (broker), React + Vite (control-plane), `node:test` (swarm/broker tests), Vitest (control-plane tests), Biome (lint/format).

## Global Constraints

- Spec source of truth: `docs/superpowers/specs/2026-08-04-workspace-connections-design.md`.
- No new "project" layer — everything extends `Workspace`/`WorkspaceRepo` (already the settled grouping concept).
- Any file holding a credential stays untracked: `swarm/.smith/users/*.json` relies on the existing blanket `swarm/.smith/*` `.gitignore` rule — do NOT add a `!swarm/.smith/users/` override.
- API responses never round-trip a raw secret: redact to `hasAtlassianToken`/`hasGithubToken` booleans.
- Agent privilege ceiling = the requesting user's own token — no separate agent- or workspace-level credential anywhere.
- Swarm tests: `node --import tsx --test --test-timeout 60000 'src/*.test.ts' 'src/**/*.test.ts'` (run via `npm test` from `swarm/`).
- Broker tests: `node --import tsx --test src/*.test.ts` (run via `npm test` from `broker/`).
- Control-plane tests: `vitest run` (run via `npm run test` from `control-plane/`); typecheck via `npm run typecheck` (`tsc --noEmit`); lint via `npm run lint` (`biome check .`).
- Fastify route error convention: `reply.status(<code>).send({ error: '<message>' })` — not `reply.code(...)`.
- `node:test` conventions: `import { test } from 'node:test'; import assert from 'node:assert/strict';` — no `describe`, no hooks; fixtures are real temp dirs via `mkdtemp(join(tmpdir(), '<prefix>-'))`.
- Broker HTTP-client tests: hand-rolled fake matching the injected structural interface (no mocking library) — see `swarm-client.test.ts`'s `fakeFetch` pattern.
- Control-plane tests: Vitest with `vi.stubGlobal('fetch', ...)`; `test.globals` is NOT set, so every test file imports `describe`/`it`/`expect`/`vi` explicitly from `"vitest"`, and component tests must call `cleanup()` in `afterEach` (RTL auto-cleanup doesn't register).
- Commit after every task (or, when a task is naturally two commits — e.g. a data-shape change plus its consumer — after each logical unit). Follow the repo's existing terse, present-tense commit style (see `git log`).

---

## Phase 1 — Config & Credential Plumbing

### Task 1: `Workspace`/`WorkspaceRepo` gain inline `atlassian`/`github` config

**Files:**
- Modify: `swarm/src/workspaces.ts`
- Test: `swarm/src/workspaces.test.ts`

**Interfaces:**
- Produces: `Workspace.atlassian?: { siteUrl: string; jiraProjectKeys?: string[]; confluenceSpaceKeys?: string[] }`, `WorkspaceRepo.github?: { owner: string; repo: string }` — every later task that reads workspace/repo config uses these exact shapes.

- [ ] **Step 1: Write the failing test**

```ts
// swarm/src/workspaces.test.ts — append
test('atlassian and github config round-trip through save/load', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-'));
  const ws: Workspace = {
    name: 'acme',
    repos: [{ name: 'web', path: '/tmp', branch: 'main', github: { owner: 'acme', repo: 'web' } }],
    atlassian: { siteUrl: 'https://acme.atlassian.net', jiraProjectKeys: ['ACME'], confluenceSpaceKeys: ['DOCS'] },
  };
  await saveWorkspace(dir, ws);
  const [loaded] = await loadWorkspacesFromDir(dir);
  assert.deepEqual(loaded?.atlassian, ws.atlassian);
  assert.deepEqual(loaded?.repos[0]?.github, { owner: 'acme', repo: 'web' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `swarm/`): `npm test -- --test-name-pattern="atlassian and github config round-trip"`
Expected: FAIL — TypeScript error, `atlassian`/`github` don't exist on the type (or a runtime `undefined` mismatch if `tsx` doesn't type-check at test time).

- [ ] **Step 3: Add the fields**

```ts
// swarm/src/workspaces.ts — extend the two interfaces
export interface WorkspaceRepo {
  name: string;
  path: string;
  repository?: string;
  branch?: string;
  /** GitHub API pointer — separate from `repository` (informational remote URL, used for PR/prompt display). */
  github?: { owner: string; repo: string };
}

export interface Workspace {
  name: string;
  description?: string;
  repos: WorkspaceRepo[];
  default?: boolean;
  archived?: boolean;
  /** Non-secret Jira/Confluence pointer. Credentials live on User, never here. */
  atlassian?: {
    siteUrl: string;
    jiraProjectKeys?: string[];
    confluenceSpaceKeys?: string[];
  };
}
```

No change needed to `assertWorkspace` — both new fields are optional and untyped-checked only at compile time; `saveWorkspace`/`loadWorkspacesFromDir` already round-trip whatever shape is on the object via `JSON.stringify`/`JSON.parse`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="atlassian and github config round-trip"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add swarm/src/workspaces.ts swarm/src/workspaces.test.ts
git commit -m "feat(swarm): Workspace/WorkspaceRepo gain atlassian/github config pointers"
```

---

### Task 2: New `User` entity + `resolveCurrentUser`

**Files:**
- Create: `swarm/src/users.ts`
- Test: `swarm/src/users.test.ts`

**Interfaces:**
- Consumes: nothing new (mirrors `workspaces.ts`'s own fs helpers — `readdir`/`readFile`/`mkdir`/`writeFile` from `node:fs/promises`).
- Produces: `User { id: string; name: string; default?: boolean; atlassian?: { email: string; apiToken: string }; github?: { token: string } }`, `loadUsersFromDir(dir): Promise<User[]>`, `saveUser(dir, user): Promise<void>`, `resolveCurrentUser(users: User[]): User | null`.

- [ ] **Step 1: Write the failing tests**

```ts
// swarm/src/users.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadUsersFromDir, saveUser, resolveCurrentUser } from './users.js';
import type { User } from './users.js';

test('resolveCurrentUser prefers the default-flagged user, falls back to the sole file', () => {
  assert.equal(resolveCurrentUser([]), null);
  const solo: User[] = [{ id: 'edwin', name: 'Edwin' }];
  assert.equal(resolveCurrentUser(solo)?.id, 'edwin');
  const multi: User[] = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B', default: true },
  ];
  assert.equal(resolveCurrentUser(multi)?.id, 'b');
});

test('saveUser rejects a bad slug and round-trips a good one, including credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'users-'));
  await assert.rejects(() => saveUser(dir, { id: 'Bad Id', name: 'x' }));
  await saveUser(dir, {
    id: 'edwin',
    name: 'Edwin',
    atlassian: { email: 'edwin@acme.com', apiToken: 'secret-tok' },
    github: { token: 'ghp_secret' },
  });
  const [loaded] = await loadUsersFromDir(dir);
  assert.equal(loaded?.id, 'edwin');
  assert.deepEqual(loaded?.atlassian, { email: 'edwin@acme.com', apiToken: 'secret-tok' });
  assert.deepEqual(loaded?.github, { token: 'ghp_secret' });
});

test('loadUsersFromDir returns [] for a missing dir', async () => {
  assert.deepEqual(await loadUsersFromDir('/tmp/does-not-exist-users-dir'), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="resolveCurrentUser|saveUser|loadUsersFromDir"`
Expected: FAIL — `Cannot find module './users.js'`

- [ ] **Step 3: Implement `users.ts`** (mirrors `workspaces.ts` structurally)

```ts
// swarm/src/users.ts
// Users — the current-operator record credentials live on (design
// §"Settled decisions": config/credential split). One JSON file per user
// under .smith/users/, untracked (holds secrets) unlike agents/workspaces.
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface User {
  id: string;
  name: string;
  /** Mirrors Workspace's default-invariant pattern; single default user today. */
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

/** Write one user to `dir`. Mirror of workspaces.saveWorkspace. */
export async function saveUser(dir: string, user: User): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(user.id)) {
    throw new Error(`Invalid user id "${user.id}": use lowercase letters, digits and dashes`);
  }
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${user.id}.json`), `${JSON.stringify(user, null, 2)}\n`);
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="resolveCurrentUser|saveUser|loadUsersFromDir"`
Expected: PASS

- [ ] **Step 5: Confirm the untracked-storage invariant, then commit**

```bash
cd swarm && mkdir -p .smith/users && echo '{"id":"tmp","name":"tmp"}' > .smith/users/tmp.json
git check-ignore -v .smith/users/tmp.json   # must print the swarm/.smith/* rule — confirms no tracking override is needed
rm -rf .smith/users
git add swarm/src/users.ts swarm/src/users.test.ts
git commit -m "feat(swarm): User entity + resolveCurrentUser"
```

---

### Task 3: Verify helpers — `verifyAtlassian`, `verifyGithubToken`, `verifyGithubRepo`

**Files:**
- Create: `swarm/src/verify-atlassian.ts`
- Create: `swarm/src/verify-github.ts`
- Test: `swarm/src/verify-atlassian.test.ts`
- Test: `swarm/src/verify-github.test.ts`

**Interfaces:**
- Produces:
  - `verifyAtlassian(siteUrl: string, email: string, apiToken: string, opts?: { confluenceSpaceKey?: string }, fetchImpl?: typeof fetch): Promise<{ ok: boolean; detail: string }>`
  - `verifyGithubToken(token: string, fetchImpl?: typeof fetch): Promise<{ ok: boolean; detail: string }>`
  - `verifyGithubRepo(owner: string, repo: string, token: string, fetchImpl?: typeof fetch): Promise<{ ok: boolean; detail: string }>`
- Injectable `fetchImpl` (defaulting to global `fetch`) mirrors `SwarmClient`'s constructor-injected `fetchImpl` pattern in `broker/src/swarm-client.ts` — the only precedent in this codebase for a testable external-HTTP client.

- [ ] **Step 1: Write the failing tests**

```ts
// swarm/src/verify-atlassian.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAtlassian } from './verify-atlassian.js';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async (url: unknown) => {
    assert.match(String(url), /^https:\/\/acme\.atlassian\.net\/rest\/api\/3\/myself$/);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

test('verifyAtlassian: ok on a 200 from /myself', async () => {
  const r = await verifyAtlassian('https://acme.atlassian.net', 'e@acme.com', 'tok', undefined, fakeFetch(200, { accountId: 'x' }));
  assert.equal(r.ok, true);
});

test('verifyAtlassian: not ok on a 401, detail carries the reason', async () => {
  const r = await verifyAtlassian(
    'https://acme.atlassian.net',
    'e@acme.com',
    'bad-tok',
    undefined,
    fakeFetch(401, { message: 'Unauthorized' }),
  );
  assert.equal(r.ok, false);
  assert.match(r.detail, /401|Unauthorized/);
});

test('verifyAtlassian: sends Basic auth of email:apiToken', async () => {
  let sentAuth: string | undefined;
  const f = (async (_url: unknown, init?: RequestInit) => {
    sentAuth = (init?.headers as Record<string, string>).authorization;
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;
  await verifyAtlassian('https://acme.atlassian.net', 'e@acme.com', 'tok', undefined, f);
  assert.equal(sentAuth, `Basic ${Buffer.from('e@acme.com:tok').toString('base64')}`);
});
```

```ts
// swarm/src/verify-github.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyGithubToken, verifyGithubRepo } from './verify-github.js';

test('verifyGithubToken: ok on 200 from /user', async () => {
  const f = (async (url: unknown) => {
    assert.equal(String(url), 'https://api.github.com/user');
    return new Response(JSON.stringify({ login: 'edwincruz' }), { status: 200 });
  }) as typeof fetch;
  const r = await verifyGithubToken('ghp_tok', f);
  assert.equal(r.ok, true);
  assert.match(r.detail, /edwincruz/);
});

test('verifyGithubRepo: not ok on 404, checks the specific repo path', async () => {
  const f = (async (url: unknown) => {
    assert.equal(String(url), 'https://api.github.com/repos/acme/web');
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  }) as typeof fetch;
  const r = await verifyGithubRepo('acme', 'web', 'ghp_tok', f);
  assert.equal(r.ok, false);
  assert.match(r.detail, /404|Not Found/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="verifyAtlassian|verifyGithub"`
Expected: FAIL — modules don't exist yet.

- [ ] **Step 3: Implement the two verify modules**

```ts
// swarm/src/verify-atlassian.ts
// Live check for an Atlassian (Jira/Confluence) site + credential pairing.
// No workspace/user storage here — callers resolve those and hand in plain
// values, so this stays a pure, injectable-fetch HTTP client (design §2).
export interface VerifyResult {
  ok: boolean;
  detail: string;
}

export async function verifyAtlassian(
  siteUrl: string,
  email: string,
  apiToken: string,
  opts?: { confluenceSpaceKey?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  const base = siteUrl.replace(/\/$/, '');
  const auth = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
  const res = await fetchImpl(`${base}/rest/api/3/myself`, { headers: { authorization: auth } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { message?: string });
    return { ok: false, detail: `Jira ${res.status}: ${(body as { message?: string }).message ?? res.statusText}` };
  }
  if (!opts?.confluenceSpaceKey) return { ok: true, detail: 'Jira: authenticated' };
  const spaceRes = await fetchImpl(`${base}/wiki/rest/api/space/${encodeURIComponent(opts.confluenceSpaceKey)}`, {
    headers: { authorization: auth },
  });
  if (!spaceRes.ok) {
    return { ok: false, detail: `Confluence space "${opts.confluenceSpaceKey}" not reachable: ${spaceRes.status}` };
  }
  return { ok: true, detail: 'Jira + Confluence: authenticated' };
}
```

```ts
// swarm/src/verify-github.ts
// Live checks for a GitHub token — generic (account-only, no repo context
// needed) and repo-specific (confirms access to one owner/repo).
export interface VerifyResult {
  ok: boolean;
  detail: string;
}

const GITHUB_API = 'https://api.github.com';

export async function verifyGithubToken(token: string, fetchImpl: typeof fetch = fetch): Promise<VerifyResult> {
  const res = await fetchImpl(`${GITHUB_API}/user`, { headers: { authorization: `Bearer ${token}` } });
  const body = (await res.json().catch(() => ({}))) as { login?: string; message?: string };
  if (!res.ok) return { ok: false, detail: `GitHub ${res.status}: ${body.message ?? 'unauthorized'}` };
  return { ok: true, detail: `Authenticated as ${body.login}` };
}

export async function verifyGithubRepo(
  owner: string,
  repo: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  const res = await fetchImpl(`${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) return { ok: false, detail: `GitHub ${res.status}: ${body.message ?? `no access to ${owner}/${repo}`}` };
  return { ok: true, detail: `Access confirmed to ${owner}/${repo}` };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="verifyAtlassian|verifyGithub"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add swarm/src/verify-atlassian.ts swarm/src/verify-atlassian.test.ts swarm/src/verify-github.ts swarm/src/verify-github.test.ts
git commit -m "feat(swarm): verifyAtlassian/verifyGithubToken/verifyGithubRepo live-check helpers"
```

---

### Task 4: Swarm routes — `GET/PUT /me`, `POST /me/verify-github`

**Files:**
- Modify: `swarm/src/server.ts`

**Interfaces:**
- Consumes: `loadUsersFromDir`, `saveUser`, `resolveCurrentUser` (Task 2), `verifyGithubToken` (Task 3).
- Produces: `GET /me` → `{ id, name, hasAtlassianToken, hasGithubToken }` (200) or `{ id: 'me', name: 'You', hasAtlassianToken: false, hasGithubToken: false }` (200, synthetic — no user file yet); `PUT /me` → same redacted shape; `POST /me/verify-github` → `{ ok, detail }` or `400 { error }` when no token is stored.

- [ ] **Step 1: Add the import and the redaction helper, then the three routes**

```ts
// swarm/src/server.ts — extend the workspaces import block
import {
  loadWorkspacesFromDir,
  resolveRepo,
  saveWorkspace,
  removeWorkspaceFile,
  isGitRepo,
  defaultViolation,
  activeWorkspaces,
  normalizeRepoBranch,
  type Workspace,
} from './workspaces.js';
import { loadUsersFromDir, saveUser, resolveCurrentUser, type User } from './users.js';
import { verifyGithubToken } from './verify-github.js';
```

```ts
// swarm/src/server.ts — inside registerRoutes(), alongside the /workspaces block
const redactUser = (u: User | null) => ({
  id: u?.id ?? 'me',
  name: u?.name ?? 'You',
  hasAtlassianToken: Boolean(u?.atlassian?.apiToken),
  hasGithubToken: Boolean(u?.github?.token),
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
  const merged: User = {
    id: existing?.id ?? 'me',
    name: b.name?.trim() || existing?.name || 'You',
    default: true,
    atlassian: b.atlassian ? { email: b.atlassian.email, apiToken: b.atlassian.apiToken } : existing?.atlassian,
    github: b.github ? { token: b.github.token } : existing?.github,
  };
  try {
    await saveUser(dir, merged);
  } catch (err) {
    return reply.status(400).send({ error: String((err as Error).message) });
  }
  return redactUser(merged);
});

this.app.post('/me/verify-github', async (req, reply) => {
  const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
  const user = resolveCurrentUser(users);
  if (!user?.github?.token) return reply.status(400).send({ error: 'No GitHub token saved yet — add one first.' });
  return verifyGithubToken(user.github.token);
});
```

The `PUT /me` merge is partial-per-credential-block (matching the spec's redaction rule: "PUT /me only touches a credential when the caller explicitly supplies a new value for it") — supplying `atlassian` replaces it wholesale, omitting it keeps the existing one, same as `Workspace`'s PUT merge pattern for `description`/`repos`.

- [ ] **Step 2: Manual verification**

```bash
cd swarm && npm run serve &
curl -s http://localhost:7777/me | jq   # {"id":"me","name":"You","hasAtlassianToken":false,"hasGithubToken":false}
curl -s -X PUT http://localhost:7777/me -H 'content-type: application/json' \
  -d '{"name":"Edwin","github":{"token":"ghp_test"}}' | jq   # hasGithubToken: true, token itself absent
curl -s http://localhost:7777/me | jq '.hasGithubToken'   # true — persisted
curl -s -X POST http://localhost:7777/me/verify-github | jq   # {"ok":false,"detail":"GitHub 401: ..."} (fake token)
kill %1
```

- [ ] **Step 3: Commit**

```bash
git add swarm/src/server.ts
git commit -m "feat(swarm): GET/PUT /me, POST /me/verify-github"
```

---

### Task 5: Swarm routes — `POST /workspaces/:name/verify-atlassian`, `POST /workspaces/:name/repos/:repoName/verify-github`

**Files:**
- Modify: `swarm/src/server.ts`

**Interfaces:**
- Consumes: `verifyAtlassian` (Task 3), `verifyGithubRepo` (Task 3), `resolveCurrentUser` (Task 2), `server.workspaces` (already loaded/reloaded via `server.reloadWorkspaces()`).
- Produces: `POST /workspaces/:name/verify-atlassian` → `{ ok, detail }` or `400 { error }`; `POST /workspaces/:name/repos/:repoName/verify-github` → same shape.

- [ ] **Step 1: Add the two routes, right after the existing `/workspaces` GET (line ~1315)**

```ts
// swarm/src/server.ts
import { verifyAtlassian } from './verify-atlassian.js';
```

```ts
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

this.app.post<{ Params: { name: string; repoName: string } }>(
  '/workspaces/:name/repos/:repoName/verify-github',
  async (req, reply) => {
    const ws = server.workspaces.find((w) => w.name === req.params.name);
    if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
    const repo = ws.repos.find((r) => r.name === req.params.repoName);
    if (!repo) return reply.status(404).send({ error: `Unknown repo: ${req.params.repoName}` });
    if (!repo.github) return reply.status(400).send({ error: `Repo "${repo.name}" has no GitHub owner/repo configured` });
    const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
    const user = resolveCurrentUser(users);
    if (!user?.github) return reply.status(400).send({ error: 'You have not added your GitHub token in account settings' });
    return verifyGithubRepo(repo.github.owner, repo.github.repo, user.github.token);
  },
);
```

- [ ] **Step 2: Manual verification**

```bash
cd swarm && npm run serve &
# assumes the 'jefelabs' workspace from .smith/workspaces/jefelabs.json exists
curl -s -X POST http://localhost:7777/workspaces/jefelabs/verify-atlassian | jq
# -> {"error":"Workspace \"jefelabs\" has no Jira/Confluence site configured"} until Task 8 UI sets one
kill %1
```

- [ ] **Step 3: Commit**

```bash
git add swarm/src/server.ts
git commit -m "feat(swarm): workspace/repo-scoped verify-atlassian and verify-github routes"
```

---

### Task 6: Broker proxy — `swarm-client.ts` additions

**Files:**
- Modify: `broker/src/swarm-client.ts`
- Test: `broker/src/swarm-client.test.ts`

**Interfaces:**
- Produces: `SwarmClient.getMe(): Promise<MeRecord>`, `.updateMe(body): Promise<MeRecord>`, `.verifyGithubToken(): Promise<VerifyResult>`, `.verifyWorkspaceAtlassian(name): Promise<VerifyResult>`, `.verifyRepoGithub(name, repoName): Promise<VerifyResult>`, exported types `MeRecord`, `VerifyResult`.

- [ ] **Step 1: Write the failing tests**

```ts
// broker/src/swarm-client.test.ts — append (uses the existing fakeFetch helper already in this file)
test('me/verify methods hit the right swarm routes', async () => {
  const calls: string[] = [];
  const client = new SwarmClient({
    baseUrl: 'http://s',
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url).replace('http://s', '')}`);
      return new Response(JSON.stringify({ ok: true, id: 'me', name: 'You', hasAtlassianToken: false, hasGithubToken: false, detail: 'x' }));
    }) as typeof fetch,
  });
  await client.getMe();
  await client.updateMe({ name: 'Edwin' });
  await client.verifyGithubToken();
  await client.verifyWorkspaceAtlassian('acme');
  await client.verifyRepoGithub('acme', 'web');
  assert.deepEqual(calls, [
    'GET /me',
    'PUT /me',
    'POST /me/verify-github',
    'POST /workspaces/acme/verify-atlassian',
    'POST /workspaces/acme/repos/web/verify-github',
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `broker/`): `npm test -- --test-name-pattern="me/verify methods"`
Expected: FAIL — methods don't exist.

- [ ] **Step 3: Add the types and methods**

```ts
// broker/src/swarm-client.ts — new exported types, near WorkspaceBody/SwarmWorkspace
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
```

```ts
// broker/src/swarm-client.ts — new methods on SwarmClient, alongside listWorkspaces
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

async verifyWorkspaceAtlassian(name: string): Promise<VerifyResult> {
  return this.http('POST', `/workspaces/${encodeURIComponent(name)}/verify-atlassian`, {}) as unknown as Promise<VerifyResult>;
}

async verifyRepoGithub(name: string, repoName: string): Promise<VerifyResult> {
  return this.http(
    'POST',
    `/workspaces/${encodeURIComponent(name)}/repos/${encodeURIComponent(repoName)}/verify-github`,
    {},
  ) as unknown as Promise<VerifyResult>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="me/verify methods"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add broker/src/swarm-client.ts broker/src/swarm-client.test.ts
git commit -m "feat(broker): SwarmClient getMe/updateMe/verifyGithubToken/verifyWorkspaceAtlassian/verifyRepoGithub"
```

---

### Task 7: Broker local routes — `/me`, verify passthroughs, `main.ts` wiring

**Files:**
- Modify: `broker/src/text-channel.ts`
- Modify: `broker/src/main.ts`
- Test: `broker/src/text-channel.test.ts`

**Interfaces:**
- Consumes: `SwarmClient.getMe/updateMe/verifyGithubToken/verifyWorkspaceAtlassian/verifyRepoGithub` (Task 6).
- Produces: local `GET/PUT /me`, `POST /me/verify-github`, `POST /workspaces/:name/verify-atlassian`, `POST /workspaces/:name/repos/:repoName/verify-github` on `TextChannel`'s HTTP surface. Extends the existing `workspaces` constructor param with `verifyAtlassian`/`verifyGithubRepo` methods; adds a new `me` constructor param (position 11) with `get`/`update`/`verifyGithub` methods.

- [ ] **Step 1: Write the failing test** (mirrors the existing `GET /workspaces` test exactly, using the file's `channelWith` helper)

```ts
// broker/src/text-channel.test.ts — append
test('GET /me returns the redacted profile; PUT /me forwards the body', async () => {
  const calls: Array<{ method?: string; url?: string }> = [];
  const channel = channelWith({
    me: {
      get: async () => {
        calls.push({ method: 'GET' });
        return { id: 'me', name: 'You', hasAtlassianToken: false, hasGithubToken: false };
      },
      update: async (body) => {
        calls.push({ method: 'PUT' });
        return { id: 'me', name: (body as { name?: string }).name ?? 'You', hasAtlassianToken: false, hasGithubToken: false };
      },
      verifyGithub: async () => ({ ok: true, detail: 'Authenticated as edwincruz' }),
    },
  });
  const port = await channel.start(0);
  try {
    const get = await fetch(`http://127.0.0.1:${port}/me`);
    assert.equal(get.status, 200);
    assert.deepEqual(await get.json(), { id: 'me', name: 'You', hasAtlassianToken: false, hasGithubToken: false });

    const put = await fetch(`http://127.0.0.1:${port}/me`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Edwin' }),
    });
    assert.equal((await put.json()).name, 'Edwin');
    assert.deepEqual(calls, [{ method: 'GET' }, { method: 'PUT' }]);

    const verify = await fetch(`http://127.0.0.1:${port}/me/verify-github`, { method: 'POST' });
    assert.equal((await verify.json()).ok, true);
  } finally {
    await channel.stop();
  }
});
```

Note: `channelWith` (this file's existing test helper) fills unused constructor slots — it needs one new line, `me: opts.me`, and the `channelWith` opts type needs `me?: ConstructorParameters<typeof TextChannel>[11]` added.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="GET /me returns"`
Expected: FAIL — `channelWith` doesn't accept `me`, and the route 404s.

- [ ] **Step 3: Extend `TextChannel`'s constructor and add the routes**

```ts
// broker/src/text-channel.ts — extend the workspaces param (position 9) and add a new me param (position 11)
/** Workspace CRUD for the manager UI: list for the picker, save for create/edit, remove decides archive vs delete; verify checks a saved connection live. */
private readonly workspaces?: {
  list(): Promise<Record<string, unknown>[]>;
  save(body: Record<string, unknown>, isNew: boolean): Promise<Record<string, unknown>>;
  remove(name: string): Promise<Record<string, unknown>>;
  verifyAtlassian(name: string): Promise<Record<string, unknown>>;
  verifyGithubRepo(name: string, repoName: string): Promise<Record<string, unknown>>;
},
/** Surface presence/admission: live per-agent surface state, Discord availability, on-request join. */
private readonly surfaces?: {
  presence(): Record<string, Record<string, boolean>>;
  info(): { configured: boolean; voiceReady: boolean };
  join(agentId: string, surface: string): Promise<{ ok: true } | { error: string; status: number }>;
},
/** The current operator's profile + credentials (account panel). */
private readonly me?: {
  get(): Promise<Record<string, unknown>>;
  update(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  verifyGithub(): Promise<Record<string, unknown>>;
},
```

```ts
// broker/src/text-channel.ts — inside the `if (this.creation)` block, after the /workspaces routes (before its closing brace)
if (req.method === 'GET' && url.pathname === '/me' && this.me) {
  void this.me.get().then((me) => json(200, me), fail);
  return;
}
if (req.method === 'PUT' && url.pathname === '/me' && this.me) {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(body || '{}') as Record<string, unknown>;
    } catch {
      return json(400, { error: 'body must be JSON' });
    }
    void this.me!.update(parsed).then((r) => json((r as { error?: string }).error ? 400 : 200, r), fail);
  });
  return;
}
if (req.method === 'POST' && url.pathname === '/me/verify-github' && this.me) {
  void this.me.verifyGithub().then((r) => json((r as { error?: string }).error ? 400 : 200, r), fail);
  return;
}
const wsAtlassianMatch = /^\/workspaces\/([^/]+)\/verify-atlassian$/.exec(url.pathname);
if (req.method === 'POST' && wsAtlassianMatch && this.workspaces) {
  void this.workspaces
    .verifyAtlassian(decodeURIComponent(wsAtlassianMatch[1]!))
    .then((r) => json((r as { error?: string }).error ? 400 : 200, r), fail);
  return;
}
const repoGithubMatch = /^\/workspaces\/([^/]+)\/repos\/([^/]+)\/verify-github$/.exec(url.pathname);
if (req.method === 'POST' && repoGithubMatch && this.workspaces) {
  void this.workspaces
    .verifyGithubRepo(decodeURIComponent(repoGithubMatch[1]!), decodeURIComponent(repoGithubMatch[2]!))
    .then((r) => json((r as { error?: string }).error ? 400 : 200, r), fail);
  return;
}
```

- [ ] **Step 4: Wire real implementations in `main.ts`**

```ts
// broker/src/main.ts — alongside the existing `workspaces` object passed into `new TextChannel(...)`
const textChannel = new TextChannel(
  // ...existing positional args 0-8 unchanged...
  {
    list: () => swarmClient.listWorkspaces(),
    save: (body, isNew) =>
      isNew ? swarmClient.createWorkspace(body as WorkspaceBody) : swarmClient.updateWorkspace((body as { name: string }).name, body),
    remove: (name) => swarmClient.deleteWorkspace(name).then(() => ({ outcome: 'deleted' })).catch((err) => ({ error: String(err) })),
    verifyAtlassian: (name) => swarmClient.verifyWorkspaceAtlassian(name),
    verifyGithubRepo: (name, repoName) => swarmClient.verifyRepoGithub(name, repoName),
  },
  surfacesDep, // unchanged, positional arg 10
  {
    get: () => swarmClient.getMe(),
    update: (body) => swarmClient.updateMe(body as { name?: string; atlassian?: { email: string; apiToken: string }; github?: { token: string } }),
    verifyGithub: () => swarmClient.verifyGithubToken(),
  },
);
```

Adjust to match `main.ts`'s actual existing `workspaces`/`surfaces` wiring exactly (the block above shows the shape to extend, not a full replacement — read the surrounding `new TextChannel(...)` call before editing so the other positional args aren't disturbed).

- [ ] **Step 5: Run test to verify it passes, typecheck, commit**

Run: `npm test -- --test-name-pattern="GET /me returns"` → PASS
Run: `npm run typecheck` (from `broker/`) → clean

```bash
git add broker/src/text-channel.ts broker/src/text-channel.test.ts broker/src/main.ts
git commit -m "feat(broker): /me and verify-atlassian/verify-github routes, wired to swarm"
```

---

### Task 8: Control-plane — Atlassian/GitHub fields on `WorkspaceManagerModal`

**Files:**
- Modify: `control-plane/src/organisms/WorkspaceManagerModal.tsx`
- Modify: `control-plane/src/hooks/useBrokerChat.ts`

**Interfaces:**
- Consumes: broker's `GET/PUT /workspaces` (already round-trip `atlassian`/`github` per Task 1's server-side change — no new swarm route needed here), new `POST /workspaces/:name/verify-atlassian` and `.../repos/:repoName/verify-github` (Task 7).
- Produces: `useBrokerChat` gains `verifyWorkspaceAtlassian(name): Promise<{ok,detail}|{error}>` and `verifyRepoGithub(name, repoName): Promise<{ok,detail}|{error}>`; `WorkspaceRecord` type gains `atlassian?`/repo-level `github?`.

- [ ] **Step 1: Extend `WorkspaceRecord` and add the two fetch functions**

```ts
// control-plane/src/hooks/useBrokerChat.ts — extend WorkspaceRecord
export interface WorkspaceRecord {
  name: string;
  description?: string;
  default: boolean;
  archived?: boolean;
  repos: Array<{ name: string; path: string; branch: string; github?: { owner: string; repo: string } }>;
  atlassian?: { siteUrl: string; jiraProjectKeys?: string[]; confluenceSpaceKeys?: string[] };
}
```

```ts
// control-plane/src/hooks/useBrokerChat.ts — new functions, alongside removeWorkspace
const verifyWorkspaceAtlassian = useCallback(
  async (name: string): Promise<{ ok?: boolean; detail?: string; error?: string }> => {
    const res = await fetch(`http://${base}/workspaces/${encodeURIComponent(name)}/verify-atlassian`, { method: 'POST' });
    return (await res.json()) as { ok?: boolean; detail?: string; error?: string };
  },
  [base],
);

const verifyRepoGithub = useCallback(
  async (name: string, repoName: string): Promise<{ ok?: boolean; detail?: string; error?: string }> => {
    const res = await fetch(
      `http://${base}/workspaces/${encodeURIComponent(name)}/repos/${encodeURIComponent(repoName)}/verify-github`,
      { method: 'POST' },
    );
    return (await res.json()) as { ok?: boolean; detail?: string; error?: string };
  },
  [base],
);
```

Add both to the hook's returned object (alongside `listWorkspaceRecords`/`saveWorkspace`/`removeWorkspace`).

- [ ] **Step 2: Extend the modal's form state and JSX**

```tsx
// control-plane/src/organisms/WorkspaceManagerModal.tsx
interface WorkspaceManagerModalProps {
  open: boolean;
  onClose: () => void;
  list: () => Promise<WorkspaceRecord[]>;
  save: (ws: WorkspaceRecord, isNew: boolean) => Promise<{ error?: string }>;
  remove: (name: string) => Promise<{ outcome?: string; error?: string }>;
  verifyAtlassian: (name: string) => Promise<{ ok?: boolean; detail?: string; error?: string }>;
  verifyRepoGithub: (name: string, repoName: string) => Promise<{ ok?: boolean; detail?: string; error?: string }>;
}
```

```tsx
const emptyRepo = () => ({ name: "", path: "", branch: "main", github: undefined as { owner: string; repo: string } | undefined });

// inside the component, alongside `error`/`busy` state
const [testResult, setTestResult] = useState<{ target: string; ok: boolean; detail: string } | null>(null);
const [testing, setTesting] = useState<string | null>(null);

const testAtlassian = async () => {
  if (!selected) return;
  setTesting("atlassian");
  const r = await verifyAtlassian(selected);
  setTesting(null);
  setTestResult({ target: "atlassian", ok: Boolean(r.ok), detail: r.detail ?? r.error ?? "unknown" });
};

const testRepoGithub = async (repoName: string) => {
  if (!selected) return;
  setTesting(repoName);
  const r = await verifyRepoGithub(selected, repoName);
  setTesting(null);
  setTestResult({ target: repoName, ok: Boolean(r.ok), detail: r.detail ?? r.error ?? "unknown" });
};
```

```tsx
{/* after the `default` checkbox label, before the repos section */}
<div className="workspace-manager__atlassian">
  <span className="wizard__hint">Atlassian (Jira / Confluence)</span>
  <input
    value={form.atlassian?.siteUrl ?? ""}
    onChange={(e) => setForm((f) => ({ ...f, atlassian: { ...f.atlassian, siteUrl: e.target.value } }))}
    placeholder="https://acme.atlassian.net"
  />
  <input
    value={form.atlassian?.jiraProjectKeys?.[0] ?? ""}
    onChange={(e) => setForm((f) => ({ ...f, atlassian: { siteUrl: f.atlassian?.siteUrl ?? "", ...f.atlassian, jiraProjectKeys: e.target.value ? [e.target.value] : undefined } }))}
    placeholder="Jira project key (ACME)"
  />
  <input
    value={form.atlassian?.confluenceSpaceKeys?.[0] ?? ""}
    onChange={(e) => setForm((f) => ({ ...f, atlassian: { siteUrl: f.atlassian?.siteUrl ?? "", ...f.atlassian, confluenceSpaceKeys: e.target.value ? [e.target.value] : undefined } }))}
    placeholder="Confluence space key (DOCS)"
  />
  {selected && form.atlassian?.siteUrl && (
    <button type="button" className="settings-btn" onClick={() => void testAtlassian()} disabled={testing === "atlassian"}>
      {testing === "atlassian" ? "testing…" : "Test connection"}
    </button>
  )}
  {testResult?.target === "atlassian" && (
    <p className={testResult.ok ? "wizard__hint" : "wizard__error"}>{testResult.detail}</p>
  )}
</div>
```

```tsx
{/* inside the repo-row map, after the branch input, before the remove button */}
<input
  value={repo.github?.owner ?? ""}
  onChange={(e) => updateRepo(i, { github: { owner: e.target.value, repo: repo.github?.repo ?? "" } })}
  placeholder="GitHub owner"
/>
<input
  value={repo.github?.repo ?? ""}
  onChange={(e) => updateRepo(i, { github: { owner: repo.github?.owner ?? "", repo: e.target.value } })}
  placeholder="GitHub repo"
/>
{selected && repo.github?.owner && repo.github?.repo && (
  <button type="button" className="settings-btn" onClick={() => void testRepoGithub(repo.name)} disabled={testing === repo.name}>
    {testing === repo.name ? "testing…" : "Test"}
  </button>
)}
```

`testResult` should clear (`setTestResult(null)`) inside `selectWorkspace`/`startNew`, mirroring how `error` already resets there — a stale test result from the previously selected workspace must not bleed into the newly selected one.

- [ ] **Step 3: Wire the two new props through from `HomePage.tsx`**

```tsx
// control-plane/src/pages/HomePage.tsx
<WorkspaceManagerModal
  open={workspacesOpen}
  onClose={() => setWorkspacesOpen(false)}
  list={listWorkspaceRecords}
  save={saveWorkspace}
  remove={removeWorkspace}
  verifyAtlassian={verifyWorkspaceAtlassian}
  verifyRepoGithub={verifyRepoGithub}
/>
```

- [ ] **Step 4: Typecheck and lint**

Run (from `control-plane/`): `npm run typecheck` → clean
Run: `npm run lint` → clean (fix any Biome complaints, e.g. quote style)

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/organisms/WorkspaceManagerModal.tsx control-plane/src/hooks/useBrokerChat.ts control-plane/src/pages/HomePage.tsx
git commit -m "feat(control-plane): Atlassian/GitHub config + test-connection on WorkspaceManagerModal"
```

---

### Task 9: Control-plane — new account panel for the operator's own credentials

**Files:**
- Create: `control-plane/src/organisms/AccountPanel.tsx`
- Test: `control-plane/src/organisms/AccountPanel.test.tsx`
- Modify: `control-plane/src/organisms/ToolRail.tsx`
- Modify: `control-plane/src/pages/HomePage.tsx`
- Modify: `control-plane/src/hooks/useBrokerChat.ts`

**Interfaces:**
- Consumes: broker's `GET/PUT /me`, `POST /me/verify-github` (Task 7).
- Produces: `useBrokerChat` gains `getMe(): Promise<MeRecord>`, `updateMe(body): Promise<MeRecord|{error}>`, `verifyGithubToken(): Promise<{ok,detail}|{error}>`; `ToolRailProps` gains `onAccount?: () => void`; `HomePage` gains `accountOpen` state mounting `AccountPanel`.

- [ ] **Step 1: Add the three hook functions**

```ts
// control-plane/src/hooks/useBrokerChat.ts — new exported type + functions
export interface MeRecord {
  id: string;
  name: string;
  hasAtlassianToken: boolean;
  hasGithubToken: boolean;
}

const getMe = useCallback(async (): Promise<MeRecord> => {
  const res = await fetch(`http://${base}/me`);
  return (await res.json()) as MeRecord;
}, [base]);

const updateMe = useCallback(
  async (body: { name?: string; atlassian?: { email: string; apiToken: string }; github?: { token: string } }): Promise<MeRecord & { error?: string }> => {
    const res = await fetch(`http://${base}/me`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as MeRecord & { error?: string };
  },
  [base],
);

const verifyGithubToken = useCallback(async (): Promise<{ ok?: boolean; detail?: string; error?: string }> => {
  const res = await fetch(`http://${base}/me/verify-github`, { method: "POST" });
  return (await res.json()) as { ok?: boolean; detail?: string; error?: string };
}, [base]);
```

Add `getMe`, `updateMe`, `verifyGithubToken` to the hook's returned object.

- [ ] **Step 2: Write the failing component test**

```tsx
// control-plane/src/organisms/AccountPanel.test.tsx
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountPanel } from "./AccountPanel";

describe("AccountPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("loads the current profile on open and shows saved-credential state without the secret", async () => {
    const getMe = vi.fn(async () => ({ id: "me", name: "Edwin", hasAtlassianToken: true, hasGithubToken: false }));
    render(
      <AccountPanel
        open
        onClose={() => {}}
        getMe={getMe}
        updateMe={vi.fn()}
        verifyGithubToken={vi.fn()}
      />,
    );
    await waitFor(() => expect(getMe).toHaveBeenCalled());
    expect(await screen.findByDisplayValue("Edwin")).toBeDefined();
    expect(screen.getByText(/atlassian token saved/i)).toBeDefined();
  });

  it("saving a new GitHub token calls updateMe with it, then Test connection calls verifyGithubToken", async () => {
    const updateMe = vi.fn(async () => ({ id: "me", name: "Edwin", hasAtlassianToken: false, hasGithubToken: true }));
    const verifyGithubToken = vi.fn(async () => ({ ok: true, detail: "Authenticated as edwincruz" }));
    render(
      <AccountPanel
        open
        onClose={() => {}}
        getMe={vi.fn(async () => ({ id: "me", name: "Edwin", hasAtlassianToken: false, hasGithubToken: false }))}
        updateMe={updateMe}
        verifyGithubToken={verifyGithubToken}
      />,
    );
    await screen.findByPlaceholderText("GitHub personal access token");
    await userEvent.type(screen.getByPlaceholderText("GitHub personal access token"), "ghp_test");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(updateMe).toHaveBeenCalledWith(expect.objectContaining({ github: { token: "ghp_test" } })));

    await userEvent.click(await screen.findByRole("button", { name: /test connection/i }));
    await waitFor(() => expect(verifyGithubToken).toHaveBeenCalled());
    expect(await screen.findByText(/authenticated as edwincruz/i)).toBeDefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run (from `control-plane/`): `npm run test -- AccountPanel`
Expected: FAIL — `./AccountPanel` doesn't exist.

- [ ] **Step 4: Implement `AccountPanel.tsx`** (flat-form style, mirrors `WorkspaceManagerModal`'s `error`/`busy`/`canSave` triad rather than `AddAgentModal`'s wizard steps — this is a single-screen form)

```tsx
// control-plane/src/organisms/AccountPanel.tsx
import { X } from "lucide-react";
import type { MouseEvent } from "react";
import { useEffect, useState } from "react";
import type { MeRecord } from "../hooks/useBrokerChat";

interface AccountPanelProps {
  open: boolean;
  onClose: () => void;
  getMe: () => Promise<MeRecord>;
  updateMe: (body: {
    name?: string;
    atlassian?: { email: string; apiToken: string };
    github?: { token: string };
  }) => Promise<MeRecord & { error?: string }>;
  verifyGithubToken: () => Promise<{ ok?: boolean; detail?: string; error?: string }>;
}

/** Your own credentials — not workspace config. Site URLs and project/space keys live on the workspace form instead. */
export function AccountPanel({ open, onClose, getMe, updateMe, verifyGithubToken }: AccountPanelProps) {
  const [me, setMe] = useState<MeRecord | null>(null);
  const [name, setName] = useState("");
  const [atlassianEmail, setAtlassianEmail] = useState("");
  const [atlassianToken, setAtlassianToken] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [testing, setTesting] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-fetch when the panel opens
  useEffect(() => {
    if (!open) return;
    setError(null);
    setTestResult(null);
    void getMe().then((record) => {
      setMe(record);
      setName(record.name);
      setAtlassianEmail("");
      setAtlassianToken("");
      setGithubToken("");
    });
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const result = await updateMe({
      name,
      atlassian: atlassianToken.trim() ? { email: atlassianEmail.trim(), apiToken: atlassianToken.trim() } : undefined,
      github: githubToken.trim() ? { token: githubToken.trim() } : undefined,
    }).catch((err: unknown): { error?: string } => ({ error: String(err) }));
    setBusy(false);
    if ("error" in result && result.error) {
      setError(result.error);
      return;
    }
    setMe(result as MeRecord);
    setAtlassianToken("");
    setGithubToken("");
  };

  const testGithub = async () => {
    setTesting(true);
    const r = await verifyGithubToken();
    setTesting(false);
    setTestResult({ ok: Boolean(r.ok), detail: r.detail ?? r.error ?? "unknown" });
  };

  const onScrimClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click-outside dismiss, same pattern as WorkspaceManagerModal
    <div className="scrim" data-open="true" role="dialog" aria-modal="true" aria-label="Your account" onClick={onScrimClick}>
      <section className="account-panel">
        <header className="workspace-manager__head">
          <h2>account</h2>
          <button type="button" className="sessions-panel__close" onClick={onClose} aria-label="Close account panel">
            <X size={13} strokeWidth={2} />
          </button>
        </header>
        <div className="account-panel__form">
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          <span className="wizard__hint">
            Atlassian {me?.hasAtlassianToken ? "— token saved" : "— not connected"}
          </span>
          <input
            value={atlassianEmail}
            onChange={(e) => setAtlassianEmail(e.target.value)}
            placeholder="Atlassian account email"
          />
          <input
            type="password"
            value={atlassianToken}
            onChange={(e) => setAtlassianToken(e.target.value)}
            placeholder="Atlassian API token"
          />

          <span className="wizard__hint">GitHub {me?.hasGithubToken ? "— token saved" : "— not connected"}</span>
          <input
            type="password"
            value={githubToken}
            onChange={(e) => setGithubToken(e.target.value)}
            placeholder="GitHub personal access token"
          />
          {me?.hasGithubToken && (
            <button type="button" className="settings-btn" onClick={() => void testGithub()} disabled={testing}>
              {testing ? "testing…" : "Test connection"}
            </button>
          )}
          {testResult && <p className={testResult.ok ? "wizard__hint" : "wizard__error"}>{testResult.detail}</p>}

          {error && <p className="wizard__error">{error}</p>}

          <button
            type="button"
            className="settings-btn settings-btn--primary settings-btn--wide"
            onClick={() => void submit()}
            disabled={busy}
          >
            {busy ? "saving…" : "save"}
          </button>
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- AccountPanel`
Expected: PASS

- [ ] **Step 6: Wire the entry point — `ToolRail` avatar click → `HomePage` state → mount**

```tsx
// control-plane/src/organisms/ToolRail.tsx
interface ToolRailProps {
  onSessions?: () => void;
  onSettings?: () => void;
  onAccount?: () => void;
}

export function ToolRail({ onSessions, onSettings, onAccount }: ToolRailProps) {
  // ...unchanged body...
  return (
    <nav className="rail rail--left" aria-label="Tools and activity">
      {/* ...unchanged logo/tools/spacer/settings button... */}
      <Avatar initial="E" label="Edwin · operator" style={OPERATOR_STYLE} onClick={onAccount} />
    </nav>
  );
}
```

```tsx
// control-plane/src/pages/HomePage.tsx
const [accountOpen, setAccountOpen] = useState(false);
// ...find the existing <ToolRail onSessions=... onSettings=.../> render call and add onAccount={() => setAccountOpen(true)}...
// ...in the overlays fragment alongside SettingsPanel/SessionsPanel/WorkspaceManagerModal:
<AccountPanel open={accountOpen} onClose={() => setAccountOpen(false)} getMe={getMe} updateMe={updateMe} verifyGithubToken={verifyGithubToken} />
```

Read the existing `<ToolRail .../>` render call and the overlays fragment in `HomePage.tsx` before editing — add the new prop/mount alongside the existing ones without disturbing them.

- [ ] **Step 7: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint` (from `control-plane/`) → clean

```bash
git add control-plane/src/organisms/AccountPanel.tsx control-plane/src/organisms/AccountPanel.test.tsx control-plane/src/organisms/ToolRail.tsx control-plane/src/pages/HomePage.tsx control-plane/src/hooks/useBrokerChat.ts
git commit -m "feat(control-plane): account panel for the operator's own Atlassian/GitHub credentials"
```

---

## Phase 2 — Swarm-Side (Delegated Work)

### Task 10: `RuntimeAdapter.launch()` gains an optional `env` param

**Files:**
- Modify: `swarm/src/runtime.ts`
- Modify: `swarm/src/remote-runtime.ts`
- Test: `swarm/src/runtime.test.ts` (create if it doesn't already exist — check first; extend if it does)

**Interfaces:**
- Produces: `RuntimeAdapter.launch(sessionName: string, command: string, cwd: string, env?: Record<string, string>): Promise<void>` — every implementation (`TmuxRuntime`, `DockerRuntime`, `RemoteRuntime`) accepts the new optional 4th param; callers that omit it are unaffected (backward compatible).

- [ ] **Step 1: Write the failing test**

```ts
// swarm/src/runtime.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TmuxRuntime } from './runtime.js';

test('TmuxRuntime.launch: env vars are exported inside the wrapped command, not interpolated into it', async () => {
  const runtime = new TmuxRuntime();
  const sessionName = `test-env-${Date.now()}`;
  const dir = await mkdtemp(join(tmpdir(), 'launch-env-'));
  const outFile = join(dir, 'out.txt');
  try {
    await runtime.launch(sessionName, `echo "$SMITH_TEST_TOKEN" > ${outFile}`, dir, { SMITH_TEST_TOKEN: 'super-secret' });
    await runtime.waitFor(sessionName);
    const content = await readFile(outFile, 'utf8');
    assert.equal(content.trim(), 'super-secret');
  } finally {
    await runtime.kill(sessionName).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
```

This test requires a real `tmux` binary on the runner (same as every other `TmuxRuntime` exercise in this codebase's suite — no mocking precedent exists for it).

- [ ] **Step 2: Run test to verify it fails**

Run (from `swarm/`): `npm test -- --test-name-pattern="env vars are exported"`
Expected: FAIL — `launch` doesn't accept a 4th argument (or the file `$SMITH_TEST_TOKEN` is empty since nothing exports it).

- [ ] **Step 3: Add the param to the interface and every implementation**

```ts
// swarm/src/runtime.ts — interface
export interface RuntimeAdapter {
  /**
   * Launch a new isolated session that runs `command` inside `cwd`.
   * `env`, when given, is exported inside the session before `command` runs
   * — never interpolated into the command string, so a secret value never
   * appears in a process listing or shell history.
   */
  launch(sessionName: string, command: string, cwd: string, env?: Record<string, string>): Promise<void>;
  // ...rest unchanged...
}
```

```ts
// swarm/src/runtime.ts — TmuxRuntime.launch
async launch(
  sessionName: string,
  command: string,
  cwd: string,
  env?: Record<string, string>,
): Promise<void> {
  await mkdir(this.exitDir, { recursive: true });

  const exitFile = this.exitFilePath(sessionName);
  const channel = `${sessionName}-done`;
  const exports = env
    ? `${Object.entries(env)
        .map(([k, v]) => `export ${k}=${this.shellEscape(v)}`)
        .join('; ')}; `
    : '';

  const wrappedCommand = [
    `${exports}${command}`,
    `; echo $? > ${this.shellEscape(exitFile)}`,
    `; tmux wait-for -S ${channel}`,
  ].join(' ');

  await this.tmux([
    'new-session',
    '-d',
    '-s', sessionName,
    '-c', cwd,
    wrappedCommand,
  ]);
}
```

`this.shellEscape` already exists (used for `exitFile` on the line below) — reuse it for each env value so a token containing a `$` or `'` can't break the command.

```ts
// swarm/src/runtime.ts — DockerRuntime.launch: accept env, merge into the existing extraEnv loop
async launch(
  sessionName: string,
  command: string,
  cwd: string,
  env?: Record<string, string>,
): Promise<void> {
  // ...unchanged setup through the `extraEnv` block...
  if (extraEnv) {
    for (const [key, value] of Object.entries(extraEnv)) {
      args.push('-e', `${key}=${value}`);
    }
  }
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      args.push('-e', `${key}=${value}`);
    }
  }
  // ...unchanged image/command push and docker() call...
}
```

```ts
// swarm/src/runtime.ts — RemoteRuntime (delegates through WorkerPool)
launch(sessionName: string, command: string, cwd: string, env?: Record<string, string>): Promise<void> {
  return this.pool.launch(sessionName, command, cwd, env);
}
```

```ts
// swarm/src/remote-runtime.ts — WorkerPool.launch: accept and forward env on the dispatch message
async launch(sessionName: string, command: string, cwd: string, env?: Record<string, string>): Promise<void> {
  const worker = this.pickWorker();
  if (!worker) {
    throw new Error('No remote workers available with capacity');
  }
  const msg: TaskDispatchMessage = {
    type: 'task:dispatch',
    taskId: sessionName,
    sessionName,
    command,
    cwd,
    env,
  };
  // ...rest unchanged...
}
```

`TaskDispatchMessage` (in `remote-types.ts`) needs `env?: Record<string, string>` added — remote/worker-side env delivery is otherwise out of scope for this plan (Phase 2 targets `tmux`/`docker` runtimes; a remote worker consuming `env` from the dispatch message is a natural follow-up but not required for the `all-local` V1 this spec targets — leave `smith-worker`'s consumption of the field for a later pass, note it doesn't break anything today since the field is simply unread there).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="env vars are exported"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add swarm/src/runtime.ts swarm/src/remote-runtime.ts swarm/src/runtime.test.ts
git commit -m "feat(swarm): RuntimeAdapter.launch accepts an optional env map"
```

---

### Task 11: `ToolDriver.materialize()` gains an optional `atlassian` param; Claude driver writes `.mcp.json`

**Files:**
- Modify: `swarm/src/drivers/types.ts`
- Modify: `swarm/src/drivers/claude.ts`
- Test: `swarm/src/drivers/claude.test.ts` (create if it doesn't already exist — check first; extend if it does)

**Interfaces:**
- Produces: `ToolDriver.materialize(agent: AgentProfile, worktreePath: string, atlassian?: { siteUrl: string; jiraProjectKeys?: string[]; confluenceSpaceKeys?: string[] }): Promise<string[]>`. TypeScript allows other drivers' existing 2-arg `materialize` implementations to keep compiling unchanged (a narrower function type structurally satisfies a wider one when the extra parameter is optional) — no other driver file needs to change.
- Credential values (`SMITH_ATLASSIAN_EMAIL`, `SMITH_ATLASSIAN_TOKEN`) are referenced as `${VAR}` placeholders in the written file, never embedded literally — Task 12 is what actually injects them, as process env on the task's session.

- [ ] **Step 1: Write the failing test**

```ts
// swarm/src/drivers/claude.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeDriver } from './claude.js';

test('materialize: without atlassian config, only CLAUDE.md is written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mat-'));
  try {
    const driver = new ClaudeDriver();
    const written = await driver.materialize({ name: 'Wilkin', role: 'dev', directives: 'ship it' }, dir);
    assert.deepEqual(written, ['CLAUDE.md']);
    await assert.rejects(() => readFile(join(dir, '.mcp.json')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('materialize: with atlassian config, also writes .mcp.json referencing env placeholders, never a literal secret', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mat-'));
  try {
    const driver = new ClaudeDriver();
    const written = await driver.materialize(
      { name: 'Wilkin', role: 'dev', directives: 'ship it' },
      dir,
      { siteUrl: 'https://acme.atlassian.net', jiraProjectKeys: ['ACME'] },
    );
    assert.deepEqual(written.sort(), ['.mcp.json', 'CLAUDE.md']);
    const mcp = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'));
    assert.equal(mcp.mcpServers.atlassian.env.JIRA_URL, 'https://acme.atlassian.net');
    assert.equal(mcp.mcpServers.atlassian.env.JIRA_API_TOKEN, '${SMITH_ATLASSIAN_TOKEN}');
    assert.doesNotMatch(JSON.stringify(mcp), /secret|tok-[a-z0-9]+/); // no literal credential ever lands here
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `swarm/`): `npm test -- --test-name-pattern="materialize:"`
Expected: FAIL — `materialize` doesn't accept a 3rd argument; `.mcp.json` is never written.

- [ ] **Step 3: Extend the interface and the Claude driver**

```ts
// swarm/src/drivers/types.ts
export interface ToolDriver {
  // ...unchanged...
  /**
   * Render the agent profile into the tool's native config surfaces inside
   * the worktree (design §5). `atlassian`, when given, additionally wires an
   * MCP server for that workspace's Jira/Confluence site — credentials are
   * referenced as `${SMITH_ATLASSIAN_EMAIL}`/`${SMITH_ATLASSIAN_TOKEN}` env
   * placeholders, never embedded literally (design: agent privilege ceiling
   * = the requesting user's own token, injected by the dispatcher at launch,
   * not written to any file in the worktree). Returns the created paths
   * relative to the worktree so callers can keep them out of task commits.
   */
  materialize(
    agent: AgentProfile,
    worktreePath: string,
    atlassian?: { siteUrl: string; jiraProjectKeys?: string[]; confluenceSpaceKeys?: string[] },
  ): Promise<string[]>;
}
```

```ts
// swarm/src/drivers/claude.ts
async materialize(
  agent: AgentProfile,
  worktreePath: string,
  atlassian?: { siteUrl: string; jiraProjectKeys?: string[]; confluenceSpaceKeys?: string[] },
): Promise<string[]> {
  const lines = [
    `# ${agent.name} — ${agent.role}`,
    '',
    agent.directives,
    '',
    `You are ${agent.name}. Stay within your role's domain; when work belongs to another specialist, say so instead of doing it badly.`,
    '',
  ];
  await writeFile(join(worktreePath, 'CLAUDE.md'), lines.join('\n'));
  const written = ['CLAUDE.md'];

  if (atlassian) {
    // mcp-atlassian (community server, API-token auth — no OAuth) is
    // configured via env vars it reads at startup. JIRA_PROJECTS_FILTER and
    // CONFLUENCE_SPACES_FILTER scope it to the workspace's configured
    // project/space keys when set; omitted = whole site, matching the
    // Workspace.atlassian type's own "omitted = whole site" semantics.
    const mcpConfig = {
      mcpServers: {
        atlassian: {
          command: 'uvx',
          args: ['mcp-atlassian'],
          env: {
            JIRA_URL: atlassian.siteUrl,
            JIRA_USERNAME: '${SMITH_ATLASSIAN_EMAIL}',
            JIRA_API_TOKEN: '${SMITH_ATLASSIAN_TOKEN}',
            CONFLUENCE_URL: `${atlassian.siteUrl.replace(/\/$/, '')}/wiki`,
            CONFLUENCE_USERNAME: '${SMITH_ATLASSIAN_EMAIL}',
            CONFLUENCE_API_TOKEN: '${SMITH_ATLASSIAN_TOKEN}',
            ...(atlassian.jiraProjectKeys?.length ? { JIRA_PROJECTS_FILTER: atlassian.jiraProjectKeys.join(',') } : {}),
            ...(atlassian.confluenceSpaceKeys?.length
              ? { CONFLUENCE_SPACES_FILTER: atlassian.confluenceSpaceKeys.join(',') }
              : {}),
          },
        },
      },
    };
    await writeFile(join(worktreePath, '.mcp.json'), `${JSON.stringify(mcpConfig, null, 2)}\n`);
    written.push('.mcp.json');
  }

  return written;
}
```

**Before Step 4, confirm one load-bearing assumption against current Claude Code documentation**: that a project-level `.mcp.json` supports `${VAR_NAME}` environment-variable expansion inside `env` values (Claude Code has documented this MCP-config env-expansion feature). If this has changed or doesn't apply the way assumed here, the fallback is to have the dispatcher (Task 12) write the *resolved* env values into a file that is git-excluded and readable only by that one task's process (e.g. an `.mcp.json` written fresh per-task by the dispatcher itself, after resolving the credential, instead of by `materialize()` with a placeholder) — note this fallback in a comment if the primary approach doesn't hold, don't silently guess.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="materialize:"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add swarm/src/drivers/types.ts swarm/src/drivers/claude.ts swarm/src/drivers/claude.test.ts
git commit -m "feat(swarm): ClaudeDriver.materialize writes .mcp.json for a workspace's Atlassian config"
```

---

### Task 12: Dispatcher resolves user × workspace/repo config, injects env, excludes `.mcp.json` from the branch

**Files:**
- Modify: `swarm/src/dispatcher.ts`
- Test: `swarm/src/dispatcher.test.ts` (create if it doesn't already exist — check first; extend if it does)

**Interfaces:**
- Consumes: `loadWorkspacesFromDir` (`./workspaces.js`, existing), `loadUsersFromDir`/`resolveCurrentUser` (`./users.js`, Task 2), `driver.materialize(agent, worktreePath, atlassian?)` (Task 11), `runtime.launch(sessionName, command, cwd, env?)` (Task 10).
- Produces: a private `resolveConnections(manifest: TaskManifest): Promise<{ atlassian?: { siteUrl: string; jiraProjectKeys?: string[]; confluenceSpaceKeys?: string[] }; env: Record<string, string> }>` on `Dispatcher`, called once per `dispatch()`.

- [ ] **Step 1: Write the failing tests**

```ts
// swarm/src/dispatcher.test.ts — add alongside whatever this file already covers (check for an existing file first; if none exists, create it with just these two tests)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from './dispatcher.js';
import type { TaskManifest, OrchestratorConfig } from './types.js';

// resolveConnections is exercised through the Dispatcher instance rather than
// exported standalone, since it reads from the same `.smith/workspaces` and
// `.smith/users` dirs the rest of the module resolves relative to cwd — the
// test drives it via a minimal manifest + a real repo/user fixture on disk.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dispatch-conn-'));
  await mkdir(join(root, '.smith/workspaces'), { recursive: true });
  await mkdir(join(root, '.smith/users'), { recursive: true });
  const repoPath = join(root, 'repo');
  await mkdir(repoPath, { recursive: true });
  await writeFile(
    join(root, '.smith/workspaces/acme.json'),
    JSON.stringify({
      name: 'acme',
      repos: [{ name: 'web', path: repoPath, github: { owner: 'acme', repo: 'web' } }],
      atlassian: { siteUrl: 'https://acme.atlassian.net', jiraProjectKeys: ['ACME'] },
    }),
  );
  await writeFile(
    join(root, '.smith/users/edwin.json'),
    JSON.stringify({ id: 'edwin', name: 'Edwin', default: true, atlassian: { email: 'e@acme.com', apiToken: 'atl-tok' }, github: { token: 'gh-tok' } }),
  );
  return { root, repoPath };
}

test('resolveConnections: pairs the current user credential with the repo-matched workspace config', async () => {
  const { root, repoPath } = await fixture();
  const dispatcher = new Dispatcher({} as OrchestratorConfig);
  const manifest = { context: { repoPath } } as TaskManifest;
  const resolved = await dispatcher.resolveConnections(manifest, root);
  assert.deepEqual(resolved.atlassian, { siteUrl: 'https://acme.atlassian.net', jiraProjectKeys: ['ACME'] });
  assert.equal(resolved.env.SMITH_ATLASSIAN_EMAIL, 'e@acme.com');
  assert.equal(resolved.env.SMITH_ATLASSIAN_TOKEN, 'atl-tok');
  assert.equal(resolved.env.GH_TOKEN, 'gh-tok');
});

test('resolveConnections: missing workspace atlassian config or missing user credential both skip injection cleanly', async () => {
  const { root, repoPath } = await fixture();
  // repoPath not matched by any workspace -> everything skipped
  const dispatcher = new Dispatcher({} as OrchestratorConfig);
  const resolved = await dispatcher.resolveConnections({ context: { repoPath: '/nope' } } as TaskManifest, root);
  assert.equal(resolved.atlassian, undefined);
  assert.equal(resolved.env.SMITH_ATLASSIAN_TOKEN, undefined);
  assert.equal(resolved.env.GH_TOKEN, undefined);
});
```

`resolveConnections` takes a second, test-only `root` param (the `.smith` parent dir) defaulting to `process.cwd()` in production — this avoids the test needing to `process.chdir()`, which is process-global and unsafe under `node --test`'s parallel test execution.

- [ ] **Step 2: Run tests to verify they fail**

Run (from `swarm/`): `npm test -- --test-name-pattern="resolveConnections"`
Expected: FAIL — `resolveConnections` doesn't exist.

- [ ] **Step 3: Implement `resolveConnections` and wire it into `dispatch()`/`prepareWorktree()`**

```ts
// swarm/src/dispatcher.ts — new imports
import { loadWorkspacesFromDir } from './workspaces.js';
import { loadUsersFromDir, resolveCurrentUser } from './users.js';
```

```ts
// swarm/src/dispatcher.ts — new method on Dispatcher
/**
 * Pair the current user's credential with the workspace/repo config that
 * matches this task's already-resolved repoPath. Missing config or missing
 * credential both mean "skip injection for that system" — the task still
 * runs, just without that tool available (design §3).
 */
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
  const repo = workspace?.repos.find((r) => r.path === manifest.context.repoPath);

  const users = await loadUsersFromDir(resolve(root, '.smith/users'));
  const user = resolveCurrentUser(users);

  const atlassian = workspace?.atlassian && user?.atlassian ? workspace.atlassian : undefined;
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

```ts
// swarm/src/dispatcher.ts — prepareWorktree: pass the resolved atlassian config into materialize()
private async prepareWorktree(manifest: TaskManifest, connections: { atlassian?: Parameters<typeof getDriver extends never ? never : never>[0] }): Promise<string> {
  // (signature note: see the concrete diff below — this comment block is
  // replaced by the real signature, not left as-is)
}
```

Replace `prepareWorktree`'s signature and its `materialize()` call site precisely as follows (the rest of the method body is unchanged from the current source):

```ts
private async prepareWorktree(
  manifest: TaskManifest,
  connections: { atlassian?: { siteUrl: string; jiraProjectKeys?: string[]; confluenceSpaceKeys?: string[] } },
): Promise<string> {
  // ...unchanged worktree-add and smith-delegate copy...

  const injected = ['bin/smith-delegate'];
  const driver = getDriver(manifest.agent);
  if (driver && manifest.profile) {
    injected.push(...(await driver.materialize(manifest.profile, worktreePath, connections.atlassian)));
  }

  // ...unchanged exclude-file write...
  return worktreePath;
}
```

```ts
// swarm/src/dispatcher.ts — dispatch(): resolve once, thread into both call sites
async dispatch(manifest: TaskManifest): Promise<TaskResult> {
  const sessionName = `${this.config.tmuxPrefix}-${manifest.taskId}`;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  const runtimeType: RuntimeType = manifest.runtime ?? this.config.defaultRuntime;
  const runtime = createRuntime(runtimeType, this.config.docker);
  const connections = await this.resolveConnections(manifest);

  let worktreePath = '';

  try {
    worktreePath = await this.prepareWorktree(manifest, connections);
    const command = this.buildAgentCommand(manifest, worktreePath);

    this.emitEvent({ type: 'task:dispatched', taskId: manifest.taskId, sessionName });

    await runtime.launch(sessionName, command, worktreePath, connections.env);

    // ...rest of the method (waitFor, ensureWorkCommitted, result building,
    // openPullRequest, captureSessionLogs, onCompleted/onFailed) unchanged...
  } finally {
    await this.teardown(manifest.taskId, sessionName, runtime);
  }
}
```

- [ ] **Step 4: Add the worktree-exclude for `.mcp.json`**

The existing exclude-file write in `prepareWorktree()` already sweeps up everything `materialize()` reports as `injected` (`bin/smith-delegate` plus whatever the driver returns — `CLAUDE.md`, and now `.mcp.json` when Atlassian was configured). Since `injected.push(...(await driver.materialize(...)))` already includes `.mcp.json` in its return value (Task 11), **no separate exclude step is needed** — the existing `appendFile(resolve(worktreePath, excludeFile), ...)` call already covers it. Confirm this by reading the untouched tail of `prepareWorktree()` (the exclude-file block after the `materialize()` call) before moving on — it should already reference `injected`, not a hardcoded list.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="resolveConnections"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add swarm/src/dispatcher.ts swarm/src/dispatcher.test.ts
git commit -m "feat(swarm): dispatcher resolves user x workspace/repo connections, injects env into launch"
```

---

### Task 13: Deterministic PR↔ticket link

**Files:**
- Modify: `swarm/src/dispatcher.ts`

**Interfaces:**
- Consumes: `manifest.metadata?.ticketKey as string | undefined` (set by Task 14's broker change — this task only needs to *read* it; it works standalone since `metadata` is already a free-form `Record<string, unknown>` today).
- Produces: `openPullRequest()`'s PR body gains a `Closes {ticketKey}` line when present.

- [ ] **Step 1: Extend `openPullRequest()`'s body-building block**

```ts
// swarm/src/dispatcher.ts — inside openPullRequest, replace the `body` construction
const ticketKey = typeof manifest.metadata?.ticketKey === 'string' ? manifest.metadata.ticketKey : undefined;
const body = [
  `Delegated task \`${manifest.taskId}\`, completed by **${agent}**.`,
  '',
  '## Task',
  '',
  taskText,
  ...(ticketKey ? ['', `Closes ${ticketKey}`] : []),
  '',
  '---',
  '🤖 Delegated to the crew via smithagents',
].join('\n');
```

- [ ] **Step 2: Manual verification**

No dedicated automated test — `openPullRequest()` shells out to a real `gh` CLI and isn't currently under test in this codebase (confirmed: no existing coverage of PR-body construction). Verify by hand: dispatch a task with `metadata: { ticketKey: 'PROJ-123' }` against a scratch repo with a `gh`-authenticated remote, and confirm the opened PR's body contains a `Closes PROJ-123` line.

```bash
cd swarm && npm run serve &
curl -s -X POST http://localhost:7777/tasks -H 'content-type: application/json' -d '{
  "prompt": "add a comment to README.md",
  "agent": "claude",
  "context": { "files": [], "repository": "", "branch": "main" },
  "metadata": { "ticketKey": "PROJ-123" }
}' | jq
# then, once the task completes: gh pr view <branch> --json body | jq -r .body | grep 'Closes PROJ-123'
kill %1
```

- [ ] **Step 3: Commit**

```bash
git add swarm/src/dispatcher.ts
git commit -m "feat(swarm): PR body links back to a delegated task's ticketKey when given"
```

---

### Task 14: `delegate` tool gains `ticketKey`; broker threads it into task metadata

**Files:**
- Modify: `broker/src/brain.ts`
- Modify: `broker/src/broker.ts`
- Test: `broker/src/broker.test.ts`

**Interfaces:**
- Produces: `TOOLS`'s `delegate` schema gains an optional `ticketKey` property; `ToolExecutors.delegate` and `broker.executors.delegate` both gain `ticketKey?: string` on their input type, forwarded into `submitTask`'s `metadata`.

- [ ] **Step 1: Write the failing test**

```ts
// broker/src/broker.test.ts — append, following this file's existing delegate-executor test pattern (a fake swarm client capturing submitTask's args)
test('delegate forwards ticketKey into task metadata when given', async () => {
  const submitted: Array<Record<string, unknown>> = [];
  const broker = makeBroker({
    swarm: {
      ...fakeSwarm,
      submitTask: async (req: Record<string, unknown>) => {
        submitted.push(req);
        return { taskId: 't-1', agentName: 'Wilkin' };
      },
    },
  });
  await broker.executors.delegate({ agent: 'wilkin', task: 'implement it', ticketKey: 'PROJ-123' });
  assert.equal((submitted[0]!.metadata as Record<string, unknown>).ticketKey, 'PROJ-123');
});
```

Use this file's existing `makeBroker`/`fakeSwarm`-style test-factory helpers (already present for the other `executors.delegate` tests in this file) rather than reconstructing dependencies inline — match whatever those helpers are actually named by reading the top of `broker.test.ts` first.

- [ ] **Step 2: Run test to verify it fails**

Run (from `broker/`): `npm test -- --test-name-pattern="ticketKey into task metadata"`
Expected: FAIL — `delegate` doesn't accept `ticketKey`.

- [ ] **Step 3: Thread `ticketKey` through both layers**

```ts
// broker/src/brain.ts — TOOLS[0] (delegate), add to properties + no change to required
{
  name: 'delegate',
  description:
    'Hand real work to an agent. The agent runs a full coding CLI in a pinned tmux session and works asynchronously; you will be told when it finishes. Use for anything beyond conversation: writing code, running commands, research in the repo.',
  input_schema: {
    type: 'object' as const,
    properties: {
      agent: { type: 'string' as const, description: 'Agent name or id from the roster' },
      task: { type: 'string' as const, description: 'Complete, self-contained task description' },
      repo: { type: 'string' as const, description: 'Repo name from the workspaces list. Omit for the default repo.' },
      workspace: { type: 'string' as const, description: 'Workspace name. Omit for the default workspace.' },
      ticketKey: {
        type: 'string' as const,
        description: 'Jira ticket key, only when the human explicitly names one (e.g. "PROJ-123"). Omit otherwise.',
      },
    },
    required: ['agent', 'task'],
  },
},
```

```ts
// broker/src/brain.ts — ToolExecutors interface
export interface ToolExecutors {
  remember(input: { key: string; text: string; scope: string }): Promise<string>;
  delegate(input: { agent: string; task: string; workspace?: string; repo?: string; ticketKey?: string }): Promise<string>;
  check_status(input: { agent: string }): Promise<string>;
  raise_hand(input: { agent: string; reason: string }): Promise<string>;
}
```

```ts
// broker/src/brain.ts — execute(): widen the cast passed to executors.delegate
if (name === 'delegate')
  return await this.executors.delegate(input as { agent: string; task: string; workspace?: string; repo?: string; ticketKey?: string });
```

```ts
// broker/src/broker.ts — executors.delegate
delegate: async (input: { agent: string; task: string; workspace?: string; repo?: string; ticketKey?: string }): Promise<string> => {
  const agent = this.deps.directory.resolve(input.agent);
  if (!agent) return `There is no agent named "${input.agent}". Offer one from the roster.`;
  const busy = this.deps.directory.snapshot().find((p) => p.agent.id === agent.id && p.status === 'busy');
  if (busy) return `${agent.name} is busy with: ${busy.taskSummary ?? busy.taskId}. Offer an idle agent instead.`;
  const { taskId, agentName } = await this.deps.swarm.submitTask({
    prompt: `${agent.directives}\n\n---\nTask from the live meeting:\n${input.task}`,
    agent: agent.engine.cli,
    repository: this.repository,
    workspace: input.workspace,
    repo: input.repo,
    metadata: { source: 'broker-meeting', composedAgentId: agent.id, ticketKey: input.ticketKey },
  });
  this.deps.directory.bindTask(agent.id, { taskId, summary: input.task.slice(0, 80), swarmName: agentName ?? undefined });
  this.notifyRoster();
  return `Delegated to ${agent.name}: task ${taskId} queued. They will work asynchronously; you will be notified on completion.`;
},
```

`SwarmClientLike.submitTask`'s `metadata?: Record<string, unknown>` param already accepts this shape with no type change — `ticketKey: undefined` when omitted is fine (matches how `composedAgentId` already flows through this exact object).

Also update `main.ts`'s wrapper (the one that fills in `workspace` from the active session) so `ticketKey` passes through untouched:

```ts
// broker/src/main.ts
delegate: (input) => broker.executors.delegate({ ...input, workspace: input.workspace ?? sessionManager.active().workspace }),
```

(No change needed here beyond confirming the spread already carries `ticketKey` — it does, since `...input` is a full spread.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="ticketKey into task metadata"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add broker/src/brain.ts broker/src/broker.ts broker/src/broker.test.ts
git commit -m "feat(broker): delegate tool accepts ticketKey, threads into task metadata"
```

---

## Phase 3 — Broker-Side (Conversational, Read-Only)

**Deviation from the spec's literal file layout, same requirements:** the design doc names `broker/src/atlassian-client.ts` as the home for the Jira/Confluence REST calls. Research for this plan surfaced a standing architectural rule stated in `swarm-client.ts`'s own file header — *"the broker's ONLY window into the swarm... no code imports"* — broker never reads swarm's `.smith/` files directly, only ever through swarm's HTTP API. Since resolving a connection means reading both `.smith/workspaces` and `.smith/users`, honoring that boundary means the actual Jira/Confluence HTTP client belongs in **swarm** (which already owns that filesystem access from Phase 1), with two new swarm routes broker proxies through — exactly the same shape as every other broker↔swarm interaction in this codebase (`/workspaces`, `/agents`, `/tasks`). This also means broker never touches a raw Atlassian credential at all, not even transiently — a tighter version of the spec's own privilege-ceiling principle. Resolution semantics, friendly-fallback behavior, and read-only scope are unchanged from the spec — only which service hosts the REST client moved.

### Task 15: `swarm/src/atlassian-client.ts` — ticket lookup + doc search

**Files:**
- Create: `swarm/src/atlassian-client.ts`
- Test: `swarm/src/atlassian-client.test.ts`

**Interfaces:**
- Produces: `lookupTicket(siteUrl, email, apiToken, ticketKey, fetchImpl?): Promise<{ ok: boolean; ticket?: { key: string; summary: string; status: string; url: string }; detail?: string }>`, `searchDocs(siteUrl, email, apiToken, query, opts?: { spaceKeys?: string[] }, fetchImpl?): Promise<{ ok: boolean; docs?: { title: string; excerpt: string; url: string }[]; detail?: string }>`.

- [ ] **Step 1: Write the failing tests**

```ts
// swarm/src/atlassian-client.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupTicket, searchDocs } from './atlassian-client.js';

test('lookupTicket: ok returns key/summary/status/url', async () => {
  const f = (async (url: unknown) => {
    assert.equal(String(url), 'https://acme.atlassian.net/rest/api/3/issue/PROJ-123?fields=summary,status');
    return new Response(JSON.stringify({ key: 'PROJ-123', fields: { summary: 'Fix the thing', status: { name: 'In Progress' } } }), {
      status: 200,
    });
  }) as typeof fetch;
  const r = await lookupTicket('https://acme.atlassian.net', 'e@acme.com', 'tok', 'PROJ-123', f);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ticket, {
    key: 'PROJ-123',
    summary: 'Fix the thing',
    status: 'In Progress',
    url: 'https://acme.atlassian.net/browse/PROJ-123',
  });
});

test('lookupTicket: not found surfaces a readable detail', async () => {
  const f = (async () => new Response(JSON.stringify({ errorMessages: ['Issue does not exist'] }), { status: 404 })) as typeof fetch;
  const r = await lookupTicket('https://acme.atlassian.net', 'e@acme.com', 'tok', 'NOPE-1', f);
  assert.equal(r.ok, false);
  assert.match(r.detail ?? '', /404|does not exist/);
});

test('searchDocs: scopes CQL to configured space keys and returns title/url pairs', async () => {
  const f = (async (url: unknown) => {
    assert.match(String(url), /cql=.*space%20in%20.*DOCS/);
    return new Response(
      JSON.stringify({ results: [{ title: 'Onboarding', _links: { webui: '/spaces/DOCS/pages/1/Onboarding' } }] }),
      { status: 200 },
    );
  }) as typeof fetch;
  const r = await searchDocs('https://acme.atlassian.net', 'e@acme.com', 'tok', 'onboarding', { spaceKeys: ['DOCS'] }, f);
  assert.equal(r.ok, true);
  assert.deepEqual(r.docs, [{ title: 'Onboarding', excerpt: '', url: 'https://acme.atlassian.net/wiki/spaces/DOCS/pages/1/Onboarding' }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `swarm/`): `npm test -- --test-name-pattern="lookupTicket|searchDocs"`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
// swarm/src/atlassian-client.ts
// Jira ticket lookup + Confluence doc search — the read-only surface broker's
// meeting brain calls through (design §4, deviation note in the plan header:
// this client lives in swarm, not broker, so broker never sees a raw token).
export interface TicketResult {
  key: string;
  summary: string;
  status: string;
  url: string;
}

export interface DocResult {
  title: string;
  excerpt: string;
  url: string;
}

function basicAuth(email: string, apiToken: string): string {
  return `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
}

export async function lookupTicket(
  siteUrl: string,
  email: string,
  apiToken: string,
  ticketKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; ticket?: TicketResult; detail?: string }> {
  const base = siteUrl.replace(/\/$/, '');
  const res = await fetchImpl(`${base}/rest/api/3/issue/${encodeURIComponent(ticketKey)}?fields=summary,status`, {
    headers: { authorization: basicAuth(email, apiToken) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { errorMessages?: string[] };
    return { ok: false, detail: `Jira ${res.status}: ${body.errorMessages?.[0] ?? res.statusText}` };
  }
  const data = (await res.json()) as { key: string; fields: { summary: string; status: { name: string } } };
  return {
    ok: true,
    ticket: { key: data.key, summary: data.fields.summary, status: data.fields.status.name, url: `${base}/browse/${data.key}` },
  };
}

export async function searchDocs(
  siteUrl: string,
  email: string,
  apiToken: string,
  query: string,
  opts?: { spaceKeys?: string[] },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; docs?: DocResult[]; detail?: string }> {
  const base = siteUrl.replace(/\/$/, '');
  const spaceClause = opts?.spaceKeys?.length ? ` and space in (${opts.spaceKeys.map((k) => `"${k}"`).join(',')})` : '';
  const cql = `text ~ "${query.replace(/"/g, '\\"')}"${spaceClause}`;
  const res = await fetchImpl(`${base}/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=5`, {
    headers: { authorization: basicAuth(email, apiToken) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    return { ok: false, detail: `Confluence ${res.status}: ${body.message ?? res.statusText}` };
  }
  const data = (await res.json()) as { results: Array<{ title: string; _links: { webui: string } }> };
  return { ok: true, docs: data.results.map((r) => ({ title: r.title, excerpt: '', url: `${base}/wiki${r._links.webui}` })) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="lookupTicket|searchDocs"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add swarm/src/atlassian-client.ts swarm/src/atlassian-client.test.ts
git commit -m "feat(swarm): atlassian-client — lookupTicket and searchDocs"
```

---

### Task 16: Swarm routes — `POST /workspaces/:name/atlassian/lookup-ticket`, `.../search-docs`

**Files:**
- Modify: `swarm/src/server.ts`

**Interfaces:**
- Consumes: `lookupTicket`/`searchDocs` (Task 15), `loadUsersFromDir`/`resolveCurrentUser` (Task 2).
- Produces: both routes return `{ ok, ticket?/docs?, detail? }` (200, Jira/Confluence-level outcome — including a "not found" or "no access" as `ok:false` with a `detail`) or `400 { error }` (swarm-level: no workspace config / no user credential / missing body field).

- [ ] **Step 1: Add the two routes**

```ts
// swarm/src/server.ts
import { lookupTicket, searchDocs } from './atlassian-client.js';
```

```ts
this.app.post<{ Params: { name: string }; Body: { ticketKey?: string } }>(
  '/workspaces/:name/atlassian/lookup-ticket',
  async (req, reply) => {
    const ws = server.workspaces.find((w) => w.name === req.params.name);
    if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
    if (!ws.atlassian) return reply.status(400).send({ error: `Workspace "${ws.name}" has no Jira/Confluence site configured` });
    const ticketKey = req.body?.ticketKey;
    if (!ticketKey) return reply.status(400).send({ error: 'Missing required field: ticketKey' });
    const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
    const user = resolveCurrentUser(users);
    if (!user?.atlassian) return reply.status(400).send({ error: 'You have not added your Atlassian credential in account settings' });
    return lookupTicket(ws.atlassian.siteUrl, user.atlassian.email, user.atlassian.apiToken, ticketKey);
  },
);

this.app.post<{ Params: { name: string }; Body: { query?: string } }>(
  '/workspaces/:name/atlassian/search-docs',
  async (req, reply) => {
    const ws = server.workspaces.find((w) => w.name === req.params.name);
    if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
    if (!ws.atlassian) return reply.status(400).send({ error: `Workspace "${ws.name}" has no Jira/Confluence site configured` });
    const query = req.body?.query;
    if (!query) return reply.status(400).send({ error: 'Missing required field: query' });
    const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
    const user = resolveCurrentUser(users);
    if (!user?.atlassian) return reply.status(400).send({ error: 'You have not added your Atlassian credential in account settings' });
    return searchDocs(ws.atlassian.siteUrl, user.atlassian.email, user.atlassian.apiToken, query, {
      spaceKeys: ws.atlassian.confluenceSpaceKeys,
    });
  },
);
```

- [ ] **Step 2: Manual verification**

```bash
cd swarm && npm run serve &
curl -s -X POST http://localhost:7777/workspaces/jefelabs/atlassian/lookup-ticket \
  -H 'content-type: application/json' -d '{"ticketKey":"PROJ-1"}' | jq
# -> {"error":"Workspace \"jefelabs\" has no Jira/Confluence site configured"} until an atlassian block is saved on it
kill %1
```

- [ ] **Step 3: Commit**

```bash
git add swarm/src/server.ts
git commit -m "feat(swarm): workspace-scoped lookup-ticket and search-docs routes"
```

---

### Task 17: Broker proxy — `swarm-client.ts` `lookupTicket`/`searchDocs`

**Files:**
- Modify: `broker/src/swarm-client.ts`
- Modify: `broker/src/broker.ts` (widen `SwarmClientLike`)
- Test: `broker/src/swarm-client.test.ts`

**Interfaces:**
- Produces: `SwarmClient.lookupTicket(workspace: string, ticketKey: string): Promise<{ ok: boolean; ticket?: TicketResult; detail?: string }>`, `.searchDocs(workspace: string, query: string): Promise<{ ok: boolean; docs?: DocResult[]; detail?: string }>`. `SwarmClientLike` (in `broker.ts`) gains both method signatures so `BrokerDeps.swarm` satisfies them.

- [ ] **Step 1: Write the failing test**

```ts
// broker/src/swarm-client.test.ts — append
test('lookupTicket/searchDocs post to the workspace-scoped atlassian routes', async () => {
  const calls: string[] = [];
  const client = new SwarmClient({
    baseUrl: 'http://s',
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url).replace('http://s', '')}`);
      return new Response(JSON.stringify({ ok: true, ticket: { key: 'P-1', summary: 's', status: 'Open', url: 'https://x' }, docs: [] }));
    }) as typeof fetch,
  });
  await client.lookupTicket('acme', 'P-1');
  await client.searchDocs('acme', 'onboarding');
  assert.deepEqual(calls, [
    'POST /workspaces/acme/atlassian/lookup-ticket',
    'POST /workspaces/acme/atlassian/search-docs',
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `broker/`): `npm test -- --test-name-pattern="lookup-ticket and search-docs routes"`
Expected: FAIL — methods don't exist.

- [ ] **Step 3: Add the types and methods**

```ts
// broker/src/swarm-client.ts — new exported types
export interface TicketResult {
  key: string;
  summary: string;
  status: string;
  url: string;
}

export interface DocResult {
  title: string;
  excerpt: string;
  url: string;
}
```

```ts
// broker/src/swarm-client.ts — new methods on SwarmClient, alongside listWorkspaces
async lookupTicket(workspace: string, ticketKey: string): Promise<{ ok: boolean; ticket?: TicketResult; detail?: string }> {
  return this.http('POST', `/workspaces/${encodeURIComponent(workspace)}/atlassian/lookup-ticket`, { ticketKey }) as unknown as Promise<{
    ok: boolean;
    ticket?: TicketResult;
    detail?: string;
  }>;
}

async searchDocs(workspace: string, query: string): Promise<{ ok: boolean; docs?: DocResult[]; detail?: string }> {
  return this.http('POST', `/workspaces/${encodeURIComponent(workspace)}/atlassian/search-docs`, { query }) as unknown as Promise<{
    ok: boolean;
    docs?: DocResult[];
    detail?: string;
  }>;
}
```

```ts
// broker/src/broker.ts — widen SwarmClientLike
export interface SwarmClientLike {
  // ...existing methods unchanged...
  lookupTicket(workspace: string, ticketKey: string): Promise<{ ok: boolean; ticket?: TicketResult; detail?: string }>;
  searchDocs(workspace: string, query: string): Promise<{ ok: boolean; docs?: DocResult[]; detail?: string }>;
}
```

Import `TicketResult`/`DocResult` into `broker.ts` from `./swarm-client.ts` alongside its other imports from that module.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="lookup-ticket and search-docs routes"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add broker/src/swarm-client.ts broker/src/swarm-client.test.ts broker/src/broker.ts
git commit -m "feat(broker): SwarmClient.lookupTicket/searchDocs, widen SwarmClientLike"
```

---

### Task 18: `lookup_ticket`/`search_docs` brain tools, broker executors, `main.ts` wiring

**Files:**
- Modify: `broker/src/brain.ts`
- Modify: `broker/src/broker.ts`
- Modify: `broker/src/main.ts`
- Test: `broker/src/broker.test.ts`

**Interfaces:**
- Produces: `TOOLS` gains `lookup_ticket`/`search_docs`; `ToolExecutors` gains matching methods; `broker.executors` gains implementations that resolve via `this.deps.swarm.lookupTicket`/`searchDocs`, given a `workspace` supplied by the caller (mirroring `delegate`'s pattern — `main.ts` fills it from `sessionManager.active().workspace`, always, since these tools are scoped to the current conversation's workspace and never model-choosable).

- [ ] **Step 1: Write the failing tests**

```ts
// broker/src/broker.test.ts — append, using this file's existing makeBroker/fakeSwarm-style factory
test('lookup_ticket returns a one-line summary on success', async () => {
  const broker = makeBroker({
    swarm: {
      ...fakeSwarm,
      lookupTicket: async () => ({ ok: true, ticket: { key: 'PROJ-1', summary: 'Fix the thing', status: 'In Progress', url: 'https://x/browse/PROJ-1' } }),
    },
  });
  const out = await broker.executors.lookup_ticket({ ticketKey: 'PROJ-1', workspace: 'acme' });
  assert.equal(out, 'PROJ-1 (In Progress): Fix the thing — https://x/browse/PROJ-1');
});

test('lookup_ticket surfaces a Jira-level not-found without throwing', async () => {
  const broker = makeBroker({
    swarm: { ...fakeSwarm, lookupTicket: async () => ({ ok: false, detail: 'Jira 404: Issue does not exist' }) },
  });
  const out = await broker.executors.lookup_ticket({ ticketKey: 'NOPE-1', workspace: 'acme' });
  assert.equal(out, 'Jira 404: Issue does not exist');
});

test('search_docs lists title/url pairs, or a no-results line', async () => {
  const broker = makeBroker({
    swarm: { ...fakeSwarm, searchDocs: async () => ({ ok: true, docs: [{ title: 'Onboarding', excerpt: '', url: 'https://x/wiki/1' }] }) },
  });
  assert.equal(await broker.executors.search_docs({ query: 'onboarding', workspace: 'acme' }), 'Onboarding — https://x/wiki/1');

  const empty = makeBroker({ swarm: { ...fakeSwarm, searchDocs: async () => ({ ok: true, docs: [] }) } });
  assert.equal(await empty.executors.search_docs({ query: 'nothing', workspace: 'acme' }), 'No Confluence docs found for "nothing".');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `broker/`): `npm test -- --test-name-pattern="lookup_ticket|search_docs"`
Expected: FAIL — `lookup_ticket`/`search_docs` don't exist on `executors`.

- [ ] **Step 3: Add the TOOLS entries, `ToolExecutors` methods, `execute()` branches, and `broker.ts` implementations**

```ts
// broker/src/brain.ts — TOOLS, append after raise_hand
{
  name: 'lookup_ticket',
  description:
    "Look up a Jira ticket's summary and status to answer a question in conversation. Read-only — never comments or changes status.",
  input_schema: {
    type: 'object' as const,
    properties: {
      ticketKey: { type: 'string' as const, description: 'Jira ticket key, e.g. "PROJ-123"' },
    },
    required: ['ticketKey'],
  },
},
{
  name: 'search_docs',
  description: 'Search Confluence for docs relevant to a question in conversation. Read-only.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string' as const, description: 'Search text' },
    },
    required: ['query'],
  },
},
```

```ts
// broker/src/brain.ts — ToolExecutors
export interface ToolExecutors {
  remember(input: { key: string; text: string; scope: string }): Promise<string>;
  delegate(input: { agent: string; task: string; workspace?: string; repo?: string; ticketKey?: string }): Promise<string>;
  check_status(input: { agent: string }): Promise<string>;
  raise_hand(input: { agent: string; reason: string }): Promise<string>;
  lookup_ticket(input: { ticketKey: string; workspace: string }): Promise<string>;
  search_docs(input: { query: string; workspace: string }): Promise<string>;
}
```

```ts
// broker/src/brain.ts — execute()
if (name === 'lookup_ticket') return await this.executors.lookup_ticket(input as { ticketKey: string; workspace: string });
if (name === 'search_docs') return await this.executors.search_docs(input as { query: string; workspace: string });
```

```ts
// broker/src/broker.ts — executors, append after check_status
lookup_ticket: async (input: { ticketKey: string; workspace: string }): Promise<string> => {
  const r = await this.deps.swarm.lookupTicket(input.workspace, input.ticketKey);
  if (!r.ok || !r.ticket) return r.detail ?? `Could not look up ${input.ticketKey}.`;
  return `${r.ticket.key} (${r.ticket.status}): ${r.ticket.summary} — ${r.ticket.url}`;
},
search_docs: async (input: { query: string; workspace: string }): Promise<string> => {
  const r = await this.deps.swarm.searchDocs(input.workspace, input.query);
  if (!r.ok) return r.detail ?? 'Could not search docs.';
  if (!r.docs?.length) return `No Confluence docs found for "${input.query}".`;
  return r.docs.map((d) => `${d.title} — ${d.url}`).join('\n');
},
```

Swarm-level failures (no workspace atlassian config, no user credential) are `400`s from the swarm route (Task 16), which `SwarmClient.http()` turns into a **thrown** `Error` (not a `{error}` return value — see `swarm-client.ts`'s `http()` helper) — `BrokerBrain.execute()`'s existing try/catch (`catch (err) { return \`tool ${name} failed: ${err.message}\`; }`) already turns that into brain-visible text with no change needed here. Only a *Jira/Confluence-level* outcome (ticket not found, no permission) needs the explicit `r.ok` check above, since that comes back as a normal `200 { ok: false, detail }` response, not a thrown error.

- [ ] **Step 4: Wire `main.ts`**

```ts
// broker/src/main.ts
const brain = new BrokerBrain(streamFactory, {
  delegate: (input) => broker.executors.delegate({ ...input, workspace: input.workspace ?? sessionManager.active().workspace }),
  check_status: (input) => broker.executors.check_status(input),
  raise_hand: (input) => broker.executors.raise_hand(input),
  remember: (input) => broker.executors.remember(input),
  lookup_ticket: (input) => broker.executors.lookup_ticket({ ...input, workspace: sessionManager.active().workspace }),
  search_docs: (input) => broker.executors.search_docs({ ...input, workspace: sessionManager.active().workspace }),
});
```

- [ ] **Step 5: Run tests to verify they pass, typecheck, commit**

Run: `npm test -- --test-name-pattern="lookup_ticket|search_docs"` → PASS
Run: `npm run typecheck` (from `broker/`) → clean

```bash
git add broker/src/brain.ts broker/src/broker.ts broker/src/broker.test.ts broker/src/main.ts
git commit -m "feat(broker): lookup_ticket/search_docs conversational tools"
```

---

## Final Verification

- [ ] **Full swarm suite:** `cd swarm && npm test` → all green, including every test added in Tasks 1–3, 10–13, 15–16.
- [ ] **Full broker suite:** `cd broker && npm test` → all green, including every test added in Tasks 6–7, 14, 17–18.
- [ ] **Full control-plane suite + typecheck + lint:** `cd control-plane && npm run test && npm run typecheck && npm run lint` → all green, including `AccountPanel.test.tsx` from Task 9.
- [ ] **Manual e2e** (spec §5, restated as a checklist):
  - [ ] Open the account panel, save an Atlassian email+token and a GitHub PAT; "Test connection" on the GitHub field succeeds.
  - [ ] Open "Manage workspaces…", set a workspace's Atlassian site URL + Jira project key, set a repo's GitHub owner/repo; both "Test connection" buttons succeed against real credentials.
  - [ ] In a meeting, say "Ignacio, implement PROJ-123 — add a comment to README.md" naming a real ticket; confirm the resulting PR body contains `Closes PROJ-123`, and (if `mcp-atlassian` is installed on the runner) that the agent's own tool calls authenticated as the operator.
  - [ ] Blank the GitHub token in the account panel, delegate again, confirm the task still completes — PR creation degrades gracefully to whatever local `gh auth` is active, exactly as it does today.
  - [ ] Ask the brain "what's the status of PROJ-123?" without delegating; confirm it answers using `lookup_ticket` (visible in the transcript as a tool round, not a delegation).
  - [ ] With no Atlassian connection configured on the active workspace, ask the same question; confirm the brain says something readable ("no Jira/Confluence site configured for this workspace") rather than erroring silently.

## Self-Review Notes

- **Spec coverage:** §1 (data model) → Tasks 1–2. §2 (API & UI) → Tasks 3–9. §3 (Phase 2 swarm-side) → Tasks 10–14. §4 (Phase 3 broker-side) → Tasks 15–18 (file layout deviation documented above; requirements unchanged). §5 (testing) → each task's own test plus the Final Verification checklist. Settled decisions (no project layer, config/credential split, privilege ceiling, untracked storage, per-repo GitHub / per-workspace Atlassian) are all reflected in Task 1–2's data shapes and Task 12's resolution logic.
- **Placeholder scan:** no "TBD"/"add appropriate handling"-style steps; every code step is complete, runnable code; every manual-verification step is an exact command with an exact expected result.
- **Type consistency:** `User`, `Workspace.atlassian`, `WorkspaceRepo.github` (Tasks 1–2) are used with identical shapes in Tasks 4–18 — cross-checked `resolveConnections`'s return type (Task 12) against what Task 11's `materialize()` and Task 10's `launch()` each consume; `TicketResult`/`DocResult` (Task 15) match what Task 17's `SwarmClient` methods return and Task 18's executors destructure.
