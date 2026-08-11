import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDigest } from './digest.ts';
import type { FeedItem } from './types.ts';

const NOW = '2026-08-11T12:00:00Z';
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();

const news = (id: string, title: string, hours = 2): FeedItem => ({
  id,
  sourceId: 'n',
  tag: 'news',
  title,
  publishedAt: hoursAgo(hours),
  summary: '',
});

const release = (id: string, name: string, version: string, spoken?: string): FeedItem => ({
  id,
  sourceId: 'r',
  tag: 'release',
  title: `${name} ${version}`,
  publishedAt: hoursAgo(4),
  summary: '',
  release: { name, version, bump: 'minor', security: false },
  spokenAt: spoken,
});

test('an empty store yields an EMPTY digest — a fresh install pays no token tax', () => {
  assert.deepEqual(buildDigest({ items: [], owners: {}, now: NOW }), { text: '', unspokenIds: [] });
});

test('the weather leads', () => {
  const { text } = buildDigest({ items: [], weather: '29°C, clear.', owners: {}, now: NOW });
  assert.match(text, /TODAY .*29°C, clear\./);
});

test('unspoken releases outrank headlines and are reported for stamping', () => {
  const { text, unspokenIds } = buildDigest({
    items: [news('n1', 'Something happened'), release('r1', 'spring-boot', '4.1.0')],
    owners: { 'spring-boot': 'Osvaldo' },
    now: NOW,
  });
  assert.ok(text.indexOf('spring-boot 4.1.0') < text.indexOf('Something happened'));
  assert.deepEqual(unspokenIds, ['r1']);
});

test('an already-spoken release is not repeated', () => {
  const { text, unspokenIds } = buildDigest({
    items: [release('r1', 'spring-boot', '4.1.0', '2026-08-10T09:00:00Z')],
    owners: {},
    now: NOW,
  });
  assert.equal(text.includes('spring-boot'), false);
  assert.deepEqual(unspokenIds, []);
});

test('a release names its owner so the line can be spoken in that voice', () => {
  const { text } = buildDigest({
    items: [release('r1', 'spring-boot', '4.1.0')],
    owners: { 'spring-boot': 'Osvaldo' },
    now: NOW,
  });
  assert.match(text, /\[Osvaldo\]/);
});

test('items older than 48 hours are not in the digest — they live in the tool', () => {
  const { text } = buildDigest({ items: [news('n1', 'Ancient news', 72)], owners: {}, now: NOW });
  assert.equal(text.includes('Ancient news'), false);
});

test('the digest stays under the 150-token ceiling however much arrives', () => {
  const many = Array.from({ length: 60 }, (_, i) => news(`n${i}`, `Headline number ${i} with a fairly long title`));
  const { text } = buildDigest({ items: many, weather: '29°C, clear.', owners: {}, now: NOW });
  // ~4 chars per token is the standard rough estimate; 150 tokens ≈ 600 chars.
  assert.ok(text.length <= 600, `digest was ${text.length} chars`);
});
