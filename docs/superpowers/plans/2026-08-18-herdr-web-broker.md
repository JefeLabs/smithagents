# herdr-web-broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `herdr-web-broker` — a herdr marketplace plugin whose daemon exposes herdr's local socket API over REST/WS and federates instances parent↔child (child dials out with a parent-issued secret; parent routes requests down the tunnel and caches child status).

**Architecture:** A single long-running Node daemon launched by the plugin's `[[startup]]` hook. It attaches to every local herdr session socket (NDJSON), serves a `/parent/{instance}/sessions/...` REST facade plus two WebSocket endpoints (`/parent/ws` for clients, `/parent/enroll` for children), keeps an event-fed instance registry, and optionally dials a configured parent as a child. Remote sessions are also projected as local socket files so the stock herdr CLI works against them.

**Tech Stack:** TypeScript (`~6.0.0`) compiled with `tsc` to `dist/`; Node ≥ 22 ESM; runtime deps exactly `ws` + `smol-toml`; tests with `node:test` running against the compiled output.

**Spec:** `/Users/edwincruz/Development/Workspaces/jefelabs/smithagents/docs/superpowers/specs/2026-08-18-herdr-web-broker-design.md` — read it before starting any task.

## Global Constraints

- **This plan builds a NEW repo** at `/Users/edwincruz/Development/Workspaces/jefelabs/herdr-web-broker`. Nothing in this plan touches the smithagents monorepo. All `git`/`npm` commands run in the new repo (`cd` there or use `git -C`).
- **Do NOT create a GitHub remote or push.** Publishing (public repo, `herdr-plugin` topic tag) is Edwin's manual step afterward — pushing needs a gh account switch to `ecruz165`.
- Node floor for users: `"engines": { "node": ">=22" }`. ESM only (`"type": "module"`); every relative import in TS uses the `.js` extension (nodenext resolution).
- Runtime dependencies exactly: `ws@^8`, `smol-toml@^1`. Dev: `typescript@~6.0.0`, `@types/node@^24`, `@types/ws@^8`. TS 6 requires `"types": ["node"]` in tsconfig.
- **The type gate is `tsc`** — `npm test` runs `tsc` then `node --test 'dist/test/**/*.test.js'` (glob form: a bare directory argument fails module resolution on Node 26). Never run tests through a type-stripping runner.
- Plugin identity: repo `herdr-web-broker`, manifest id `jefelabs.web-broker`, plugin name "Web Broker", `min_herdr_version = "0.8.0"`.
- Wire constants (defined once in `src/tunnel.ts`, imported everywhere): `PROTO_VERSION = 1`, `DEFAULT_TIMEOUT_MS = 30_000`, `HEARTBEAT_MS = 15_000`.
- Agent status vocabulary is herdr's, verbatim: `working | blocked | idle`.
- Default listen: `127.0.0.1:7591`. Default remote deny list: `["server.stop", "server.reload_config", "plugin.*"]`.
- Error envelope everywhere: `{code, message, ...details}`; broker codes and HTTP mapping per spec §6; unknown (herdr passthrough) codes map to 502.
- Reserved instance name: `runtime`. URL grammar: `/parent/{instance}/sessions/{session}/...` exactly as in spec §2.
- Commits: conventional (`feat:`/`test:`/`docs:`/`chore:`), one per plan commit step, each ending with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Two herdr API shapes are **documented assumptions** isolated in adapters (`mapAgentList`, `mapHerdrEvent` in `src/local-attach.ts`) and validated only by the live smoke test: the `agent.list` result shape and the shape of streamed `pane.agent_status_changed` events. If the live smoke reveals different shapes, only those two functions change.

### File structure of the new repo (end state)

```
herdr-web-broker/
  herdr-plugin.toml       marketplace manifest (Task 1, finalized Task 13)
  package.json  tsconfig.json  .gitignore  LICENSE  README.md
  src/
    ndjson.ts             NDJSON codec (encode + incremental decode)
    errors.ts             BrokerError + code→HTTP mapping
    policy.ts             method deny-list evaluation
    auth.ts               secret mint/hash/verify, constant-time bearer check
    config.ts             config.toml load/save + defaults
    state.ts              children store, admin token, lockfile
    registry.ts           instance/status registry (EventEmitter) + persistence
    tunnel.ts             frame types, constants, ChildConnection, TunnelHub
    ws-server.ts          upgrade routing: /parent/enroll (Task 6) + /parent/ws (Task 10)
    local-attach.ts       local herdr sockets: discovery, rpc, events, snapshot
    http.ts               REST facade + admin + health + callInstance
    south.ts              ParentLink: child side of the tunnel
    projection.ts         remote sessions as local socket files
    daemon.ts             assembly: lock singleton, wiring, shutdown
    cli.ts                plugin actions: status/issue-secret/pair/revoke/start
    version.ts            PLUGIN_VERSION
  test/
    util.ts  fake-herdr.ts
    ndjson.test.ts  policy-auth.test.ts  config-state.test.ts  registry.test.ts
    local-attach.test.ts  tunnel.test.ts  http.test.ts  daemon.test.ts
    federation.test.ts  ws-client.test.ts  projection.test.ts  cli.test.ts
    live-smoke.test.ts
```

---

### Task 1: Repo scaffold + NDJSON codec

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `herdr-plugin.toml`, `src/version.ts`, `src/ndjson.ts`
- Test: `test/ndjson.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `encodeFrame(value: unknown): string`; `class NdjsonDecoder { push(chunk: Buffer | string): unknown[] }`; `PLUGIN_VERSION: string`. Repo builds with `npm run build`, tests run with `npm test`.

- [ ] **Step 1: Scaffold the repo**

```bash
mkdir -p /Users/edwincruz/Development/Workspaces/jefelabs/herdr-web-broker/{src,test}
cd /Users/edwincruz/Development/Workspaces/jefelabs/herdr-web-broker
git init -b main
```

Write `package.json`:

```json
{
  "name": "herdr-web-broker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "npm run build && node --test 'dist/test/**/*.test.js'"
  },
  "dependencies": {
    "smol-toml": "^1.3.1",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@types/ws": "^8.5.10",
    "typescript": "~6.0.0"
  }
}
```

Write `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node"],
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Write `.gitignore`:

```
node_modules/
dist/
```

Write `herdr-plugin.toml` (finalized with actions in Task 13; startup entry is valid from day one):

```toml
id = "jefelabs.web-broker"
name = "Web Broker"
version = "0.1.0"
min_herdr_version = "0.8.0"
description = "REST/WS gateway and parent↔child federation for herdr instances"

[[build]]
command = ["npm", "install"]

[[build]]
command = ["npm", "run", "build"]

[[startup]]
command = ["node", "dist/src/daemon.js"]
```

Write `src/version.ts`:

```ts
export const PLUGIN_VERSION = "0.1.0";
```

Run: `npm install`
Expected: lockfile created, deps installed.

- [ ] **Step 2: Write the failing test**

`test/ndjson.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, NdjsonDecoder } from "../src/ndjson.js";

test("encodeFrame appends exactly one newline", () => {
  assert.equal(encodeFrame({ a: 1 }), '{"a":1}\n');
});

test("decoder yields frames split across chunks", () => {
  const d = new NdjsonDecoder();
  assert.deepEqual(d.push('{"id":"r1","me'), []);
  assert.deepEqual(d.push('thod":"ping"}\n{"id":"r2"}\n'), [
    { id: "r1", method: "ping" },
    { id: "r2" },
  ]);
});

test("decoder skips blank lines and holds trailing partials", () => {
  const d = new NdjsonDecoder();
  assert.deepEqual(d.push('\n{"x":1}\n{"y":'), [{ x: 1 }]);
  assert.deepEqual(d.push("2}\n"), [{ y: 2 }]);
});

test("decoder throws on malformed JSON line", () => {
  const d = new NdjsonDecoder();
  assert.throws(() => d.push("not json\n"));
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../src/ndjson.js`.

- [ ] **Step 4: Implement**

`src/ndjson.ts`:

```ts
/** One NDJSON frame per line. Over WebSockets each message is one frame and
 * this codec is not needed; it exists for raw socket transports. */
export function encodeFrame(value: unknown): string {
  return JSON.stringify(value) + "\n";
}

export class NdjsonDecoder {
  #buf = "";

  /** Feed a chunk; returns every complete frame it finishes. Throws on a
   * malformed line — callers should close the connection. */
  push(chunk: Buffer | string): unknown[] {
    this.#buf += chunk.toString();
    const frames: unknown[] = [];
    let idx: number;
    while ((idx = this.#buf.indexOf("\n")) !== -1) {
      const line = this.#buf.slice(0, idx).trim();
      this.#buf = this.#buf.slice(idx + 1);
      if (line.length === 0) continue;
      frames.push(JSON.parse(line));
    }
    return frames;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: scaffold plugin repo with NDJSON codec" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Errors, policy, auth

**Files:**
- Create: `src/errors.ts`, `src/policy.ts`, `src/auth.ts`
- Test: `test/policy-auth.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class BrokerError extends Error { constructor(code: string, message: string, details?: Record<string, unknown>); code: string; details: Record<string, unknown>; toEnvelope(): Record<string, unknown> }`
  - `httpStatus(code: string): number` — spec §6 table; unknown codes → 502.
  - `methodDenied(method: string, denyGlobs: string[]): boolean`; `DEFAULT_REMOTE_DENY: string[]`
  - `mintSecret(): string` (32 random bytes, base64url); `hashSecret(secret: string): string` (sha256 hex); `verifySecret(secret: string, expectedHash: string): boolean` (constant-time); `checkBearer(header: string | undefined, tokens: { token: string }[]): boolean` (constant-time)

- [ ] **Step 1: Write the failing test**

`test/policy-auth.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { BrokerError, httpStatus } from "../src/errors.js";
import { methodDenied, DEFAULT_REMOTE_DENY } from "../src/policy.js";
import { mintSecret, hashSecret, verifySecret, checkBearer } from "../src/auth.js";

test("httpStatus maps broker codes per spec and unknown codes to 502", () => {
  assert.equal(httpStatus("unauthorized"), 401);
  assert.equal(httpStatus("method_denied"), 403);
  assert.equal(httpStatus("unknown_instance"), 404);
  assert.equal(httpStatus("unknown_session"), 404);
  assert.equal(httpStatus("instance_offline"), 503);
  assert.equal(httpStatus("upstream_timeout"), 504);
  assert.equal(httpStatus("not_found"), 502); // herdr passthrough
});

test("BrokerError carries details into the envelope", () => {
  const e = new BrokerError("instance_offline", "tunnel down", { last_seen: "2026-08-18T00:00:00Z" });
  assert.deepEqual(e.toEnvelope(), {
    code: "instance_offline",
    message: "tunnel down",
    last_seen: "2026-08-18T00:00:00Z",
  });
});

test("methodDenied handles exact names and dot-star globs", () => {
  assert.equal(methodDenied("server.stop", DEFAULT_REMOTE_DENY), true);
  assert.equal(methodDenied("plugin.list", DEFAULT_REMOTE_DENY), true);
  assert.equal(methodDenied("plugin.action.invoke", DEFAULT_REMOTE_DENY), true);
  assert.equal(methodDenied("agent.list", DEFAULT_REMOTE_DENY), false);
  assert.equal(methodDenied("pluginx", DEFAULT_REMOTE_DENY), false);
  assert.equal(methodDenied("anything", ["*"]), true);
});

test("secrets round-trip and reject tampering", () => {
  const s = mintSecret();
  assert.ok(s.length >= 40);
  assert.notEqual(mintSecret(), s);
  const h = hashSecret(s);
  assert.equal(verifySecret(s, h), true);
  assert.equal(verifySecret(s + "x", h), false);
});

test("checkBearer accepts a configured token and nothing else", () => {
  const tokens = [{ token: "tok-a" }, { token: "tok-b" }];
  assert.equal(checkBearer("Bearer tok-b", tokens), true);
  assert.equal(checkBearer("Bearer nope", tokens), false);
  assert.equal(checkBearer("tok-a", tokens), false);
  assert.equal(checkBearer(undefined, tokens), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/errors.ts`:

```ts
const STATUS: Record<string, number> = {
  unauthorized: 401,
  bad_request: 400,
  method_denied: 403,
  unknown_instance: 404,
  unknown_session: 404,
  instance_offline: 503,
  upstream_timeout: 504,
  proto_mismatch: 400,
};

/** Unknown codes are herdr passthrough errors → 502 per spec §6. */
export function httpStatus(code: string): number {
  return STATUS[code] ?? 502;
}

export class BrokerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "BrokerError";
  }

  toEnvelope(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.details };
  }
}
```

`src/policy.ts`:

```ts
export const DEFAULT_REMOTE_DENY = ["server.stop", "server.reload_config", "plugin.*"];

