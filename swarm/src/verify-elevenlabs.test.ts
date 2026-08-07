import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyElevenlabs } from './verify-elevenlabs.js';

test('verifyElevenlabs: ok on 200 from /v1/voices, sends xi-api-key header', async () => {
  const f = (async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), 'https://api.elevenlabs.io/v1/voices');
    assert.equal((init?.headers as Record<string, string>)['xi-api-key'], 'el-key');
    return new Response(JSON.stringify({ voices: [{ voice_id: 'a' }, { voice_id: 'b' }] }), { status: 200 });
  }) as typeof fetch;
  const r = await verifyElevenlabs('el-key', f);
  assert.equal(r.ok, true);
  assert.match(r.detail, /2 voices/);
});

test('verifyElevenlabs: not ok on 401, surfaces upstream permission message', async () => {
  const f = (async () =>
    new Response(JSON.stringify({ detail: { message: 'The API key you used is missing the permission voices_read to execute this operation.' } }), {
      status: 401,
    })) as typeof fetch;
  const r = await verifyElevenlabs('bad', f);
  assert.equal(r.ok, false);
  assert.match(r.detail, /401/);
  assert.match(r.detail, /voices_read/);
});

test('verifyElevenlabs: network failure resolves {ok:false}, never rejects', async () => {
  const f = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  const r = await verifyElevenlabs('el-key', f);
  assert.equal(r.ok, false);
  assert.match(r.detail, /fetch failed/);
});
