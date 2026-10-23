# Local API Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A container on Docker Desktop can no longer drive the swarm (7777) or the broker (7790).

- The swarm always requires an admin token. Only the broker and the CLI hold it.
- Each task's session gets its own delegation token, which can only create a sub-task in that
  task's workspace and repo, on its runtime.
- The broker requires a passkey by default, and Edwin signs in at `http://localhost:1420` with
  Touch ID.

**Architecture:**
- **Secrets:** generated secrets live in `~/.smith/` next to `master.key` and are created
  race-safely by whichever service boots first.
- **Delegation tokens** are stateless: HMAC-signed claims, with a key derived from the admin token.
  The swarm checks them only on `POST /tasks`, against a live parent in `activeTasks`, and rewrites
  the task body to the parent's scope.
- **Broker:** required mode, which already exists for cloud cells, becomes the local default. The
  broker prints a first-run invite link when no passkey exists.
- **UI:** it calls the broker on the page's own hostname, so the `SameSite=Lax` session cookie is
  same-site, and it gates on `/auth/me` everywhere.

**Tech Stack:** Node ≥ 24, TypeScript ~7.0.2 (`tsx` strips types, so `tsc --noEmit` is the only type gate), `node:test`, fastify 5 (swarm), the broker's hand-rolled `node:http` + `ws` server, `@simplewebauthn/server` ^14 / `@simplewebauthn/browser`, React + vitest (control-plane), `node:crypto` (`hkdfSync`, `createHmac`, `timingSafeEqual`, `randomBytes`), biome 2.6.2, pnpm 12.15.0.

**Spec:** `docs/superpowers/specs/2026-10-23-local-api-auth-design.md`. Read its "Calls made without asking" list first. The **companion git-mount fix** it describes is a separate plan, and this plan's protection depends on it.

**Base branch:** `origin/main` @ `8c27fb2`.

## Global Constraints

- **Worktree:** `git worktree add -b feat/local-api-auth .claude/worktrees/local-api-auth origin/main`
  (always `origin/<base>`). With symlinked `node_modules`, run scripts as
  `pnpm --config.verify-deps-before-run=false -C <pkg> <script>`. Never `git add -A`.
- **Test commands:**
  - swarm: `cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 src/<file>.test.ts`
  - broker: `cd broker && node --import tsx --test src/<file>.test.ts`
  - control-plane: `pnpm -C control-plane exec vitest run <path>`
  - The node runner prints the SPEC reporter. A run counts only if it shows `ℹ fail 0` **and** a
    non-zero `ℹ pass`. Read exit codes by redirect, never through a pipe.
- **Gates at every commit:** `tsc --noEmit` passes in swarm, broker, and control-plane. biome shows
  no findings beyond main's baseline at `8c27fb2`: 2 warnings and 1 info. Measure it; don't quote it.
- **No test may read or write the real `~/.smith` or `~/.smithagents`.**
  - Every secret-file test passes a `mkdtemp` `home`.
  - Every spawned script gets `HOME=<tmp>`.
  - Server tests boot with an explicit `apiToken`, never through `serverConfigFromArgs` with the
    real home.
- **Never print a secret value** in a log, a test message, or a command's output. The one exception
  is the first-run invite code: it is single-use, lasts 24 hours, and printing it is the point.
- **Secret files:**
  - `~/.smith/api-token` (swarm admin token) and `~/.smith/broker-bridge-token` (broker bridge
    token).
  - Content: 32 random bytes, base64url (43 chars), plus `\n`. File `0600`, directory `0700`.
  - An env var with a non-blank value always wins over the file: `SMITH_API_TOKEN`,
    `SMITH_BROKER_TOKEN`.
- **Delegation token format:**
  `sdt1.<base64url(JSON claims)>.<base64url(HMAC-SHA256(key, "sdt1." + payload))>`.
  - Key: `hkdfSync("sha256", adminToken, "", "smith-delegation-v1", 32)`.
  - Session env var: `SMITH_DELEGATE_TOKEN`.
- **Exact response bodies:**
  - `401 {"error":"unauthorized"}`: bad or missing credential. This shape already exists.
  - `403 {"error":"a delegation token can only create sub-tasks (POST /tasks)"}`
  - `401 {"error":"the delegating task is no longer running"}`
  - The scope refusals in Task 3.
- **Broker auth env:** `SMITH_BROKER_AUTH` unset or anything else means required.
  `SMITH_BROKER_AUTH=open` means open; it is loopback-only and logs a warning.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Once a SHA has
  been reported, fix forward; never amend.

## Review Focus

1. **The swarm and broker boot at the same instant on a fresh machine.** Both must end up holding
   the same api-token, not two different ones where the loser 401s forever. Task 1 has an
   8-way concurrency test.
2. **The swarm restarts while a docker task is mid-run, and that task then delegates.** It should
   get a clear 401 "the delegating task is no longer running", not a 500 and not a silent launch on
   the default runtime. Task 4 has a dead-parent test.
3. **Edwin opens `http://127.0.0.1:1420` out of habit** (it is the Playwright default). A passkey
   can't work on an IP address, so the login screen must say so and link to `localhost`. Task 9 has
   a `localhostHint` test.
4. **The 30-day session expires mid-use.** The first 401 from any broker call must drop to the
   login screen, not only in cloud mode. After Touch ID, the live updates must resume without a
   reload. Task 9 has a local brokerFetch 401 test; the existing socket 4401 test covers the
   socket.
5. **A Copilot/Claude bridge was set up without `SMITH_BROKER_TOKEN`.** After the upgrade it must
   keep working by reading the generated file, and the existing "refused without a token" test must
   not start reading the real home. Task 7 has bin tests with `HOME=<tmp>`.

---

## File Structure