/** Deny globs: exact method name, "prefix.*" (matches any deeper suffix), or "*". */
export function methodDenied(method: string, denyGlobs: string[]): boolean {
  return denyGlobs.some((glob) => {
    if (glob === "*") return true;
    if (glob.endsWith(".*")) return method.startsWith(glob.slice(0, -1));
    return method === glob;
  });
}
```

`src/auth.ts`:

```ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function mintSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function verifySecret(secret: string, expectedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), "hex");
  const b = Buffer.from(expectedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Constant-time bearer check: compare sha256 digests so lengths never leak. */
export function checkBearer(header: string | undefined, tokens: { token: string }[]): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const presented = createHash("sha256").update(header.slice(7)).digest();
  return tokens.some((t) =>
    timingSafeEqual(presented, createHash("sha256").update(t.token).digest()),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: error envelope, method policy, constant-time auth primitives" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Config and state stores

**Files:**
- Create: `src/config.ts`, `src/state.ts`
- Test: `test/config-state.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_REMOTE_DENY` from `policy.js`.
- Produces:
  - `interface ClientToken { name: string; token: string }`
  - `interface ParentConfig { address: string; secret: string; name: string }`
  - `interface BrokerConfig { listen: string; client_tokens: ClientToken[]; parent?: ParentConfig; policy: { remote_deny: string[] }; tls?: { cert: string; key: string } }`
  - `DEFAULT_LISTEN = "127.0.0.1:7591"`; `loadConfig(configDir: string): BrokerConfig`; `saveConfig(configDir: string, config: BrokerConfig): void`
  - `class ChildrenStore { constructor(stateDir: string); get(name: string): { secret_hash: string } | undefined; set(name: string, secretHash: string): void; delete(name: string): boolean; names(): string[] }` — file-backed at `<stateDir>/children.json`
  - `ensureAdminToken(stateDir: string): string` — creates `<stateDir>/admin-token` (mode 0600) if missing, returns the token
  - `readLock(stateDir: string): { pid: number; listen: string } | undefined`; `writeLock(stateDir: string, info: { pid: number; listen: string }): void`; `clearLock(stateDir: string): void` — at `<stateDir>/daemon.lock`

- [ ] **Step 1: Write the failing test**

`test/config-state.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, DEFAULT_LISTEN } from "../src/config.js";
import { ChildrenStore, ensureAdminToken, readLock, writeLock, clearLock } from "../src/state.js";

const dir = () => mkdtempSync(join(tmpdir(), "hwb-"));

test("loadConfig returns spec defaults when no file exists", () => {
  const c = loadConfig(dir());
  assert.equal(c.listen, DEFAULT_LISTEN);
  assert.deepEqual(c.client_tokens, []);
  assert.deepEqual(c.policy.remote_deny, ["server.stop", "server.reload_config", "plugin.*"]);
  assert.equal(c.parent, undefined);
});

test("loadConfig parses a full config.toml", () => {
  const d = dir();
  writeFileSync(
    join(d, "config.toml"),
    [
      'listen = "0.0.0.0:9999"',
      "[[client_tokens]]",
      'name = "cli"',
      'token = "tok-a"',
      "[parent]",
      'address = "ws://parent:7591"',
      'secret = "sss"',
      'name = "laptop"',
      "[policy]",
      'remote_deny = ["server.stop"]',
    ].join("\n"),
  );
  const c = loadConfig(d);
  assert.equal(c.listen, "0.0.0.0:9999");
  assert.deepEqual(c.client_tokens, [{ name: "cli", token: "tok-a" }]);
  assert.deepEqual(c.parent, { address: "ws://parent:7591", secret: "sss", name: "laptop" });
  assert.deepEqual(c.policy.remote_deny, ["server.stop"]);
});

test("saveConfig round-trips through loadConfig", () => {
  const d = dir();
  const c = loadConfig(d);
  c.parent = { address: "ws://p:1", secret: "s", name: "n" };
  saveConfig(d, c);
  assert.deepEqual(loadConfig(d).parent, { address: "ws://p:1", secret: "s", name: "n" });
});

test("ChildrenStore persists across instances and deletes", () => {
  const d = dir();
  const a = new ChildrenStore(d);
  assert.equal(a.get("laptop"), undefined);
  a.set("laptop", "hash1");
  const b = new ChildrenStore(d);
  assert.deepEqual(b.get("laptop"), { secret_hash: "hash1" });
  assert.deepEqual(b.names(), ["laptop"]);
  assert.equal(b.delete("laptop"), true);
  assert.equal(b.delete("laptop"), false);
  assert.equal(new ChildrenStore(d).get("laptop"), undefined);
});

test("ensureAdminToken is stable, non-empty, and mode 0600", () => {
  const d = dir();
  const t1 = ensureAdminToken(d);
  assert.ok(t1.length >= 40);
  assert.equal(ensureAdminToken(d), t1);
  assert.equal(statSync(join(d, "admin-token")).mode & 0o777, 0o600);
});

test("lockfile round-trips and clears", () => {
  const d = dir();
  assert.equal(readLock(d), undefined);
  writeLock(d, { pid: 123, listen: "127.0.0.1:7591" });
  assert.deepEqual(readLock(d), { pid: 123, listen: "127.0.0.1:7591" });
  clearLock(d);
  assert.equal(readLock(d), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/config.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { DEFAULT_REMOTE_DENY } from "./policy.js";

export interface ClientToken {
  name: string;
  token: string;
}

export interface ParentConfig {
  address: string;
  secret: string;
  name: string;
}

export interface BrokerConfig {
  listen: string;
  client_tokens: ClientToken[];
  parent?: ParentConfig;
  policy: { remote_deny: string[] };
  tls?: { cert: string; key: string };
}

export const DEFAULT_LISTEN = "127.0.0.1:7591";

export function loadConfig(configDir: string): BrokerConfig {
  const path = join(configDir, "config.toml");
  const raw = existsSync(path) ? (parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  const policy = (raw.policy ?? {}) as { remote_deny?: string[] };
  return {
    listen: (raw.listen as string) ?? DEFAULT_LISTEN,
    client_tokens: (raw.client_tokens as ClientToken[]) ?? [],
    parent: raw.parent as ParentConfig | undefined,
    policy: { remote_deny: policy.remote_deny ?? [...DEFAULT_REMOTE_DENY] },
    tls: raw.tls as { cert: string; key: string } | undefined,
  };
}

/** Rewrites config.toml wholesale — operator comments are not preserved (v1, documented). */
export function saveConfig(configDir: string, config: BrokerConfig): void {
  mkdirSync(configDir, { recursive: true });
  const out: Record<string, unknown> = {
    listen: config.listen,
    client_tokens: config.client_tokens,
    policy: config.policy,
  };
  if (config.parent) out.parent = config.parent;
  if (config.tls) out.tls = config.tls;
  writeFileSync(join(configDir, "config.toml"), stringify(out) + "\n");
}
```

`src/state.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mintSecret } from "./auth.js";

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export class ChildrenStore {
  #path: string;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.#path = join(stateDir, "children.json");
  }

  #read(): Record<string, { secret_hash: string }> {
    return readJson(this.#path, {});
  }

  #write(data: Record<string, { secret_hash: string }>): void {
    writeFileSync(this.#path, JSON.stringify(data, null, 2) + "\n");
  }

  get(name: string): { secret_hash: string } | undefined {
    return this.#read()[name];
  }

  set(name: string, secretHash: string): void {
    const data = this.#read();
    data[name] = { secret_hash: secretHash };
    this.#write(data);
  }

  delete(name: string): boolean {
    const data = this.#read();
    if (!(name in data)) return false;
    delete data[name];
    this.#write(data);
    return true;
  }

  names(): string[] {
    return Object.keys(this.#read());
  }
}

export function ensureAdminToken(stateDir: string): string {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "admin-token");
  if (!existsSync(path)) writeFileSync(path, mintSecret(), { mode: 0o600 });
  return readFileSync(path, "utf8").trim();
}

export function readLock(stateDir: string): { pid: number; listen: string } | undefined {
  const path = join(stateDir, "daemon.lock");
  return existsSync(path) ? readJson(path, undefined as never) : undefined;
}

export function writeLock(stateDir: string, info: { pid: number; listen: string }): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "daemon.lock"), JSON.stringify(info) + "\n");
}

export function clearLock(stateDir: string): void {
  rmSync(join(stateDir, "daemon.lock"), { force: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: TOML config and file-backed state stores" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Instance registry

**Files:**
- Create: `src/registry.ts`
- Test: `test/registry.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `type AgentStatus = "working" | "blocked" | "idle"`
  - `interface AgentInfo { id: string; title: string; status: AgentStatus }`
  - `interface SessionSnapshot { name: string; agents: AgentInfo[] }`
  - `interface InstanceSnapshot { platform: string; herdr_version: string; sessions: SessionSnapshot[] }`
  - `interface Counts { working: number; blocked: number; idle: number }`
  - `class Registry extends EventEmitter` with: `load(): void`, `replaceSnapshot(instance: string, snap: InstanceSnapshot): void`, `applyAgentStatus(instance: string, session: string, agent: AgentInfo): void`, `applySessionAdded(instance: string, session: SessionSnapshot): void` (upsert), `applySessionRemoved(instance: string, session: string): void`, `setOffline(instance: string): void`, `get(instance: string)`, `instances(): string[]`, `counts(instance: string): Counts`, `rollup(): { instance: string; online: boolean; as_of: string; counts: Counts }[]`
  - Events emitted: `"agent_status" {instance, session, agent}`, `"session_added" {instance, session: SessionSnapshot}`, `"session_removed" {instance, session: string}`, `"snapshot" {instance}`, `"online" {instance}`, `"offline" {instance}`
  - `get()` returns `{ online: boolean; as_of: string; platform: string; herdr_version: string; sessions: Record<string, { agents: AgentInfo[] }> } | undefined`

- [ ] **Step 1: Write the failing test**

`test/registry.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry, type InstanceSnapshot } from "../src/registry.js";

const SNAP: InstanceSnapshot = {
  platform: "macos",
  herdr_version: "0.8.0",
  sessions: [
    {
      name: "default",
      agents: [
        { id: "a1", title: "claude", status: "working" },
        { id: "a2", title: "codex", status: "idle" },
      ],
    },
  ],
};

test("replaceSnapshot brings an instance online and rollup counts statuses", () => {
  const r = new Registry();
  const events: string[] = [];
  r.on("online", (e) => events.push(`online:${e.instance}`));
  r.on("snapshot", (e) => events.push(`snapshot:${e.instance}`));
  r.replaceSnapshot("laptop", SNAP);
  const roll = r.rollup();
  assert.equal(roll.length, 1);
  assert.equal(roll[0].instance, "laptop");
  assert.equal(roll[0].online, true);
  assert.ok(roll[0].as_of.endsWith("Z"));
  assert.deepEqual(roll[0].counts, { working: 1, blocked: 0, idle: 1 });
  assert.deepEqual(events, ["online:laptop", "snapshot:laptop"]);
});

test("applyAgentStatus upserts and emits", () => {
  const r = new Registry();
  r.replaceSnapshot("laptop", SNAP);
  let seen: unknown;
  r.on("agent_status", (e) => (seen = e));
  r.applyAgentStatus("laptop", "default", { id: "a1", title: "claude", status: "blocked" });
  assert.deepEqual(r.counts("laptop"), { working: 0, blocked: 1, idle: 1 });
  r.applyAgentStatus("laptop", "default", { id: "a3", title: "new", status: "working" });
  assert.deepEqual(r.counts("laptop"), { working: 1, blocked: 1, idle: 1 });
  assert.deepEqual(seen, {
    instance: "laptop",
    session: "default",
    agent: { id: "a3", title: "new", status: "working" },
  });
});

test("session add/remove reshape the instance", () => {
  const r = new Registry();
  r.replaceSnapshot("laptop", SNAP);
  r.applySessionAdded("laptop", { name: "extra", agents: [] });
  assert.deepEqual(Object.keys(r.get("laptop")!.sessions).sort(), ["default", "extra"]);
  r.applySessionRemoved("laptop", "default");
  assert.deepEqual(Object.keys(r.get("laptop")!.sessions), ["extra"]);
});

test("setOffline keeps last-known data and as_of (stale beats silent)", () => {
  const r = new Registry();
  r.replaceSnapshot("laptop", SNAP);
  const asOf = r.get("laptop")!.as_of;
  let off = false;
  r.on("offline", () => (off = true));
  r.setOffline("laptop");
  const e = r.get("laptop")!;
  assert.equal(e.online, false);
  assert.equal(e.as_of, asOf);
  assert.deepEqual(r.counts("laptop"), { working: 1, blocked: 0, idle: 1 });
  assert.equal(off, true);
  r.setOffline("laptop"); // idempotent, no second emit tested via flag reset
});

test("persistence survives restart as offline stale data", () => {
  const d = mkdtempSync(join(tmpdir(), "hwb-"));
  const path = join(d, "registry.json");
  const r1 = new Registry(path);
  r1.replaceSnapshot("laptop", SNAP);
  const r2 = new Registry(path);
  r2.load();
  const e = r2.get("laptop")!;
  assert.equal(e.online, false);
  assert.equal(e.platform, "macos");
  assert.deepEqual(r2.counts("laptop"), { working: 1, blocked: 0, idle: 1 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/registry.ts`:

```ts
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export type AgentStatus = "working" | "blocked" | "idle";

export interface AgentInfo {
  id: string;
  title: string;
  status: AgentStatus;
}

export interface SessionSnapshot {
  name: string;
  agents: AgentInfo[];
}

export interface InstanceSnapshot {
  platform: string;
  herdr_version: string;
  sessions: SessionSnapshot[];
}

export interface Counts {
  working: number;
  blocked: number;
  idle: number;
}

interface Stored {
  online: boolean;
  as_of: string;
  platform: string;
  herdr_version: string;
  sessions: Record<string, { agents: AgentInfo[] }>;
}

export class Registry extends EventEmitter {
  #instances = new Map<string, Stored>();

  constructor(readonly persistPath?: string) {
    super();
  }

  /** Boot from persisted stale data: everything comes back offline. */
  load(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    const data = JSON.parse(readFileSync(this.persistPath, "utf8")) as Record<string, Stored>;
    for (const [name, entry] of Object.entries(data)) {
      this.#instances.set(name, { ...entry, online: false });
    }
  }

  #flush(): void {
    if (!this.persistPath) return;
    writeFileSync(
      this.persistPath,
      JSON.stringify(Object.fromEntries(this.#instances), null, 2) + "\n",
    );
  }

  #touch(entry: Stored): void {
    entry.as_of = new Date().toISOString();
  }

  replaceSnapshot(instance: string, snap: InstanceSnapshot): void {
    const wasOnline = this.#instances.get(instance)?.online ?? false;
    const entry: Stored = {
      online: true,
      as_of: new Date().toISOString(),
      platform: snap.platform,
      herdr_version: snap.herdr_version,
      sessions: Object.fromEntries(snap.sessions.map((s) => [s.name, { agents: s.agents }])),
    };
    this.#instances.set(instance, entry);
    this.#flush();
    if (!wasOnline) this.emit("online", { instance });
    this.emit("snapshot", { instance });
  }

  applyAgentStatus(instance: string, session: string, agent: AgentInfo): void {
    const entry = this.#instances.get(instance);
    if (!entry) return;
    const sess = (entry.sessions[session] ??= { agents: [] });
    const existing = sess.agents.findIndex((a) => a.id === agent.id);
    if (existing === -1) sess.agents.push(agent);
    else sess.agents[existing] = agent;
    this.#touch(entry);
    this.#flush();
    this.emit("agent_status", { instance, session, agent });
  }

  applySessionAdded(instance: string, session: SessionSnapshot): void {
    const entry = this.#instances.get(instance);
    if (!entry) return;
    entry.sessions[session.name] = { agents: session.agents };
    this.#touch(entry);
    this.#flush();
    this.emit("session_added", { instance, session });
  }

  applySessionRemoved(instance: string, session: string): void {
    const entry = this.#instances.get(instance);
    if (!entry) return;
    delete entry.sessions[session];
    this.#touch(entry);
    this.#flush();
    this.emit("session_removed", { instance, session });
  }

  /** Keeps last-known sessions and as_of — stale beats silent (spec §5). */
  setOffline(instance: string): void {
    const entry = this.#instances.get(instance);
    if (!entry || !entry.online) return;
    entry.online = false;
    this.#flush();
    this.emit("offline", { instance });
  }

  get(instance: string): Stored | undefined {
    return this.#instances.get(instance);
  }

  instances(): string[] {
    return [...this.#instances.keys()];
  }

  counts(instance: string): Counts {
    const counts: Counts = { working: 0, blocked: 0, idle: 0 };
    const entry = this.#instances.get(instance);
    if (!entry) return counts;
    for (const sess of Object.values(entry.sessions)) {
      for (const agent of sess.agents) counts[agent.status] += 1;
    }
    return counts;
  }

  rollup(): { instance: string; online: boolean; as_of: string; counts: Counts }[] {
    return this.instances().map((instance) => {
      const entry = this.#instances.get(instance)!;
      return { instance, online: entry.online, as_of: entry.as_of, counts: this.counts(instance) };
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: event-emitting instance registry with stale persistence" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Fake herdr + local attach

**Files:**
- Create: `test/util.ts`, `test/fake-herdr.ts`, `src/local-attach.ts`
- Test: `test/local-attach.test.ts`

**Interfaces:**
- Consumes: `NdjsonDecoder`/`encodeFrame`, `Registry` + snapshot types, `BrokerError`.
- Produces:
  - `test/util.ts`: `waitFor(fn: () => boolean | Promise<boolean>, ms?: number): Promise<void>` (polls every 10ms, default 2000ms, throws on timeout); `tmpDir(): string`
  - `test/fake-herdr.ts`: `class FakeHerdr { constructor(socketPath: string); agents: AgentInfo[]; received: { method: string; params: unknown }[]; handlers: Map<string, (params: unknown) => unknown>; listen(): Promise<void>; close(): Promise<void>; emitEvent(event: object): void }` — NDJSON server; default handlers: `ping → {type:"pong"}`, `agent.list → {agents}`, `events.subscribe → {subscribed:true}`; unknown methods answer `{error:{code:"not_found",...}}`
  - `src/local-attach.ts`:
    - `interface HerdrEndpoint { session: string; socketPath: string }`
    - `class LocalHerdr { constructor(opts: { registry: Registry; herdrVersion: string; endpoints?: HerdrEndpoint[]; sessionsDir?: string; defaultSocket?: string; envSocket?: string; rescanMs?: number }); start(): Promise<void>; stop(): void; sessions(): string[]; request(session: string, method: string, params: unknown, timeoutMs?: number): Promise<unknown>; snapshot(): Promise<InstanceSnapshot> }`
    - `mapAgentList(result: unknown): AgentInfo[]` and `mapHerdrEvent(frame: unknown): { agent: AgentInfo } | undefined` — the two documented herdr-shape assumption adapters
    - `discoverEndpoints(opts: { sessionsDir?: string; defaultSocket?: string; envSocket?: string }): HerdrEndpoint[]`

- [ ] **Step 1: Write the test helpers (no test cycle of their own)**

`test/util.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "hwb-"));
}

