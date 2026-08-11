import assert from 'node:assert/strict';
import { test } from 'node:test';
import { versionFromTitle, latestFromAtom } from './atom-release.ts';

const FEED = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>v4.1.0</title>
    <updated>2026-08-09T12:00:00Z</updated>
    <content type="html">Fixes CVE-2026-1234 in the actuator.</content>
  </entry>
  <entry>
    <title>v4.0.7</title>
    <updated>2026-06-10T12:00:00Z</updated>
    <content type="html">Routine maintenance.</content>
  </entry>
</feed>`;

test('a version is read out of the entry title, with or without a v', () => {
  assert.equal(versionFromTitle('v4.1.0'), '4.1.0');
  assert.equal(versionFromTitle('4.1.0'), '4.1.0');
  assert.equal(versionFromTitle('Spring Boot 4.1.0'), '4.1.0');
  assert.equal(versionFromTitle('4.1.0-RC1'), '4.1.0');
});

test('a title with no version is null rather than a guess', () => {
  assert.equal(versionFromTitle('Nightly build'), null);
  assert.equal(versionFromTitle(''), null);
});

test('latestFromAtom takes the FIRST entry — Atom is newest-first', () => {
  const latest = latestFromAtom(FEED)!;
  assert.equal(latest.version, '4.1.0');
  assert.match(latest.notes, /CVE-2026-1234/);
  assert.equal(latest.publishedAt, '2026-08-09T12:00:00Z');
});

test('the notes are what the security check reads — this is the maven gap closer', () => {
  assert.match(latestFromAtom(FEED)!.notes, /actuator/);
});

test('an entry whose title carries no version is skipped, not fatal', () => {
  const withNightly = FEED.replace('<title>v4.1.0</title>', '<title>Nightly</title>');
  assert.equal(latestFromAtom(withNightly)!.version, '4.0.7');
});

test('an unusable feed is null', () => {
  assert.equal(latestFromAtom(''), null);
  assert.equal(latestFromAtom('<feed></feed>'), null);
});