| File | Responsibility after this plan |
|---|---|
| `swarm/src/secret-file.ts` | NEW. Race-safe generated secrets in `~/.smith`, the admin-token resolver, and the list of secret paths |
| `swarm/src/delegation-token.ts` | NEW. Mint and verify delegation tokens, plus the pure rule that rewrites a delegated `POST /tasks` body to the parent's scope |
| `swarm/src/server.ts` | Admin token always on (`main` resolves it). `?token=` only on `/ws`. Delegation accepted only on `POST /tasks` with a live parent |
| `swarm/src/types.ts` | `TaskManifest.delegation`, `OrchestratorConfig.delegationKey` |
| `swarm/src/dispatcher.ts` | `sessionEnv` adds `SMITH_DELEGATE_TOKEN` and blanks `SMITH_API_TOKEN` |
| `swarm/src/runtime.ts` | `exposedSecrets`, plus DockerRuntime's refusal to mount a `~/.smith` secret |
| `swarm/bin/smith-delegate` | Sends `SMITH_DELEGATE_TOKEN` only |
| `swarm/src/cli.ts`, `swarm/src/dashboard.ts` | Carry the admin token |
| `broker/src/secrets.ts` | NEW. The same `ensureSecretFile` contract, plus `resolveBrokerSecrets` (swarm token + bridge token) |
| `broker/src/config.ts` | Required by default. No longer reads the two tokens (secrets.ts does) |
| `broker/src/auth.ts` | `hasUsers`, `firstRunInviteUrl`, login-challenge expiry |
| `broker/src/text-channel.ts` | `/events` refuses a disallowed Origin with 4403 |
| `broker/src/main.ts` | Wires the secrets, prints the first-run link, warns in open mode |
| `broker/bin/smith-broker-{send,check}.mjs`, `swarm/scripts/{author-presets,generate-preset-avatars}.ts` | Fall back to `~/.smith/broker-bridge-token` |
| `control-plane/src/api/origin.ts` | Broker base = page hostname. 401 means session lost everywhere |
| `control-plane/src/organisms/{AuthGate,LoginScreen}.tsx` | Gate always on. `#invite=` prefill. 127.0.0.1 hint |

---

### Task 1: Generated secrets in `~/.smith` (swarm)

**Files:**
- Create: `swarm/src/secret-file.ts`
- Test: `swarm/src/secret-file.test.ts`

**Interfaces:**
- Produces:
  - `ensureSecretFile(path: string): Promise<string>`
  - `smithSecretsDir(home?: string): string` → `<home>/.smith`
  - `apiTokenPath(home?: string): string` → `<home>/.smith/api-token`
  - `bridgeTokenPath(home?: string): string` → `<home>/.smith/broker-bridge-token`
  - `secretPaths(home?: string): string[]` → `[apiTokenPath, bridgeTokenPath, <home>/.smith/master.key]`
  - `resolveApiToken(env?: NodeJS.ProcessEnv, home?: string): Promise<string>`
  - `adminAuthHeader(env?: NodeJS.ProcessEnv, home?: string): Promise<{ authorization: string }>`
  - Every `home` parameter defaults to `os.homedir()`.

- [ ] **Step 1: Write the failing tests** in `swarm/src/secret-file.test.ts`. Each test runs in a `mkdtemp(join(tmpdir(), "secret-"))` home and removes it in `finally`.

```ts
test("ensureSecretFile: creates a 0600 token in a 0700 dir, and returns the same token next time", async () => {
  const path = apiTokenPath(home);
  const first = await ensureSecretFile(path);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
  assert.equal(await ensureSecretFile(path), first);
});
test("ensureSecretFile: eight simultaneous first calls agree on one token and leave no temp files", async () => {
  const path = apiTokenPath(home);
  const tokens = await Promise.all(Array.from({ length: 8 }, () => ensureSecretFile(path)));
  assert.equal(new Set(tokens).size, 1);
  assert.deepEqual(await readdir(dirname(path)), ["api-token"]);
});
test("ensureSecretFile: an empty file is refused, not silently replaced", async () => {
  const path = apiTokenPath(home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "\n");
  await assert.rejects(ensureSecretFile(path), /is empty/);
});
test("resolveApiToken: a non-blank SMITH_API_TOKEN wins and no file is written", async () => {
  assert.equal(await resolveApiToken({ SMITH_API_TOKEN: "  env-tok  " }, home), "env-tok");
  await assert.rejects(access(apiTokenPath(home)));
});
test("resolveApiToken: a blank SMITH_API_TOKEN falls back to the generated file", async () => {
  const token = await resolveApiToken({ SMITH_API_TOKEN: "  " }, home);
  assert.equal(token, (await readFile(apiTokenPath(home), "utf8")).trim());
});
test("adminAuthHeader: a Bearer header carrying the resolved token", async () => {
  assert.deepEqual(await adminAuthHeader({ SMITH_API_TOKEN: "t" }, home), { authorization: "Bearer t" });
});
```

- [ ] **Step 2: Run the tests and confirm they fail** (module not found).

- [ ] **Step 3: Implement `swarm/src/secret-file.ts`.** The race-safe algorithm in `ensureSecretFile` is the part the tests don't fully determine:

```
1. readFile(path) → trimmed non-empty: return it. Trimmed empty: throw
   new Error(`${path} is empty — delete it to regenerate`). ENOENT: go on. Any other error: rethrow.
2. mkdir(dirname(path), { recursive: true, mode: 0o700 }). Do not chmod an existing directory
   (same as secretbox.ts's master.key).
3. tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
   writeFile(tmp, randomBytes(32).toString("base64url") + "\n", { mode: 0o600, flag: "wx" })
4. try link(tmp, path) — EEXIST means another writer won, and that's fine; anything else rethrows.
   finally unlink(tmp).
5. return (await readFile(path, "utf8")).trim()   // the winner's token, whoever won
```

- [ ] **Step 4: Run the tests and confirm they pass.** Expect `ℹ pass 6`, `ℹ fail 0`.

- [ ] **Step 5: Commit** with message `feat(swarm): generated secrets in ~/.smith, created race-safely`, adding the two files.

---

### Task 2: The swarm always requires its admin token

**Files:**
- Modify: `swarm/src/server.ts`:
  - `ServerConfig` (:273-290)
  - constructor (:376)
  - `registerAuthHook()` (:854-876)
  - `main()` and its docblock (:3950-3990)