export async function waitFor(fn: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}
```

`test/fake-herdr.ts`:

```ts
import { createServer, type Server, type Socket } from "node:net";
import { encodeFrame, NdjsonDecoder } from "../src/ndjson.js";
import type { AgentInfo } from "../src/registry.js";

interface Frame {
  id?: string;
  method?: string;
  params?: unknown;
}

/** Minimal stand-in for a herdr server socket: NDJSON request/response with
 * canned handlers, plus emitEvent() to stream event frames to every client. */
export class FakeHerdr {
  agents: AgentInfo[] = [];
  received: { method: string; params: unknown }[] = [];
  handlers = new Map<string, (params: unknown) => unknown>();
  #server: Server;
  #conns = new Set<Socket>();

  constructor(readonly socketPath: string) {
    this.handlers.set("ping", () => ({ type: "pong" }));
    this.handlers.set("agent.list", () => ({ agents: this.agents }));
    this.handlers.set("events.subscribe", () => ({ subscribed: true }));
    this.#server = createServer((sock) => {
      this.#conns.add(sock);
      const dec = new NdjsonDecoder();
      sock.on("data", (chunk) => {
        for (const frame of dec.push(chunk)) this.#handle(sock, frame as Frame);
      });
      sock.on("close", () => this.#conns.delete(sock));
      sock.on("error", () => this.#conns.delete(sock));
    });
  }

  #handle(sock: Socket, frame: Frame): void {
    if (!frame.method) return;
    this.received.push({ method: frame.method, params: frame.params });
    const handler = this.handlers.get(frame.method);
    if (handler) sock.write(encodeFrame({ id: frame.id, result: handler(frame.params) }));
    else
      sock.write(
        encodeFrame({
          id: frame.id,
          error: { code: "not_found", message: `unknown method ${frame.method}` },
        }),
      );
  }

  emitEvent(event: object): void {
    for (const sock of this.#conns) sock.write(encodeFrame({ event }));
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.#server.listen(this.socketPath, resolve));
  }

  close(): Promise<void> {
    for (const sock of this.#conns) sock.destroy();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }
}
```

- [ ] **Step 2: Write the failing test**

`test/local-attach.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Registry } from "../src/registry.js";
import { LocalHerdr, mapAgentList, mapHerdrEvent } from "../src/local-attach.js";
import { BrokerError } from "../src/errors.js";
import { FakeHerdr } from "./fake-herdr.js";
import { tmpDir, waitFor } from "./util.js";

async function setup() {
  const dir = tmpDir();
  const fake = new FakeHerdr(join(dir, "h.sock"));
  fake.agents = [{ id: "a1", title: "claude", status: "working" }];
  await fake.listen();
  const registry = new Registry();
  const local = new LocalHerdr({
    registry,
    herdrVersion: "0.8.0-test",
    endpoints: [{ session: "default", socketPath: fake.socketPath }],
  });
  await local.start();
  return { fake, registry, local };
}

test("adapters map the assumed herdr shapes and reject junk", () => {
  assert.deepEqual(mapAgentList({ agents: [{ id: "a1", title: "t", status: "blocked" }] }), [
    { id: "a1", title: "t", status: "blocked" },
  ]);
  assert.deepEqual(mapAgentList({ nope: 1 }), []);
  assert.deepEqual(
    mapHerdrEvent({
      event: {
        type: "pane.agent_status_changed",
        agent: { id: "a1", title: "t", status: "idle" },
      },
    }),
    { agent: { id: "a1", title: "t", status: "idle" } },
  );
  assert.equal(mapHerdrEvent({ event: { type: "workspace.created" } }), undefined);
});

test("start subscribes, snapshots runtime into the registry, and rpc round-trips", async () => {
  const { fake, registry, local } = await setup();
  assert.deepEqual(local.sessions(), ["default"]);
  assert.ok(fake.received.some((r) => r.method === "events.subscribe"));
  const entry = registry.get("runtime");
  assert.ok(entry?.online);
  assert.equal(entry.herdr_version, "0.8.0-test");
  assert.deepEqual(registry.counts("runtime"), { working: 1, blocked: 0, idle: 0 });
  const result = (await local.request("default", "agent.list", {})) as { agents: unknown[] };
  assert.equal(result.agents.length, 1);
  local.stop();
  await fake.close();
});

test("herdr errors and unknown sessions become BrokerErrors", async () => {
  const { fake, local } = await setup();
  await assert.rejects(
    () => local.request("default", "no.such.method", {}),
    (e: BrokerError) => e.code === "not_found",
  );
  await assert.rejects(
    () => local.request("ghost", "ping", {}),
    (e: BrokerError) => e.code === "unknown_session",
  );
  local.stop();
  await fake.close();
});

test("streamed status events update the runtime registry entry", async () => {
  const { fake, registry, local } = await setup();
  fake.emitEvent({
    type: "pane.agent_status_changed",
    agent: { id: "a1", title: "claude", status: "blocked" },
  });
  await waitFor(() => registry.counts("runtime").blocked === 1);
  local.stop();
  await fake.close();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/local-attach.js` not found.

- [ ] **Step 4: Implement**

`src/local-attach.ts`:

```ts
import { existsSync, readdirSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { BrokerError } from "./errors.js";
import { encodeFrame, NdjsonDecoder } from "./ndjson.js";
import type { AgentInfo, AgentStatus, InstanceSnapshot, Registry } from "./registry.js";
import { DEFAULT_TIMEOUT_MS } from "./tunnel.js";

export interface HerdrEndpoint {
  session: string;
  socketPath: string;
}

/** ASSUMPTION (validated by live smoke, spec Global note): agent.list returns
 * { agents: [{ id, title, status }] } with status ∈ working|blocked|idle. */
export function mapAgentList(result: unknown): AgentInfo[] {
  const r = result as { agents?: Array<{ id?: unknown; title?: unknown; status?: unknown }> };
  if (!Array.isArray(r?.agents)) return [];
  return r.agents.map((a) => ({
    id: String(a.id ?? ""),
    title: String(a.title ?? ""),
    status: (a.status === "working" || a.status === "blocked" ? a.status : "idle") as AgentStatus,
  }));
}

/** ASSUMPTION (validated by live smoke): streamed frames look like
 * { event: { type: "pane.agent_status_changed", agent: {...} } } — the fake
 * wraps emitEvent() payloads in { event }, matching this shape. */
export function mapHerdrEvent(frame: unknown): { agent: AgentInfo } | undefined {
  const f = frame as { event?: { type?: string; agent?: AgentInfo } };
  if (f?.event?.type === "pane.agent_status_changed" && f.event.agent) {
    return { agent: f.event.agent };
  }
  return undefined;
}

export function discoverEndpoints(opts: {
  sessionsDir?: string;
  defaultSocket?: string;
  envSocket?: string;
}): HerdrEndpoint[] {
  const seen = new Map<string, HerdrEndpoint>();
  const add = (session: string, socketPath: string) => {
    if (existsSync(socketPath) && !seen.has(socketPath)) seen.set(socketPath, { session, socketPath });
  };
  if (opts.envSocket) {
    const named = /sessions\/([^/]+)\/herdr\.sock$/.exec(opts.envSocket);
    add(named ? named[1] : "default", opts.envSocket);
  }
  if (opts.defaultSocket) add("default", opts.defaultSocket);
  if (opts.sessionsDir && existsSync(opts.sessionsDir)) {
    for (const name of readdirSync(opts.sessionsDir)) {
      add(name, join(opts.sessionsDir, name, "herdr.sock"));
    }
  }
  return [...seen.values()];
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

class SessionConn {
  #sock?: Socket;
  #dec = new NdjsonDecoder();
  #pending = new Map<string, Pending>();
  #seq = 0;

  constructor(
    readonly session: string,
    readonly socketPath: string,
    private onEvent: (frame: unknown) => void,
    private onClose: () => void,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = connect(this.socketPath);
      this.#sock = sock;
      sock.once("connect", resolve);
      sock.once("error", reject);
      sock.on("data", (chunk) => {
        for (const frame of this.#dec.push(chunk)) this.#route(frame);
      });
      sock.on("close", () => {
        for (const p of this.#pending.values()) {
          clearTimeout(p.timer);
          p.reject(new BrokerError("instance_offline", "local herdr socket closed"));
        }
        this.#pending.clear();
        this.onClose();
      });
    });
  }

  #route(frame: unknown): void {
    const f = frame as { id?: string; result?: unknown; error?: { code: string; message: string } };
    const pending = f.id ? this.#pending.get(f.id) : undefined;
    if (!pending) {
      this.onEvent(frame);
      return;
    }
    this.#pending.delete(f.id!);
    clearTimeout(pending.timer);
    if (f.error) pending.reject(new BrokerError(f.error.code, f.error.message));
    else pending.resolve(f.result);
  }

  rpc(method: string, params: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    const id = `l${++this.#seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new BrokerError("upstream_timeout", `local ${method} exceeded ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#sock?.write(encodeFrame({ id, method, params }));
    });
  }

  close(): void {
    this.#sock?.destroy();
  }
}

export class LocalHerdr {
  #conns = new Map<string, SessionConn>();
  #timer?: NodeJS.Timeout;
  #stopped = false;

  constructor(
    private opts: {
      registry: Registry;
      herdrVersion: string;
      endpoints?: HerdrEndpoint[];
      sessionsDir?: string;
      defaultSocket?: string;
      envSocket?: string;
      rescanMs?: number;
    },
  ) {}

  async start(): Promise<void> {
    await this.#rescan();
    this.opts.registry.replaceSnapshot("runtime", await this.snapshot());
    const interval = this.opts.rescanMs ?? 15_000;
    this.#timer = setInterval(() => void this.#rescan(), interval);
    this.#timer.unref();
  }

  async #rescan(): Promise<void> {
    if (this.#stopped) return;
    const endpoints = this.opts.endpoints ?? discoverEndpoints(this.opts);
    for (const ep of endpoints) {
      if (this.#conns.has(ep.session)) continue;
      const conn = new SessionConn(
        ep.session,
        ep.socketPath,
        (frame) => {
          const mapped = mapHerdrEvent(frame);
          if (mapped) this.opts.registry.applyAgentStatus("runtime", ep.session, mapped.agent);
        },
        () => {
          this.#conns.delete(ep.session);
          if (!this.#stopped) this.opts.registry.applySessionRemoved("runtime", ep.session);
        },
      );
      try {
        await conn.connect();
        this.#conns.set(ep.session, conn);
        await conn.rpc("events.subscribe", {
          subscriptions: [{ type: "pane.agent_status_changed" }],
        }).catch(() => undefined);
        const agents = mapAgentList(await conn.rpc("agent.list", {}).catch(() => ({})));
        this.opts.registry.applySessionAdded("runtime", { name: ep.session, agents });
      } catch {
        // socket not connectable right now; next rescan retries
      }
    }
  }

  sessions(): string[] {
    return [...this.#conns.keys()];
  }

  request(session: string, method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const conn = this.#conns.get(session);
    if (!conn) {
      return Promise.reject(new BrokerError("unknown_session", `no local session '${session}'`));
    }
    return conn.rpc(method, params, timeoutMs);
  }

  async snapshot(): Promise<InstanceSnapshot> {
    const sessions = [];
    for (const conn of this.#conns.values()) {
      const agents = mapAgentList(await conn.rpc("agent.list", {}).catch(() => ({})));
      sessions.push({ name: conn.session, agents });
    }
    const platformMap: Record<string, string> = { darwin: "macos", win32: "windows" };
    return {
      platform: platformMap[process.platform] ?? process.platform,
      herdr_version: this.opts.herdrVersion,
      sessions,
    };
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    for (const conn of this.#conns.values()) conn.close();
    this.#conns.clear();
  }
}
```

Also create the constants half of `src/tunnel.ts` now (the classes arrive in Task 6), because `local-attach.ts` imports `DEFAULT_TIMEOUT_MS`:

```ts
export const PROTO_VERSION = 1;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const HEARTBEAT_MS = 15_000;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: local herdr attach with discovery, events, and snapshot" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Tunnel — frames, hub, enroll endpoint (parent side)

**Files:**
- Modify: `src/tunnel.ts` (append to the constants from Task 5)
- Create: `src/ws-server.ts`
- Test: `test/tunnel.test.ts`

**Interfaces:**
- Consumes: `Registry` apply methods, `ChildrenStore`, `verifySecret`, `BrokerError`.
- Produces (in `tunnel.ts`):
  - Frame types: `TunnelFrame` union of `{type:"hello"; name; platform; herdr_version; plugin_version; proto: number; sessions: SessionSnapshot[]}`, `{type:"welcome"; name; proto}`, `{type:"req"; id; session; method; params?; timeout_ms?}`, `{type:"res"; id; result?; error?: {code: string; message: string}}`, `{type:"event"; event: TunnelEvent}`
  - `type TunnelEvent = {kind:"agent_status"; session: string; agent: AgentInfo} | {kind:"session_added"; session: SessionSnapshot} | {kind:"session_removed"; session: string} | {kind:"snapshot"; snapshot: InstanceSnapshot}`
  - `class ChildConnection { constructor(name: string, ws: WebSocket, registry: Registry, onGone: () => void); request(session: string, method: string, params: unknown, timeoutMs?: number): Promise<unknown>; close(): void }` — WS message = one JSON frame (no newline framing needed on WS); request ids are `` `${name}:${seq}` ``; heartbeat: `ws.ping()` every `HEARTBEAT_MS`, terminate after 2 missed pongs; on close → fail pending with `instance_offline`, `registry.setOffline(name)`, `onGone()`
  - `class TunnelHub { get(name: string): ChildConnection | undefined; attach(name: string, ws: WebSocket, registry: Registry): ChildConnection; disconnect(name: string): void; names(): string[] }` — `attach` replaces (closes) an existing connection of the same name
- Produces (in `ws-server.ts`): `attachUpgradeHandling(server: http.Server, deps: WsDeps): void` where `interface WsDeps { children: ChildrenStore; hub: TunnelHub; registry: Registry; config: BrokerConfig; callInstance?: CallInstance }` — handles `/parent/enroll` now; `/parent/ws` returns 404 until Task 10 fills it in. `type CallInstance = (instance: string, session: string, method: string, params: unknown, timeoutMs?: number) => Promise<unknown>` (defined here, implemented by `http.ts` in Task 7).

- [ ] **Step 1: Write the failing test**

`test/tunnel.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { Registry } from "../src/registry.js";
import { ChildrenStore } from "../src/state.js";
import { hashSecret } from "../src/auth.js";
import { TunnelHub, PROTO_VERSION } from "../src/tunnel.js";
import { attachUpgradeHandling } from "../src/ws-server.js";
import { loadConfig } from "../src/config.js";
import { tmpDir, waitFor } from "./util.js";

const HELLO = {
  type: "hello",
  name: "laptop",
  platform: "macos",
  herdr_version: "0.8.0",
  plugin_version: "0.1.0",
  proto: PROTO_VERSION,
  sessions: [{ name: "default", agents: [{ id: "a1", title: "claude", status: "idle" }] }],
};

async function setup() {
  const stateDir = tmpDir();
  const children = new ChildrenStore(stateDir);
  children.set("laptop", hashSecret("sekret"));
  const registry = new Registry();
  const hub = new TunnelHub();
  const server = createServer((_, res) => res.writeHead(404).end());
  attachUpgradeHandling(server, { children, hub, registry, config: loadConfig(tmpDir()) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { children, registry, hub, server, port };
}

function dial(port: number, name: string, secret: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/parent/enroll`, {
    headers: { "x-herdr-broker-name": name, "x-herdr-broker-secret": secret },
  });
}

test("enroll: wrong secret is refused before upgrade", async () => {
  const { server, port } = await setup();
  const ws = dial(port, "laptop", "wrong");
  const err = await new Promise<Error>((r) => ws.once("error", r));
  assert.match(err.message, /401/);
  server.close();
});

test("enroll: hello→welcome, snapshot lands, req/res round-trips, events apply, close = offline", async () => {
  const { registry, hub, server, port } = await setup();
  const ws = dial(port, "laptop", "sekret");
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify(HELLO));

  const welcome = JSON.parse(String(await new Promise((r) => ws.once("message", r))));
  assert.deepEqual(welcome, { type: "welcome", name: "laptop", proto: PROTO_VERSION });
  assert.ok(registry.get("laptop")?.online);
  assert.deepEqual(registry.counts("laptop"), { working: 0, blocked: 0, idle: 1 });

  // child answers exactly ONE forwarded request — `once`, not `on`: a permanent
  // listener would also auto-answer the later agent.wait req, defeating the
  // instance_offline assertion below (fixture bug found in execution, ruled fixed)
  ws.once("message", (data) => {
    const frame = JSON.parse(String(data));
    if (frame.type === "req") {
      assert.equal(frame.session, "default");
      assert.equal(frame.method, "agent.list");
      ws.send(JSON.stringify({ type: "res", id: frame.id, result: { agents: [] } }));
    }
  });
  const result = await hub.get("laptop")!.request("default", "agent.list", {});
  assert.deepEqual(result, { agents: [] });

  // child pushes a status event
  ws.send(
    JSON.stringify({
      type: "event",
      event: {
        kind: "agent_status",
        session: "default",
        agent: { id: "a1", title: "claude", status: "working" },
      },
    }),
  );
  await waitFor(() => registry.counts("laptop").working === 1);

  // pending requests fail and the instance goes offline when the tunnel drops
  const pending = hub.get("laptop")!.request("default", "agent.wait", {});
  ws.close();
  await assert.rejects(pending, (e: { code: string }) => e.code === "instance_offline");
  await waitFor(() => registry.get("laptop")!.online === false);
  assert.equal(hub.get("laptop"), undefined);
  server.close();
});

test("enroll: wrong proto is closed with proto_mismatch", async () => {
  const { server, port } = await setup();
  const ws = dial(port, "laptop", "sekret");
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ ...HELLO, proto: 99 }));
  const code = await new Promise<number>((r) => ws.once("close", (c) => r(c)));
  assert.equal(code, 4001);
  server.close();
});

