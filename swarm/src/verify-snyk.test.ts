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
