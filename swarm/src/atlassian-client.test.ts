import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupTicket, searchDocs } from './atlassian-client.js';

test('lookupTicket: ok returns key/summary/status/url', async () => {
  const f = (async (url: unknown) => {
    assert.equal(String(url), 'https://acme.atlassian.net/rest/api/3/issue/PROJ-123?fields=summary,status');
    return new Response(JSON.stringify({ key: 'PROJ-123', fields: { summary: 'Fix the thing', status: { name: 'In Progress' } } }), {
      status: 200,
    });
  }) as typeof fetch;
  const r = await lookupTicket('https://acme.atlassian.net', 'e@acme.com', 'tok', 'PROJ-123', f);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ticket, {
    key: 'PROJ-123',
    summary: 'Fix the thing',
    status: 'In Progress',
    url: 'https://acme.atlassian.net/browse/PROJ-123',
  });
});

test('lookupTicket: not found surfaces a readable detail', async () => {
  const f = (async () => new Response(JSON.stringify({ errorMessages: ['Issue does not exist'] }), { status: 404 })) as typeof fetch;
  const r = await lookupTicket('https://acme.atlassian.net', 'e@acme.com', 'tok', 'NOPE-1', f);
  assert.equal(r.ok, false);
  assert.match(r.detail ?? '', /404|does not exist/);
});

test('searchDocs: scopes CQL to configured space keys and returns title/url pairs', async () => {
  const f = (async (url: unknown) => {
    assert.match(String(url), /cql=.*space%20in%20.*DOCS/);
    return new Response(
      JSON.stringify({ results: [{ title: 'Onboarding', _links: { webui: '/spaces/DOCS/pages/1/Onboarding' } }] }),
      { status: 200 },
    );
  }) as typeof fetch;
  const r = await searchDocs('https://acme.atlassian.net', 'e@acme.com', 'tok', 'onboarding', { spaceKeys: ['DOCS'] }, f);
  assert.equal(r.ok, true);
  assert.deepEqual(r.docs, [{ title: 'Onboarding', excerpt: '', url: 'https://acme.atlassian.net/wiki/spaces/DOCS/pages/1/Onboarding' }]);
});

test('lookupTicket: a network failure resolves to {ok:false, detail}, never rejects', async () => {
  const f = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  const r = await lookupTicket('https://acme.atlassian.net', 'e@acme.com', 'tok', 'PROJ-123', f);
  assert.equal(r.ok, false);
  assert.match(r.detail ?? '', /fetch failed/);
});

test('searchDocs: a network failure resolves to {ok:false, detail}, never rejects', async () => {
  const f = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  const r = await searchDocs('https://acme.atlassian.net', 'e@acme.com', 'tok', 'onboarding', undefined, f);
  assert.equal(r.ok, false);
  assert.match(r.detail ?? '', /fetch failed/);
});