test("hub.disconnect severs the live tunnel (revocation path)", async () => {
  const { registry, hub, server, port } = await setup();
  const ws = dial(port, "laptop", "sekret");
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify(HELLO));
  await new Promise((r) => ws.once("message", r));
  hub.disconnect("laptop");
  await waitFor(() => registry.get("laptop")!.online === false);
  server.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `attachUpgradeHandling` / `TunnelHub` not found.

- [ ] **Step 3: Implement**

Append to `src/tunnel.ts` (below the constants):

```ts
import type WebSocket from "ws";
import { BrokerError } from "./errors.js";
import type { AgentInfo, InstanceSnapshot, Registry, SessionSnapshot } from "./registry.js";

export type TunnelEvent =
  | { kind: "agent_status"; session: string; agent: AgentInfo }
  | { kind: "session_added"; session: SessionSnapshot }
  | { kind: "session_removed"; session: string }
  | { kind: "snapshot"; snapshot: InstanceSnapshot };

export type TunnelFrame =
  | {
      type: "hello";
      name: string;
      platform: string;
      herdr_version: string;
      plugin_version: string;
      proto: number;
      sessions: SessionSnapshot[];
    }
  | { type: "welcome"; name: string; proto: number }
  | { type: "req"; id: string; session: string; method: string; params?: unknown; timeout_ms?: number }
  | { type: "res"; id: string; result?: unknown; error?: { code: string; message: string } }
  | { type: "event"; event: TunnelEvent };

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Parent-side wrapper around one enrolled child's WebSocket. */
export class ChildConnection {
  #pending = new Map<string, Pending>();
  #seq = 0;
  #missedPongs = 0;
  #heartbeat: NodeJS.Timeout;

  constructor(
    readonly name: string,
    private ws: WebSocket,
    private registry: Registry,
    private onGone: () => void,
  ) {
    ws.on("message", (data) => this.#route(JSON.parse(String(data)) as TunnelFrame));
    ws.on("pong", () => (this.#missedPongs = 0));
    this.#heartbeat = setInterval(() => {
      this.#missedPongs += 1;
      if (this.#missedPongs > 2) {
        ws.terminate();
        return;
      }
      ws.ping();
    }, HEARTBEAT_MS);
    this.#heartbeat.unref();
    ws.on("close", () => this.#gone());
    ws.on("error", () => this.#gone());
  }

  #gone(): void {
    clearInterval(this.#heartbeat);
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(new BrokerError("instance_offline", `tunnel to '${this.name}' closed`));
    }
    this.#pending.clear();
    // setOffline lives in the hub's identity-guarded onGone — a replaced (stale)
    // connection's async close must not mark the freshly reattached child offline.
    this.onGone();
  }

  #route(frame: TunnelFrame): void {
    if (frame.type === "res") {
      const pending = this.#pending.get(frame.id);
      if (!pending) return;
      this.#pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.error) pending.reject(new BrokerError(frame.error.code, frame.error.message));
      else pending.resolve(frame.result);
    } else if (frame.type === "event") {
      const e = frame.event;
      if (e.kind === "agent_status") this.registry.applyAgentStatus(this.name, e.session, e.agent);
      else if (e.kind === "session_added") this.registry.applySessionAdded(this.name, e.session);
      else if (e.kind === "session_removed") this.registry.applySessionRemoved(this.name, e.session);
      else if (e.kind === "snapshot") this.registry.replaceSnapshot(this.name, e.snapshot);
    }
  }

  request(session: string, method: string, params: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    const id = `${this.name}:${++this.#seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new BrokerError("upstream_timeout", `'${this.name}' gave no response in ${timeoutMs}ms`, {
            instance: this.name,
          }),
        );
      }, timeoutMs + 1000); // child applies timeoutMs to its local call; grace for transit
      this.#pending.set(id, { resolve, reject, timer });
      this.ws.send(
        JSON.stringify({ type: "req", id, session, method, params, timeout_ms: timeoutMs }),
      );
    });
  }

  close(): void {
    this.ws.close();
  }
}

export class TunnelHub {
  #children = new Map<string, ChildConnection>();

  get(name: string): ChildConnection | undefined {
    return this.#children.get(name);
  }

  names(): string[] {
    return [...this.#children.keys()];
  }

  /** A re-enrolling child replaces its previous connection. Only the CURRENT
   * connection's death marks the instance offline — the replaced connection's
   * async close arrives after the new tunnel is live and must not flip it. */
  attach(name: string, ws: WebSocket, registry: Registry): ChildConnection {
    this.#children.get(name)?.close();
    const conn = new ChildConnection(name, ws, registry, () => {
      if (this.#children.get(name) === conn) {
        this.#children.delete(name);
        registry.setOffline(name);
      }
    });
    this.#children.set(name, conn);
    return conn;
  }

  disconnect(name: string): void {
    this.#children.get(name)?.close();
  }
}
```

`src/ws-server.ts`:

```ts
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { verifySecret } from "./auth.js";
import type { BrokerConfig } from "./config.js";
import type { Registry } from "./registry.js";
import type { ChildrenStore } from "./state.js";
import { PROTO_VERSION, TunnelHub, type TunnelFrame } from "./tunnel.js";

export type CallInstance = (
  instance: string,
  session: string,
  method: string,
  params: unknown,
  timeoutMs?: number,
) => Promise<unknown>;

export interface WsDeps {
  children: ChildrenStore;
  hub: TunnelHub;
  registry: Registry;
  config: BrokerConfig;
  callInstance?: CallInstance;
}

export function attachUpgradeHandling(server: Server, deps: WsDeps): void {
  const enrollWss = new WebSocketServer({ noServer: true });
  const clientWss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? "/", "http://placeholder").pathname;
    if (path === "/parent/enroll") {
      const name = String(req.headers["x-herdr-broker-name"] ?? "");
      const secret = String(req.headers["x-herdr-broker-secret"] ?? "");
      const child = deps.children.get(name);
      if (!name || !child || !verifySecret(secret, child.secret_hash)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      enrollWss.handleUpgrade(req, socket, head, (ws) => acceptChild(deps, name, ws));
    } else if (path === "/parent/ws") {
      // Task 10 wires the client duplex; until then: not found.
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      void clientWss;
    } else {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    }
  });
}

