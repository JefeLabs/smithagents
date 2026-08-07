import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildApiKeyListings,
  emptyApiKeysFile,
  findProvider,
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
