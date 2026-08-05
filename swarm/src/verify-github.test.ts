import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyGithubToken, verifyGithubRepo } from './verify-github.js';

test('verifyGithubToken: ok on 200 from /user', async () => {
  const f = (async (url: unknown) => {
    assert.equal(String(url), 'https://api.github.com/user');
    return new Response(JSON.stringify({ login: 'edwincruz' }), { status: 200 });
  }) as typeof fetch;
  const r = await verifyGithubToken('ghp_tok', f);
  assert.equal(r.ok, true);
  assert.match(r.detail, /edwincruz/);
});

test('verifyGithubRepo: not ok on 404, checks the specific repo path', async () => {
  const f = (async (url: unknown) => {
    assert.equal(String(url), 'https://api.github.com/repos/acme/web');
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  }) as typeof fetch;
  const r = await verifyGithubRepo('acme', 'web', 'ghp_tok', f);
  assert.equal(r.ok, false);
  assert.match(r.detail, /404|Not Found/);
});
