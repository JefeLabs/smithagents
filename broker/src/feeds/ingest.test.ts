import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CADENCE_MS, dueSources, recordOutcome, isDisabled } from './ingest.ts';
import type { FeedSource, FeedState } from './types.ts';

const NOW = Date.parse('2026-08-11T12:00:00Z');
const rss: FeedSource = {
  id: 's1',
  label: 'a',
  kind: 'rss',
  locator: 'u',
  tag: 'news',
  origin: 'manual',
  enabled: true,
};
const EMPTY: FeedState = { sources: {}, xUsage: {}, candidates: {}, seenVersions: {}, pendingDiscoveries: {} };

test('a never-fetched source is due', () => {
  assert.deepEqual(
    dueSources([rss], EMPTY, NOW).map((s) => s.id),
    ['s1'],
  );
});

test('a source fetched inside its cadence is not due', () => {
  const state: FeedState = {
    ...EMPTY,
    sources: { s1: { lastFetchedAt: new Date(NOW - 60_000).toISOString(), consecutiveFailures: 0 } },
  };
  assert.deepEqual(dueSources([rss], state, NOW), []);
});

test('each kind keeps its own cadence, X the slowest of the polled ones', () => {
  assert.equal(CADENCE_MS.rss, 20 * 60_000);
  assert.equal(CADENCE_MS.weather, 30 * 60_000);
  assert.equal(CADENCE_MS.x, 30 * 60_000);
  assert.equal(CADENCE_MS.registry, 60 * 60_000);
});

test('a disabled or dismissed source is never due', () => {
  assert.deepEqual(dueSources([{ ...rss, enabled: false }], EMPTY, NOW), []);
  assert.deepEqual(dueSources([{ ...rss, dismissed: true }], EMPTY, NOW), []);
});

test('failures accumulate and the fifth disables the source with its reason', () => {
  let state = EMPTY;
  for (let i = 0; i < 4; i++) {
    state = recordOutcome(state, 's1', { ok: false, at: '2026-08-11T12:00:00Z', error: 'ENOTFOUND' });
  }
  assert.equal(isDisabled(state, 's1'), false, 'four is not yet fatal');
  state = recordOutcome(state, 's1', { ok: false, at: '2026-08-11T12:00:00Z', error: 'ENOTFOUND' });
  assert.equal(isDisabled(state, 's1'), true);
  assert.equal(state.sources.s1!.lastError, 'ENOTFOUND');
});

test('one success clears the failure streak', () => {
  let state = recordOutcome(EMPTY, 's1', { ok: false, at: '2026-08-11T12:00:00Z', error: 'x' });
  state = recordOutcome(state, 's1', { ok: true, at: '2026-08-11T12:20:00Z' });
  assert.equal(state.sources.s1!.consecutiveFailures, 0);
  assert.equal(state.sources.s1!.lastError, undefined);
});

test('a disabled source stops being due — silent decay is not allowed to keep costing fetches', () => {
  let state = EMPTY;
  for (let i = 0; i < 5; i++) state = recordOutcome(state, 's1', { ok: false, at: '2026-08-11T12:00:00Z', error: 'x' });
  assert.deepEqual(dueSources([rss], state, NOW + 86_400_000), []);
});
