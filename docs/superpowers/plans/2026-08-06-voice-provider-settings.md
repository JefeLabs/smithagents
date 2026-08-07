# Voice Provider Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `ELEVENLABS_API_KEY`/`DEEPGRAM_API_KEY` out of `.env` into the connector registry (with registry-wide encryption at rest), add a Settings → Voice group mapping STT/TTS to connected keys, and make the broker resolve keys at runtime with graceful pointer-message degradation when unset.

**Architecture:** ElevenLabs/Deepgram become `ConnectorVendorDef` entries with a new `capabilities` tag; a `User.voice` record + `/me/voice` routes select which instance powers each capability; the broker fetches resolved keys via a loopback-only `/me/voice/keys` route through a 20s-TTL `VoiceKeyResolver`, constructing Deepgram clients per session and rebuilding the ElevenLabs provider only on key change. All `secret: true` connector fields get AES-256-GCM encryption under a master key from `SMITH_MASTER_KEY` env or `~/.smith/master.key`.

**Tech Stack:** TypeScript. swarm + broker: `node:test` via tsx (`npm test` in each package). control-plane: React + vitest. Node built-in `crypto` only — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-06-voice-provider-settings-design.md` (approved 2026-08-06). Section references (§N) below point there.

## Global Constraints

- Vendor ids are exactly `elevenlabs` (capabilities `['tts']`) and `deepgram` (capabilities `['stt']`); each has one field `{ key: 'apiKey', label: 'API key', secret: true }`.
- Encrypted-value format is exactly `enc:v1:<iv>:<ciphertext>:<authTag>` with base64 segments, AES-256-GCM (§3).
- Master key: `SMITH_MASTER_KEY` env var (64 hex chars) wins; else `~/.smith/master.key` (64 hex chars, auto-generated, mode 0600) (§3).
- Resolver TTL: 20 seconds (§4).
- Pointer copy — use these exact strings everywhere (§5):
  - STT hint: `Add a Deepgram key in Settings → Integrations, then select it under Settings → Voice.`
  - TTS hint: `No text-to-speech key — add an ElevenLabs key in Settings → Integrations, then select it under Settings → Voice.`
- `GET /me/voice/keys` returns raw secrets: loopback/server-to-server only, NEVER proxied through broker port 7790 (mirror of `/workspaces/:name/channels/discord-token`).
- Hard cut: after this plan, nothing reads `ELEVENLABS_API_KEY`/`DEEPGRAM_API_KEY`. `DEEPGRAM_LANGUAGE` is config, not a credential — it stays.
- Git discipline: always `git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents`, always `git add <explicit paths>` (never `-A`; the checkout has an unrelated modified `swarm/.smith/agents/ignacio.json` and live worktrees). Verify `[branch hash]` + file count after each commit.
- **api-keys registry landed on main (06901fe) — boundaries to respect:** `swarm/.smith/api-keys.json` + `swarm/src/api-keys.ts` is a SEPARATE store for model-provider keys (anthropic/openai/google). Voice keys do NOT go there — they live in the connector registry per the approved voice spec. The `TextChannel` constructor now ends `..., cliTools, apiKeys` — the new `voice` dep goes AFTER `apiKeys` (text-channel.ts:194). That feature's "env GEMINI key outranks store" precedence is its own documented quirk; voice is a hard cut, no env fallback.
- Line numbers cited in tasks were read at main @ 9cb662d and may have drifted after the 06901fe merge — locate by the named symbol/anchor when a number is off.

---

### Task 1: Secret encryption module (`secretbox`)

**Files:**
- Create: `swarm/src/secretbox.ts`
- Test: `swarm/src/secretbox.test.ts`

**Interfaces:**
- Produces: `encryptSecret(value: string, key: Buffer): string`, `decryptSecret(value: string, key: Buffer): string` (throws on bad format/tag/key), `isEncrypted(value: string): boolean`, `resolveMasterKey(env?: NodeJS.ProcessEnv, home?: string): Promise<Buffer>`, `ENC_PREFIX = 'enc:v1:'`.

- [ ] **Step 1: Write the failing tests**

```ts
// swarm/src/secretbox.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { encryptSecret, decryptSecret, isEncrypted, resolveMasterKey, ENC_PREFIX } from './secretbox.js';

const KEY = randomBytes(32);

test('roundtrip: encrypt then decrypt returns the original value', () => {
  const out = encryptSecret('sk-super-secret', KEY);
  assert.ok(out.startsWith(ENC_PREFIX));
  assert.equal(decryptSecret(out, KEY), 'sk-super-secret');
});

test('format: enc:v1: plus three base64 segments; unique IV per call', () => {
  const a = encryptSecret('same', KEY);
  const b = encryptSecret('same', KEY);
  assert.notEqual(a, b); // fresh IV every time
  const segs = a.slice(ENC_PREFIX.length).split(':');
  assert.equal(segs.length, 3);
  for (const s of segs) assert.doesNotThrow(() => Buffer.from(s, 'base64'));
});

test('isEncrypted: true only for the enc:v1: prefix', () => {
  assert.equal(isEncrypted(encryptSecret('x', KEY)), true);
  assert.equal(isEncrypted('sk-plaintext'), false);
  assert.equal(isEncrypted(''), false);
});

test('decryptSecret: wrong key throws, never returns garbage', () => {
  const out = encryptSecret('value', KEY);
  assert.throws(() => decryptSecret(out, randomBytes(32)));
});

test('decryptSecret: malformed input throws', () => {
  assert.throws(() => decryptSecret('enc:v1:not-valid', KEY));
});

test('resolveMasterKey: SMITH_MASTER_KEY env var wins and needs no file', async () => {
  const hex = randomBytes(32).toString('hex');
  const key = await resolveMasterKey({ SMITH_MASTER_KEY: hex }, '/nonexistent-home');
  assert.deepEqual(key, Buffer.from(hex, 'hex'));
});

test('resolveMasterKey: invalid env value throws with a clear message', async () => {
  await assert.rejects(resolveMasterKey({ SMITH_MASTER_KEY: 'too-short' }, '/nonexistent-home'), /SMITH_MASTER_KEY/);
});