- Modify: `swarm/src/cli.ts:20-46` (`request()`), and `swarm/src/dashboard.ts:25-26,192` (the `/ws` URL)
- Modify (docs): `README.md:102`, `.env.example:50`, `swarm/.env.example:7`
- Test: `swarm/src/server.test.ts`

**Interfaces:**
- Consumes: `resolveApiToken`, `adminAuthHeader` (Task 1).
- Produces:
  - `ServerConfig.apiToken?: string | null`. `undefined` means `SMITH_API_TOKEN` or open, which
    tests use. `null` means open; it is loopback-only and only tests use it. A string means
    required.
  - `export async function serverConfigFromArgs(args: string[], env?: NodeJS.ProcessEnv, home?: string): Promise<Partial<ServerConfig>>`.
    It holds `main()`'s argv parsing plus `apiToken: await resolveApiToken(env, home)`.
  - A test helper in `server.test.ts`:
    `async function bootServer(root: string, apiToken: string | null): Promise<{ server: OrchestratorServer; url: string }>`.
    It uses `port: 0`, `host: "127.0.0.1"`, `maxConcurrent: 0` (nothing dispatches), and
    `orchestrator: { smithRoot: root }`. `url` is read from `orchConfig.swarmUrl` after `start()`,
    the same way the port-0 test at :1830 does.

- [ ] **Step 1: Write the failing tests** in `server.test.ts`, each on a `freshStateRoot(...)` root:

```ts
test("auth: with an admin token, a request without it is 401 and with it is 200; /health stays open", async () => {
  const { server, url } = await bootServer(root, "admin-secret");
  try {
    assert.equal((await fetch(`${url}/tasks`)).status, 401);
    assert.equal((await fetch(`${url}/tasks`, { headers: { authorization: "Bearer admin-secret" } })).status, 200);
    assert.equal((await fetch(`${url}/health`)).status, 200);
  } finally { await server.stop(); }
});
test("auth: ?token= is honoured on /ws only", async () => {
  // fetch(`${url}/tasks?token=admin-secret`) → 401
  // new WebSocket(`${wsUrl}/ws?token=admin-secret`) opens; without ?token= it errors (401 upgrade)
});
test("serverConfigFromArgs: always resolves an admin token — SMITH_API_TOKEN, else the generated file", async () => {
  const cfg = await serverConfigFromArgs(["--port", "9"], {}, home);
  assert.equal(cfg.port, 9);
  assert.equal(cfg.apiToken, (await readFile(apiTokenPath(home), "utf8")).trim());
  assert.equal((await serverConfigFromArgs([], { SMITH_API_TOKEN: "e" }, home)).apiToken, "e");
});
```

- [ ] **Step 2: Run the tests and confirm they fail.** Expected failures:
  - `/tasks` returns 200 with no token, because there is no seam.
  - `/tasks?token=` returns 200.
  - `serverConfigFromArgs` is not exported.

- [ ] **Step 3: Implement.**
  - **Constructor:**
    `this.apiToken = config.apiToken !== undefined ? config.apiToken : process.env.SMITH_API_TOKEN?.trim() || null`.
  - **Hook:** read the query-string token only when `path === "/ws"`. Every other route takes the
    `Authorization` header only.
  - **`main()`:** becomes `new OrchestratorServer(await serverConfigFromArgs(process.argv.slice(2)))`.
  - **Docblock:** "every route except /health, /devices/redeem and /workers/connect requires the
    admin token. It comes from SMITH_API_TOKEN, else `~/.smith/api-token` (generated on first
    boot)."
  - **`cli.ts` `request()`:** spreads `await adminAuthHeader()` into its headers.
  - **`dashboard.ts`:** appends `?token=${encodeURIComponent(await resolveApiToken())}` to the `/ws`
    URL.
  - **Docs:** the env comment becomes
    `# blank = generated at ~/.smith/api-token on first boot (always required)`.

- [ ] **Step 4: Run the tests and confirm they pass.** Then run all of `server.test.ts`: it shows `ℹ fail 0`, because existing tests construct without `apiToken`, which means open.

- [ ] **Step 5: Commit** with message `feat(swarm): the API always requires the admin token`.

---

### Task 3: Delegation tokens (pure module)

**Files:**
- Create: `swarm/src/delegation-token.ts`
- Test: `swarm/src/delegation-token.test.ts`

**Interfaces:**
- Consumes: `RuntimeType`, `TaskManifest` (`swarm/src/types.ts`).
- Produces:
  - `export const DELEGATION_PREFIX = "sdt1."`
  - `export const MAX_DELEGATION_DEPTH = 3`
  - `export interface DelegationClaims { task: string; workspace?: string; repo?: string; branch?: string; runtime: RuntimeType; depth: number }`
  - `export function delegationKey(adminToken: string): Buffer`
  - `export function mintDelegationToken(key: Buffer, claims: DelegationClaims): string`
  - `export function verifyDelegationToken(key: Buffer | undefined, token: string): DelegationClaims | null`.
    It returns null for a missing key, a wrong prefix, bad base64 or JSON, a signature mismatch
    (compared with `timingSafeEqual` on equal-length buffers), or a claims shape that fails
    validation.
  - `export type ScopeResult = { ok: true; body: Partial<TaskManifest> } | { ok: false; error: string }`
  - `export function scopeDelegatedTask(claims: DelegationClaims, body: Partial<TaskManifest>): ScopeResult`

- [ ] **Step 1: Write the failing tests.** Here `claims = { task: "t1", workspace: "acme", repo: "web", branch: "dev", runtime: "docker", depth: 0 }` and `key = delegationKey("admin-secret")`:

