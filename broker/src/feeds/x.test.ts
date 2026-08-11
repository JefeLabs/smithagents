import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchX, parsePosts } from './x.ts';
import type { FeedSource, FeedState } from './types.ts';

const SOURCE: FeedSource = {
  id: 'x1',
  label: '@dr1com',
  kind: 'x',
  locator: 'dr1com',
  tag: 'news',
  origin: 'manual',
  enabled: true,
};

const EMPTY: FeedState = { sources: {}, xUsage: {}, candidates: {}, seenVersions: {} };
const NOW = '2026-08-11T10:00:00Z';

test('parses posts into items', () => {
  const items = parsePosts(SOURCE, {
    data: [{ id: '1', text: 'Something happened in Santo Domingo', created_at: '2026-08-11T09:00:00Z' }],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0]!.title, 'Something happened in Santo Domingo');
  assert.equal(items[0]!.tag, 'news');
  assert.equal(items[0]!.url, 'https://x.com/dr1com/status/1');
});

test('with no key the adapter is inert with a REASON, never an error', async () => {
  const result = await fetchX(
    { fetchJson: async () => assert.fail('must not fetch'), token: null, cap: 100, now: () => NOW },
    SOURCE,
    EMPTY,
  );
  assert.deepEqual(result.items, []);
  assert.match(result.skipped!, /no api key/i);
});

test("a fetch counts against the month's budget", async () => {
  const result = await fetchX(
    { fetchJson: async () => ({ data: [] }), token: 't', cap: 100, now: () => NOW },
    SOURCE,
    EMPTY,
  );
  assert.equal(result.usage, 1);
});

test('at the cap it stops fetching and says so — the only hard money stop', async () => {
  const spent: FeedState = { ...EMPTY, xUsage: { '2026-08': 100 } };
  const result = await fetchX(
    { fetchJson: async () => assert.fail('must not fetch past the cap'), token: 't', cap: 100, now: () => NOW },
    SOURCE,
    spent,
  );
  assert.deepEqual(result.items, []);
  assert.match(result.skipped!, /budget/i);
});

test('a new calendar month restores the budget', async () => {
  const spent: FeedState = { ...EMPTY, xUsage: { '2026-07': 100 } };
  const result = await fetchX(
    { fetchJson: async () => ({ data: [] }), token: 't', cap: 100, now: () => NOW },
    SOURCE,
    spent,
  );
  assert.equal(result.usage, 1);
  assert.equal(result.skipped, undefined);
});

test('a 429 is reported, not thrown, and does not burn budget', async () => {
  const result = await fetchX(
    {
      fetchJson: async () => {
        throw new Error('429 Too Many Requests');
      },
      token: 't',
      cap: 100,
      now: () => NOW,
    },
    SOURCE,
    EMPTY,
  );
  assert.deepEqual(result.items, []);
  assert.match(result.skipped!, /429/);
});