test('resolveMasterKey: generates ~/.smith/master.key (0600) once and reuses it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sbox-home-'));
  const first = await resolveMasterKey({}, home);
  const second = await resolveMasterKey({}, home);
  assert.deepEqual(first, second);
  assert.equal(first.length, 32);
  const filePath = join(home, '.smith', 'master.key');
  const mode = (await stat(filePath)).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.match((await readFile(filePath, 'utf8')).trim(), /^[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/swarm && node --import tsx --test src/secretbox.test.ts`
Expected: FAIL — cannot find module './secretbox.js'

- [ ] **Step 3: Write the implementation**

```ts
// swarm/src/secretbox.ts
// Secrets-at-rest for .smith/users/*.json (spec §3): AES-256-GCM via node:crypto
// only — no native deps, identical on macOS/Linux/Windows. Master key resolves
// OS-agnostically: SMITH_MASTER_KEY env (the cloud/headless seam) else
// ~/.smith/master.key, auto-generated 0600. The key lives in the HOME dir,
// outside every repo checkout/worktree, so a copied workspace never carries
// key + ciphertext together.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const ENC_PREFIX = 'enc:v1:';

export function isEncrypted(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

export function encryptSecret(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64')}:${ct.toString('base64')}:${tag.toString('base64')}`;
}

/** Throws on malformed input, wrong key, or a tampered ciphertext — the caller decides the fallback. */
export function decryptSecret(value: string, key: Buffer): string {
  const segs = value.slice(ENC_PREFIX.length).split(':');
  if (!isEncrypted(value) || segs.length !== 3) throw new Error('secretbox: not an enc:v1 value');
  const [iv, ct, tag] = segs.map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/** Env wins (64 hex chars); else read-or-create ~/.smith/master.key. */
export async function resolveMasterKey(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<Buffer> {
  const fromEnv = env.SMITH_MASTER_KEY;
  if (fromEnv !== undefined) {
    if (!/^[0-9a-f]{64}$/i.test(fromEnv)) {
      throw new Error('SMITH_MASTER_KEY must be 64 hex characters (32 bytes)');
    }
    return Buffer.from(fromEnv, 'hex');
  }
  const dir = join(home, '.smith');
  const file = join(dir, 'master.key');
  try {
    const hex = (await readFile(file, 'utf8')).trim();
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`${file} is corrupt: expected 64 hex characters`);
    return Buffer.from(hex, 'hex');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const key = randomBytes(32);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const fh = await open(file, 'w', 0o600);
  try {
    await fh.writeFile(`${key.toString('hex')}\n`);
  } finally {
    await fh.close();
  }
  return key;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/swarm && node --import tsx --test src/secretbox.test.ts`
Expected: all 8 PASS

- [ ] **Step 5: Typecheck and commit**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/swarm && npm run typecheck`

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add swarm/src/secretbox.ts swarm/src/secretbox.test.ts
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(swarm): secretbox — AES-256-GCM secrets with OS-agnostic master key"
```

---

### Task 2: Encrypt connector secrets in `users.ts` + boot sweep

**Files:**
- Modify: `swarm/src/users.ts`
- Modify: `swarm/src/server.ts` (one line in `start()` — see Step 3)
- Test: `swarm/src/users.test.ts` (append tests)

**Interfaces:**
- Consumes: Task 1's `encryptSecret/decryptSecret/isEncrypted/resolveMasterKey`; `findVendor` from `./connectors.js` (safe: connectors.ts does not import users.ts).
- Produces: `loadUsersFromDir(dir)` now returns **decrypted** fields in memory (all existing consumers unchanged); `saveUser(dir, user)` encrypts `secret: true` fields on write; new `sweepEncryptUsers(dir): Promise<number>` (returns count of files rewritten) called once at server boot.

- [ ] **Step 1: Write the failing tests** (append to `swarm/src/users.test.ts`, matching its existing `node:test` style; set `process.env.SMITH_MASTER_KEY` to a fixed key so no home-dir file is touched)

```ts
// append to swarm/src/users.test.ts
import { randomBytes as sbRandom } from 'node:crypto';
import { readFile as sbReadFile } from 'node:fs/promises';
import { sweepEncryptUsers } from './users.js';
import { ENC_PREFIX } from './secretbox.js';

const MASTER_HEX = sbRandom(32).toString('hex');

test('saveUser encrypts secret fields on disk; loadUsersFromDir decrypts them in memory', async () => {
  process.env.SMITH_MASTER_KEY = MASTER_HEX;
  const dir = await mkdtemp(join(tmpdir(), 'users-enc-'));
  await saveUser(dir, {
    id: 'me', name: 'You', default: true,
    connectors: [{ id: 'c1', vendorId: 'github', label: 'personal', fields: { token: 'ghp_raw' } }],
  });
  const onDisk = JSON.parse(await sbReadFile(join(dir, 'me.json'), 'utf8'));
  assert.ok(String(onDisk.connectors[0].fields.token).startsWith(ENC_PREFIX), 'secret must be encrypted at rest');
  const [user] = await loadUsersFromDir(dir);
  assert.equal(user.connectors?.[0].fields.token, 'ghp_raw'); // decrypted in memory
  delete process.env.SMITH_MASTER_KEY;
});

test('non-secret fields stay plaintext on disk (files remain inspectable)', async () => {
  process.env.SMITH_MASTER_KEY = MASTER_HEX;
  const dir = await mkdtemp(join(tmpdir(), 'users-enc-'));
  await saveUser(dir, {
    id: 'me', name: 'You', default: true,
    connectors: [{ id: 'c1', vendorId: 'atlassian', label: 'acme', fields: { email: 'e@a.com', apiToken: 'tok' } }],
  });
  const onDisk = JSON.parse(await sbReadFile(join(dir, 'me.json'), 'utf8'));
  assert.equal(onDisk.connectors[0].fields.email, 'e@a.com');
  assert.ok(String(onDisk.connectors[0].fields.apiToken).startsWith(ENC_PREFIX));
  delete process.env.SMITH_MASTER_KEY;
});

test('sweepEncryptUsers: rewrites a plaintext legacy file once, then is a no-op', async () => {
  process.env.SMITH_MASTER_KEY = MASTER_HEX;
  const dir = await mkdtemp(join(tmpdir(), 'users-sweep-'));
  const fh = await open(join(dir, 'me.json'), 'w', 0o600); // hand-written plaintext file, as upgrades find it
  await fh.writeFile(JSON.stringify({
    id: 'me', name: 'You', default: true,
    connectors: [{ id: 'c1', vendorId: 'github', label: 'personal', fields: { token: 'ghp_plain' } }],
  }));
  await fh.close();
  assert.equal(await sweepEncryptUsers(dir), 1);
  const onDisk = JSON.parse(await sbReadFile(join(dir, 'me.json'), 'utf8'));
  assert.ok(String(onDisk.connectors[0].fields.token).startsWith(ENC_PREFIX));
  assert.equal(await sweepEncryptUsers(dir), 0); // already encrypted → untouched
  const [user] = await loadUsersFromDir(dir);
  assert.equal(user.connectors?.[0].fields.token, 'ghp_plain');
  delete process.env.SMITH_MASTER_KEY;
});

test('a value that fails to decrypt is passed through as-is (connected-but-failing-verify, spec §3), not a crash', async () => {
  process.env.SMITH_MASTER_KEY = MASTER_HEX;
  const dir = await mkdtemp(join(tmpdir(), 'users-badkey-'));
  await saveUser(dir, {
    id: 'me', name: 'You', default: true,
    connectors: [{ id: 'c1', vendorId: 'github', label: 'personal', fields: { token: 'ghp_raw' } }],
  });
  process.env.SMITH_MASTER_KEY = sbRandom(32).toString('hex'); // key rotated out from under the file
  const [user] = await loadUsersFromDir(dir);
  assert.ok(String(user.connectors?.[0].fields.token).startsWith(ENC_PREFIX)); // ciphertext passthrough
  delete process.env.SMITH_MASTER_KEY;
});
```

Note: `mkdtemp`, `tmpdir`, `join`, `open`, `saveUser`, `loadUsersFromDir`, `test`, `assert` are already imported at the top of `users.test.ts` — add only the missing imports; if `open` isn't imported there yet, add it to the existing `node:fs/promises` import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/swarm && node --import tsx --test src/users.test.ts`
Expected: FAIL — `sweepEncryptUsers` not exported; secret stored plaintext

- [ ] **Step 3: Implement in `users.ts`**

Add imports and three helpers; wire them into `saveUser` and `loadUsersFromDir` (keep both signatures unchanged); export `sweepEncryptUsers`.

```ts
// users.ts — add imports
import { findVendor } from './connectors.js';
import { encryptSecret, decryptSecret, isEncrypted, resolveMasterKey } from './secretbox.js';

/** Which of this instance's field keys are secrets, per the vendor registry. Unknown vendor → none. */
function secretKeysFor(vendorId: string): Set<string> {
  return new Set((findVendor(vendorId)?.fields ?? []).filter((f) => f.secret).map((f) => f.key));
}

function mapSecretFields(
  user: User,
  fn: (value: string, isSecret: boolean) => string,
): User {
  if (!user.connectors) return user;
  return {
    ...user,
    connectors: user.connectors.map((c) => {
      const secrets = secretKeysFor(c.vendorId);
      const fields = Object.fromEntries(
        Object.entries(c.fields).map(([k, v]) => [k, fn(v, secrets.has(k))]),
      );
      return { ...c, fields };
    }),
  };
}

function encryptUser(user: User, key: Buffer): User {
  // idempotent: an already-encrypted value (incl. a decrypt-failure passthrough) is left alone
  return mapSecretFields(user, (v, isSecret) => (isSecret && v && !isEncrypted(v) ? encryptSecret(v, key) : v));
}

function decryptUser(user: User, key: Buffer): User {
  return mapSecretFields(user, (v, isSecret) => {
    if (!isSecret || !isEncrypted(v)) return v;
    try {
      return decryptSecret(v, key);
    } catch {
      // Wrong/rotated master key: keep the ciphertext as the field value so the
      // connector shows connected-but-failing-verify (spec §3) instead of crashing.
      console.warn(`[users] could not decrypt a secret for connector — re-enter the key in Settings`);
      return v;
    }
  });
}
```

In `loadUsersFromDir`, resolve the key once and decrypt each user (the `for` loop body becomes):

```ts
  const key = await resolveMasterKey();
  for (const file of entries.filter((f) => f.endsWith('.json'))) {
    const raw = await readFile(join(dir, file), 'utf8');
    users.push(decryptUser(assertUser(file, JSON.parse(raw)), key));
  }
```

In `saveUser`, encrypt before writing (replace the `writeFile` line's payload):

```ts
  const key = await resolveMasterKey();
  const toWrite = encryptUser(user, key);
  // ... existing open() ...
    await fh.writeFile(`${JSON.stringify(toWrite, null, 2)}\n`);
```

Add the sweep (spec §3 "transparent migration" — done as a boot-time pass so `loadUsersFromDir` stays read-only, same spirit as the legacy in-memory upgrade):

```ts
/**
 * One-time-per-boot migration pass (spec §3): any user file still holding a
 * plaintext secret is re-saved, which encrypts it. Skips files already fully
 * encrypted so boots don't churn IVs. Returns how many files were rewritten.
 */
export async function sweepEncryptUsers(dir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  let rewritten = 0;
  for (const file of entries.filter((f) => f.endsWith('.json'))) {
    const raw = assertUser(file, JSON.parse(await readFile(join(dir, file), 'utf8')));
    const hasPlaintextSecret = (raw.connectors ?? []).some((c) => {
      const secrets = secretKeysFor(c.vendorId);
      return Object.entries(c.fields).some(([k, v]) => secrets.has(k) && v && !isEncrypted(v));
    });
    if (!hasPlaintextSecret) continue;
    await saveUser(dir, raw); // raw is plaintext in memory; saveUser encrypts
    rewritten++;
  }
  return rewritten;
}
```

Then in `swarm/src/server.ts`: find the `start()` method (it calls `registerRoutes` then `this.app.listen`) and add, before the listen call:

```ts
    await sweepEncryptUsers(resolve(process.cwd(), '.smith/users'));
```

with `sweepEncryptUsers` added to the existing `./users.js` import at server.ts:74.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/swarm && node --import tsx --test src/users.test.ts && npm run typecheck`
Expected: PASS (new + all pre-existing users tests)

- [ ] **Step 5: Run the full swarm suite** (verify/materialize/dispatcher tests still pass — they consume decrypted in-memory fields)

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/swarm && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add swarm/src/users.ts swarm/src/users.test.ts swarm/src/server.ts
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(swarm): encrypt connector secrets at rest with boot-time migration sweep"
```

---

### Task 3: ElevenLabs + Deepgram vendors with verify + `capabilities`

**Files:**
- Create: `swarm/src/verify-elevenlabs.ts`, `swarm/src/verify-deepgram.ts`
- Modify: `swarm/src/connectors.ts`, `swarm/src/server.ts` (vendors route), `swarm/src/connectors.test.ts`
- Test: `swarm/src/verify-elevenlabs.test.ts`, `swarm/src/verify-deepgram.test.ts`

**Interfaces:**
- Produces: `verifyElevenlabs(apiKey: string, fetchImpl?: typeof fetch): Promise<VerifyResult>`; `verifyDeepgram(apiKey: string, fetchImpl?: typeof fetch): Promise<VerifyResult>`; `ConnectorVendorDef.capabilities?: ('stt' | 'tts')[]`; vendors `elevenlabs`/`deepgram` in `VENDORS`; `GET /connectors/vendors` responses gain `capabilities: string[]`.

- [ ] **Step 1: Write the failing verify tests** (mirror `verify-github.test.ts` exactly)

```ts
// swarm/src/verify-elevenlabs.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyElevenlabs } from './verify-elevenlabs.js';

test('verifyElevenlabs: ok on 200 from /v1/user, sends xi-api-key header', async () => {
  const f = (async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), 'https://api.elevenlabs.io/v1/user');
    assert.equal((init?.headers as Record<string, string>)['xi-api-key'], 'el-key');
    return new Response(JSON.stringify({ subscription: { tier: 'starter' } }), { status: 200 });
  }) as typeof fetch;
  const r = await verifyElevenlabs('el-key', f);
  assert.equal(r.ok, true);
  assert.match(r.detail, /starter/);
});

test('verifyElevenlabs: not ok on 401', async () => {
  const f = (async () => new Response(JSON.stringify({ detail: { message: 'invalid api key' } }), { status: 401 })) as typeof fetch;
  const r = await verifyElevenlabs('bad', f);
  assert.equal(r.ok, false);
  assert.match(r.detail, /401/);
});

test('verifyElevenlabs: network failure resolves {ok:false}, never rejects', async () => {
  const f = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  const r = await verifyElevenlabs('el-key', f);
  assert.equal(r.ok, false);
  assert.match(r.detail, /fetch failed/);
});
```

```ts
// swarm/src/verify-deepgram.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyDeepgram } from './verify-deepgram.js';

test('verifyDeepgram: ok on 200 from /v1/projects, sends Token auth', async () => {
  const f = (async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), 'https://api.deepgram.com/v1/projects');
    assert.equal((init?.headers as Record<string, string>).authorization, 'Token dg-key');
    return new Response(JSON.stringify({ projects: [{ project_id: 'p1' }] }), { status: 200 });
  }) as typeof fetch;
  const r = await verifyDeepgram('dg-key', f);
  assert.equal(r.ok, true);
  assert.match(r.detail, /1 project/);
});

test('verifyDeepgram: not ok on 401', async () => {
  const f = (async () => new Response(JSON.stringify({ err_msg: 'invalid credentials' }), { status: 401 })) as typeof fetch;
  const r = await verifyDeepgram('bad', f);
  assert.equal(r.ok, false);
  assert.match(r.detail, /401/);
});

test('verifyDeepgram: network failure resolves {ok:false}, never rejects', async () => {
  const f = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  const r = await verifyDeepgram('dg-key', f);
  assert.equal(r.ok, false);
  assert.match(r.detail, /fetch failed/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/swarm && node --import tsx --test src/verify-elevenlabs.test.ts src/verify-deepgram.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement both verify functions**

```ts
// swarm/src/verify-elevenlabs.ts
// Live check for an ElevenLabs API key (spec §1): GET /v1/user with xi-api-key.
import type { VerifyResult } from './verify-github.js';

export async function verifyElevenlabs(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<VerifyResult> {
  try {
    const res = await fetchImpl('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': apiKey } });
    const body = (await res.json().catch(() => ({}))) as { subscription?: { tier?: string }; detail?: { message?: string } };
    if (!res.ok) return { ok: false, detail: `ElevenLabs ${res.status}: ${body.detail?.message ?? 'unauthorized'}` };
    return { ok: true, detail: body.subscription?.tier ? `Key valid — ${body.subscription.tier} plan` : 'Key valid' };
  } catch (err) {
    return { ok: false, detail: `Could not reach ElevenLabs: ${err instanceof Error ? err.message : String(err)}` };
  }
}
```

```ts
// swarm/src/verify-deepgram.ts
// Live check for a Deepgram API key (spec §1): GET /v1/projects with Token auth.
import type { VerifyResult } from './verify-github.js';

export async function verifyDeepgram(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<VerifyResult> {
  try {
    const res = await fetchImpl('https://api.deepgram.com/v1/projects', { headers: { authorization: `Token ${apiKey}` } });
    const body = (await res.json().catch(() => ({}))) as { projects?: unknown[]; err_msg?: string };
    if (!res.ok) return { ok: false, detail: `Deepgram ${res.status}: ${body.err_msg ?? 'unauthorized'}` };
    const n = body.projects?.length ?? 0;
    return { ok: true, detail: `Key valid — ${n} project${n === 1 ? '' : 's'}` };
  } catch (err) {
    return { ok: false, detail: `Could not reach Deepgram: ${err instanceof Error ? err.message : String(err)}` };
  }
}
```

- [ ] **Step 4: Add `capabilities` to the vendor def and register both vendors**

In `swarm/src/connectors.ts`, add to `ConnectorVendorDef` (after `verifyExtraFields`):

```ts
  /** Voice capabilities this vendor's credential can power (spec §1). Absent = not a voice vendor. */
  capabilities?: ('stt' | 'tts')[];
```

Add the two vendor defs (after `SNYK`) and extend `VENDORS`:

```ts
import { verifyElevenlabs } from './verify-elevenlabs.js';
import { verifyDeepgram } from './verify-deepgram.js';

const ELEVENLABS: ConnectorVendorDef = {
  id: 'elevenlabs',
  label: 'ElevenLabs',
  description: 'Text-to-speech — the voices agents speak with.',
  fields: [{ key: 'apiKey', label: 'API key', secret: true }],
  capabilities: ['tts'],
  verify: (fields, _extra, fetchImpl) => verifyElevenlabs(fields.apiKey ?? '', fetchImpl),
};

const DEEPGRAM: ConnectorVendorDef = {
  id: 'deepgram',
  label: 'Deepgram',
  description: 'Speech-to-text — how agents hear you.',
  fields: [{ key: 'apiKey', label: 'API key', secret: true }],
  capabilities: ['stt'],
  verify: (fields, _extra, fetchImpl) => verifyDeepgram(fields.apiKey ?? '', fetchImpl),
};

export const VENDORS: ConnectorVendorDef[] = [ATLASSIAN, GITHUB, DATADOG, SNYK, ELEVENLABS, DEEPGRAM];
```

In `swarm/src/server.ts:1461-1469`, add `capabilities` to the `GET /connectors/vendors` mapping:

```ts
      return VENDORS.map((v) => ({
        id: v.id,
        label: v.label,
        description: v.description,
        fields: v.fields,
        verifyExtraFields: v.verifyExtraFields ?? [],
        capabilities: v.capabilities ?? [],
      }));
```

- [ ] **Step 5: Update `connectors.test.ts` for six vendors**

The existing tests pin exactly 4 vendors — update all four affected tests:

```ts
// in 'findVendor: resolves each of the … shipped vendors by id' — extend the list:
  for (const id of ['atlassian', 'github', 'datadog', 'snyk', 'elevenlabs', 'deepgram']) {
// in 'field keys match the documented shape for each vendor' — add:
  assert.deepEqual(findVendor('elevenlabs')!.fields.map((f) => f.key), ['apiKey']);
  assert.deepEqual(findVendor('deepgram')!.fields.map((f) => f.key), ['apiKey']);
// in 'only Atlassian declares verifyExtraFields' — extend the loop list with 'elevenlabs', 'deepgram'
// in 'VENDORS has exactly the 4 shipped vendors, no duplicates' — rename to '…exactly the 6 shipped vendors…':
  assert.equal(VENDORS.length, 6);
  assert.equal(new Set(VENDORS.map((v) => v.id)).size, 6);
```

Add a capabilities test:

```ts
test('capabilities: only the two voice vendors declare them, one capability each', () => {
  assert.deepEqual(findVendor('elevenlabs')!.capabilities, ['tts']);
  assert.deepEqual(findVendor('deepgram')!.capabilities, ['stt']);
  for (const id of ['atlassian', 'github', 'datadog', 'snyk']) {
    assert.equal(findVendor(id)!.capabilities, undefined);
  }
});
```

- [ ] **Step 6: Run and commit**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/swarm && npm test && npm run typecheck`
Expected: PASS (the wizard/premade tests don't enumerate vendors; only connectors.test.ts pins the count)

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add swarm/src/verify-elevenlabs.ts swarm/src/verify-elevenlabs.test.ts swarm/src/verify-deepgram.ts swarm/src/verify-deepgram.test.ts swarm/src/connectors.ts swarm/src/connectors.test.ts swarm/src/server.ts
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(swarm): elevenlabs + deepgram connector vendors with capabilities tag"
```

---

### Task 4: `User.voice`, `/me/voice` routes, `/me/voice/keys`, delete-clears-slot

**Files:**
- Modify: `swarm/src/users.ts` (voice field), `swarm/src/server.ts` (helpers + routes)
- Test: `swarm/src/server.test.ts` (append helper tests)

**Interfaces:**
- Produces (all exported from `server.ts`, tested as pure helpers per the house convention documented at `server.test.ts:1-10`):
  - `interface VoiceSettings { stt?: { instanceId: string }; tts?: { instanceId: string }; hideInactive?: boolean }` on `users.ts` as `User.voice?: VoiceSettings`
  - `buildVoiceUpdate(user: User | null, body: unknown): { voice: VoiceSettings } | { error: string }` — full-replace semantics; validates instance existence + vendor capability
  - `clearVoiceReferences(voice: VoiceSettings | undefined, instanceId: string): VoiceSettings | undefined`
  - `resolveVoiceKeys(user: User | null): { stt: { vendorId: string; apiKey: string } | null; tts: { vendorId: string; apiKey: string } | null }`
  - Routes: `GET /me/voice`, `PUT /me/voice`, `GET /me/voice/keys` (raw, loopback-only)

- [ ] **Step 1: Add the `voice` field to `User`** in `users.ts` (after `connectors`):

```ts
export interface VoiceSettings {
  stt?: { instanceId: string };
  tts?: { instanceId: string };
  hideInactive?: boolean;
}

export interface User {
  id: string;
  name: string;
  /** Mirrors Workspace's default-invariant pattern; single default user today. */
  default?: boolean;
  connectors?: ConnectorInstance[];
  /** Which connector instance powers each voice capability (spec §2). */
  voice?: VoiceSettings;
}
```

- [ ] **Step 2: Write the failing helper tests** (append to `server.test.ts`; add `buildVoiceUpdate`, `clearVoiceReferences`, `resolveVoiceKeys` to the existing `./server.js` import and `VoiceSettings` to the `./users.js` type import)

```ts
const voiceUser: User = {
  id: 'me', name: 'You', default: true,
  connectors: [
    { id: 'dg1', vendorId: 'deepgram', label: 'personal', fields: { apiKey: 'dg-key' } },
    { id: 'el1', vendorId: 'elevenlabs', label: 'personal', fields: { apiKey: 'el-key' } },
    { id: 'gh1', vendorId: 'github', label: 'personal', fields: { token: 'ghp' } },
  ],
};

test('buildVoiceUpdate: accepts matching-capability instances and hideInactive', () => {
  const r = buildVoiceUpdate(voiceUser, { stt: { instanceId: 'dg1' }, tts: { instanceId: 'el1' }, hideInactive: true });
  assert.deepEqual(r, { voice: { stt: { instanceId: 'dg1' }, tts: { instanceId: 'el1' }, hideInactive: true } });
});

test('buildVoiceUpdate: null slots clear; omitted hideInactive defaults false-ish', () => {
  const r = buildVoiceUpdate(voiceUser, { stt: null, tts: null });
  assert.deepEqual(r, { voice: { hideInactive: false } });
});

test('buildVoiceUpdate: unknown instance id → error', () => {
  const r = buildVoiceUpdate(voiceUser, { stt: { instanceId: 'nope' }, tts: null });
  assert.ok('error' in r && /nope/.test(r.error));
});

test('buildVoiceUpdate: wrong-capability instance rejected (github can neither hear nor speak; elevenlabs cannot do STT in v1)', () => {
  for (const instanceId of ['gh1', 'el1']) {
    const r = buildVoiceUpdate(voiceUser, { stt: { instanceId }, tts: null });
    assert.ok('error' in r, `expected error for stt=${instanceId}`);
  }
});

test('clearVoiceReferences: deleting a selected instance clears only that slot', () => {
  const voice = { stt: { instanceId: 'dg1' }, tts: { instanceId: 'el1' }, hideInactive: true };
  assert.deepEqual(clearVoiceReferences(voice, 'dg1'), { tts: { instanceId: 'el1' }, hideInactive: true });
  assert.deepEqual(clearVoiceReferences(voice, 'other'), voice);
  assert.equal(clearVoiceReferences(undefined, 'dg1'), undefined);
});

test('resolveVoiceKeys: resolves selected slots to raw keys; unset/dangling/empty → null per slot', () => {
  assert.deepEqual(resolveVoiceKeys({ ...voiceUser, voice: { stt: { instanceId: 'dg1' }, tts: { instanceId: 'el1' } } }), {
    stt: { vendorId: 'deepgram', apiKey: 'dg-key' },
    tts: { vendorId: 'elevenlabs', apiKey: 'el-key' },
  });
  assert.deepEqual(resolveVoiceKeys({ ...voiceUser, voice: { stt: { instanceId: 'gone' } } }), { stt: null, tts: null });
  assert.deepEqual(resolveVoiceKeys(null), { stt: null, tts: null });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/swarm && node --import tsx --test src/server.test.ts`
Expected: FAIL — helpers not exported

- [ ] **Step 4: Implement helpers + routes in `server.ts`**

Helpers (module level, near `buildConnectorFields`; import `VoiceSettings` from `./users.js`):

```ts
/** PUT /me/voice body → validated full-replace VoiceSettings (spec §2). */
export function buildVoiceUpdate(user: User | null, body: unknown): { voice: VoiceSettings } | { error: string } {
  const b = (body ?? {}) as { stt?: { instanceId?: string } | null; tts?: { instanceId?: string } | null; hideInactive?: boolean };
  const voice: VoiceSettings = { hideInactive: Boolean(b.hideInactive) };
  for (const slot of ['stt', 'tts'] as const) {
    const sel = b[slot];
    if (!sel) continue; // null/undefined → slot off
    const instanceId = sel.instanceId ?? '';
    const instance = user?.connectors?.find((c) => c.id === instanceId);
    if (!instance) return { error: `Unknown connector instance: ${instanceId}` };
    const vendor = findVendor(instance.vendorId);
    if (!vendor?.capabilities?.includes(slot)) {
      return { error: `${vendor?.label ?? instance.vendorId} cannot power ${slot === 'stt' ? 'speech-to-text' : 'text-to-speech'}` };
    }
    voice[slot] = { instanceId };
  }
  return { voice };
}

/** DELETE /me/connectors/:id side effect (spec §2): a deleted instance vacates any voice slot pointing at it. */
export function clearVoiceReferences(voice: VoiceSettings | undefined, instanceId: string): VoiceSettings | undefined {
  if (!voice) return undefined;
  const next: VoiceSettings = { ...voice };
  if (next.stt?.instanceId === instanceId) delete next.stt;
  if (next.tts?.instanceId === instanceId) delete next.tts;
  return next;
}

/** GET /me/voice/keys resolution (spec §4). Fields are already decrypted in memory by loadUsersFromDir. */
export function resolveVoiceKeys(user: User | null): {
  stt: { vendorId: string; apiKey: string } | null;
  tts: { vendorId: string; apiKey: string } | null;
} {
  const resolveSlot = (slot: 'stt' | 'tts') => {
    const instanceId = user?.voice?.[slot]?.instanceId;
    const instance = user?.connectors?.find((c) => c.id === instanceId);
    const apiKey = instance?.fields.apiKey;
    if (!instance || !apiKey) return null;
    return { vendorId: instance.vendorId, apiKey };
  };
  return { stt: resolveSlot('stt'), tts: resolveSlot('tts') };
}
```

Routes (after the `/me/connectors/:id/verify` route, before the CLI-tools block):

```ts
    const redactVoice = (u: User | null) => ({
      stt: u?.voice?.stt ?? null,
      tts: u?.voice?.tts ?? null,
      hideInactive: Boolean(u?.voice?.hideInactive),
    });

    this.app.get('/me/voice', async () => {
      const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
      return redactVoice(resolveCurrentUser(users));
    });

    this.app.put('/me/voice', async (req, reply) => {
      const dir = resolve(process.cwd(), '.smith/users');
      const users = await loadUsersFromDir(dir);
      const existing = resolveCurrentUser(users) ?? { id: 'me', name: 'You', default: true, connectors: [] };
      const r = buildVoiceUpdate(existing, req.body);
      if ('error' in r) return reply.status(400).send({ error: r.error });
      const merged: User = { ...existing, voice: r.voice };
      try {
        await saveUser(dir, merged);
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
      return redactVoice(merged);
    });

    // Internal-only — returns RAW voice keys, like /workspaces/:name/channels/discord-token
    // above: never proxied through broker's browser-facing text-channel.ts surface.
    // broker's SwarmClient calls it server-to-server on the same loopback-bound,
    // no-separate-auth trust boundary. In cloud mode this route is the seam where
    // platform-provisioned keys would be resolved instead (spec §7).
    this.app.get('/me/voice/keys', async () => {
      const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
      return resolveVoiceKeys(resolveCurrentUser(users));
    });
```

And in the existing `DELETE /me/connectors/:id` handler (server.ts:1519-1533), extend the `merged` construction:

```ts
      const merged: User = {
        ...existing,
        connectors: existing.connectors.filter((c) => c.id !== req.params.id),
        voice: clearVoiceReferences(existing.voice, req.params.id),
      };
```

- [ ] **Step 5: Run and commit**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/swarm && npm test && npm run typecheck`
Expected: PASS

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add swarm/src/users.ts swarm/src/server.ts swarm/src/server.test.ts
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(swarm): /me/voice settings + raw /me/voice/keys resolution routes"
```

---

### Task 5: Broker `SwarmClient` voice methods

**Files:**
- Modify: `broker/src/swarm-client.ts`
- Test: `broker/src/swarm-client.test.ts` (append)

**Interfaces:**
- Produces: `interface VoiceKeys { stt: { vendorId: string; apiKey: string } | null; tts: { vendorId: string; apiKey: string } | null }` (exported); `getVoiceKeys(): Promise<VoiceKeys | null>` — **`null` means swarm unreachable** (route always 200s when reachable, so unset-vs-unreachable stays distinguishable, unlike `getWorkspaceDiscordConfig`'s deliberate collapse at swarm-client.ts:430-439); `getMyVoice(): Promise<Record<string, unknown>>`; `saveMyVoice(body: unknown): Promise<Record<string, unknown>>` (both throw like the other `http()` passthroughs).

- [ ] **Step 1: Write the failing tests** (append to `swarm-client.test.ts`, using its `fakeFetch(routes)` helper at :8-18)

```ts
test('getVoiceKeys: returns the resolved slots from /me/voice/keys', async () => {
  const client = new SwarmClient({
    baseUrl: 'http://s',
    fetchImpl: fakeFetch({ '/me/voice/keys': { stt: { vendorId: 'deepgram', apiKey: 'dg' }, tts: null } }),
  });
  assert.deepEqual(await client.getVoiceKeys(), { stt: { vendorId: 'deepgram', apiKey: 'dg' }, tts: null });
});

test('getVoiceKeys: unreachable swarm → null (distinct from {stt:null,tts:null})', async () => {
  const client = new SwarmClient({
    baseUrl: 'http://s',
    fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
  });
  assert.equal(await client.getVoiceKeys(), null);
});

test('getMyVoice/saveMyVoice: GET and PUT /me/voice pass through', async () => {
  const client = new SwarmClient({
    baseUrl: 'http://s',
    fetchImpl: fakeFetch({ '/me/voice': { stt: null, tts: null, hideInactive: false } }),
  });
  assert.deepEqual(await client.getMyVoice(), { stt: null, tts: null, hideInactive: false });
  assert.deepEqual(await client.saveMyVoice({ stt: null, tts: null }), { stt: null, tts: null, hideInactive: false });
});
```

(If `fakeFetch` only answers GET, check its shape first — it maps pathname→body regardless of method, which is fine for the PUT passthrough.)

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/broker && node --import tsx --test src/swarm-client.test.ts`
Expected: FAIL — methods missing

- [ ] **Step 3: Implement** (place near `getWorkspaceDiscordConfig`, swarm-client.ts:440; export the type near the other wire types at the top)

```ts
export interface VoiceKeys {
  stt: { vendorId: string; apiKey: string } | null;
  tts: { vendorId: string; apiKey: string } | null;
}
```

```ts
  /**
   * Raw voice keys (spec §4). Returns null ONLY on transport failure — the
   * route itself always 200s with per-slot nulls when keys are unset, so the
   * VoiceKeyResolver can keep its last good keys across a swarm restart
   * instead of flapping voice off.
   */
  async getVoiceKeys(): Promise<VoiceKeys | null> {
    try {
      return (await this.http('GET', '/me/voice/keys')) as unknown as VoiceKeys;
    } catch {
      return null;
    }
  }

  async getMyVoice(): Promise<Record<string, unknown>> {
    return this.http('GET', '/me/voice');
  }

  async saveMyVoice(body: unknown): Promise<Record<string, unknown>> {
    return this.http('PUT', '/me/voice', body);
  }
```

- [ ] **Step 4: Run and commit**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/broker && node --import tsx --test src/swarm-client.test.ts && npm run typecheck`
Expected: PASS

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add broker/src/swarm-client.ts broker/src/swarm-client.test.ts
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(broker): SwarmClient voice-keys + /me/voice passthrough methods"
```

---

### Task 6: `VoiceKeyResolver` (20s TTL, keep-last-good, sync status)

**Files:**
- Create: `broker/src/voice-keys.ts`
- Test: `broker/src/voice-keys.test.ts`

**Interfaces:**
- Consumes: Task 5's `VoiceKeys` + a `Pick<SwarmClient, 'getVoiceKeys'>`.
- Produces: `class VoiceKeyResolver` with `sttKey(): Promise<string | null>`, `ttsKey(): Promise<string | null>`, `status(): Promise<{ stt: boolean; tts: boolean }>`, `statusSync(): { stt: boolean; tts: boolean }` (returns cached snapshot AND kicks a background refresh when stale — the polled `/agents` route self-heals), `VOICE_KEYS_TTL_MS = 20_000`, and the two pointer strings `VOICE_STT_HINT` / `VOICE_TTS_HINT` (exact copy from Global Constraints).

- [ ] **Step 1: Write the failing tests**

```ts
// broker/src/voice-keys.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceKeyResolver, VOICE_KEYS_TTL_MS } from './voice-keys.ts';
import type { VoiceKeys } from './swarm-client.ts';

const KEYS: VoiceKeys = { stt: { vendorId: 'deepgram', apiKey: 'dg' }, tts: { vendorId: 'elevenlabs', apiKey: 'el' } };

function makeSwarm(responses: Array<VoiceKeys | null>) {
  let calls = 0;
  return {
    calls: () => calls,
    client: { getVoiceKeys: async () => { calls++; return responses[Math.min(calls - 1, responses.length - 1)]; } },
  };
}

test('resolves keys and caches within the TTL', async () => {
  let now = 0;
  const swarm = makeSwarm([KEYS]);
  const r = new VoiceKeyResolver(swarm.client, () => now);
  assert.equal(await r.sttKey(), 'dg');
  assert.equal(await r.ttsKey(), 'el');
  assert.equal(swarm.calls(), 1); // second read inside TTL hits cache
  now = VOICE_KEYS_TTL_MS + 1;
  assert.equal(await r.sttKey(), 'dg');
  assert.equal(swarm.calls(), 2); // TTL expiry refetches
});

test('unset keys resolve null and status false', async () => {
  const r = new VoiceKeyResolver(makeSwarm([{ stt: null, tts: null }]).client, () => 0);
  assert.equal(await r.sttKey(), null);
  assert.deepEqual(await r.status(), { stt: false, tts: false });
});

test('swarm unreachable (null) keeps the last good keys', async () => {
  let now = 0;
  const r = new VoiceKeyResolver(makeSwarm([KEYS, null]).client, () => now);
  assert.equal(await r.sttKey(), 'dg');
  now = VOICE_KEYS_TTL_MS + 1;
  assert.equal(await r.sttKey(), 'dg'); // refresh returned null → cached keys survive
});

test('a key change is picked up after the TTL', async () => {
  let now = 0;
  const rotated: VoiceKeys = { stt: { vendorId: 'deepgram', apiKey: 'dg2' }, tts: null };
  const r = new VoiceKeyResolver(makeSwarm([KEYS, rotated]).client, () => now);
  assert.equal(await r.sttKey(), 'dg');
  now = VOICE_KEYS_TTL_MS + 1;
  assert.equal(await r.sttKey(), 'dg2');
  assert.equal(await r.ttsKey(), null);
});

test('statusSync returns the cached snapshot without awaiting', async () => {
  const r = new VoiceKeyResolver(makeSwarm([KEYS]).client, () => 0);
  assert.deepEqual(r.statusSync(), { stt: false, tts: false }); // nothing fetched yet
  await r.status(); // warm
  assert.deepEqual(r.statusSync(), { stt: true, tts: true });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/broker && node --import tsx --test src/voice-keys.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// broker/src/voice-keys.ts
// Runtime voice-key resolution (spec §4): a short-TTL cache over swarm's
// GET /me/voice/keys so pasting a key in Settings takes effect without a
// broker restart. Swarm-unreachable (client returns null) keeps the last
// good keys — voice shouldn't flap off because swarm restarted.
import type { VoiceKeys } from './swarm-client.ts';

export const VOICE_KEYS_TTL_MS = 20_000;

export const VOICE_STT_HINT = 'Add a Deepgram key in Settings → Integrations, then select it under Settings → Voice.';
export const VOICE_TTS_HINT =
  'No text-to-speech key — add an ElevenLabs key in Settings → Integrations, then select it under Settings → Voice.';

export class VoiceKeyResolver {
  private cached: VoiceKeys = { stt: null, tts: null };
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly swarm: { getVoiceKeys(): Promise<VoiceKeys | null> },
    private readonly now: () => number = Date.now,
  ) {}

  private refresh(): Promise<void> {
    this.inflight ??= this.swarm.getVoiceKeys().then((keys) => {
      if (keys) this.cached = keys; // null = unreachable → keep last good
      this.fetchedAt = this.now();
      this.inflight = null;
    });
    return this.inflight;
  }

  private async current(): Promise<VoiceKeys> {
    if (this.now() - this.fetchedAt >= VOICE_KEYS_TTL_MS) await this.refresh();
    return this.cached;
  }

  async sttKey(): Promise<string | null> {
    return (await this.current()).stt?.apiKey ?? null;
  }

  async ttsKey(): Promise<string | null> {
    return (await this.current()).tts?.apiKey ?? null;
  }

  async status(): Promise<{ stt: boolean; tts: boolean }> {
    const c = await this.current();
    return { stt: Boolean(c.stt), tts: Boolean(c.tts) };
  }

  /** Cached snapshot for sync call sites (/agents payload); kicks a background refresh when stale. */
  statusSync(): { stt: boolean; tts: boolean } {
    if (this.now() - this.fetchedAt >= VOICE_KEYS_TTL_MS) void this.refresh();
    return { stt: Boolean(this.cached.stt), tts: Boolean(this.cached.tts) };
  }
}
```

- [ ] **Step 4: Run and commit**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/broker && node --import tsx --test src/voice-keys.test.ts && npm run typecheck`
Expected: PASS

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add broker/src/voice-keys.ts broker/src/voice-keys.test.ts
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(broker): VoiceKeyResolver — 20s TTL, keep-last-good, sync status"
```

---

### Task 7: Broker hard cut — config fields out, engines resolve keys at use

**Files:**
- Modify: `broker/src/config.ts`, `broker/src/config.test.ts`, `broker/src/main.ts`

**Interfaces:**
- Consumes: Task 6's `VoiceKeyResolver`; existing `ElevenLabsVoiceProvider`, `VoiceCatalog`, `DeepgramClient`.
- Produces (module scope in `main.ts`, used by Task 8): `const voiceKeys = new VoiceKeyResolver(swarm)`; `async function currentTts(): Promise<{ provider: ElevenLabsVoiceProvider; catalog: VoiceCatalog } | null>` (memoized per key, rebuilt only on key change — both classes bind the key in their constructors).

- [ ] **Step 1: Rewrite `config.test.ts`'s required-var test.** Delete the test `'throws naming the missing required var'` (config.test.ts:21-24) and remove `DEEPGRAM_API_KEY: 'dg'` from the `FULL` fixture (:5-11). Add:

```ts
test('boots with no voice keys anywhere — voice keys are Settings-managed, not env (spec §6)', () => {
  const config = loadBrokerConfig(FULL); // FULL no longer contains either voice key
  assert.ok(!('deepgramApiKey' in config));
  assert.ok(!('elevenlabsApiKey' in config));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/broker && node --import tsx --test src/config.test.ts`
Expected: FAIL — config still carries the fields (and `FULL` without DEEPGRAM_API_KEY makes `loadBrokerConfig` throw)

- [ ] **Step 3: Cut the fields from `config.ts`.** Remove `deepgramApiKey: string;` (:4) and `elevenlabsApiKey?: string;` (:5) from `BrokerConfig`, and the loader lines `deepgramApiKey: required('DEEPGRAM_API_KEY'),` (:23) and `elevenlabsApiKey: env.ELEVENLABS_API_KEY || undefined,` (:24).

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/broker && node --import tsx --test src/config.test.ts`
Expected: config tests PASS (main.ts won't typecheck yet — next steps)

- [ ] **Step 4: Rewire `main.ts` TTS construction.** Replace the two module constants at main.ts:99-103:

```ts
const voiceKeys = new VoiceKeyResolver(swarm);

// Both classes bind the key in their constructors, so "rebuilt only when the
// key changes" (spec §4) is a memoized {key, provider, catalog} triple, not a
// per-call key thread.
let ttsCache: { key: string; provider: ElevenLabsVoiceProvider; catalog: VoiceCatalog } | null = null;
async function currentTts(): Promise<{ provider: ElevenLabsVoiceProvider; catalog: VoiceCatalog } | null> {
  const key = await voiceKeys.ttsKey();
  if (!key) {
    ttsCache = null;
    return null;
  }
  if (ttsCache?.key !== key) {
    ttsCache = {
      key,
      provider: new ElevenLabsVoiceProvider({ apiKey: key }),
      catalog: new VoiceCatalog(key, process.env.BROKER_VOICE_CACHE_DIR ?? '.smith/voice-cache'),
    };
  }
  return ttsCache;
}
```

with `import { VoiceKeyResolver, VOICE_STT_HINT, VOICE_TTS_HINT } from './voice-keys.ts';` added to the imports. Note: `swarm` (the SwarmClient) must already be constructed above this point — if the SwarmClient is currently constructed later in the file, move ONLY its construction up above this block (it has no dependencies besides config).

Then update every `tts`/`voiceCatalog` consumer (exact sites from exploration):

1. `speak()` meeting generator (main.ts:122-153): replace the `if (!tts) { return; }` guard and `tts.stream(...)`:
```ts
  const t = await currentTts();
  if (!t) {
    return; // no TTS configured — onSpeechText already surfaced the text
  }
  // ...unchanged body, with `tts.stream(` → `t.provider.stream(`
```
2. `broadcastSpokenAudio()` (main.ts:929-957): change signature to `async function`, replace `if (!tts) return;` with the Task 8 hint logic — for THIS task just use `const t = await currentTts(); if (!t) return;` and `tts.synthesize(` → `t.provider.synthesize(`. Its call site in `onSpeechText` (main.ts:997) stays fire-and-forget: change to `void broadcastSpokenAudio(text);`.
3. Hello config frame (main.ts:778): `{ type: 'config', audio: Boolean(tts) }` → `{ type: 'config', audio: voiceKeys.statusSync().tts }`. (Task 8 makes hello frames per-connect so this is evaluated fresh.)
4. `creation.voices` (main.ts:728-736): `if (!voiceCatalog) return { voices: [], hasMore: false, error: '...' }` → 
```ts
      const t = await currentTts();
      if (!t) return { voices: [], hasMore: false, error: VOICE_TTS_HINT };
      // ...unchanged, with voiceCatalog → t.catalog
```
5. `creation.preview` (main.ts:737-740): same shape — `if (!t) throw new Error(VOICE_TTS_HINT);`, `voiceCatalog` → `t.catalog`.
6. Post-create cache warm (main.ts:751-762): `if (voiceCatalog && agent.voice?.voiceId)` → `const t = await currentTts(); if (t && agent.voice?.voiceId)` with `voiceCatalog` → `t.catalog` (make the enclosing function async if it isn't; it's already fire-and-forget).

- [ ] **Step 5: Rewire `makeDeepgramLive` for per-session keys.** Delete the module constant `const deepgram = new DeepgramClient({ apiKey: config.deepgramApiKey });` (main.ts:170). Inside `makeDeepgramLive` (main.ts:177-223), the `ready` promise gains the key fetch + client construction:

```ts
  type Socket = Awaited<ReturnType<DeepgramClient['listen']['v1']['connect']>>;
  // ...existing socket/resultsCb/pending/closed declarations unchanged...
  const ready: Promise<Socket | null> = voiceKeys
    .sttKey()
    .then((key) => {
      if (!key) return null; // no STT key — session yields no results (callers gate before starting)
      const deepgram = new DeepgramClient({ apiKey: key });
      return deepgram.listen.v1.connect(deepgramLiveOptions(sampleRate) as any);
    })
    .then(async (s) => {
      if (!s) return null;
      // ...existing open/waitForOpen/pending-flush body unchanged...
    })
    .catch((err: unknown) => {
      console.error('[stt] deepgram connect failed:', err);
      return null;
    });
```

The `type Socket` alias must switch from `ReturnType<typeof deepgram...>` to the `DeepgramClient['listen']['v1']['connect']` indexed form shown above since the module constant is gone.

- [ ] **Step 6: Run the broker suite + typecheck**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/broker && npm test && npm run typecheck`
Expected: PASS. If main.ts references `config.deepgramApiKey`/`config.elevenlabsApiKey` anywhere else, the typecheck names the stragglers — fix them with the same `voiceKeys`/`currentTts()` seams.

- [ ] **Step 7: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add broker/src/config.ts broker/src/config.test.ts broker/src/main.ts
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(broker): hard-cut voice env keys — engines resolve via VoiceKeyResolver"
```

---

### Task 8: Broker inactive UX — notice frame, guards, status, proxy

**Files:**
- Modify: `broker/src/text-channel.ts`, `broker/src/main.ts`, `broker/src/discord-voice-lifecycle.ts`
- Test: `broker/src/text-channel.test.ts` (append)

**Interfaces:**
- Consumes: Task 6/7's `voiceKeys`, `currentTts()`, `VOICE_STT_HINT`, `VOICE_TTS_HINT`.
- Produces:
  - `ChannelFrame` union (text-channel.ts:32-53) gains `| { type: 'notice'; text: string }` — a muted system line, distinct from agent `speech`.
  - `TextChannel` constructor gains optional dep as the new LAST positional param, after `apiKeys` (text-channel.ts:194): `voice?: { status(): { stt: boolean; tts: boolean }; get(): Promise<Record<string, unknown>>; save(body: unknown): Promise<Record<string, unknown>> }`.
  - `GET /agents` response gains top-level `voice: { stt: boolean, tts: boolean }` sibling of `discord`.
  - `GET/PUT /me/voice` proxied on 7790, origin-restricted via `credJson` like `/me/connectors*`. `/me/voice/keys` is NOT proxied (negative test).
  - `discord-voice-lifecycle` deps gain `voiceCapabilities?: () => { stt: boolean; tts: boolean }`.

- [ ] **Step 1: Write the failing text-channel tests** (append to `text-channel.test.ts`, using its `channelWith({...})` override helper — the same harness the api-keys negative-proxy test at :906 uses):

```ts
const voiceDep = {
  status: () => ({ stt: true, tts: false }),
  get: async () => ({ stt: null, tts: null, hideInactive: false }),
  save: async (body: unknown) => body as Record<string, unknown>,
};

test('voice: GET and PUT /me/voice are proxied when the voice dep is wired', async () => {
  const channel = channelWith({ voice: voiceDep });
  const port = await channel.start(0);
  try {
    const got = await fetch(`http://127.0.0.1:${port}/me/voice`, { headers: { Origin: 'http://localhost:1420' } });
    assert.equal(got.status, 200);
    assert.deepEqual(await got.json(), { stt: null, tts: null, hideInactive: false });
    const put = await fetch(`http://127.0.0.1:${port}/me/voice`, {
      method: 'PUT',
      headers: { Origin: 'http://localhost:1420', 'content-type': 'application/json' },
      body: JSON.stringify({ stt: { instanceId: 'dg1' }, tts: null, hideInactive: false }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { stt: { instanceId: 'dg1' }, tts: null, hideInactive: false });
  } finally {
    await channel.stop();
  }
});

test('voice: /me/voice/keys is NOT proxied on 7790 — raw keys never reach the browser surface', async () => {
  const channel = channelWith({ voice: voiceDep });
  const port = await channel.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/me/voice/keys`, { headers: { Origin: 'http://localhost:1420' } });
    assert.equal(res.status, 404);
  } finally {
    await channel.stop();
  }
});

test('agents: response carries the voice status sibling; absent dep → both false', async () => {
  const withDep = channelWith({ voice: voiceDep });
  const port = await withDep.start(0);
  try {
    const body = (await (await fetch(`http://127.0.0.1:${port}/agents`)).json()) as { voice?: unknown };
    assert.deepEqual(body.voice, { stt: true, tts: false });
  } finally {
    await withDep.stop();
  }
  const without = channelWith({});
  const port2 = await without.start(0);
  try {
    const body = (await (await fetch(`http://127.0.0.1:${port2}/agents`)).json()) as { voice?: unknown };
    assert.deepEqual(body.voice, { stt: false, tts: false });
  } finally {
    await without.stop();
  }
});
```

(If `channelWith` positions deps differently than named overrides suggest, follow how the api-keys test at :906 passes its dep and mirror it exactly. `channelWith({})` may need the file's default required args — copy an adjacent minimal-construction test.)

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/broker && node --import tsx --test src/text-channel.test.ts`
Expected: FAIL — no `voice` dep, no routes, no `voice` sibling

- [ ] **Step 3: Implement in `text-channel.ts`:**

1. Frame union (:32-53): add `| { type: 'notice'; text: string }`.
2. Constructor: add after `apiKeys` (currently last, :194+):
```ts
    private readonly voice?: {
      /** Cached resolver snapshot for the /agents payload. */
      status(): { stt: boolean; tts: boolean };
      /** Voice settings passthrough (Settings → Voice group). Origin-restricted like connectors. */
      get(): Promise<Record<string, unknown>>;
      save(body: unknown): Promise<Record<string, unknown>>;
    },
```
3. `/agents` (:385-395): add the sibling:
```ts
            return json(200, {
              agents: withPresence,
              discord: this.surfaces?.info() ?? { configured: false, voiceReady: false },
              voice: this.voice?.status() ?? { stt: false, tts: false },
            });
```
4. Routes (next to the `/me/connectors` block at :582+, same `credJson`/origin-block idiom — copy the GET and PUT arms of an adjacent route pair):
```ts
        if (req.method === 'GET' && url.pathname === '/me/voice' && this.voice) {
          if (originBlocked()) return;
          void this.voice.get().then((v) => credJson(200, v), credFail);
          return;
        }
        if (req.method === 'PUT' && url.pathname === '/me/voice' && this.voice) {
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
            void this.voice!.save(parsed).then((r) => credJson((r as { error?: string }).error ? 400 : 200, r), credFail);
          });
          return;
        }
```
This is the PUT `/me` arm's exact body-reading idiom (text-channel.ts:516-530) with `me.update` swapped for `voice.save` — keep it byte-for-byte otherwise, including the no-arg `originBlocked()`.
5. Hello frames staleness fix: if the constructor's `helloFrames` param (slot 2) is a static `ChannelFrame[]`, change its type to `() => ChannelFrame[]` and call it at the WS-connect send site (:748); update main.ts's single construction site to pass a thunk. This makes `{ type: 'config', audio: voiceKeys.statusSync().tts }` (Task 7 Step 4.3) live per-connect instead of frozen at boot.

- [ ] **Step 4: Wire it in `main.ts`:**

1. The `voice` dep, defined next to `cliTools` (:595-600) and passed as the new last constructor arg:
```ts
const voice = {
  status: () => voiceKeys.statusSync(),
  get: () => swarm.getMyVoice(),
  save: (body: unknown) => swarm.saveMyVoice(body),
};
```
2. PTT mic guard (inside `mic.start(clientId)` at :799-807 — the handler stays sync, so gate inside the async body):
```ts
    start: (clientId) => {
      void (async () => {
        if (!(await voiceKeys.sttKey())) {
          textChannel.broadcast({ type: 'notice', text: VOICE_STT_HINT });
          return;
        }
        // ...existing body: new DeepgramSttStream(makeDeepgramLive), stt.start(...), session map...
      })();
    },
```
3. TTS once-per-session hint in `broadcastSpokenAudio` (replacing Task 7's plain `if (!t) return;`):
```ts
let ttsHintSessionId: string | null = null;
// inside broadcastSpokenAudio:
  const t = await currentTts();
  if (!t) {
    const sid = sessionManager.active().id;
    if (ttsHintSessionId !== sid) {
      ttsHintSessionId = sid;
      textChannel.broadcast({ type: 'notice', text: VOICE_TTS_HINT });
    }
    return;
  }
```
(Check `sessionManager.active()`'s actual shape at its definition before using `.id` — if the accessor differs, use the file's existing idiom for "current session id", e.g. what `appendTranscript` keys on.)
4. Discord join pointer (main.ts:897): replace `if (!voiceSurface) return { error: 'Discord voice is not configured', status: 409 };` with:
```ts
        if (!voiceSurface) {
          const caps = voiceKeys.statusSync();
          return {
            error: !caps.stt && !caps.tts ? `Discord voice needs voice keys — ${VOICE_STT_HINT}` : 'Discord voice is not configured',
            status: 409,
          };
        }
```
5. Missing-half hint on a one-capability join (spec §5: join proceeds, "the missing half is hinted") — in the same handler, after `await voiceSurface.joinAgent(agentId)` succeeds and before `return { ok: true }`:
```ts
        const caps = voiceKeys.statusSync();
        if (!caps.stt || !caps.tts) {
          textChannel.broadcast({ type: 'notice', text: caps.stt ? VOICE_TTS_HINT : VOICE_STT_HINT });
        }
```
(The hint surfaces on the control-plane clients; making the agent explain it in Discord itself is brain-prompt territory, deliberately out of this plan.)

- [ ] **Step 5: Discord voice boot gate** in `discord-voice-lifecycle.ts` — add to its deps interface (next to `checkFfmpeg` at :101):

```ts
  /** Spec §5: voice boots if EITHER capability is available; blocked only when both are missing. */
  voiceCapabilities?: () => { stt: boolean; tts: boolean };
```

and after the ffmpeg/token guards (:189-199), same log+null shape:

```ts
    const caps = deps.voiceCapabilities?.() ?? { stt: true, tts: true };
    if (!caps.stt && !caps.tts) {
      console.error('[discord-voice] no STT or TTS keys configured — voice disabled. Add keys in Settings → Voice.');
      return null;
    }
```

Wire from main.ts where the lifecycle deps are built (near `makeStt` at :1058): `voiceCapabilities: () => voiceKeys.statusSync(),`.

- [ ] **Step 6: Run and commit**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/broker && npm test && npm run typecheck`
Expected: PASS, including the new text-channel tests

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add broker/src/text-channel.ts broker/src/text-channel.test.ts broker/src/main.ts broker/src/discord-voice-lifecycle.ts
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(broker): voice status + /me/voice proxy + pointer notices when keys absent"
```

---

### Task 9: Control-plane plumbing — voice API fns, notice frames, status hook

**Files:**
- Modify: `control-plane/src/hooks/useBrokerChat.ts`
- Create: `control-plane/src/hooks/useVoiceStatus.ts`
- Test: `control-plane/src/hooks/useVoiceStatus.test.ts`

**Interfaces:**
- Produces:
  - `export interface VoiceSettingsRecord { stt: { instanceId: string } | null; tts: { instanceId: string } | null; hideInactive: boolean }` (in useBrokerChat.ts near `ChannelsRecord` at :111)
  - `ConnectorVendorMeta` gains `capabilities?: string[]` (useBrokerChat.ts:62-76 region)
  - `getVoiceSettings(): Promise<VoiceSettingsRecord>` and `saveVoiceSettings(body): Promise<VoiceSettingsRecord & { error?: string }>` in the hook's return literal (:514-553)
  - `ChatMessage.role` widens from `"user" | "broker"` (:11) to `"user" | "broker" | "notice"`
  - `useVoiceStatus(): { voice: { stt: boolean; tts: boolean }; refresh: () => void }` — defaults `{ stt: true, tts: true }` when unknown/unreachable (house rule from useCliToolHealth: block only confirmed negatives, never show stale badges)

- [ ] **Step 1: Write the failing `useVoiceStatus` test** (vitest; mirror the mocking style of the existing hook tests — check `useCliToolHealth`'s test if one exists, else `ChannelsGroup.test.tsx`'s `vi.fn` style with a stubbed global fetch):

```tsx
// control-plane/src/hooks/useVoiceStatus.test.ts
import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useVoiceStatus } from "./useVoiceStatus";

afterEach(() => vi.unstubAllGlobals());

describe("useVoiceStatus", () => {
  it("reads the voice sibling from /agents", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ agents: [], voice: { stt: false, tts: true } }))));
    const { result } = renderHook(() => useVoiceStatus());
    await waitFor(() => expect(result.current.voice).toEqual({ stt: false, tts: true }));
  });

  it("defaults to enabled when the broker is unreachable — no stale gating", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const { result } = renderHook(() => useVoiceStatus());
    await waitFor(() => expect(result.current.voice).toEqual({ stt: true, tts: true }));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/control-plane && npx vitest run src/hooks/useVoiceStatus.test.ts`
Expected: FAIL — module missing

- [ ] **Step 3: Implement `useVoiceStatus`** (mirror `useCliToolHealth.ts`: module-local `BASE`, mount-once fetch, exported refresh):

```tsx
// control-plane/src/hooks/useVoiceStatus.ts
// Broker voice capability snapshot from GET /agents (the `voice` sibling,
// spec §4). Unknown/unreachable → enabled: gate only on confirmed negatives,
// same rule as useCliToolHealth.
import { useCallback, useEffect, useState } from "react";

const BASE = "127.0.0.1:7790";
const ENABLED = { stt: true, tts: true };

export function useVoiceStatus(): { voice: { stt: boolean; tts: boolean }; refresh: () => void } {
  const [voice, setVoice] = useState(ENABLED);
  const refresh = useCallback(() => {
    void fetch(`http://${BASE}/agents`)
      .then((r) => r.json())
      .then((body: { voice?: { stt: boolean; tts: boolean } }) => setVoice(body.voice ?? ENABLED))
      .catch(() => setVoice(ENABLED));
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { voice, refresh };
}
```

- [ ] **Step 4: Extend `useBrokerChat.ts`:**

1. Widen `ChatMessage.role` (:11) to `"user" | "broker" | "notice"`.
2. Add to the WS frame union (:165-176): `| { type: "notice"; text: string }`, and handle it right before the utterance/speech fallthrough (:198):
```ts
        if (frame.type === "notice") {
          setMessages((list) => [...list, { id: nextId.current++, role: "notice", text: frame.text }]);
          return;
        }
```
3. Add `capabilities?: string[]` to `ConnectorVendorMeta`.
4. Add the two fetch fns next to the connector fns (:385+), and both names to the return literal:
```ts
  const getVoiceSettings = useCallback(async (): Promise<VoiceSettingsRecord> => {
    const res = await fetch(`http://${base}/me/voice`);
    return (await res.json()) as VoiceSettingsRecord;
  }, [base]);

  const saveVoiceSettings = useCallback(
    async (body: { stt: { instanceId: string } | null; tts: { instanceId: string } | null; hideInactive: boolean }): Promise<VoiceSettingsRecord & { error?: string }> => {
      const res = await fetch(`http://${base}/me/voice`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return (await res.json()) as VoiceSettingsRecord & { error?: string };
    },
    [base],
  );
```
5. Render notices: find where `Transcript` (used by `VoiceStage.tsx:57`) maps messages and add a `role === "notice"` branch rendering `<p className="transcript__notice">{text}</p>`; add CSS next to the transcript styles in `styles/components.css`:
```css
.transcript__notice {
  font-size: 12px;
  opacity: 0.6;
  font-style: italic;
  text-align: center;
  margin: 4px 0;
}
```

- [ ] **Step 5: Run and commit**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/control-plane && npx vitest run && npm run typecheck`
Expected: PASS

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add control-plane/src/hooks/useBrokerChat.ts control-plane/src/hooks/useVoiceStatus.ts control-plane/src/hooks/useVoiceStatus.test.ts control-plane/src/styles/components.css control-plane/src/molecules/Transcript.tsx
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(control-plane): voice settings API, notice frames, voice status hook"
```

(Adjust the Transcript path in the `git add` if the component file is named differently — add whatever file actually renders messages.)

---

### Task 10: Settings → Voice group

**Files:**
- Create: `control-plane/src/organisms/settings/VoiceGroup.tsx`
- Modify: `control-plane/src/organisms/SettingsPanel.tsx`, `control-plane/src/pages/HomePage.tsx`
- Test: `control-plane/src/organisms/settings/VoiceGroup.test.tsx`

**Interfaces:**
- Consumes: Task 9's `VoiceSettingsRecord`, `getVoiceSettings`/`saveVoiceSettings`; existing `listConnectorVendors`/`listMyConnectors`.
- Produces: `VoiceGroup` with props `{ getVoice; saveVoice; listVendors; listConnectors }`; `SettingsGroupId` union gains `"voice"`; nav entry between Integrations and Channels (spec §2).

- [ ] **Step 1: Write the failing test** (ChannelsGroup.test.tsx style):

```tsx
// control-plane/src/organisms/settings/VoiceGroup.test.tsx
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VoiceGroup } from "./VoiceGroup";

const vendors = [
  { id: "deepgram", label: "Deepgram", description: "", fields: [], verifyExtraFields: [], capabilities: ["stt"] },
  { id: "elevenlabs", label: "ElevenLabs", description: "", fields: [], verifyExtraFields: [], capabilities: ["tts"] },
  { id: "github", label: "GitHub", description: "", fields: [], verifyExtraFields: [], capabilities: [] },
];
const connectors = [
  { id: "dg1", vendorId: "deepgram", label: "personal", fields: {} },
  { id: "el1", vendorId: "elevenlabs", label: "personal", fields: {} },
  { id: "gh1", vendorId: "github", label: "personal", fields: {} },
];

function make(overrides: Partial<Parameters<typeof VoiceGroup>[0]> = {}) {
  return {
    getVoice: vi.fn(async () => ({ stt: null, tts: null, hideInactive: false })),
    saveVoice: vi.fn(async (b: unknown) => ({ ...(b as object), error: undefined }) as never),
    listVendors: vi.fn(async () => vendors),
    listConnectors: vi.fn(async () => connectors),
    ...overrides,
  };
}

describe("VoiceGroup", () => {
  it("pickers list only capability-matching instances plus Off", async () => {
    render(<VoiceGroup {...make()} />);
    await waitFor(() => expect(screen.getByLabelText("Speech-to-text")).toBeInTheDocument());
    const stt = screen.getByLabelText("Speech-to-text") as HTMLSelectElement;
    const labels = Array.from(stt.options).map((o) => o.textContent);
    expect(labels).toContain("Off");
    expect(labels).toContain("Deepgram — personal");
    expect(labels).not.toContain("GitHub — personal");
    expect(labels).not.toContain("ElevenLabs — personal");
  });

  it("selecting an instance saves the full record", async () => {
    const props = make();
    render(<VoiceGroup {...props} />);
    await waitFor(() => expect(screen.getByLabelText("Speech-to-text")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Speech-to-text"), { target: { value: "dg1" } });
    await waitFor(() =>
      expect(props.saveVoice).toHaveBeenCalledWith({ stt: { instanceId: "dg1" }, tts: null, hideInactive: false }),
    );
  });

  it("empty capability list shows vendor-naming guidance", async () => {
    const props = make({ listConnectors: vi.fn(async () => [connectors[2]]) }); // only github connected
    render(<VoiceGroup {...props} />);
    await waitFor(() => expect(screen.getByText(/Connect a Deepgram key in Integrations first/)).toBeInTheDocument());
    expect(screen.getByText(/Connect an ElevenLabs key in Integrations first/)).toBeInTheDocument();
  });

  it("hide-inactive toggle persists", async () => {
    const props = make();
    render(<VoiceGroup {...props} />);
    await waitFor(() => expect(screen.getByLabelText("Hide inactive voice features")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Hide inactive voice features"));
    await waitFor(() =>
      expect(props.saveVoice).toHaveBeenCalledWith({ stt: null, tts: null, hideInactive: true }),
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/control-plane && npx vitest run src/organisms/settings/VoiceGroup.test.tsx`
Expected: FAIL — component missing

- [ ] **Step 3: Implement `VoiceGroup.tsx`** (follow ChannelsGroup's structure and class names — `settings-group`, `wizard__hint`, `wizard__error`; reuse its mount-once biome-ignore comment convention):

```tsx
// control-plane/src/organisms/settings/VoiceGroup.tsx
// Settings → Voice (spec §2): maps each voice capability to a connected
// connector instance. Key entry/verify lives in Integrations — this group
// deals strictly in instance ids and labels, never key material.
import { useEffect, useState } from "react";
import type { ConnectorInstanceRecord, ConnectorVendorMeta, VoiceSettingsRecord } from "../../hooks/useBrokerChat";

interface VoiceGroupProps {
  getVoice: () => Promise<VoiceSettingsRecord>;
  saveVoice: (body: {
    stt: { instanceId: string } | null;
    tts: { instanceId: string } | null;
    hideInactive: boolean;
  }) => Promise<VoiceSettingsRecord & { error?: string }>;
  listVendors: () => Promise<ConnectorVendorMeta[]>;
  listConnectors: () => Promise<ConnectorInstanceRecord[]>;
}

const SLOTS = [
  { slot: "stt" as const, label: "Speech-to-text", vendorHint: "a Deepgram" },
  { slot: "tts" as const, label: "Text-to-speech", vendorHint: "an ElevenLabs" },
];

export function VoiceGroup({ getVoice, saveVoice, listVendors, listConnectors }: VoiceGroupProps) {
  const [voice, setVoice] = useState<VoiceSettingsRecord | null>(null);
  const [vendors, setVendors] = useState<ConnectorVendorMeta[]>([]);
  const [connectors, setConnectors] = useState<ConnectorInstanceRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once load, same convention as IntegrationsGroup
  useEffect(() => {
    void Promise.all([getVoice(), listVendors(), listConnectors()]).then(([v, vs, cs]) => {
      setVoice(v);
      setVendors(vs);
      setConnectors(cs);
    });
  }, []);

  const save = async (next: VoiceSettingsRecord) => {
    setVoice(next);
    const res = await saveVoice({ stt: next.stt, tts: next.tts, hideInactive: next.hideInactive });
    if (res.error) setError(res.error);
    else setError(null);
  };

  if (!voice) return <p className="wizard__hint">Loading…</p>;

  const optionsFor = (slot: "stt" | "tts") => {
    const vendorIds = new Set(vendors.filter((v) => v.capabilities?.includes(slot)).map((v) => v.id));
    return connectors
      .filter((c) => vendorIds.has(c.vendorId))
      .map((c) => ({ id: c.id, label: `${vendors.find((v) => v.id === c.vendorId)?.label ?? c.vendorId} — ${c.label}` }));
  };

  return (
    <div className="settings-group">
      <h3>Voice</h3>
      <p className="wizard__hint">Pick which connected key powers each capability. Keys live in Integrations.</p>
      {SLOTS.map(({ slot, label, vendorHint }) => {
        const options = optionsFor(slot);
        return (
          <label key={slot} className="settings-group__row">
            {label}
            {options.length === 0 ? (
              <p className="wizard__hint">Connect {vendorHint} key in Integrations first.</p>
            ) : (
              <select
                aria-label={label}
                value={voice[slot]?.instanceId ?? ""}
                onChange={(e) =>
                  void save({ ...voice, [slot]: e.target.value ? { instanceId: e.target.value } : null })
                }
              >
                <option value="">Off</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
          </label>
        );
      })}
      <label className="settings-group__row">
        <input
          type="checkbox"
          aria-label="Hide inactive voice features"
          checked={voice.hideInactive}
          onChange={(e) => void save({ ...voice, hideInactive: e.target.checked })}
        />
        Hide inactive voice features
      </label>
      {error && <p className="wizard__error">{error}</p>}
    </div>
  );
}
```

Adapt markup/class names to whatever ChannelsGroup actually uses if `settings-group__row` doesn't exist — reuse its exact row classes rather than inventing new CSS.

- [ ] **Step 4: Register the group.** The nav became grouped SECTIONS (App/Agents/Workspace) in the api-keys merge — five coupled edits:

1. `SettingsPanel.tsx:19`: `export type SettingsGroupId = "general" | "integrations" | "voice" | "cli-tools" | "api-keys" | "channels" | "themes";`
2. `SECTIONS` (:60+): in the **Workspace** section's `groups` array, insert between the `integrations` and `channels` entries (spec §2 says "between Integrations and Channels" — both live in Workspace now, and Voice points at Integrations-held keys): `{ id: "voice", label: "Voice", icon: Mic },` with `Mic` added to the lucide-react import.
3. `SettingsPanelProps` (the interface holding `initialGroup` at :27): add the two optional fns `getVoiceSettings?`, `saveVoiceSettings?`, plus reuse of the existing vendors/connectors props already threaded for Integrations.
4. Body chain (the `{active === "x" && ...}` conditionals), with the guard-or-placeholder idiom:
```tsx
        {active === "voice" &&
          (getVoiceSettings && saveVoiceSettings && listVendors && listConnectors ? (
            <VoiceGroup
              getVoice={getVoiceSettings}
              saveVoice={saveVoiceSettings}
              listVendors={listVendors}
              listConnectors={listConnectors}
            />
          ) : (
            <p className="wizard__hint">Voice — not wired up yet.</p>
          ))}
```
(Use the actual prop names SettingsPanel already receives for vendors/connectors — the rename layer at :125-132 shows the local naming.)
5. `HomePage.tsx:226-248`: pass `getVoiceSettings={getVoiceSettings}` and `saveVoiceSettings={saveVoiceSettings}` from the `useBrokerChat` destructuring (:53-90 — add both names there too).

- [ ] **Step 5: Run and commit**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/control-plane && npx vitest run && npm run typecheck`
Expected: PASS (including existing SettingsPanel tests)

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add control-plane/src/organisms/settings/VoiceGroup.tsx control-plane/src/organisms/settings/VoiceGroup.test.tsx control-plane/src/organisms/SettingsPanel.tsx control-plane/src/pages/HomePage.tsx
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(control-plane): Settings → Voice group with capability pickers + hide toggle"
```

---

### Task 11: Mic gating, hide-inactive, delete-confirm warning

**Files:**
- Modify: `control-plane/src/molecules/Composer.tsx`, `control-plane/src/molecules/MicHero.tsx`, `control-plane/src/organisms/VoiceStage.tsx`, `control-plane/src/pages/HomePage.tsx`, `control-plane/src/organisms/settings/IntegrationsGroup.tsx`
- Test: extend `control-plane/src/organisms/settings/IntegrationsGroup.test.tsx` + a Composer test

**Interfaces:**
- Consumes: Task 9's `useVoiceStatus`, `getVoiceSettings`; Task 10's Voice group.
- Produces: `ComposerProps` gains `sttEnabled?: boolean` (default true) and `onVoiceBlocked?: () => void`; `MicHeroProps` gains the same pair; `IntegrationsGroupProps` gains `getVoice?: () => Promise<VoiceSettingsRecord>`.

- [ ] **Step 1: Write the failing Composer test** (create `control-plane/src/molecules/Composer.test.tsx` if none exists, in the house vitest style):

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

describe("Composer voice gating", () => {
  it("blocked hold-to-talk fires onVoiceBlocked instead of starting the mic", () => {
    const onMicToggle = vi.fn();
    const onVoiceBlocked = vi.fn();
    render(<Composer onSend={vi.fn()} onMicToggle={onMicToggle} sttEnabled={false} onVoiceBlocked={onVoiceBlocked} />);
    fireEvent.pointerDown(screen.getByLabelText("Hold to talk"));
    expect(onMicToggle).not.toHaveBeenCalled();
    expect(onVoiceBlocked).toHaveBeenCalled();
  });

  it("sttEnabled leaves the mic working", () => {
    const onMicToggle = vi.fn();
    render(<Composer onSend={vi.fn()} onMicToggle={onMicToggle} sttEnabled={true} />);
    fireEvent.pointerDown(screen.getByLabelText("Hold to talk"));
    expect(onMicToggle).toHaveBeenCalled();
  });
});
```

(Check the actual `aria-label` on the hold-to-talk button in Composer.tsx:91-115 and use it verbatim.)

- [ ] **Step 2: Run to verify failure, then implement Composer/MicHero gating.**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/control-plane && npx vitest run src/molecules/Composer.test.tsx`

Composer: add to props `sttEnabled?: boolean;` (default `true`) and `onVoiceBlocked?: () => void;`. In `startHold` (:27-32) and the always-listening toggle's `onClick`:

```ts
  const startHold = () => {
    if (!sttEnabled) {
      onVoiceBlocked?.();
      return;
    }
    if (micLive || holding || !onMicToggle) return;
    setHolding(true);
    onMicToggle();
  };
```

and on both mic buttons add `className={... + (sttEnabled ? "" : " is-voice-disabled")}` with CSS `.is-voice-disabled { opacity: 0.5; }` next to the composer styles. Same guard in `MicHero`'s `onClick`.

- [ ] **Step 3: Wire in HomePage/VoiceStage.**

In `HomePage.tsx`:
```tsx
  const { voice } = useVoiceStatus();
  const [voicePrefs, setVoicePrefs] = useState<VoiceSettingsRecord | null>(null);
  // load prefs on mount and again when Settings closes (hideInactive may have changed)
  useEffect(() => {
    if (!settingsOpen) void getVoiceSettings().then(setVoicePrefs).catch(() => setVoicePrefs(null));
  }, [settingsOpen, getVoiceSettings]);

  const hideMic = Boolean(voicePrefs?.hideInactive) && !voice.stt;
  const sttHint = "Add a Deepgram key in Settings → Integrations, then select it under Settings → Voice.";
  const onVoiceBlocked = () => {
    setLocalNotice(sttHint); // localNotice state defined below
  };
```

For the blocked-press notice, reuse the Task 9 notice path locally: `useBrokerChat` exposes `setMessages` internally only, so instead add a tiny local state near the Composer render: `const [localNotice, setLocalNotice] = useState<string | null>(null);` rendered as `<p className="transcript__notice">{localNotice}</p>` above the Composer, cleared by `setTimeout(() => setLocalNotice(null), 6000)` — follow whatever HomePage already does for transient hints if a pattern exists.

Thread the props: Composer gets `sttEnabled={voice.stt} onVoiceBlocked={onVoiceBlocked}`, and when `hideMic` is true pass `onMicToggle={undefined}` (Composer already renders no mic buttons without `onMicToggle`; MicHero needs an explicit `hidden` return in VoiceStage — pass `showMicHero={!hideMic}` down and return null accordingly).

- [ ] **Step 4: Delete-confirm warning in IntegrationsGroup.** Add optional prop `getVoice?: () => Promise<VoiceSettingsRecord>`. In the delete handler (find `deleteConnector(` in IntegrationsGroup.tsx), before deleting:

```ts
    if (getVoice) {
      const v = await getVoice().catch(() => null);
      const uses = [v?.stt?.instanceId === id && "speech-to-text", v?.tts?.instanceId === id && "text-to-speech"].filter(Boolean);
      if (uses.length > 0 && !window.confirm(`Deleting this key also turns off ${uses.join(" and ")}. Continue?`)) return;
    }
```

If the group already confirms deletes, merge this copy into the existing confirm instead of stacking two dialogs. Pass `getVoice={getVoiceSettings}` through SettingsPanel → IntegrationsGroup (optional prop, same pattern as Task 10 Step 4.3). Extend `IntegrationsGroup.test.tsx` with one test: deleting an instance referenced by voice shows the confirm (stub `window.confirm` with `vi.spyOn(window, "confirm")`).

- [ ] **Step 5: Run everything and commit**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/control-plane && npx vitest run && npm run typecheck`
Expected: PASS

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add control-plane/src/molecules/Composer.tsx control-plane/src/molecules/Composer.test.tsx control-plane/src/molecules/MicHero.tsx control-plane/src/organisms/VoiceStage.tsx control-plane/src/pages/HomePage.tsx control-plane/src/organisms/settings/IntegrationsGroup.tsx control-plane/src/organisms/settings/IntegrationsGroup.test.tsx control-plane/src/styles/components.css
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(control-plane): mic gating with pointer hints, hide-inactive, delete warning"
```

---

### Task 12: Docs hard cut + full verification

**Files:**
- Modify: `.env.example`, `README.md`, `docs/MANUAL-TESTING.md`

- [ ] **Step 1: `.env.example`** — delete line 12 (`DEEPGRAM_API_KEY=`) and line 29 (`ELEVENLABS_API_KEY=`); keep `#DEEPGRAM_LANGUAGE=multi` (line 16 — config, not a credential). Where line 12 was, add:

```
# Voice keys (Deepgram STT, ElevenLabs TTS) are no longer env vars — add them
# in Settings → Integrations and select them under Settings → Voice.
```

- [ ] **Step 2: `README.md:88-89`** — replace the two key lines with:

```
# Voice (STT/TTS): no env vars — paste your Deepgram + ElevenLabs keys in
# Settings → Integrations, then pick them under Settings → Voice.
```

- [ ] **Step 3: `docs/MANUAL-TESTING.md`** — add a "Voice provider settings" section at the end covering, as manual checks:
  - Fresh boot with no keys anywhere: broker starts; hold-to-talk press shows the Deepgram pointer notice; agent replies are text-only with the one-time TTS hint.
  - Paste a Deepgram key in Integrations → Test connection → select under Voice → within ~20s hold-to-talk works, no broker restart.
  - Same for ElevenLabs → agents speak.
  - Delete the selected Deepgram connector → confirm dialog mentions speech-to-text; mic goes inactive again.
  - "Hide inactive voice features" on → mic controls disappear instead of graying.
  - **Upgrade callout (spec §6):** the live rig (tmux `smith-broker`) loses voice on upgrade — `.env` voice keys are ignored now, deliberately. Paste both keys into Settings to restore. Also note: existing user files are encrypted at first swarm boot (`sweepEncryptUsers`), and `~/.smith/master.key` now exists — deleting it orphans saved secrets (re-enter keys in Settings to heal).

- [ ] **Step 4: Full verification across all three packages**

Run:
```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/swarm && npm test && npm run typecheck
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/broker && npm test && npm run typecheck
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/control-plane && npx vitest run && npm run typecheck
```
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add .env.example README.md docs/MANUAL-TESTING.md
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "docs: voice keys move from .env to Settings — hard cut + manual test section"
```
