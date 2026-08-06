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