function acceptChild(deps: WsDeps, name: string, ws: WebSocket): void {
  const timer = setTimeout(() => ws.close(4000, "hello timeout"), 5000);
  ws.once("message", (data) => {
    clearTimeout(timer);
    const hello = JSON.parse(String(data)) as TunnelFrame;
    if (hello.type !== "hello" || hello.proto !== PROTO_VERSION) {
      ws.close(4001, "proto_mismatch");
      return;
    }
    // The enrolled (secret-bound) name is authoritative; hello.name is informational.
    deps.registry.replaceSnapshot(name, {
      platform: hello.platform,
      herdr_version: hello.herdr_version,
      sessions: hello.sessions,
    });
    deps.hub.attach(name, ws, deps.registry);
    ws.send(JSON.stringify({ type: "welcome", name, proto: PROTO_VERSION }));
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: tunnel frames, child connections, hub, and enroll endpoint" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: HTTP facade — REST, admin, health

**Files:**
- Create: `src/http.ts`
- Test: `test/http.test.ts`

**Interfaces:**
- Consumes: `Registry`, `LocalHerdr`, `TunnelHub`, `ChildrenStore`, `BrokerConfig`, `checkBearer`, `mintSecret`/`hashSecret`, `BrokerError`/`httpStatus`, `mapAgentList`.
- Produces:
  - `interface HttpDeps { registry: Registry; local: LocalHerdr; hub: TunnelHub; children: ChildrenStore; config: BrokerConfig; adminToken: string; onReload?: () => void }`
  - `createHttpHandler(deps: HttpDeps): (req: IncomingMessage, res: ServerResponse) => void`
  - `makeCallInstance(deps: { registry: Registry; local: LocalHerdr; hub: TunnelHub; remoteDeny: string[] }): CallInstance` — routes `runtime` to `local.request`, anything else through the hub; throws `unknown_instance` / `instance_offline` (with `last_seen`) / `unknown_session`. For non-runtime instances it pre-checks `methodDenied(method, remoteDeny)` and throws `method_denied` **without touching the tunnel** (spec §2); the child re-enforces its own policy authoritatively (spec §4, Task 9) — defense in depth.
  - Response shapes (consumed by Tasks 10, 12, 13):
    - `GET /health` → 200 `{ok: true, name: "herdr-web-broker", version, pid}` (no auth)
    - `GET /parent` → `{instances: rollup()}`
    - `GET /parent/{i}` → `{instance, online, as_of, platform, herdr_version, counts, sessions: string[]}`
    - `GET /parent/{i}/sessions` → `{sessions: [{name, counts}]}`
    - `GET /parent/{i}/sessions/{s}/agents[?fresh=1]` → `{instance, session, online, as_of, agents}`
    - `POST /parent/{i}/sessions/{s}/rpc` body `{method, params?, timeout_ms?}` → 200 `{result}` or error envelope
    - Admin (loopback-only + `x-admin-token` header): `GET /admin/status` → `{listen, instances, children}`; `POST /admin/children {name}` → `{name, secret}`; `DELETE /admin/children/{name}` → 200 `{revoked: name}`; `POST /admin/reload` → `{reloaded: true}`

- [ ] **Step 1: Write the failing test**

`test/http.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Registry } from "../src/registry.js";
import { LocalHerdr } from "../src/local-attach.js";
import { TunnelHub } from "../src/tunnel.js";
import { ChildrenStore } from "../src/state.js";
import { loadConfig } from "../src/config.js";
import { createHttpHandler } from "../src/http.js";
import { FakeHerdr } from "./fake-herdr.js";
import { tmpDir } from "./util.js";

async function setup() {
  const fake = new FakeHerdr(join(tmpDir(), "h.sock"));
  fake.agents = [{ id: "a1", title: "claude", status: "working" }];
  await fake.listen();
  const registry = new Registry();
  const local = new LocalHerdr({
    registry,
    herdrVersion: "0.8.0-test",
    endpoints: [{ session: "default", socketPath: fake.socketPath }],
  });
  await local.start();
  const config = loadConfig(tmpDir());
  config.client_tokens = [{ name: "t", token: "tok" }];
  const children = new ChildrenStore(tmpDir());
  const server = createServer(
    createHttpHandler({
      registry,
      local,
      hub: new TunnelHub(),
      children,
      config,
      adminToken: "admin-tok",
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const authed = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: "Bearer tok", ...init.headers } });
  return { fake, registry, local, children, server, base, authed };
}

test("health needs no auth; /parent does", async () => {
  const { server, base } = await setup();
  const health = await (await fetch(base + "/health")).json();
  assert.equal(health.ok, true);
  assert.equal(health.name, "herdr-web-broker");
  assert.equal((await fetch(base + "/parent")).status, 401);
  server.close();
});

test("GET grammar: rollup, instance, sessions, agents", async () => {
  const { server, authed } = await setup();
  const roll = await (await authed("/parent")).json();
  assert.equal(roll.instances[0].instance, "runtime");
  assert.deepEqual(roll.instances[0].counts, { working: 1, blocked: 0, idle: 0 });

  const inst = await (await authed("/parent/runtime")).json();
  assert.equal(inst.herdr_version, "0.8.0-test");
  assert.deepEqual(inst.sessions, ["default"]);

  const sessions = await (await authed("/parent/runtime/sessions")).json();
  assert.deepEqual(sessions.sessions, [
    { name: "default", counts: { working: 1, blocked: 0, idle: 0 } },
  ]);

  const agents = await (await authed("/parent/runtime/sessions/default/agents")).json();
  assert.equal(agents.agents[0].id, "a1");
  assert.equal((await authed("/parent/ghost")).status, 404);
  assert.equal((await authed("/parent/runtime/sessions/ghost/agents")).status, 404);
  server.close();
});

test("rpc passthrough returns herdr results and relays herdr errors as 502", async () => {
  const { server, authed } = await setup();
  const ok = await authed("/parent/runtime/sessions/default/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "agent.list", params: {} }),
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).result.agents.length, 1);

  const bad = await authed("/parent/runtime/sessions/default/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "no.such.method" }),
  });
  assert.equal(bad.status, 502);
  assert.equal((await bad.json()).code, "not_found");
  server.close();
});

test("fresh=1 forwards agent.list and refreshes the registry", async () => {
  const { fake, registry, server, authed } = await setup();
  fake.agents = [{ id: "a1", title: "claude", status: "blocked" }];
  const res = await (await authed("/parent/runtime/sessions/default/agents?fresh=1")).json();
  assert.equal(res.agents[0].status, "blocked");
  assert.deepEqual(registry.counts("runtime"), { working: 0, blocked: 1, idle: 0 });
  server.close();
});

test("admin: token-gated child minting and revocation", async () => {
  const { server, base, children } = await setup();
  assert.equal((await fetch(base + "/admin/status")).status, 401);
  const minted = await (
    await fetch(base + "/admin/children", {
      method: "POST",
      headers: { "x-admin-token": "admin-tok", "content-type": "application/json" },
      body: JSON.stringify({ name: "laptop" }),
    })
  ).json();
  assert.equal(minted.name, "laptop");
  assert.ok(minted.secret.length >= 40);
  assert.ok(children.get("laptop"));
  const revoked = await fetch(base + "/admin/children/laptop", {
    method: "DELETE",
    headers: { "x-admin-token": "admin-tok" },
  });
  assert.equal(revoked.status, 200);
  assert.equal(children.get("laptop"), undefined);
  server.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/http.js` not found.

- [ ] **Step 3: Implement**

`src/http.ts`:

```ts
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { checkBearer, hashSecret, mintSecret } from "./auth.js";
import type { BrokerConfig } from "./config.js";
import { BrokerError, httpStatus } from "./errors.js";
import { LocalHerdr, mapAgentList } from "./local-attach.js";
import { methodDenied } from "./policy.js";
import type { Registry } from "./registry.js";
import type { ChildrenStore } from "./state.js";
import type { TunnelHub } from "./tunnel.js";
import { PLUGIN_VERSION } from "./version.js";
import type { CallInstance } from "./ws-server.js";

export interface HttpDeps {
  registry: Registry;
  local: LocalHerdr;
  hub: TunnelHub;
  children: ChildrenStore;
  config: BrokerConfig;
  adminToken: string;
  onReload?: () => void;
}

export function makeCallInstance(deps: {
  registry: Registry;
  local: LocalHerdr;
  hub: TunnelHub;
  remoteDeny: string[];
}): CallInstance {
  return async (instance, session, method, params, timeoutMs) => {
    if (instance === "runtime") {
      if (!deps.local.sessions().includes(session)) {
        throw new BrokerError("unknown_session", `runtime has no session '${session}'`);
      }
      return deps.local.request(session, method, params, timeoutMs);
    }
    // Parent-side fast-fail per spec §2 — deny without touching the tunnel.
    // The child re-enforces its own policy authoritatively (spec §4).
    if (methodDenied(method, deps.remoteDeny)) {
      throw new BrokerError("method_denied", `'${method}' is denied for remote-originated calls`);
    }
    const entry = deps.registry.get(instance);
    if (!entry) throw new BrokerError("unknown_instance", `no instance '${instance}'`);
    const child = deps.hub.get(instance);
    if (!child) {
      throw new BrokerError("instance_offline", `'${instance}' is not connected`, {
        last_seen: entry.as_of,
      });
    }
    if (!(session in entry.sessions)) {
      throw new BrokerError("unknown_session", `'${instance}' has no session '${session}'`);
    }
    return child.request(session, method, params, timeoutMs);
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function fail(res: ServerResponse, e: unknown): void {
  const err = e instanceof BrokerError ? e : new BrokerError("upstream_error", String(e));
  try {
    json(res, httpStatus(err.code), err.toEnvelope());
  } catch {
    // the socket may already be destroyed (e.g. body-cap abort) — an error
    // response that cannot be written must never crash the daemon
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_048_576) {
      // destroy, don't just stop reading — an unconsumed oversized body leaves
      // the keep-alive framing desynced and hangs the connection's next request
      req.socket.destroy();
      throw new BrokerError("bad_request", "body exceeds 1MB");
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new BrokerError("bad_request", "body is not valid JSON");
  }
}

export function createHttpHandler(deps: HttpDeps) {
  const callInstance = makeCallInstance({
    registry: deps.registry,
    local: deps.local,
    hub: deps.hub,
    remoteDeny: deps.config.policy.remote_deny,
  });

  return (req: IncomingMessage, res: ServerResponse): void => {
    void handle(req, res).catch((e) => fail(res, e));
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://placeholder");
    const parts = url.pathname.split("/").filter(Boolean);

    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true, name: "herdr-web-broker", version: PLUGIN_VERSION, pid: process.pid });
      return;
    }

    if (parts[0] === "admin") {
      const remote = req.socket.remoteAddress ?? "";
      const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      const presented = String(req.headers["x-admin-token"] ?? "");
      const tokenOk = timingSafeEqual(
        createHash("sha256").update(presented).digest(),
        createHash("sha256").update(deps.adminToken).digest(),
      );
      if (!loopback || !tokenOk) {
        throw new BrokerError("unauthorized", "admin requires loopback + x-admin-token");
      }
      await admin(req, res, parts, url);
      return;
    }

    // bearer auth precedes ANY 404 — an unauthenticated caller learns nothing
    // about the route space, unknown prefixes included
    if (!checkBearer(req.headers.authorization, deps.config.client_tokens)) {
      throw new BrokerError("unauthorized", "missing or invalid bearer token");
    }
    if (parts[0] !== "parent") {
      throw new BrokerError("unknown_instance", `no route ${url.pathname}`);
    }

    // GET /parent
    if (parts.length === 1 && req.method === "GET") {
      json(res, 200, { instances: deps.registry.rollup() });
      return;
    }

    const instance = decodeURIComponent(parts[1] ?? "");
    const entry = deps.registry.get(instance);
    if (!entry) throw new BrokerError("unknown_instance", `no instance '${instance}'`);

    // GET /parent/{i}
    if (parts.length === 2 && req.method === "GET") {
      json(res, 200, {
        instance,
        online: entry.online,
        as_of: entry.as_of,
        platform: entry.platform,
        herdr_version: entry.herdr_version,
        counts: deps.registry.counts(instance),
        sessions: Object.keys(entry.sessions),
      });
      return;
    }

    // GET /parent/{i}/sessions
    if (parts.length === 3 && parts[2] === "sessions" && req.method === "GET") {
      const sessions = Object.entries(entry.sessions).map(([name, sess]) => {
        const counts = { working: 0, blocked: 0, idle: 0 };
        for (const agent of sess.agents) counts[agent.status] += 1;
        return { name, counts };
      });
      json(res, 200, { sessions });
      return;
    }

    const session = decodeURIComponent(parts[3] ?? "");
    if (parts[2] !== "sessions" || !(session in entry.sessions)) {
      throw new BrokerError("unknown_session", `'${instance}' has no session '${session}'`);
    }

    // GET /parent/{i}/sessions/{s}/agents
    if (parts[4] === "agents" && req.method === "GET") {
      let agents = entry.sessions[session].agents;
      if (url.searchParams.get("fresh") === "1") {
        agents = mapAgentList(await callInstance(instance, session, "agent.list", {}));
        deps.registry.applySessionAdded(instance, { name: session, agents });
      }
      json(res, 200, { instance, session, online: entry.online, as_of: entry.as_of, agents });
      return;
    }

    // POST /parent/{i}/sessions/{s}/rpc
    if (parts[4] === "rpc" && req.method === "POST") {
      const body = await readBody(req);
      const method = body.method;
      if (typeof method !== "string" || method.length === 0) {
        throw new BrokerError("bad_request", "rpc body needs a string 'method'");
      }
      const timeout = typeof body.timeout_ms === "number" ? body.timeout_ms : undefined;
      const result = await callInstance(instance, session, method, body.params ?? {}, timeout);
      json(res, 200, { result });
      return;
    }

    throw new BrokerError("bad_request", `unsupported route ${req.method} ${url.pathname}`);
  }

  async function admin(
    req: IncomingMessage,
    res: ServerResponse,
    parts: string[],
    url: URL,
  ): Promise<void> {
    if (req.method === "GET" && parts[1] === "status") {
      json(res, 200, {
        listen: deps.config.listen,
        instances: deps.registry.rollup(),
        children: deps.children.names(),
      });
      return;
    }
    if (req.method === "POST" && parts[1] === "children" && parts.length === 2) {
      const body = await readBody(req);
      const name = body.name;
      if (typeof name !== "string" || !/^[a-zA-Z0-9._-]+$/.test(name)) {
        throw new BrokerError("bad_request", "child name must be [a-zA-Z0-9._-]+");
      }
      const secret = mintSecret();
      deps.children.set(name, hashSecret(secret));
      json(res, 200, { name, secret });
      return;
    }
    if (req.method === "DELETE" && parts[1] === "children" && parts.length === 3) {
      const name = decodeURIComponent(parts[2]);
      deps.children.delete(name);
      deps.hub.disconnect(name);
      json(res, 200, { revoked: name });
      return;
    }
    if (req.method === "POST" && parts[1] === "reload") {
      deps.onReload?.();
      json(res, 200, { reloaded: true });
      return;
    }
    throw new BrokerError("bad_request", `unsupported admin route ${req.method} ${url.pathname}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: REST facade with /parent grammar, admin surface, health" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Daemon assembly and lifecycle singleton

**Files:**
- Create: `src/daemon.ts`
- Test: `test/daemon.test.ts`

**Interfaces:**
- Consumes: everything so far.
- Produces:
  - `interface DaemonOptions { configDir: string; stateDir: string; configOverrides?: Partial<BrokerConfig>; localEndpoints?: HerdrEndpoint[]; herdrVersion?: string; projectionDir?: string }`
  - `interface DaemonHandle { port: number; host: string; base: string; registry: Registry; hub: TunnelHub; children: ChildrenStore; adminToken: string; config: BrokerConfig; local: LocalHerdr; close(): Promise<void> }`
  - `startDaemon(opts: DaemonOptions): Promise<DaemonHandle | undefined>` — returns `undefined` when a healthy daemon already owns the lock. Lock is written after listen (with the real port, so `listen: "127.0.0.1:0"` works in tests). Stale locks (health fetch fails or names a different service) are replaced.
  - Run as main module (`node dist/src/daemon.js`): dirs from `HERDR_PLUGIN_CONFIG_DIR`/`HERDR_PLUGIN_STATE_DIR`, herdr version via `spawnSync(HERDR_BIN_PATH, ["--version"])`, local sockets discovered from `HERDR_SOCKET_PATH` + `~/.config/herdr/`; SIGINT/SIGTERM → graceful close.
  - TLS: when `config.tls` is set, serve `https`/`wss` using the cert/key files.
  - Tasks 9/11 modify this file to wire `ParentLink` and `Projection` (marked below).

- [ ] **Step 1: Write the failing test**

`test/daemon.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { startDaemon } from "../src/daemon.js";
import { FakeHerdr } from "./fake-herdr.js";
import { tmpDir } from "./util.js";

async function boot() {
  const fake = new FakeHerdr(join(tmpDir(), "h.sock"));
  await fake.listen();
  const stateDir = tmpDir();
  const handle = await startDaemon({
    configDir: tmpDir(),
    stateDir,
    configOverrides: { listen: "127.0.0.1:0", client_tokens: [{ name: "t", token: "tok" }] },
    localEndpoints: [{ session: "default", socketPath: fake.socketPath }],
    herdrVersion: "0.8.0-test",
  });
  return { fake, stateDir, handle: handle! };
}

test("daemon boots, serves health and authed REST, and closes cleanly", async () => {
  const { fake, handle } = await boot();
  const health = await (await fetch(`${handle.base}/health`)).json();
  assert.equal(health.ok, true);
  const roll = await (
    await fetch(`${handle.base}/parent`, { headers: { authorization: "Bearer tok" } })
  ).json();
  assert.equal(roll.instances[0].instance, "runtime");
  await handle.close();
  await fake.close();
});

test("second daemon against the same state dir yields to the healthy first", async () => {
  const { fake, stateDir, handle } = await boot();
  const second = await startDaemon({
    configDir: tmpDir(),
    stateDir,
    configOverrides: { listen: "127.0.0.1:0" },
    localEndpoints: [],
    herdrVersion: "0.8.0-test",
  });
  assert.equal(second, undefined);
  await handle.close();
  await fake.close();
});

test("a stale lock is replaced", async () => {
  const { fake, stateDir, handle } = await boot();
  await handle.close(); // lock cleared on close; recreate a stale one by hand
  const { writeLock } = await import("../src/state.js");
  writeLock(stateDir, { pid: 999999, listen: "127.0.0.1:1" });
  const again = await startDaemon({
    configDir: tmpDir(),
    stateDir,
    configOverrides: { listen: "127.0.0.1:0" },
    localEndpoints: [],
    herdrVersion: "0.8.0-test",
  });
  assert.ok(again);
  await again.close();
  await fake.close();
});

test("tls config serves https when openssl is available", async (t) => {
  const which = spawnSync("openssl", ["version"]);
  if (which.status !== 0) return t.skip("no openssl");
  const dir = tmpDir();
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost",
  ]);
  const handle = await startDaemon({
    configDir: tmpDir(),
    stateDir: tmpDir(),
    configOverrides: { listen: "127.0.0.1:0", tls: { cert, key } },
    localEndpoints: [],
    herdrVersion: "0.8.0-test",
  });
  assert.ok(handle!.base.startsWith("https://"));
  await handle!.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/daemon.js` not found.

- [ ] **Step 3: Implement**

`src/daemon.ts`:

```ts
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, type BrokerConfig } from "./config.js";
import { createHttpHandler, makeCallInstance } from "./http.js";
import { LocalHerdr, type HerdrEndpoint } from "./local-attach.js";
import { Registry } from "./registry.js";
import { ChildrenStore, clearLock, ensureAdminToken, readLock, writeLock } from "./state.js";
import { TunnelHub } from "./tunnel.js";
import { attachUpgradeHandling } from "./ws-server.js";

export interface DaemonOptions {
  configDir: string;
  stateDir: string;
  configOverrides?: Partial<BrokerConfig>;
  localEndpoints?: HerdrEndpoint[];
  herdrVersion?: string;
  projectionDir?: string;
}

export interface DaemonHandle {
  port: number;
  host: string;
  base: string;
  registry: Registry;
  hub: TunnelHub;
  children: ChildrenStore;
  adminToken: string;
  config: BrokerConfig;
  local: LocalHerdr;
  close(): Promise<void>;
}

async function otherDaemonHealthy(stateDir: string): Promise<boolean> {
  const lock = readLock(stateDir);
  if (!lock) return false;
  try {
    const res = await fetch(`http://${lock.listen}/health`, { signal: AbortSignal.timeout(1000) });
    const body = (await res.json()) as { name?: string };
    return body.name === "herdr-web-broker";
  } catch {
    return false;
  }
}

export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle | undefined> {
  if (await otherDaemonHealthy(opts.stateDir)) return undefined;

  const config = { ...loadConfig(opts.configDir), ...opts.configOverrides };
  const registry = new Registry(join(opts.stateDir, "registry.json"));
  registry.load();
  const children = new ChildrenStore(opts.stateDir);
  const adminToken = ensureAdminToken(opts.stateDir);

  const local = new LocalHerdr({
    registry,
    herdrVersion: opts.herdrVersion ?? detectHerdrVersion(),
    endpoints: opts.localEndpoints,
    envSocket: opts.localEndpoints ? undefined : process.env.HERDR_SOCKET_PATH,
    defaultSocket: opts.localEndpoints ? undefined : join(homedir(), ".config/herdr/herdr.sock"),
    sessionsDir: opts.localEndpoints ? undefined : join(homedir(), ".config/herdr/sessions"),
  });
  await local.start();

  const hub = new TunnelHub();
  const handler = createHttpHandler({ registry, local, hub, children, config, adminToken });
  const lastColon = config.listen.lastIndexOf(":");
  const host = config.listen.slice(0, lastColon);
  const wantPort = Number(config.listen.slice(lastColon + 1));
  let server: Server;
  try {
    server = config.tls
      ? createHttpsServer(
          { cert: readFileSync(config.tls.cert), key: readFileSync(config.tls.key) },
          handler,
        )
      : createHttpServer(handler);
    attachUpgradeHandling(server, {
      children,
      hub,
      registry,
      config,
      callInstance: makeCallInstance({ registry, local, hub, remoteDeny: config.policy.remote_deny }),
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(wantPort, host, resolve);
    });
  } catch (e) {
    // a failed boot (bad cert, EADDRINUSE) must not orphan the already-started
    // local attach — its live sockets and rescan timer would leak
    local.stop();
    throw e;
  }
  const port = (server.address() as AddressInfo).port;
  writeLock(opts.stateDir, { pid: process.pid, listen: `${host}:${port}` });

  // Task 9 wires ParentLink here; Task 11 wires Projection here.

  const scheme = config.tls ? "https" : "http";
  return {
    port,
    host,
    base: `${scheme}://${host}:${port}`,
    registry,
    hub,
    children,
    adminToken,
    config,
    local,
    async close() {
      local.stop();
      for (const name of hub.names()) hub.disconnect(name);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      clearLock(opts.stateDir);
    },
  };
}

function detectHerdrVersion(): string {
  const bin = process.env.HERDR_BIN_PATH ?? "herdr";
  const out = spawnSync(bin, ["--version"], { encoding: "utf8" });
  return out.status === 0 ? out.stdout.trim() : "unknown";
}

async function main(): Promise<void> {
  const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR ?? join(homedir(), ".config/herdr-web-broker");
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR ?? join(homedir(), ".local/state/herdr-web-broker");
  const handle = await startDaemon({ configDir, stateDir });
  if (!handle) {
    console.log("herdr-web-broker: healthy daemon already running, exiting");
    return;
  }
  console.log(`herdr-web-broker: listening on ${handle.base}`);
  const shutdown = () => void handle.close().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (TLS test may skip without openssl).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: daemon assembly with lock singleton, tls, graceful shutdown" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: ParentLink (child side) + full federation integration

**Files:**
- Create: `src/south.ts`
- Modify: `src/daemon.ts` (wire ParentLink at the `// Task 9` marker; add `onReload` restarting it)
- Test: `test/federation.test.ts`

**Interfaces:**
- Consumes: `LocalHerdr` (request/snapshot), `Registry` events, `methodDenied`, tunnel frame types, `PLUGIN_VERSION`.
- Produces: `class ParentLink { constructor(opts: { address: string; secret: string; name: string; local: LocalHerdr; registry: Registry; remoteDeny: string[] }); start(): void; stop(): void }`
  - Dials `<address>/parent/enroll` (trailing slash stripped) with the two enrollment headers; on open sends `hello` built from a fresh `local.snapshot()`.
  - Answers `req` frames: `methodDenied(method, remoteDeny)` → `res` with `{code:"method_denied"}`; otherwise `local.request(session, method, params, timeout_ms)` → `res`; caught `BrokerError` → `res` with its `{code, message}`.
  - Relays registry events for `instance === "runtime"` up as tunnel `event` frames (`agent_status`, `session_added`, `session_removed`).
  - Reconnects forever with exponential backoff: `min(1000 * 2^attempt, 60_000)` ± 20% jitter; resets on `welcome`.
- Modified `startDaemon`: when `config.parent` is set, constructs and starts a `ParentLink`; `handle.close()` stops it; `onReload` (admin) reloads config and restarts the link.

- [ ] **Step 1: Write the failing test**

`test/federation.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../src/daemon.js";
import { FakeHerdr } from "./fake-herdr.js";
import { tmpDir, waitFor } from "./util.js";

async function bootPair(parentDeny?: string[]) {
  const fakeParent = new FakeHerdr(join(tmpDir(), "p.sock"));
  const fakeChild = new FakeHerdr(join(tmpDir(), "c.sock"));
  fakeChild.agents = [{ id: "c1", title: "codex", status: "idle" }];
  await fakeParent.listen();
  await fakeChild.listen();

  const parent = (await startDaemon({
    configDir: tmpDir(),
    stateDir: tmpDir(),
    configOverrides: {
      listen: "127.0.0.1:0",
      client_tokens: [{ name: "t", token: "tok" }],
      ...(parentDeny ? { policy: { remote_deny: parentDeny } } : {}),
    },
    localEndpoints: [{ session: "default", socketPath: fakeParent.socketPath }],
    herdrVersion: "0.8.0-test",
  }))!;

  const minted = (await (
    await fetch(`${parent.base}/admin/children`, {
      method: "POST",
      headers: { "x-admin-token": parent.adminToken, "content-type": "application/json" },
      body: JSON.stringify({ name: "laptop" }),
    })
  ).json()) as { secret: string };

  const child = (await startDaemon({
    configDir: tmpDir(),
    stateDir: tmpDir(),
    configOverrides: {
      listen: "127.0.0.1:0",
      parent: { address: `ws://127.0.0.1:${parent.port}`, secret: minted.secret, name: "laptop" },
    },
    localEndpoints: [{ session: "default", socketPath: fakeChild.socketPath }],
    herdrVersion: "0.8.0-test",
  }))!;

  await waitFor(() => parent.registry.get("laptop")?.online === true);
  return { fakeParent, fakeChild, parent, child };
}

