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
