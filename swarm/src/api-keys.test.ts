import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type ApiKeysFile,
  buildApiKeyListings,
  deleteKey,
  emptyApiKeysFile,
  findProvider,
  getCredential,
  last4,
  loadApiKeysFile,
  saveAndVerifyKey,
  saveApiKeysFile,
  verifyStoredKey,
} from "./api-keys.js";

const entry = (over: Partial<ApiKeysFile["providers"][string]> = {}) => ({
  key: "sk-test-abcd1234",
  verified: true as const,
  detail: "key accepted",
  lastCheckedAt: "2026-08-06T00:00:00.000Z",
  ...over,
});

test("load: missing file -> empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "apikeys-"));
  assert.deepEqual(await loadApiKeysFile(join(dir, "nope.json")), emptyApiKeysFile());
});

test("load: corrupt file -> empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "apikeys-"));
  const p = join(dir, "api-keys.json");
  await writeFile(p, "{not json");
  assert.deepEqual(await loadApiKeysFile(p), emptyApiKeysFile());
});

test("save: round-trips and is 0600", async () => {
  const dir = await mkdtemp(join(tmpdir(), "apikeys-"));
  const p = join(dir, "sub", "api-keys.json");
  const file: ApiKeysFile = { version: 1, providers: { google: entry() } };
  await saveApiKeysFile(p, file);
  assert.deepEqual(await loadApiKeysFile(p), file);
  assert.equal((await stat(p)).mode & 0o777, 0o600);
});

test("last4", () => {
  assert.equal(last4("sk-test-abcd1234"), "1234");
});

test("listings: every provider present, raw key never serialized", () => {
  const listings = buildApiKeyListings({ version: 1, providers: { google: entry() } });
  assert.ok(listings.length >= 3); // anthropic, openai, google
  const google = listings.find((l) => l.id === "google");
  assert.deepEqual(google, {
    id: "google",
    label: "Google",
    description: google?.description,
    hasKey: true,
    last4: "1234",
    verified: true,
    detail: "key accepted",
    lastCheckedAt: "2026-08-06T00:00:00.000Z",
  });
  const keyless = listings.find((l) => l.id === "anthropic");
  assert.deepEqual(keyless && { hasKey: keyless.hasKey, last4: keyless.last4, verified: keyless.verified }, {
    hasKey: false,
    last4: null,
    verified: null,
  });
  assert.ok(!JSON.stringify(listings).includes("sk-test-abcd1234"));
});

type FetchStub = typeof fetch;
const okFetch = (): FetchStub => (async () => new Response("{}", { status: 200 })) as unknown as FetchStub;
const statusFetch = (status: number): FetchStub => (async () => new Response("{}", { status })) as unknown as FetchStub;
const downFetch = (): FetchStub =>
  (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as FetchStub;

test("probe mapping: 2xx true, 401/403 false, 5xx/network unknown", async () => {
  const p = findProvider("anthropic")!;
  assert.equal((await p.verify("k", okFetch())).ok, true);
  assert.equal((await p.verify("k", statusFetch(401))).ok, false);
  assert.equal((await p.verify("k", statusFetch(403))).ok, false);
  assert.equal((await p.verify("k", statusFetch(500))).ok, "unknown");
  assert.equal((await p.verify("k", statusFetch(429))).ok, "unknown");
  assert.equal((await p.verify("k", downFetch())).ok, "unknown");
});

test("probe request shapes: header auth, key never in URL", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const spy: FetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response("{}", { status: 200 });
  }) as unknown as FetchStub;

  await findProvider("anthropic")!.verify("KEY_A", spy);
  await findProvider("openai")!.verify("KEY_B", spy);
  await findProvider("google")!.verify("KEY_C", spy);

  assert.equal(calls[0]!.url, "https://api.anthropic.com/v1/models");
  assert.equal(calls[0]!.headers["x-api-key"], "KEY_A");
  assert.equal(calls[0]!.headers["anthropic-version"], "2023-06-01");
  assert.equal(calls[1]!.url, "https://api.openai.com/v1/models");
  assert.equal(calls[1]!.headers.authorization, "Bearer KEY_B");
  assert.equal(calls[2]!.url, "https://generativelanguage.googleapis.com/v1beta/models");
  assert.equal(calls[2]!.headers["x-goog-api-key"], "KEY_C");
  for (const c of calls) assert.ok(!c.url.includes("KEY_"), "key must never appear in a URL");
});

