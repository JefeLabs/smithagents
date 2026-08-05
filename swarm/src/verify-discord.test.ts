import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyDiscordToken } from './verify-discord.js';

test('verifyDiscordToken: ok on 200 from /users/@me, sends Bot auth', async () => {
  const f = (async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), 'https://discord.com/api/v10/users/@me');
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bot disc-tok');
    return new Response(JSON.stringify({ username: 'smithagents-crew', id: '123' }), { status: 200 });
  }) as typeof fetch;
  const r = await verifyDiscordToken('disc-tok', f);
  assert.equal(r.ok, true);
  assert.match(r.detail, /smithagents-crew/);
});

test('verifyDiscordToken: not ok on 401, detail carries the reason', async () => {
  const f = (async () => new Response(JSON.stringify({ message: '401: Unauthorized' }), { status: 401 })) as typeof fetch;
  const r = await verifyDiscordToken('bad-tok', f);
  assert.equal(r.ok, false);
  assert.match(r.detail, /401/);
});

test('verifyDiscordToken: network failure resolves {ok:false}, never rejects', async () => {
  const f = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  const r = await verifyDiscordToken('any-tok', f);
  assert.equal(r.ok, false);
  assert.match(r.detail, /fetch failed/);
});