```ts
test("mint/verify: a token round-trips its claims", () => {
  assert.deepEqual(verifyDelegationToken(key, mintDelegationToken(key, claims)), claims);
});
test("verify: refuses a changed payload, a foreign key, another prefix, garbage, and no key", () => {
  const [, , sig] = mintDelegationToken(key, claims).split(".");
  const forged = `sdt1.${Buffer.from(JSON.stringify({ ...claims, runtime: "tmux" })).toString("base64url")}.${sig}`;
  assert.equal(verifyDelegationToken(key, forged), null);
  assert.equal(verifyDelegationToken(delegationKey("other"), mintDelegationToken(key, claims)), null);
  assert.equal(verifyDelegationToken(key, mintDelegationToken(key, claims).replace("sdt1.", "sdt0.")), null);
  assert.equal(verifyDelegationToken(key, "sdt1.%%%.x"), null);
  assert.equal(verifyDelegationToken(undefined, mintDelegationToken(key, claims)), null);
});
test("scope: fills workspace/repo/branch/runtime from the claims and keeps only metadata.source", () => {
  const r = scopeDelegatedTask(claims, {
    prompt: "p", agent: "claude", priority: "high", location: "host",
    context: { files: ["a.ts"], repository: "", branch: "" },
    metadata: { source: "smith-delegate", workCardRef: { boardId: "b", cardId: "c" }, composedAgentId: "x" },
  });
  assert.deepEqual(r, { ok: true, body: {
    prompt: "p", agent: "claude", runtime: "docker",
    context: { files: ["a.ts"], repository: "", workspace: "acme", repo: "web", branch: "dev" },
    metadata: { source: "smith-delegate" },
  } });
});
test("scope: naming another workspace, repo or runtime is refused, not overridden", () => {
  const base = { prompt: "p", agent: "claude", context: { files: [], repository: "", branch: "" } };
  assert.deepEqual(scopeDelegatedTask(claims, { ...base, context: { ...base.context, workspace: "other" } }),
    { ok: false, error: 'this task can only delegate within workspace "acme"' });
  assert.deepEqual(scopeDelegatedTask(claims, { ...base, context: { ...base.context, repo: "api" } }),
    { ok: false, error: 'this task can only delegate within repo "web"' });
  assert.deepEqual(scopeDelegatedTask(claims, { ...base, runtime: "tmux" }),
    { ok: false, error: "sub-tasks run on this task's runtime (docker)" });
});
test("scope: a task three levels down cannot delegate again", () => {
  const base = { prompt: "p", agent: "claude", context: { files: [], repository: "", branch: "" } };
  assert.equal(scopeDelegatedTask({ ...claims, depth: 2 }, base).ok, true);
  assert.deepEqual(scopeDelegatedTask({ ...claims, depth: 3 }, base),
    { ok: false, error: "delegation depth limit (3) reached" });
});
```

- [ ] **Step 2: Run the tests and confirm they fail** (module not found).

- [ ] **Step 3: Implement.** Rules the tests pin:
  - Compare with strict equality, so an absent claim plus a named value is a mismatch. In the
    message, an absent claim shows as `(default)`.
  - `branch` is `body.context.branch || claims.branch`.
  - `metadata.source` is the body's string, else `"delegation"`.
  - `location` and `priority` are dropped.
  - Check depth (`claims.depth + 1 > MAX_DELEGATION_DEPTH`) first.

- [ ] **Step 4: Run the tests and confirm they pass** (5).

- [ ] **Step 5: Commit** with message `feat(swarm): stateless delegation tokens scoped to the parent task`.

---

### Task 4: The swarm accepts a delegation token on `POST /tasks` only

**Files:**
- Modify: `swarm/src/types.ts`:
  - `TaskManifest` (:75-104) gains `delegation?: { parentTaskId: string; depth: number }`.
  - `OrchestratorConfig` (:129-148) gains `delegationKey?: Buffer`.
- Modify: `swarm/src/server.ts`:
  - constructor: when `apiToken` is non-null, set `this.orchConfig.delegationKey = delegationKey(apiToken)`.
  - `registerAuthHook()`
  - `POST /tasks` (:975-1053)
- Test: `swarm/src/server.test.ts`

**Interfaces:**
- Consumes:
  - `delegationKey`, `verifyDelegationToken`, `scopeDelegatedTask`, `DELEGATION_PREFIX`,
    `mintDelegationToken` (Task 3)
  - `bootServer` (Task 2)
  - `makeSquadWorkspace(root)` (server.test.ts:1109; registers workspace `pg` with repo `app`)
- Produces: `TaskManifest.delegation` (read by Task 5), `OrchestratorConfig.delegationKey` (read by Task 5).

- [ ] **Step 1: Write the failing tests.** Setup for each test:
  - `root = await freshStateRoot(...)`, then `await makeSquadWorkspace(root)`, then
    `bootServer(root, "admin-secret")`.
  - Mark a parent live with a full `ActiveTask`-shaped entry (server.ts:262-270), so no reader
    trips on a missing field:
    `activeTasks.set("parent-1", { manifest: <a TaskManifest for pg/app on docker>, status: "running", startedAt: new Date().toISOString(), sessionName: "task-parent-1", agentName: null, runtime: null })`.
    Reach the map through `server as unknown as { activeTasks: Map<string, unknown> }`.
  - `tok = mintDelegationToken(delegationKey("admin-secret"), { task: "parent-1", workspace: "pg", repo: "app", branch: "main", runtime: "docker", depth: 0 })`.
  - Read the queue through `(server as unknown as { taskQueue: TaskManifest[] }).taskQueue`.

```ts
test("delegation: a running task's token creates a sub-task pinned to its workspace, repo and runtime", async () => {
  const res = await post(url, "/tasks", tok, { prompt: "p", agent: "claude", context: { files: [], repository: "", branch: "" } });
  assert.equal(res.status, 202);
  const m = taskQueue[0];
  assert.equal(m.runtime, "docker");                 // server default is tmux
  assert.equal(m.context.workspace, "pg");
  assert.equal(m.context.repo, "app");
  assert.deepEqual(m.delegation, { parentTaskId: "parent-1", depth: 1 });
  assert.deepEqual(m.metadata, { source: "delegation" });
});
test("delegation: asking for the host runtime is 403 and nothing is queued", async () => {
  // body runtime "tmux" → 403 {"error":"sub-tasks run on this task's runtime (docker)"}; taskQueue.length === 0
});
test("delegation: the token opens no other route", async () => {
  // GET /tasks and POST /agent-sessions with Bearer tok → 403 {"error":"a delegation token can only create sub-tasks (POST /tasks)"}
  // GET /ws?token=<tok> (WebSocket) → refused (query tokens are compared to the admin token only)
});
test("delegation: once the parent is gone the token is refused", async () => {
  // activeTasks.delete("parent-1") → POST /tasks → 401 {"error":"the delegating task is no longer running"}
});
test("delegation: a token signed with another key is 401", async () => {
  // mint with delegationKey("other") → 401 {"error":"unauthorized"}
});
```

