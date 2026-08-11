import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffBundle } from './rediscover.ts';
import type { Candidate, Topic } from './topics.ts';
import type { FeedSource } from './types.ts';

const NOW = '2026-08-11T00:00:00Z';
const blog: Candidate = { kind: 'site', url: 'https://spring.io/blog.atom', label: 'blog', evidence: 'e' };
const tube: Candidate = { kind: 'youtube', url: 'https://www.youtube.com/channel/UC1', label: 'chan', evidence: 'e' };

const topic: Topic = { id: 'spring-boot', name: 'Spring Boot', status: 'active', candidates: [], declined: [] };
const approvedBlog: FeedSource = {
  id: 'topic:spring-boot:site:https://spring.io/blog.atom',
  label: 'blog', kind: 'rss', locator: 'https://spring.io/blog.atom',
  tag: 'tech', origin: 'derived', enabled: true, topicId: 'spring-boot',
};

test('a candidate never seen before is an addition', () => {
  const { additions } = diffBundle({ topic, fresh: [blog, tube], approved: [approvedBlog], now: NOW });
  assert.deepEqual(additions.map((c) => c.label), ['chan']);
});

test('a DECLINED candidate is skipped silently, however often it reappears', () => {
  const declined = { ...topic, declined: [tube.url] };
  const { additions } = diffBundle({ topic: declined, fresh: [blog, tube], approved: [approvedBlog], now: NOW });
  assert.deepEqual(additions, []);
});

test('an approved source missing from the fresh bundle is FLAGGED, never removed', () => {
  const { flagged } = diffBundle({ topic, fresh: [], approved: [approvedBlog], now: NOW });
  assert.deepEqual(flagged, [approvedBlog.id]);
});

test('a source whose newest activity is over 180 days old is flagged as quiet', () => {
  const stale: Candidate = { ...blog, lastActivity: '2026-01-01T00:00:00Z' };
  const { flagged } = diffBundle({ topic, fresh: [stale], approved: [approvedBlog], now: NOW });
  assert.deepEqual(flagged, [approvedBlog.id]);
});

test('a quiet-but-alive source inside 180 days is NOT flagged', () => {
  const recent: Candidate = { ...blog, lastActivity: '2026-06-01T00:00:00Z' };
  const { flagged } = diffBundle({ topic, fresh: [recent], approved: [approvedBlog], now: NOW });
  assert.deepEqual(flagged, []);
});

test('re-discovery never returns anything that activates a source by itself', () => {
  const { additions } = diffBundle({ topic, fresh: [tube], approved: [approvedBlog], now: NOW });
  assert.equal('enabled' in (additions[0] as object), false);
});
