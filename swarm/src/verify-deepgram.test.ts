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