`post(url, path, bearer, body)` is a small helper in the test file.

- [ ] **Step 2: Run the tests and confirm they fail.** Expect 401 on every delegation request, since the token isn't the admin token.

- [ ] **Step 3: Implement.** Hook order (the tests pin the outcomes; this pins the precedence):

```
exempt path                                    → pass
presented = bearer ?? (path === "/ws" ? query : undefined)
secretsEqual(presented, adminToken)            → pass
bearer?.startsWith(DELEGATION_PREFIX):
  claims = verifyDelegationToken(orchConfig.delegationKey, bearer)
  !claims                                      → 401 unauthorized
  !(method === "POST" && path === "/tasks")    → 403 only-sub-tasks
  !activeTasks.has(claims.task)                → 401 no-longer-running
  this.delegations.set(req, claims); pass      // private delegations = new WeakMap<FastifyRequest, DelegationClaims>()
otherwise                                      → 401 unauthorized
```

In `POST /tasks`:
- After the existing 400 check, `const claims = this.delegations.get(req)`.
- If there are claims, `scopeDelegatedTask(claims, body)`: on `!ok` reply 403 `{ error }`;
  otherwise continue with the scoped body.
- The manifest gets `delegation: claims ? { parentTaskId: claims.task, depth: claims.depth + 1 } : undefined`.
- Admin requests can't set `delegation`, because the manifest is built field by field.

- [ ] **Step 4: Run the tests and confirm they pass.** Then run all of `server.test.ts` and confirm `ℹ fail 0`.

- [ ] **Step 5: Commit** with message `feat(swarm): a task's delegation token creates sub-tasks in its own scope, nothing else`.

---

### Task 5: Every session carries its own delegation token, never the admin token

**Files:**
- Modify: `swarm/src/dispatcher.ts:418-426` (`sessionEnv`)
- Modify: `swarm/bin/smith-delegate` (the `curl` line, and the env list in the header comment)
- Modify: `swarm/src/runtime.docker.test.ts` (the "image contract: smith-delegate reaches the swarm on the host…" test, :185; plus its stale comment at :188)
- Test: `swarm/src/dispatcher.test.ts:600`, `swarm/src/smith-delegate.test.ts`

**Interfaces:**
- Consumes: `OrchestratorConfig.delegationKey`, `TaskManifest.delegation` (Task 4), `mintDelegationToken`, `verifyDelegationToken`, `delegationKey` (Task 3).
- Produces: the session env contract.
  - `SMITH_DELEGATE_TOKEN` is present when `config.delegationKey` is set.
  - `SMITH_API_TOKEN: ""` always, placed after `connectionsEnv`, so neither the tmux server's
    inherited env nor a connector can put the admin token into a session.

- [ ] **Step 1: Write the failing tests.**
  - **Existing test** "sessionEnv: every session can call this swarm back…" (dispatcher.test.ts:600):
    both expected objects gain `SMITH_API_TOKEN: ""`. Its config has no key, so it gets no
    `SMITH_DELEGATE_TOKEN`.
  - **New test** "sessionEnv: with a delegation key the session gets a token scoped to its own task — never the admin token":
    - Build the config with `loadConfig({ smithRoot, agentCommands: NO_SUCH_BINARY, delegationKey: delegationKey("admin-secret") })`.
    - The env has `SMITH_API_TOKEN === ""`.
    - `verifyDelegationToken(key, env.SMITH_DELEGATE_TOKEN)` deep-equals
      `{ task: "env", workspace: "acme", repo: "web", branch: "dev", runtime: "tmux", depth: 0 }`.
    - The same manifest with `runtime: "docker", delegation: { parentTaskId: "p", depth: 2 }` gives
      claims `runtime: "docker"` and `depth: 2`.
  - **`smith-delegate.test.ts`:**
    - `standInSwarm` also records `headers`.
    - New test "smith-delegate: authenticates with the session's own delegation token":
      `SMITH_DELEGATE_TOKEN=sdt1.fake` → recorded `authorization === "Bearer sdt1.fake"`.
    - New test "smith-delegate: never sends SMITH_API_TOKEN, even when the session inherited one":
      only `SMITH_API_TOKEN=admin-secret` set → recorded `authorization === undefined`.

- [ ] **Step 2: Run the tests and confirm they fail.**

- [ ] **Step 3: Implement.**
  - Claims come from the manifest: `task = taskId`, `workspace`/`repo`/`branch` from `context`,
    `runtime = manifest.runtime ?? config.defaultRuntime`,
    `depth = manifest.delegation?.depth ?? 0`.
  - `smith-delegate`: `${SMITH_DELEGATE_TOKEN:+-H "authorization: Bearer $SMITH_DELEGATE_TOKEN"}`
    replaces the `SMITH_API_TOKEN` line.
  - Docker contract test: launch with `SMITH_DELEGATE_TOKEN=sdt1.contract`, and assert the stand-in
    swarm received `authorization: Bearer sdt1.contract`. That proves the env crosses into the
    container and the script sends it. The test runs the repo's `swarm/bin/smith-delegate`
    (`DELEGATE_BIN`, :26), so no image rebuild is needed.

- [ ] **Step 4: Run the tests and confirm they pass:**
  - dispatcher and smith-delegate suites: `ℹ fail 0`.
  - The image contract:
    `cd swarm && SMITH_AGENT_IMAGE=smith-agent:latest node --import tsx --test --test-timeout 60000 src/runtime.docker.test.ts`
    shows `ℹ pass 9`, `ℹ fail 0`, and **no skips**. If `smith-agent:latest` is missing, run
    `make agent-image` first.