const NOW = () => "2026-08-06T12:00:00.000Z";

test("saveAndVerifyKey: 404 unknown provider, 400 blank key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "apikeys-"));
  const p = join(dir, "api-keys.json");
  assert.deepEqual(await saveAndVerifyKey(p, "nope", "k", okFetch(), NOW), {
    error: "unknown provider: nope",
    status: 404,
  });
  assert.deepEqual(await saveAndVerifyKey(p, "google", "   ", okFetch(), NOW), {
    error: "key must not be blank",
    status: 400,
  });
});

test("saveAndVerifyKey: persists trimmed key + probe outcome, returns listings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "apikeys-"));
  const p = join(dir, "api-keys.json");
  const r = await saveAndVerifyKey(p, "google", "  sk-live-9876  ", statusFetch(401), NOW);
  assert.ok("listings" in r);
  const g = r.listings.find((l) => l.id === "google")!;
  assert.deepEqual(
    { hasKey: g.hasKey, last4: g.last4, verified: g.verified },
    { hasKey: true, last4: "9876", verified: false },
  );
  const stored = (await loadApiKeysFile(p)).providers.google!;
  assert.equal(stored.key, "sk-live-9876");
  assert.equal(stored.lastCheckedAt, NOW());
});

test("verifyStoredKey: 409 without key, re-probes with stored key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "apikeys-"));
  const p = join(dir, "api-keys.json");
  assert.deepEqual(await verifyStoredKey(p, "google", okFetch(), NOW), {
    error: "no key stored for google",
    status: 409,
  });
  await saveAndVerifyKey(p, "google", "sk-live-9876", downFetch(), NOW); // saved as 'unknown'
  const r = await verifyStoredKey(p, "google", okFetch(), NOW);
  assert.ok("listings" in r && r.listings.find((l) => l.id === "google")!.verified === true);
});

test("deleteKey: removes, idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "apikeys-"));
  const p = join(dir, "api-keys.json");
  await saveAndVerifyKey(p, "google", "sk-live-9876", okFetch(), NOW);
  const r1 = await deleteKey(p, "google");
  assert.ok("listings" in r1 && r1.listings.find((l) => l.id === "google")!.hasKey === false);
  const r2 = await deleteKey(p, "google"); // absent -> still ok
  assert.ok("listings" in r2);
  assert.deepEqual(await deleteKey(p, "nope"), { error: "unknown provider: nope", status: 404 });
});

test("getCredential: raw key for broker hop; 404 when absent/unknown provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "apikeys-"));
  const p = join(dir, "api-keys.json");
  assert.deepEqual(await getCredential(p, "google"), { error: "no key stored for google", status: 404 });
  assert.deepEqual(await getCredential(p, "nope"), { error: "unknown provider: nope", status: 404 });
  await saveAndVerifyKey(p, "google", "sk-live-9876", okFetch(), NOW);
  assert.deepEqual(await getCredential(p, "google"), { key: "sk-live-9876" });
});

test("getCredential: withholds a key that failed verification (confirmed negative)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "apikeys-"));
  const p = join(dir, "api-keys.json");
  await saveAndVerifyKey(p, "google", "sk-live-9876", statusFetch(401), NOW); // stores verified:false
  assert.deepEqual(await getCredential(p, "google"), {
    error: "stored key for google failed verification",
    status: 404,
  });
});

test("getCredential: still serves a key whose last probe was unconfirmed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "apikeys-"));
  const p = join(dir, "api-keys.json");
  await saveAndVerifyKey(p, "google", "sk-live-9876", downFetch(), NOW); // stores verified:'unknown'
  assert.deepEqual(await getCredential(p, "google"), { key: "sk-live-9876" });
});
