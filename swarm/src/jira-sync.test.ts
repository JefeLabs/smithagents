import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addCard, createBoard } from './work-items.js';
import { importIssues, searchIssues, transitionIssue } from './jira-sync.js';

const fetchStub = (routes: Array<{ match: RegExp; status?: number; body: unknown; capture?: (url: string, init?: RequestInit) => void }>) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const r = routes.find((x) => x.match.test(u));
    if (!r) throw new Error(`unexpected fetch: ${u}`);
    r.capture?.(u, init);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, statusText: 'x', json: async () => r.body } as Response;
  }) as typeof fetch;

test('searchIssues: jql query, basic auth, maps key/summary/url; non-ok throws', async () => {
  let seenAuth = '';
  const f = fetchStub([{
    match: /\/rest\/api\/3\/search/,
    body: { issues: [{ key: 'PROJ-1', fields: { summary: 'Fix login' } }, { key: 'PROJ-2', fields: { summary: 'Add SSO' } }] },
    capture: (u, init) => { seenAuth = String((init?.headers as Record<string, string>)?.authorization); assert.match(u, /jql=project%20%3D%20PROJ/); },
  }]);
  const issues = await searchIssues('https://acme.atlassian.net/', 'e@x.com', 'tok', 'project = PROJ', f);
  assert.deepEqual(issues, [
    { key: 'PROJ-1', summary: 'Fix login', url: 'https://acme.atlassian.net/browse/PROJ-1' },
    { key: 'PROJ-2', summary: 'Add SSO', url: 'https://acme.atlassian.net/browse/PROJ-2' },
  ]);
  assert.match(seenAuth, /^Basic /);
  const bad = fetchStub([{ match: /search/, status: 401, body: { message: 'nope' } }]);
  await assert.rejects(searchIssues('https://a.net', 'e', 't', 'x', bad), /401/);
});

test('importIssues: creates unseen keys in the leftmost column, updates titles of known keys, idempotent', () => {
  const b = createBoard('t', 'personal');
  const existing = addCard(b, { title: 'old title', columnId: b.columns[3].id });
  existing.jira = { key: 'PROJ-1', url: 'https://a/browse/PROJ-1' };
  const issues = [
    { key: 'PROJ-1', summary: 'new title', url: 'https://a/browse/PROJ-1' },
    { key: 'PROJ-9', summary: 'brand new', url: 'https://a/browse/PROJ-9' },
  ];
  const r1 = importIssues(b, issues);
  assert.deepEqual(r1, { created: 1, updated: 1 });
  assert.equal(b.cards.find((c) => c.jira?.key === 'PROJ-1')?.title, 'new title');
  const created = b.cards.find((c) => c.jira?.key === 'PROJ-9');
  assert.equal(created?.columnId, b.columns[0].id);
  const r2 = importIssues(b, issues);
  assert.deepEqual(r2, { created: 0, updated: 2 });
  assert.equal(b.cards.filter((c) => c.jira?.key === 'PROJ-9').length, 1);
  assert.equal(b.cards.find((c) => c.jira?.key === 'PROJ-1')?.columnId, b.columns[3].id); // import never moves
});

test('transitionIssue: finds the transition by target status name (case-insensitive) and POSTs it; missing → throws', async () => {
  let posted = '';
  const f = fetchStub([
    { match: /\/transitions$/, body: { transitions: [{ id: '31', to: { name: 'In Review' } }, { id: '41', to: { name: 'Done' } }] },
      capture: (u, init) => { if (init?.method === 'POST') posted = String(init.body); } },
  ]);
  await transitionIssue('https://a.net', 'e', 't', 'PROJ-1', 'in review', f);
  assert.match(posted, /"id":"31"/);
  await assert.rejects(transitionIssue('https://a.net', 'e', 't', 'PROJ-1', 'Blocked', f), /no transition to "Blocked"/i);
});