- [ ] **Step 5: Commit** with message `feat(swarm): sessions delegate with their own scoped token; the admin token never enters a session`.

---

### Task 6: Docker never mounts a `~/.smith` secret

**Files:**
- Modify: `swarm/src/runtime.ts`. Add the export `exposedSecrets`. `DockerRuntime.launch` checks
  every `-v` source just before `await this.docker(args)` (~:455).
- Test: `swarm/src/runtime.test.ts`

**Interfaces:**
- Consumes: `secretPaths()` (Task 1).
- Produces: `export function exposedSecrets(mountSources: string[], secrets: string[]): Array<{ source: string; secret: string }>`.
  A secret is exposed when `resolve(source)` equals it, or is an ancestor of it at a path-segment
  boundary.

- [ ] **Step 1: Write the failing tests:**

```ts
test("exposedSecrets: a mount of a secret's directory or any ancestor exposes it; a sibling does not", () => {
  const secrets = secretPaths("/h");
  assert.deepEqual(exposedSecrets(["/h/.smith/docker-auth", "/h/.smithx", "/w/repo/.git"], secrets), []);
  assert.equal(exposedSecrets(["/h/.smith"], secrets).length, 3);
  assert.equal(exposedSecrets(["/h"], secrets).length, 3);
});
test("DockerRuntime.launch: refuses a mount that would expose ~/.smith, before docker runs", async () => {
  // DockerConfig.extraMounts: [`${homedir()}/.smith:/x`], docker stubbed as in runtime.test.ts:217
  // → rejects /refusing to start container: mount .* would expose/, and the stub saw no `run`
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**

- [ ] **Step 3: Implement.** A mount source is the text before the first `:` of each `-v` value.
  The error is `refusing to start container: mount ${source} would expose ${secret}`. Check only
  paths; never stat or read the secrets.

- [ ] **Step 4: Run the tests and confirm they pass.** Then run all of `runtime.test.ts` and confirm `ℹ fail 0`.

- [ ] **Step 5: Commit** with message `feat(swarm): docker refuses any mount that would expose a ~/.smith secret`.

---

### Task 7: Broker secrets: swarm token and bridge token from env or `~/.smith`

**Files:**
- Create: `broker/src/secrets.ts`, `broker/src/secrets.test.ts`
- Modify: `broker/src/config.ts`. Remove `swarm.token` (:61) and `auth.bridgeToken` (:70) from
  `BrokerConfig` and from `loadBrokerConfig`, since secrets.ts now owns them.
- Modify: `broker/src/config.test.ts` (:27 and the auth cases :45-76, which drop the removed fields)
- Modify: `broker/src/main.ts`. Resolve the secrets before `new SwarmClient` (:110). Pass
  `secrets.swarmToken` there, and `secrets.bridgeToken` to `new BrokerAuth` (:1395-1402).
- Modify: `broker/bin/smith-broker-send.mjs`, `broker/bin/smith-broker-check.mjs`,
  `swarm/scripts/author-presets.ts`, `swarm/scripts/generate-preset-avatars.ts`. Each sends
  `authorization: Bearer <SMITH_BROKER_TOKEN ?? ~/.smith/broker-bridge-token>`, reading the file
  only, never creating it.
- Test: `broker/src/smith-broker-bin.test.ts`

**Interfaces:**
- Produces:
  - `ensureSecretFile(path: string): Promise<string>`: the **same contract and algorithm as Task 1**.
    Copy it with a header comment naming `swarm/src/secret-file.ts` as its twin; there is no shared
    package.
  - `resolveBrokerSecrets(env?: NodeJS.ProcessEnv, home?: string): Promise<{ swarmToken: string; bridgeToken: string }>`.
    `swarmToken` is `SMITH_API_TOKEN`, else `<home>/.smith/api-token`. `bridgeToken` is
    `SMITH_BROKER_TOKEN`, else `<home>/.smith/broker-bridge-token`. Both go through
    `ensureSecretFile`.

- [ ] **Step 1: Write the failing tests:**
  - "resolveBrokerSecrets: env wins; otherwise both tokens come from ~/.smith, generated once".
    Call it twice in a temp home and get equal results. With
    `{ SMITH_API_TOKEN: "a", SMITH_BROKER_TOKEN: "b" }` it returns `{ swarmToken: "a", bridgeToken: "b" }`
    and writes no files.
  - "resolveBrokerSecrets: reads the api-token the swarm generated". Pre-write
    `<home>/.smith/api-token` with `"from-swarm\n"`, and expect `swarmToken === "from-swarm"`.
  - Bin: "required mode: with no SMITH_BROKER_TOKEN the send bin reads ~/.smith/broker-bridge-token".
    Use `HOME=<tmp>` with the file holding `bridge-secret`, and an env with `SMITH_BROKER_TOKEN`
    deleted. The utterance is accepted.
  - The existing "…without it the gate refuses" case now runs with `HOME=<empty tmp>`, so it can't
    pick up the real file.

- [ ] **Step 2: Run the tests and confirm they fail.**

- [ ] **Step 3: Implement as specified above.**

- [ ] **Step 4: Run the broker suite** (`cd broker && node --import tsx --test 'src/*.test.ts'`) and confirm `ℹ fail 0`. Run `tsc --noEmit` in broker and swarm.

- [ ] **Step 5: Commit** with message `feat(broker): swarm and bridge tokens come from env or generated ~/.smith files`.

---

### Task 8: The broker requires a passkey by default, and says how to enroll the first one

**Files:**
- Modify: `broker/src/config.ts:43-51`. Set `required = env.SMITH_BROKER_AUTH !== "open"`. The
  non-loopback refusal stays as it is.
- Modify: `broker/src/auth.ts`:
  - `hasUsers`, `firstRunInviteUrl`.
  - `loginChallenges` becomes a `Map<string, number>` (challenge → issuedAt), with
    `beginLogin(now = Date.now())`, `finishLogin(response, now = Date.now())`, and
    `pendingLoginCount()`.
- Modify: `broker/src/main.ts` (after `await brokerAuth.load()`, :1401).
  - Required mode with a link: `console.log("[broker] No passkey enrolled yet — open " + url + " on this Mac to create one (link expires in 24h).")`.
  - Open mode: `console.warn("[broker] SMITH_BROKER_AUTH=open — the broker is UNAUTHENTICATED; any local process or container can drive it.")`.
- Modify: `broker/src/text-channel.ts:2036-2043` (the `/events` `connection` handler)
- Modify (docs): `.env.example` and `README.md`:
  - `SMITH_BROKER_AUTH` blank = required (passkey); `open` = no auth, loopback only.
  - `SMITH_BROKER_TOKEN` blank = generated at `~/.smith/broker-bridge-token`.
  - The first-run link.
- Test: `broker/src/config.test.ts`, `broker/src/auth.test.ts`, `broker/src/text-channel.test.ts`

**Interfaces:**
- Produces:
  - `export const FIRST_RUN_INVITE_TTL_MS = 24 * 60 * 60_000`
  - `export const LOGIN_CHALLENGE_TTL_MS = 5 * 60_000`
  - `BrokerAuth.hasUsers(): boolean`
  - `BrokerAuth.firstRunInviteUrl(now?: number): string | null`. It returns null unless the broker
    is required and has no users; otherwise it mints a 24h invite and returns
    `${webOrigin}/#invite=${code}`.
  - `BrokerAuth.pendingLoginCount(): number`