async function teardown(parts: { fakeParent: FakeHerdr; fakeChild: FakeHerdr; parent: DaemonHandle; child: DaemonHandle }) {
  await parts.child.close();
  await parts.parent.close();
  await parts.fakeParent.close();
  await parts.fakeChild.close();
}

const authed = (base: string, path: string, init: RequestInit = {}) =>
  fetch(base + path, { ...init, headers: { authorization: "Bearer tok", ...init.headers } });

test("child enrolls; parent rollup shows both instances with child agents", async () => {
  const parts = await bootPair();
  const roll = (await (await authed(parts.parent.base, "/parent")).json()) as {
    instances: { instance: string; online: boolean; counts: { idle: number } }[];
  };
  const names = roll.instances.map((i) => i.instance).sort();
  assert.deepEqual(names, ["laptop", "runtime"]);
  const laptop = roll.instances.find((i) => i.instance === "laptop")!;
  assert.equal(laptop.online, true);
  assert.equal(laptop.counts.idle, 1);
  await teardown(parts);
});

test("forwarded rpc reaches the child's herdr and returns its result", async () => {
  const parts = await bootPair();
  const res = await authed(parts.parent.base, "/parent/laptop/sessions/default/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "agent.list" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { result: { agents: { id: string }[] } };
  assert.equal(body.result.agents[0].id, "c1");
  assert.ok(parts.fakeChild.received.some((r) => r.method === "agent.list"));
  await teardown(parts);
});

test("child status events stream up and update the parent cache", async () => {
  const parts = await bootPair();
  parts.fakeChild.emitEvent({
    type: "pane.agent_status_changed",
    agent: { id: "c1", title: "codex", status: "blocked" },
  });
  await waitFor(() => parts.parent.registry.counts("laptop").blocked === 1);
  await teardown(parts);
});

test("remote-denied methods fast-fail at the parent without touching the tunnel", async () => {
  const parts = await bootPair();
  const res = await authed(parts.parent.base, "/parent/laptop/sessions/default/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "server.stop" }),
  });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { code: string }).code, "method_denied");
  assert.equal(parts.fakeChild.received.some((r) => r.method === "server.stop"), false);
  await teardown(parts);
});

test("the child enforces its own policy even when the parent's is permissive", async () => {
  const parts = await bootPair([]); // parent forwards everything; child keeps defaults
  const res = await authed(parts.parent.base, "/parent/laptop/sessions/default/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "server.stop" }),
  });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { code: string }).code, "method_denied");
  // the refusal came from the child's ParentLink — its herdr never saw the call
  assert.equal(parts.fakeChild.received.some((r) => r.method === "server.stop"), false);
  await teardown(parts);
});

test("revocation severs the tunnel; offline keeps last_seen; child retry is refused", async () => {
  const parts = await bootPair();
  await fetch(`${parts.parent.base}/admin/children/laptop`, {
    method: "DELETE",
    headers: { "x-admin-token": parts.parent.adminToken },
  });
  await waitFor(() => parts.parent.registry.get("laptop")!.online === false);
  const res = await authed(parts.parent.base, "/parent/laptop/sessions/default/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "agent.list" }),
  });
  assert.equal(res.status, 503);
  const body = (await res.json()) as { code: string; last_seen: string };
  assert.equal(body.code, "instance_offline");
  assert.ok(body.last_seen);
  await teardown(parts);
});

test("child reconnects after a parent restart on the same port", async () => {
  const parts = await bootPair();
  const port = parts.parent.port;
  const stateDir = tmpDir();
  await parts.parent.close();
  // Re-mint on the restarted parent (fresh state dir), then re-issue the same name.
  const parent2 = (await startDaemon({
    configDir: tmpDir(),
    stateDir,
    configOverrides: { listen: `127.0.0.1:${port}`, client_tokens: [{ name: "t", token: "tok" }] },
    localEndpoints: [{ session: "default", socketPath: parts.fakeParent.socketPath }],
    herdrVersion: "0.8.0-test",
  }))!;
  // The child's old secret is unknown to parent2 → its retries are refused, staying offline.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(parent2.registry.get("laptop")?.online ?? false, false);
  await parent2.close();
  await parts.child.close();
  await parts.fakeParent.close();
  await parts.fakeChild.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `startDaemon` ignores `config.parent` (laptop never comes online; first test times out in `waitFor`).

- [ ] **Step 3: Implement**

`src/south.ts`:

```ts
import WebSocket from "ws";
import { BrokerError } from "./errors.js";
import type { LocalHerdr } from "./local-attach.js";
import { methodDenied } from "./policy.js";
import type { Registry } from "./registry.js";
import { PROTO_VERSION, type TunnelFrame } from "./tunnel.js";
import { PLUGIN_VERSION } from "./version.js";

const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 60_000;

/** Child side of the tunnel: dial out, enroll, answer, push, reconnect forever. */
export class ParentLink {
  #ws?: WebSocket;
  #attempt = 0;
  #stopped = false;
  #redial?: NodeJS.Timeout;
  #listeners: Array<() => void> = [];

  constructor(
    private opts: {
      address: string;
      secret: string;
      name: string;
      local: LocalHerdr;
      registry: Registry;
      remoteDeny: string[];
    },
  ) {}

  start(): void {
    this.#stopped = false;
    this.#dial();
    const relay = (kind: "agent_status" | "session_added" | "session_removed") => {
      const listener = (e: { instance: string } & Record<string, unknown>) => {
        if (e.instance !== "runtime") return;
        if (kind === "agent_status") {
          this.#send({ type: "event", event: { kind, session: e.session as string, agent: e.agent as never } });
        } else if (kind === "session_added") {
          this.#send({ type: "event", event: { kind, session: e.session as never } });
        } else {
          this.#send({ type: "event", event: { kind, session: e.session as string } });
        }
      };
      this.opts.registry.on(kind, listener);
      this.#listeners.push(() => this.opts.registry.off(kind, listener));
    };
    relay("agent_status");
    relay("session_added");
    relay("session_removed");
  }

  #send(frame: TunnelFrame): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(frame));
  }

  #dial(): void {
    if (this.#stopped) return;
    const url = this.opts.address.replace(/\/$/, "") + "/parent/enroll";
    const ws = new WebSocket(url, {
      headers: {
        "x-herdr-broker-name": this.opts.name,
        "x-herdr-broker-secret": this.opts.secret,
      },
    });
    this.#ws = ws;
    ws.on("open", () => {
      void this.opts.local.snapshot().then((snap) => {
        this.#send({
          type: "hello",
          name: this.opts.name,
          platform: snap.platform,
          herdr_version: snap.herdr_version,
          plugin_version: PLUGIN_VERSION,
          proto: PROTO_VERSION,
          sessions: snap.sessions,
        });
      });
    });
    ws.on("message", (data) => void this.#route(JSON.parse(String(data)) as TunnelFrame));
    ws.on("close", () => this.#scheduleRedial());
    ws.on("error", () => ws.close());
  }

  async #route(frame: TunnelFrame): Promise<void> {
    if (frame.type === "welcome") {
      this.#attempt = 0;
      return;
    }
    if (frame.type !== "req") return;
    try {
      if (methodDenied(frame.method, this.opts.remoteDeny)) {
        throw new BrokerError("method_denied", `'${frame.method}' is denied for remote callers`);
      }
      const result = await this.opts.local.request(
        frame.session,
        frame.method,
        frame.params ?? {},
        frame.timeout_ms,
      );
      this.#send({ type: "res", id: frame.id, result });
    } catch (e) {
      const err = e instanceof BrokerError ? e : new BrokerError("upstream_error", String(e));
      this.#send({ type: "res", id: frame.id, error: { code: err.code, message: err.message } });
    }
  }

  #scheduleRedial(): void {
    if (this.#stopped) return;
    const base = Math.min(BACKOFF_BASE_MS * 2 ** this.#attempt, BACKOFF_CAP_MS);
    this.#attempt += 1;
    const jitter = base * (0.8 + Math.random() * 0.4);
    this.#redial = setTimeout(() => this.#dial(), jitter);
    this.#redial.unref();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#redial) clearTimeout(this.#redial);
    for (const off of this.#listeners) off();
    this.#listeners = [];
    this.#ws?.close();
  }
}
```

Modify `src/daemon.ts` in four places:

1. Add the import at the top: `import { ParentLink } from "./south.js";`

2. Insert the link machinery ABOVE the `const handler = createHttpHandler(...)` line (the handler's `onReload` closure references `startLink`, which is why it is declared first):

```ts
  let link: ParentLink | undefined;
  const startLink = (cfg: BrokerConfig) => {
    link?.stop();
    link = undefined;
    if (cfg.parent) {
      link = new ParentLink({
        address: cfg.parent.address,
        secret: cfg.parent.secret,
        name: cfg.parent.name,
        local,
        registry,
        remoteDeny: cfg.policy.remote_deny,
      });
      link.start();
    }
  };
```

3. Extend the handler deps with reload, and replace the `// Task 9 wires ParentLink here; Task 11 wires Projection here.` comment (after `writeLock`) with the initial dial:

```ts
  const handler = createHttpHandler({
    registry, local, hub, children, config, adminToken,
    onReload: () => startLink({ ...loadConfig(opts.configDir), ...opts.configOverrides }),
  });
```

```ts
  startLink(config);
  // Task 11 wires Projection here.
```

4. In `handle.close()`, add `link?.stop();` as the first line.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all federation tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: child ParentLink with enrollment, policy, events, and backoff" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Client WebSocket duplex (/parent/ws)

**Files:**
- Modify: `src/ws-server.ts` (fill in the `/parent/ws` branch)
- Test: `test/ws-client.test.ts`

**Interfaces:**
- Consumes: `checkBearer`, `callInstance` from `WsDeps`, `Registry` events, `BrokerError`.
- Produces, on an authenticated `/parent/ws` connection:
  - Client → broker frames: `{id, instance, session, method, params?, timeout_ms?}`. `method === "events.subscribe"` is intercepted and acked `{id, result: {subscribed: true}}` (registry-sourced events already stream; single mechanism per spec §2 note). Everything else goes through `callInstance` → `{id, result}` or `{id, error: envelope}`.
  - Broker → client unsolicited frames: `{event: {type: "agent_status", instance, session, agent}}`, `{event: {type: "instance.online", instance}}`, `{event: {type: "instance.offline", instance}}`.
  - Upgrade without a valid bearer token → HTTP 401, no WS.

- [ ] **Step 1: Write the failing test**

`test/ws-client.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import WebSocket from "ws";
import { startDaemon } from "../src/daemon.js";
import { FakeHerdr } from "./fake-herdr.js";
import { tmpDir, waitFor } from "./util.js";

async function boot() {
  const fake = new FakeHerdr(join(tmpDir(), "h.sock"));
  fake.agents = [{ id: "a1", title: "claude", status: "working" }];
  await fake.listen();
  const handle = (await startDaemon({
    configDir: tmpDir(),
    stateDir: tmpDir(),
    configOverrides: { listen: "127.0.0.1:0", client_tokens: [{ name: "t", token: "tok" }] },
    localEndpoints: [{ session: "default", socketPath: fake.socketPath }],
    herdrVersion: "0.8.0-test",
  }))!;
  return { fake, handle };
}

test("ws upgrade requires a bearer token", async () => {
  const { fake, handle } = await boot();
  const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/parent/ws`);
  const err = await new Promise<Error>((r) => ws.once("error", r));
  assert.match(err.message, /401/);
  await handle.close();
  await fake.close();
});

