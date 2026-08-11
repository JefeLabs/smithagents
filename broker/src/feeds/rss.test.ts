import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFeed, youtubeFeedUrl } from './rss.ts';
import type { FeedSource } from './types.ts';

const SOURCE: FeedSource = {
  id: 's1',
  label: 'Test',
  kind: 'rss',
  locator: 'https://example.test/rss',
  tag: 'tech',
  origin: 'manual',
  enabled: true,
};

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>Example</title>
  <item>
    <title>Spring Boot 4.1.0 released</title>
    <link>https://example.test/a</link>
    <guid>tag:a</guid>
    <pubDate>Mon, 10 Aug 2026 12:00:00 GMT</pubDate>
    <description>&lt;p&gt;Virtual threads by default.&lt;/p&gt;</description>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
  <title>Releases</title>
  <entry>
    <title>v4.1.0</title>
    <link href="https://github.test/r/releases/v4.1.0"/>
    <id>tag:gh,2026:4.1.0</id>
    <updated>2026-08-10T12:00:00Z</updated>
    <content type="html">Fixes CVE-2026-1234 in the actuator.</content>
  </entry>
</feed>`;

test('parses RSS 2.0 items', () => {
  const items = parseFeed(SOURCE, RSS);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.title, 'Spring Boot 4.1.0 released');
  assert.equal(items[0]!.url, 'https://example.test/a');
  assert.equal(items[0]!.tag, 'tech');
  assert.equal(new Date(items[0]!.publishedAt).toISOString(), '2026-08-10T12:00:00.000Z');
});

test('parses Atom entries', () => {
  const items = parseFeed({ ...SOURCE, tag: 'release' }, ATOM);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.title, 'v4.1.0');
  assert.equal(items[0]!.url, 'https://github.test/r/releases/v4.1.0');
});

test('strips HTML and entities from summaries, and trims to 400 chars', () => {
  const items = parseFeed(SOURCE, RSS);
  assert.equal(items[0]!.summary, 'Virtual threads by default.');
  const long = RSS.replace('&lt;p&gt;Virtual threads by default.&lt;/p&gt;', 'x'.repeat(900));
  assert.equal(parseFeed(SOURCE, long)[0]!.summary.length, 400);
});

test('item ids are stable per source+guid, so re-fetching never duplicates', () => {
  assert.equal(parseFeed(SOURCE, RSS)[0]!.id, parseFeed(SOURCE, RSS)[0]!.id);
  assert.notEqual(parseFeed(SOURCE, RSS)[0]!.id, parseFeed({ ...SOURCE, id: 's2' }, RSS)[0]!.id);
});

test('an entry with no date falls back to now rather than being dropped', () => {
  const noDate = RSS.replace(/<pubDate>.*<\/pubDate>/, '');
  const items = parseFeed(SOURCE, noDate);
  assert.equal(items.length, 1);
  assert.ok(!Number.isNaN(Date.parse(items[0]!.publishedAt)));
});

test('malformed XML yields what parsed rather than throwing', () => {
  assert.deepEqual(parseFeed(SOURCE, '<rss><channel><item><title>unclosed'), []);
  assert.deepEqual(parseFeed(SOURCE, ''), []);
});

test('a YouTube channel URL converts to its feed URL — no API key needed', () => {
  assert.equal(
    youtubeFeedUrl('https://www.youtube.com/channel/UC123abc'),
    'https://www.youtube.com/feeds/videos.xml?channel_id=UC123abc',
  );
  assert.equal(youtubeFeedUrl('https://example.test/rss'), null);
});