- [ ] **Step 1: Write the failing tests:**

```ts
// config.test.ts
test("auth is required unless SMITH_BROKER_AUTH=open", () => {
  assert.equal(loadBrokerConfig({ ...FULL }).auth.required, true);
  assert.equal(loadBrokerConfig({ ...FULL, SMITH_BROKER_AUTH: "required" }).auth.required, true);
  assert.equal(loadBrokerConfig({ ...FULL, SMITH_BROKER_AUTH: "open" }).auth.required, false);
  assert.throws(() => loadBrokerConfig({ ...FULL, SMITH_BROKER_AUTH: "open", BROKER_HOST: "0.0.0.0" }), /Refusing BROKER_HOST/);
});
// auth.test.ts (freshAuth / fakeWebauthn helpers, :10/:37)
test("firstRunInviteUrl: with no passkey it returns a link whose code enrolls; once one exists, null", async () => {
  const auth = await freshAuth();
  const url = auth.firstRunInviteUrl();
  assert.match(url ?? "", /^http:\/\/localhost:1420\/#invite=[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const code = (url ?? "").split("#invite=")[1];
  // beginRegistration(code, "Edwin") + finishRegistration(code, <fake response>) succeed (as the :62 test does)
  assert.equal(auth.hasUsers(), true);
  assert.equal(auth.firstRunInviteUrl(), null);
});
test("firstRunInviteUrl: an open broker never mints one", async () => {
  assert.equal((await freshAuth({ required: false })).firstRunInviteUrl(), null);
});
test("login challenges expire after 5 minutes and are pruned", async () => {
  const auth = await freshAuth();
  await auth.beginLogin(0);
  await auth.beginLogin(6 * 60_000);
  assert.equal(auth.pendingLoginCount(), 1);
});
// text-channel.test.ts (makeAuth / channelWith / connectAuthed, :34/:103/:2566)
test("WS /events: a present, disallowed Origin is closed with 4403 before any frame", async () => {
  // a valid session cookie + Origin http://localhost:3000 → close code 4403, zero frames received
  // the same cookie + Origin http://localhost:1420 → receives the hello frame
});
```

- [ ] **Step 2: Run the tests and confirm they fail.** Several existing config tests assume open by default. Update each to say `SMITH_BROKER_AUTH: "open"` where open is what they test, and record which ones in the commit body.

- [ ] **Step 3: Implement.**
  - **WS check:** if `origin` is present, and is neither in `ALLOWED_ORIGINS` nor equal to
    `auth.webOrigin`, call `ws.close(4403, "origin not allowed")` and return. This runs before
    identity resolution.
  - **`finishLogin`** treats a challenge older than `LOGIN_CHALLENGE_TTL_MS` as unknown.

- [ ] **Step 4: Run the broker suite and confirm `ℹ fail 0`.** Run `tsc --noEmit`.

- [ ] **Step 5: Commit** with message `feat(broker): passkey login is the local default; first run prints an enroll link`.

---

### Task 9: The UI signs in locally

**Files:**
- Modify: `control-plane/src/api/origin.ts`:
  - `export const LOCAL_PORT = 7790`. `LOCAL_BASE` stays `"127.0.0.1:7790"` for tauri.
  - `brokerBase`: cloud → `loc.host`; `tauri:` → `LOCAL_BASE`; else `${loc.hostname}:${LOCAL_PORT}`.
  - `brokerFetch`: drop `isCloud()` from the 401 condition and keep the `/auth/me` exemption.
  - Update the module and function docblocks to match.
- Modify: `control-plane/src/organisms/AuthGate.tsx`. One gate for every mode; delete the
  `CLOUD_MODE` passthrough and update the docblock.
- Modify: `control-plane/src/organisms/LoginScreen.tsx`. Export two pure helpers, and:
  - Prefill and open the invite form from `inviteFromHash(location.hash)`.
  - On successful enroll, `history.replaceState(null, "", location.pathname + location.search)`.
  - Render `localhostHint(location)` as `<p role="note">` with a link.
  - Add the copy "First time on this Mac? Open the sign-up link printed in the broker's terminal
    (`tmux attach -t smith-broker`)."
- Modify: `control-plane/e2e/passkey-login.spec.ts` header. Delete the now-false "under
  localhost/127.0.0.1 the gate is a passthrough". Describe a local run: a required broker on 7790
  with a **throwaway** `SMITH_BROKER_AUTH_FILE`, the SPA at `http://localhost:1420`,
  `INVITE_CODE` from the printed link, and `E2E_BASE_URL=http://localhost:1420`.