test("rpc over ws round-trips; events.subscribe acks; events stream unsolicited", async () => {
  const { fake, handle } = await boot();
  const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/parent/ws`, {
    headers: { authorization: "Bearer tok" },
  });
  await new Promise((r) => ws.once("open", r));
  const frames: Record<string, unknown>[] = [];
  ws.on("message", (data) => frames.push(JSON.parse(String(data))));

  ws.send(
    JSON.stringify({ id: "1", instance: "runtime", session: "default", method: "agent.list" }),
  );
  await waitFor(() => frames.some((f) => f.id === "1"));
  const reply = frames.find((f) => f.id === "1") as { result: { agents: unknown[] } };
  assert.equal(reply.result.agents.length, 1);

  ws.send(
    JSON.stringify({ id: "2", instance: "runtime", session: "default", method: "events.subscribe" }),
  );
  await waitFor(() => frames.some((f) => f.id === "2"));
  assert.deepEqual((frames.find((f) => f.id === "2") as { result: unknown }).result, {
    subscribed: true,
  });

  fake.emitEvent({
    type: "pane.agent_status_changed",
    agent: { id: "a1", title: "claude", status: "blocked" },
  });
  await waitFor(() =>
    frames.some(
      (f) =>
        (f.event as { type?: string; instance?: string } | undefined)?.type === "agent_status" &&
        (f.event as { instance: string }).instance === "runtime",
    ),
  );

  ws.send(JSON.stringify({ id: "3", instance: "ghost", session: "x", method: "ping" }));
  await waitFor(() => frames.some((f) => f.id === "3"));
  const errFrame = frames.find((f) => f.id === "3") as { error: { code: string } };
  assert.equal(errFrame.error.code, "unknown_instance");

  ws.close();
  await handle.close();
  await fake.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — upgrade to `/parent/ws` is refused with 404 (Task 6 stub).

- [ ] **Step 3: Implement**

In `src/ws-server.ts`, add imports:

```ts
import { checkBearer } from "./auth.js";
import { BrokerError } from "./errors.js";
```

Replace the `/parent/ws` branch of the upgrade handler with:

```ts
    } else if (path === "/parent/ws") {
      if (!checkBearer(req.headers.authorization, deps.config.client_tokens)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      clientWss.handleUpgrade(req, socket, head, (ws) => acceptClient(deps, ws));
    } else if (
```

Add below `acceptChild`:

```ts
function acceptClient(deps: WsDeps, ws: WebSocket): void {
  const push = (event: Record<string, unknown>) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ event }));
  };
  const onStatus = (e: { instance: string; session: string; agent: unknown }) =>
    push({ type: "agent_status", instance: e.instance, session: e.session, agent: e.agent });
  const onOnline = (e: { instance: string }) => push({ type: "instance.online", instance: e.instance });
  const onOffline = (e: { instance: string }) => push({ type: "instance.offline", instance: e.instance });
  deps.registry.on("agent_status", onStatus);
  deps.registry.on("online", onOnline);
  deps.registry.on("offline", onOffline);
  ws.on("close", () => {
    deps.registry.off("agent_status", onStatus);
    deps.registry.off("online", onOnline);
    deps.registry.off("offline", onOffline);
  });

  ws.on("message", (data) => {
    void (async () => {
      let id: unknown;
      try {
        const frame = JSON.parse(String(data)) as {
          id?: unknown;
          instance?: string;
          session?: string;
          method?: string;
          params?: unknown;
          timeout_ms?: number;
        };
        id = frame.id;
        if (typeof frame.method !== "string") {
          throw new BrokerError("bad_request", "frame needs a string 'method'");
        }
        if (frame.method === "events.subscribe") {
          ws.send(JSON.stringify({ id, result: { subscribed: true } }));
          return;
        }
        if (!deps.callInstance) throw new BrokerError("bad_request", "rpc unavailable");
        const result = await deps.callInstance(
          String(frame.instance ?? ""),
          String(frame.session ?? ""),
          frame.method,
          frame.params ?? {},
          frame.timeout_ms,
        );
        ws.send(JSON.stringify({ id, result }));
      } catch (e) {
        const err = e instanceof BrokerError ? e : new BrokerError("upstream_error", String(e));
        ws.send(JSON.stringify({ id, error: err.toEnvelope() }));
      }
    })();
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: client websocket duplex with rpc routing and event stream" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Remote socket projection

**Files:**
- Create: `src/projection.ts`
- Modify: `src/daemon.ts` (wire at the `// Task 11` marker; `projectionDir` option; stop in `close()`)
- Test: `test/projection.test.ts`

**Interfaces:**
- Consumes: `TunnelHub`, `Registry` events (`snapshot`/`session_added`/`session_removed`/`offline`), `NdjsonDecoder`/`encodeFrame`, `BrokerError`.
- Produces: `class Projection { constructor(opts: { dir: string; hub: TunnelHub; registry: Registry }); start(): void; stop(): void }`
  - For every online remote instance session, a unix socket at `<dir>/<instance>/<session>.sock` speaking plain herdr NDJSON (`{id, method, params}` → `{id, result}` / `{id, error}`), relayed through `hub.get(instance).request(...)`.
  - Sockets are created on `snapshot`/`session_added`, removed (files deleted) on `offline`/`session_removed`. `runtime` is never projected. No-op on `win32` (documented v1 degrade, spec §7).

- [ ] **Step 1: Write the failing test**

`test/projection.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { startDaemon } from "../src/daemon.js";
import { encodeFrame, NdjsonDecoder } from "../src/ndjson.js";
import { FakeHerdr } from "./fake-herdr.js";
import { tmpDir, waitFor } from "./util.js";

test("remote sessions project as local sockets that relay herdr NDJSON", { skip: process.platform === "win32" }, async () => {
  const fakeParent = new FakeHerdr(join(tmpDir(), "p.sock"));
  const fakeChild = new FakeHerdr(join(tmpDir(), "c.sock"));
  fakeChild.agents = [{ id: "c1", title: "codex", status: "idle" }];
  await fakeParent.listen();
  await fakeChild.listen();
  const projDir = tmpDir();

  const parent = (await startDaemon({
    configDir: tmpDir(),
    stateDir: tmpDir(),
    configOverrides: { listen: "127.0.0.1:0", client_tokens: [{ name: "t", token: "tok" }] },
    localEndpoints: [{ session: "default", socketPath: fakeParent.socketPath }],
    herdrVersion: "0.8.0-test",
    projectionDir: projDir,
  }))!;
  const minted = (await (
    await fetch(`${parent.base}/admin/children`, {
      method: "POST",
      headers: { "x-admin-token": parent.adminToken, "content-type": "application/json" },
      body: JSON.stringify({ name: "laptop" }),
    })
  ).json()) as { secret: string };
  const child = (await startDaemon({
    configDir: tmpDir(),
    stateDir: tmpDir(),
    configOverrides: {
      listen: "127.0.0.1:0",
      parent: { address: `ws://127.0.0.1:${parent.port}`, secret: minted.secret, name: "laptop" },
    },
    localEndpoints: [{ session: "default", socketPath: fakeChild.socketPath }],
    herdrVersion: "0.8.0-test",
  }))!;

  const sockPath = join(projDir, "laptop", "default.sock");
  await waitFor(() => existsSync(sockPath));

  // stock herdr NDJSON against the projected socket
  const sock = connect(sockPath);
  const dec = new NdjsonDecoder();
  const frames: unknown[] = [];
  sock.on("data", (c) => frames.push(...dec.push(c)));
  await new Promise((r) => sock.once("connect", r));
  sock.write(encodeFrame({ id: "p1", method: "agent.list", params: {} }));
  await waitFor(() => frames.length === 1);
  const reply = frames[0] as { id: string; result: { agents: { id: string }[] } };
  assert.equal(reply.id, "p1");
  assert.equal(reply.result.agents[0].id, "c1");
  sock.destroy();

  // offline → socket file removed
  await child.close();
  await waitFor(() => !existsSync(sockPath));
  // runtime is never projected
  assert.equal(existsSync(join(projDir, "runtime")), false);

  await parent.close();
  await fakeParent.close();
  await fakeChild.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — socket file never appears.

- [ ] **Step 3: Implement**

`src/projection.ts`:

```ts
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { BrokerError } from "./errors.js";
import { encodeFrame, NdjsonDecoder } from "./ndjson.js";
import type { Registry } from "./registry.js";
import type { TunnelHub } from "./tunnel.js";

/** Materializes each online remote session as a local herdr-NDJSON socket so
 * the stock herdr CLI can drive remote machines via HERDR_SOCKET_PATH (spec §7).
 * Unix-only in v1; a no-op on Windows. */
export class Projection {
  #servers = new Map<string, Server>(); // key: `${instance}/${session}`
  #listeners: Array<() => void> = [];

  constructor(private opts: { dir: string; hub: TunnelHub; registry: Registry }) {}

  start(): void {
    if (process.platform === "win32") return;
    const sync = (e: { instance: string }) => this.#syncInstance(e.instance);
    const drop = (e: { instance: string }) => this.#removeInstance(e.instance);
    const dropSession = (e: { instance: string; session: string }) =>
      this.#removeSocket(e.instance, e.session);
    this.opts.registry.on("snapshot", sync);
    this.opts.registry.on("session_added", sync);
    this.opts.registry.on("session_removed", dropSession);
    this.opts.registry.on("offline", drop);
    this.#listeners.push(
      () => this.opts.registry.off("snapshot", sync),
      () => this.opts.registry.off("session_added", sync),
      () => this.opts.registry.off("session_removed", dropSession),
      () => this.opts.registry.off("offline", drop),
    );
    for (const instance of this.opts.registry.instances()) this.#syncInstance(instance);
  }

  #syncInstance(instance: string): void {
    if (instance === "runtime") return;
    const entry = this.opts.registry.get(instance);
    if (!entry?.online) return;
    for (const session of Object.keys(entry.sessions)) this.#ensureSocket(instance, session);
  }

  #ensureSocket(instance: string, session: string): void {
    const key = `${instance}/${session}`;
    if (this.#servers.has(key)) return;
    const dir = join(this.opts.dir, instance);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${session}.sock`);
    rmSync(path, { force: true });
    const server = createServer((sock) => {
      const dec = new NdjsonDecoder();
      sock.on("data", (chunk) => {
        // the decoder throws on a malformed line; an inbound local client must
        // never be able to crash the daemon — close just that connection
        let frames: unknown[];
        try {
          frames = dec.push(chunk);
        } catch {
          sock.destroy();
          return;
        }
        for (const raw of frames) {
          const frame = raw as { id?: string; method?: string; params?: unknown };
          if (typeof frame.method !== "string") {
            sock.write(
              encodeFrame({ id: frame.id, error: { code: "bad_request", message: "frame needs a string 'method'" } }),
            );
            continue;
          }
          const child = this.opts.hub.get(instance);
          const call = child
            ? child.request(session, frame.method, frame.params ?? {})
            : Promise.reject(new BrokerError("instance_offline", `'${instance}' is not connected`));
          void call
            .then((result) => sock.write(encodeFrame({ id: frame.id, result })))
            .catch((e: BrokerError) =>
              sock.write(
                encodeFrame({ id: frame.id, error: { code: e.code ?? "upstream_error", message: e.message } }),
              ),
            );
        }
      });
      sock.on("error", () => sock.destroy());
    });
    server.listen(path);
    this.#servers.set(key, server);
  }

  #removeSocket(instance: string, session: string): void {
    const key = `${instance}/${session}`;
    const server = this.#servers.get(key);
    if (!server) return;
    this.#servers.delete(key);
    server.close();
    rmSync(join(this.opts.dir, instance, `${session}.sock`), { force: true });
  }

  #removeInstance(instance: string): void {
    for (const key of [...this.#servers.keys()]) {
      if (key.startsWith(`${instance}/`)) {
        this.#removeSocket(instance, key.slice(instance.length + 1));
      }
    }
  }

  stop(): void {
    for (const off of this.#listeners) off();
    this.#listeners = [];
    for (const key of [...this.#servers.keys()]) {
      const [instance, session] = key.split("/");
      this.#removeSocket(instance, session);
    }
  }
}
```

**Test hermeticity (execution amendment):** every `startDaemon` call in the test
suite must pass `projectionDir: tmpDir()` — without it the daemon defaults to
the REAL `~/.config/herdr/remotes` and earlier suites (federation, daemon,
ws-client) write sockets/dirs under the developer's actual `$HOME` on every
run. Modify `test/federation.test.ts` (bootPair), `test/daemon.test.ts`, and
`test/ws-client.test.ts` accordingly in this task.

Modify `src/daemon.ts` — replace the `// Task 11 wires Projection here.` comment with:

```ts
  const projection = new Projection({
    dir: opts.projectionDir ?? join(homedir(), ".config/herdr/remotes"),
    hub,
    registry,
  });
  projection.start();
```

Add import `import { Projection } from "./projection.js";` and add `projection.stop();` to `handle.close()` (before `local.stop()`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: project remote sessions as local herdr sockets" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: CLI actions

**Files:**
- Create: `src/cli.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `readLock`, `ensureAdminToken`, `loadConfig`/`saveConfig`.
- Produces: `node dist/src/cli.js <command> [--flags]` with commands:
  - `status` — prints daemon health + `/admin/status` JSON, or `{"running": false}` when unreachable (exit 0 either way).
  - `issue-secret --name <n>` — POST `/admin/children`; prints `{name, secret}` JSON; exit 1 with a message on any failure ("daemon not running — run the start action first").
  - `revoke --name <n>` — DELETE `/admin/children/<n>`.
  - `pair --address <url> --secret <s> --name <n>` — writes `[parent]` into config.toml, then best-effort POST `/admin/reload` (connection failures ignored: the daemon picks the config up on next start).
  - `start` — health-check; if down, spawn `node dist/src/daemon.js` detached and print the outcome.
  - Dir resolution everywhere: `--config-dir`/`--state-dir` flags override `HERDR_PLUGIN_CONFIG_DIR`/`HERDR_PLUGIN_STATE_DIR`.

- [ ] **Step 1: Write the failing test**

`test/cli.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startDaemon } from "../src/daemon.js";
import { FakeHerdr } from "./fake-herdr.js";
import { tmpDir } from "./util.js";

const CLI = join(process.cwd(), "dist/src/cli.js");

// async spawn, NOT spawnSync: the daemon under test runs in THIS process, and
// spawnSync freezes the event loop — the CLI child would connect to a listening
// socket nothing can ever accept (found in execution; ruled fixture fix)
function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("status / issue-secret / revoke against a live daemon", async () => {
  const fake = new FakeHerdr(join(tmpDir(), "h.sock"));
  await fake.listen();
  const configDir = tmpDir();
  const stateDir = tmpDir();
  const handle = (await startDaemon({
    configDir,
    stateDir,
    configOverrides: { listen: "127.0.0.1:0" },
    localEndpoints: [{ session: "default", socketPath: fake.socketPath }],
    herdrVersion: "0.8.0-test",
  }))!;
  const dirs = ["--config-dir", configDir, "--state-dir", stateDir];

  const status = await run(["status", ...dirs]);
  assert.equal(status.status, 0);
  assert.equal(JSON.parse(status.stdout).running, true);

  const minted = await run(["issue-secret", "--name", "laptop", ...dirs]);
  assert.equal(minted.status, 0);
  const parsed = JSON.parse(minted.stdout);
  assert.equal(parsed.name, "laptop");
  assert.ok(parsed.secret.length >= 40);

  const revoked = await run(["revoke", "--name", "laptop", ...dirs]);
  assert.equal(revoked.status, 0);

  await handle.close();
  await fake.close();
});

test("status reports not running when there is no daemon", () => {
  const out = await run(["status", "--config-dir", tmpDir(), "--state-dir", tmpDir()]);
  assert.equal(out.status, 0);
  assert.equal(JSON.parse(out.stdout).running, false);
});

test("pair writes [parent] into config.toml without a daemon", () => {
  const configDir = tmpDir();
  const out = await run([
    "pair",
    "--address", "ws://parent.example:7591",
    "--secret", "sss",
    "--name", "laptop",
    "--config-dir", configDir,
    "--state-dir", tmpDir(),
  ]);
  assert.equal(out.status, 0);
  const toml = readFileSync(join(configDir, "config.toml"), "utf8");
  assert.match(toml, /\[parent\]/);
  assert.match(toml, /address = "ws:\/\/parent\.example:7591"/);
  assert.match(toml, /name = "laptop"/);
});

test("issue-secret without a daemon fails with guidance", () => {
  const out = await run(["issue-secret", "--name", "x", "--config-dir", tmpDir(), "--state-dir", tmpDir()]);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /not running/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `dist/src/cli.js` missing.

- [ ] **Step 3: Implement**

`src/cli.ts`:

```ts
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "./config.js";
import { ensureAdminToken, readLock } from "./state.js";

interface Ctx {
  configDir: string;
  stateDir: string;
}

function parseArgs(argv: string[]): { command: string; flags: Map<string, string> } {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string>();
  // value-aware, not positional: `--a --b v` must leave --a empty, not eat "--b"
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--")) continue;
    const name = rest[i].slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, "");
    }
  }
  return { command, flags };
}

function need(flags: Map<string, string>, name: string): string {
  const v = flags.get(name);
  if (!v) {
    console.error(`missing required --${name}`);
    process.exit(1);
  }
  return v;
}

async function adminFetch(
  ctx: Ctx,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response | undefined> {
  const lock = readLock(ctx.stateDir);
  if (!lock) return undefined;
  try {
    return await fetch(`http://${lock.listen}${path}`, {
      method,
      headers: {
        "x-admin-token": ensureAdminToken(ctx.stateDir),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const ctx: Ctx = {
    configDir:
      flags.get("config-dir") ??
      process.env.HERDR_PLUGIN_CONFIG_DIR ??
      join(homedir(), ".config/herdr-web-broker"),
    stateDir:
      flags.get("state-dir") ??
      process.env.HERDR_PLUGIN_STATE_DIR ??
      join(homedir(), ".local/state/herdr-web-broker"),
  };

  if (command === "status") {
    const res = await adminFetch(ctx, "GET", "/admin/status");
    if (!res) {
      console.log(JSON.stringify({ running: false }));
      return;
    }
    console.log(JSON.stringify({ running: true, ...(await res.json()) }, null, 2));
    return;
  }

  if (command === "issue-secret") {
    const name = need(flags, "name");
    const res = await adminFetch(ctx, "POST", "/admin/children", { name });
    if (!res) {
      console.error("daemon not running — run the start action first");
      process.exit(1);
    }
    if (!res.ok) {
      // a live daemon refusing (bad name, auth) is not "not running" — say why
      console.error(`daemon refused: ${await res.text()}`);
      process.exit(1);
    }
    console.log(JSON.stringify(await res.json()));
    return;
  }

  if (command === "revoke") {
    const name = need(flags, "name");
    const res = await adminFetch(ctx, "DELETE", `/admin/children/${encodeURIComponent(name)}`);
    if (!res) {
      console.error("daemon not running — run the start action first");
      process.exit(1);
    }
    if (!res.ok) {
      console.error(`daemon refused: ${await res.text()}`);
      process.exit(1);
    }
    console.log(JSON.stringify(await res.json()));
    return;
  }

  if (command === "pair") {
    const config = loadConfig(ctx.configDir);
    config.parent = {
      address: need(flags, "address"),
      secret: need(flags, "secret"),
      name: need(flags, "name"),
    };
    saveConfig(ctx.configDir, config);
    await adminFetch(ctx, "POST", "/admin/reload"); // best effort
    console.log(JSON.stringify({ paired: config.parent.name, address: config.parent.address }));
    return;
  }

  if (command === "start") {
    const res = await adminFetch(ctx, "GET", "/admin/status");
    if (res) {
      console.log(JSON.stringify({ running: true, started: false }));
      return;
    }
    const daemonPath = join(dirname(fileURLToPath(import.meta.url)), "daemon.js");
    const child = spawn(process.execPath, [daemonPath], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        HERDR_PLUGIN_CONFIG_DIR: ctx.configDir,
        HERDR_PLUGIN_STATE_DIR: ctx.stateDir,
      },
    });
    child.unref();
    console.log(JSON.stringify({ started: true, pid: child.pid }));
    return;
  }

  console.error(`unknown command '${command}' — one of: status issue-secret revoke pair start`);
  process.exit(1);
}

void main();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: cli actions for status, pairing, secrets, and daemon start" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: Manifest actions, live smoke, README, LICENSE

**Files:**
- Modify: `herdr-plugin.toml` (add the five `[[actions]]`)
- Create: `test/live-smoke.test.ts`, `README.md`, `LICENSE`

**Interfaces:**
- Consumes: everything.
- Produces: the finished marketplace repo. No new code interfaces.

- [ ] **Step 1: Finalize the manifest**

Append to `herdr-plugin.toml`:

```toml
[[actions]]
id = "status"
title = "Broker: status"
contexts = ["workspace"]
command = ["node", "dist/src/cli.js", "status"]

[[actions]]
id = "issue-secret"
title = "Broker: issue child secret"
contexts = ["workspace"]
command = ["node", "dist/src/cli.js", "issue-secret"]

[[actions]]
id = "pair"
title = "Broker: pair with parent"
contexts = ["workspace"]
command = ["node", "dist/src/cli.js", "pair"]

[[actions]]
id = "revoke"
title = "Broker: revoke child"
contexts = ["workspace"]
command = ["node", "dist/src/cli.js", "revoke"]

[[actions]]
id = "start"
title = "Broker: start daemon"
contexts = ["workspace"]
command = ["node", "dist/src/cli.js", "start"]
```

- [ ] **Step 2: Write the live smoke test**

`test/live-smoke.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../src/daemon.js";
import { tmpDir } from "./util.js";

/** Validates the two documented herdr-shape assumptions (mapAgentList,
 * mapHerdrEvent) against a real herdr server. Skips unless both a herdr
 * binary and a live default socket exist. */
test("live smoke: daemon attaches to a real herdr and serves truth", async (t) => {
  const which = spawnSync("herdr", ["--version"], { encoding: "utf8" });
  const socket = process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config/herdr/herdr.sock");
  if (which.status !== 0 || !existsSync(socket)) {
    return t.skip("no herdr binary or live socket");
  }
  const handle = (await startDaemon({
    configDir: tmpDir(),
    stateDir: tmpDir(),
    configOverrides: { listen: "127.0.0.1:0", client_tokens: [{ name: "t", token: "tok" }] },
    herdrVersion: which.stdout.trim(),
  }))!;
  const sessions = (await (
    await fetch(`${handle.base}/parent/runtime/sessions`, {
      headers: { authorization: "Bearer tok" },
    })
  ).json()) as { sessions: { name: string }[] };
  assert.ok(sessions.sessions.length >= 1, "expected at least the default session");
  const rpc = await fetch(`${handle.base}/parent/runtime/sessions/${sessions.sessions[0].name}/rpc`, {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify({ method: "ping" }),
  });
  assert.equal(rpc.status, 200);
  await handle.close();
});
```

- [ ] **Step 3: Write README and LICENSE**

`README.md`:

```markdown
# herdr-web-broker

A [herdr](https://herdr.dev) plugin that lifts herdr's local socket API onto
the network — REST + WebSocket — and federates instances parent↔child. Enroll
your laptop with the herdr running on your home server; from the server (or
anything holding a token) list the laptop's sessions, check which agents are
blocked, and send prompts — all over one child-initiated tunnel that works
behind NAT.

## How it compares

- **herdr-remote** — phone/menu-bar monitoring via a hosted tunnel. This plugin
  is self-hosted: your parent, your secret, no third-party relay.
- **herdr-mirror** — drives remote servers over SSH. This plugin needs no SSH
  reachability: children dial out, so roaming laptops stay connected.
- **herdr-mobile-relay** — phone approvals. This plugin is an API, not an app:
  full method passthrough for any client, plus socket projection for the herdr
  CLI itself.

## Install

`herdr plugin install` from the marketplace, or clone this repo and
`herdr plugin link` it. The build compiles TypeScript; the startup hook keeps
the broker daemon alive.

## Pair a child

On the parent: run the **Broker: issue child secret** action
(`issue-secret --name laptop`) — copy the printed secret.
On the child: run **Broker: pair with parent**
(`pair --address ws://parent-host:7591 --secret <secret> --name laptop`).

The child dials out and holds the tunnel; the parent can now reach it.

## API

Bearer-token auth (`[[client_tokens]]` in config.toml). Instance `runtime` is
the local machine; anything else is an enrolled child.

| Route | Meaning |
| --- | --- |
| `GET /parent` | all instances with live status rollup |
| `GET /parent/{instance}` | one instance: online, versions, sessions |
| `GET /parent/{instance}/sessions` | herdr sessions on that machine |
| `GET /parent/{instance}/sessions/{s}/agents` | agents + status (`?fresh=1` re-queries) |
| `POST /parent/{instance}/sessions/{s}/rpc` | any herdr socket method: `{"method", "params"}` |
| `WS /parent/ws` | duplex rpc + unsolicited status events |

Every herdr method is passthrough (see `herdr api schema --json`), gated by a
deny-list (`policy.remote_deny`, default: `server.stop`,
`server.reload_config`, `plugin.*` for remote-originated calls).

Remote sessions are also projected as local sockets —
`HERDR_SOCKET_PATH=~/.config/herdr/remotes/laptop/default.sock herdr agent list`
drives the laptop with the stock CLI.

## Security

- The daemon listens on `127.0.0.1` unless you explicitly configure otherwise.
- Child secrets are 256-bit, name-bound, shown once, stored hashed. Revoke with
  the **Broker: revoke child** action.
- For cross-network use, prefer a tailnet/VPN or TLS-terminating proxy; direct
  TLS via `[tls] cert/key` config is supported.

## License

MIT
```

`LICENSE`: the standard MIT license text with `Copyright (c) 2026 Edwin Cruz`.

- [ ] **Step 4: Full suite + repo sanity**

Run: `npm test`
Expected: PASS — every suite green (live smoke skips without herdr).

Run: `git -C /Users/edwincruz/Development/Workspaces/jefelabs/herdr-web-broker log --oneline`
Expected: one commit per task, conventional messages.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: manifest actions, live smoke, README with positioning" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## After execution

- Do NOT push. Edwin publishes manually: create the public GitHub repo `herdr-web-broker` under the right account (`ecruz165` switch needed), push `main`, add the `herdr-plugin` topic so the marketplace indexes it.
- The two herdr-shape assumptions (`mapAgentList`, `mapHerdrEvent`) must be validated against a real herdr ≥ 0.8.0 before publishing — run the live smoke on a machine with herdr running; adjust only those two adapters if shapes differ.
- smithagents integration (consuming this broker) is a separate future spec in the smithagents repo.