- Test: `control-plane/src/api/origin.test.ts`, `control-plane/src/organisms/AuthGate.test.tsx`, `control-plane/src/organisms/LoginScreen.test.tsx`

**Interfaces:**
- Produces:
  - `inviteFromHash(hash: string): string | null`: `"#invite=ABCD-EFGH"` → `"ABCD-EFGH"`; anything
    else → null.
  - `localhostHint(loc: { hostname: string; port: string; pathname: string; hash: string }): string | null`.
    On `127.0.0.1` it returns `http://localhost:<port><pathname><hash>`; otherwise null.

- [ ] **Step 1: Write the failing tests:**

```ts
// origin.test.ts — replaces "brokerBase is the loopback in dev…" and "a 401 does NOT flip sessionLost in local mode"
it("brokerBase follows the page's own hostname locally, so the session cookie is same-site", () => {
  expect(brokerBase(dev)).toBe("localhost:7790");
  expect(brokerBase({ hostname: "127.0.0.1", host: "127.0.0.1:1420", protocol: "http:" })).toBe("127.0.0.1:7790");
  expect(brokerBase(tauri)).toBe(LOCAL_BASE);
  expect(brokerBase(cloud)).toBe("skoolscout.smith.app");
});
it("a 401 flips sessionLost locally too", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
  await brokerFetch("/me");
  expect(useAuthStore.getState().sessionLost).toBe(true);
});
it("a 401 from /auth/me never flips it (it IS the check)", async () => { /* … toBe(false) */ });
// AuthGate.test.tsx — delete vi.mock("../lib/cloud"); keep the human/null cases; add:
it("renders children for an open-mode broker", async () => {
  (getMe as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "human", local: true });
  // children render
});
// LoginScreen.test.tsx
it("inviteFromHash reads the first-run link", () => {
  expect(inviteFromHash("#invite=ABCD-EFGH")).toBe("ABCD-EFGH");
  expect(inviteFromHash("")).toBeNull();
  expect(inviteFromHash("#other=1")).toBeNull();
});
it("localhostHint: on 127.0.0.1 it points at localhost, keeping port, path and hash", () => {
  expect(localhostHint({ hostname: "127.0.0.1", port: "1420", pathname: "/", hash: "#invite=X" }))
    .toBe("http://localhost:1420/#invite=X");
  expect(localhostHint({ hostname: "localhost", port: "1420", pathname: "/", hash: "" })).toBeNull();
});
it("a first-run link opens the invite form with the code filled in", () => {
  window.location.hash = "#invite=ABCD-EFGH";
  // render <LoginScreen onAuthed={vi.fn()} /> → the "Invite code" textbox has value "ABCD-EFGH"
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**

- [ ] **Step 3: Implement as specified above.**

- [ ] **Step 4: Run** `pnpm -C control-plane exec vitest run` (whole suite) and confirm 0 failed. Run `tsc --noEmit` in control-plane. Run biome against the baseline.

- [ ] **Step 5: Commit** with message `feat(control-plane): sign in with a passkey on localhost; the broker is called on the page's hostname`.

---

### Task 10: Whole-branch gates and the live proof (with Edwin)

The suites can't show the medium itself: a real browser keeping a real cookie, and a real container
hitting a real wall. This task does, and it needs Edwin twice: once for Touch ID, once to OK
restarting his live services.

- [ ] **Step 1: Run the whole-branch gates.**
  - `pnpm -r run typecheck` exits 0.
  - The swarm, broker, and control-plane suites show `ℹ fail 0` / 0 failed.
  - The image contract (Task 5, Step 4) passes 9/9 with no skips.
  - biome is at the baseline.

- [ ] **Step 2: Restart the live services, with Edwin's OK.** `tmux send-keys C-c` kills the whole
  session, so recreate each one:
  - `tmux new-session -d -s smith-swarm -c <repo>/swarm 'pnpm run serve'`
  - `tmux new-session -d -s smith-broker -c <repo>/broker 'node --env-file=../.env --import tsx src/main.ts'`
  - Confirm `~/.smith/api-token` and `~/.smith/broker-bridge-token` exist with mode `0600`, using
    `stat -f '%Lp %N'`. Never `cat` them.

- [ ] **Step 3: Enroll (Edwin).** Copy the `No passkey enrolled yet — open …` line from
  `tmux capture-pane -p -t smith-broker`. Edwin opens it, creates the passkey with Touch ID, and
  the app loads with its agents and workspaces. Agents and workspaces come from the swarm, so this
  proves the broker→swarm token works. Reload: still signed in.

- [ ] **Step 4: Prove the container wall, with a positive control.** Run:

```sh
probe() { docker run --rm --add-host host.docker.internal:host-gateway --entrypoint curl smith-agent:latest \
  -s -o /dev/null -w '%{http_code}\n' "$@"; }
probe http://host.docker.internal:7777/tasks                       # expect 401
probe -X POST -H 'content-type: application/json' -d '{"prompt":"x","agent":"claude","context":{},"runtime":"tmux"}' \
  http://host.docker.internal:7777/tasks                           # expect 401
probe http://host.docker.internal:7790/agents                      # expect 401
probe -X POST -H 'content-type: application/json' -d '{}' http://host.docker.internal:7790/sessions   # expect 401
# POSITIVE CONTROL — same container, same route, admin token passed in: proves the 401s are the wall, not unreachability
docker run --rm --add-host host.docker.internal:host-gateway -e T="$(cat ~/.smith/api-token)" --entrypoint sh smith-agent:latest \
  -c 'curl -s -o /dev/null -w "%{http_code}\n" -H "authorization: Bearer $T" http://host.docker.internal:7777/tasks'   # expect 200
```

- [ ] **Step 5: Live delegation.** This needs a working docker credential. The exported one has
  been dead since 2026-09-13, and re-exporting is Edwin's call. Without it, the Task 5 image
  contract is the evidence. Say which one was used.

- [ ] **Step 6: Merge.** Fast-forward `main` by ref after checking that origin/main is unchanged
  and the shared checkout is clean. Push with `gh auth switch --user ecruz165`, then switch back to
  `edwin-skoolscout`.
