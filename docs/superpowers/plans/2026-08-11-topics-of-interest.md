# Topics of Interest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Say "track Spring Boot" and an agent goes and finds its blog, its GitHub releases, its YouTube channel and its X account — you tick what you want, and it starts producing digest lines and Triage cards like a dependency in your own manifests.

**Architecture:** Topics sit *above* the feed pipe built on 2026-08-11: a topic holds candidates, and approving them writes ordinary `FeedSource` rows carrying `topicId`. Discovery is a real `dispatchWork` to a CLI agent that writes a bundle **file**; the broker correlates the completion by `taskId` held in state. A `github` candidate becomes a release source whose versions come from the Atom feed rather than a package registry.

**Tech Stack:** Broker — Node ≥24, TypeScript, `tsx`, `node:test`, **npm**. Control plane — React 19, HeroUI, TanStack Query, vitest, biome, **pnpm**.

**Spec:** `docs/superpowers/specs/2026-08-11-topics-of-interest-design.md`

## Global Constraints

- Broker: `cd broker && npm test`, `npm run typecheck`. **No biome in broker.** The test glob is already `src/*.test.ts src/**/*.test.ts`.
- Control plane: `pnpm test`, `pnpm lint`, `pnpm typecheck`. **pnpm, never npm.** **Never `pnpm test` inside a worktree** — it purges `node_modules`; use `npx vitest run`.
- Every adapter takes an **injected** fetcher/dispatcher. No test touches the network.
- **No source is ever polled that the human did not tick.**
- **Every candidate URL passes `urlRejectionReason()` before storage** — an agent-supplied URL is as untrusted as a pasted one.
- **A declined candidate is never offered again.**
- **Re-discovery never activates a source by itself.**
- **Approving a GitHub source sets a version baseline**, so history is never carded.
- **Every non-active topic status carries a `note` saying why.**
- Manifest-derived sources (no `topicId`) must be unaffected by everything here.
- Broker frame types and `control-plane/src/api/types.ts` stay in lockstep **by hand**.

## File structure

| File | Responsibility |
|---|---|
| `broker/src/feeds/topics.ts` | `Topic`/`Candidate` types + `TopicStore` (topics.json) |
| `broker/src/feeds/bundle.ts` | Parse the agent's bundle file; reject unsafe/unknown candidates |
| `broker/src/feeds/approve.ts` | Candidate → `FeedSource`, incl. the github release shape + baseline |
| `broker/src/feeds/rediscover.ts` | Diff a fresh bundle against what was approved |
| `broker/src/feeds/atom-release.ts` | Version + notes from a GitHub releases Atom feed |
| `broker/src/feeds/discovery.ts` | The brief, and `taskId → topicId` correlation |
| `broker/src/brain.ts` | `track_topic` tool |
| `broker/src/text-channel.ts`, `main.ts` | Routes + wiring + timers |
| `control-plane/src/organisms/settings/TopicsGroup.tsx` | Settings › Topics |

---

### Task 1: Topic types and store

**Files:**
- Create: `broker/src/feeds/topics.ts`
- Modify: `broker/src/feeds/types.ts` (add `topicId` to `FeedSource`, `pendingDiscoveries` to `FeedState`)
- Test: `broker/src/feeds/topics.test.ts`

**Interfaces:**
- Consumes: `FeedIo` from `./store.ts`.
- Produces: `Candidate`, `Topic` (verbatim from spec §2), and
  `class TopicStore` with `constructor(io: FeedIo)`, `all(): Topic[]`, `get(id): Topic | null`,
  `put(t: Topic): void`, `remove(id: string): void`, and `function slugify(name: string): string`.
  `FeedSource.topicId?: string`; `FeedState.pendingDiscoveries: Record<string, string>`.

- [ ] **Step 1: Write the failing test**

Create `broker/src/feeds/topics.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TopicStore, slugify, type Topic } from './topics.ts';

function memoryIo() {
  const files = new Map<string, string>();
  return { files, read: (n: string) => files.get(n) ?? null, write: (n: string, b: string) => void files.set(n, b) };
}

const topic: Topic = {
  id: 'spring-boot',
  name: 'Spring Boot',
  status: 'discovering',
  candidates: [],
  declined: [],
};

test('topics round-trip through the io seam', () => {
  const io = memoryIo();
  new TopicStore(io).put(topic);
  assert.deepEqual(new TopicStore(io).all(), [topic]);
});

test('put replaces by id rather than duplicating', () => {
  const store = new TopicStore(memoryIo());
  store.put(topic);
  store.put({ ...topic, status: 'pending', note: 'no file written' });
  assert.equal(store.all().length, 1);
  assert.equal(store.get('spring-boot')!.status, 'pending');
  assert.equal(store.get('spring-boot')!.note, 'no file written');
});

test('get of an unknown topic is null, not a throw', () => {
  assert.equal(new TopicStore(memoryIo()).get('nope'), null);
});

test('remove drops it', () => {
  const store = new TopicStore(memoryIo());
  store.put(topic);
  store.remove('spring-boot');
  assert.deepEqual(store.all(), []);
});

test('a corrupt file reads as empty rather than bricking the broker', () => {
  const io = memoryIo();
  io.files.set('topics.json', '{not json');
  assert.deepEqual(new TopicStore(io).all(), []);
});

test('slugify makes a stable id from a human name', () => {
  assert.equal(slugify('Spring Boot'), 'spring-boot');
  assert.equal(slugify('  Node.js  '), 'node-js');
  assert.equal(slugify('C++'), 'c');
  assert.equal(slugify(''), 'topic');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/feeds/topics.test.ts`
Expected: FAIL — `Cannot find module './topics.ts'`

- [ ] **Step 3: Write `broker/src/feeds/topics.ts`**

```ts
/**
 * A topic is the unit you configure; sources hang off it (spec §2). It sits
 * ABOVE the feed pipe — approving a topic writes ordinary FeedSource rows, and
 * everything downstream (ingest, digest, check_feeds, cards) is untouched.
 */
import type { FeedIo } from './store.ts';

export interface Candidate {
  kind: 'site' | 'github' | 'youtube' | 'x';
  url: string;
  label: string;
  /** Why the agent believes this is the right source — shown in the review list. */
  evidence: string;
  /** ISO date of the newest thing found there; absent when unknown. */
  lastActivity?: string;
}

export interface Topic {
  id: string;
  name: string;
  status: 'discovering' | 'pending' | 'active';
  /** Why it is in this status when something went wrong. Every non-active status has one. */
  note?: string;
  candidates: Candidate[];
  /** URLs you unticked. Re-discovery must never offer them again. */
  declined: string[];
  lastDiscoveredAt?: string;
}

/** A stable id from a human name. Never empty, so a topic always has a key. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'topic';
}

export class TopicStore {
  constructor(private readonly io: FeedIo) {}

  all(): Topic[] {
    try {
      const raw = this.io.read('topics.json');
      return raw ? (JSON.parse(raw) as Topic[]) : [];
    } catch {
      return []; // a bad write must not brick the broker
    }
  }

  get(id: string): Topic | null {
    return this.all().find((t) => t.id === id) ?? null;
  }

  put(topic: Topic): void {
    const rest = this.all().filter((t) => t.id !== topic.id);
    this.io.write('topics.json', JSON.stringify([...rest, topic], null, 2));
  }

  remove(id: string): void {
    this.io.write('topics.json', JSON.stringify(this.all().filter((t) => t.id !== id), null, 2));
  }
}
```

Then in `broker/src/feeds/types.ts` add to `FeedSource`:

```ts
  /** The topic this source belongs to. Absent on manifest-derived sources. */
  topicId?: string;
```

and to `FeedState`:

```ts
  /** In-flight discovery dispatches: taskId → topicId. SwarmEvent carries no metadata, so this is the correlation. */
  pendingDiscoveries: Record<string, string>;
```

Extend `EMPTY_STATE` in `store.ts` with `pendingDiscoveries: {}`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd broker && node --import tsx --test src/feeds/topics.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
cd broker && npm run typecheck && npm test
git add broker/src/feeds/topics.ts broker/src/feeds/topics.test.ts broker/src/feeds/types.ts broker/src/feeds/store.ts
git commit -m "feat: a topic is the unit you configure"
```

---

### Task 2: Parse the agent's bundle

**Files:**
- Create: `broker/src/feeds/bundle.ts`
- Test: `broker/src/feeds/bundle.test.ts`

**Interfaces:**
- Consumes: `Candidate` (Task 1), `urlRejectionReason` from `./url-guard.ts`.
- Produces: `function parseBundle(raw: string | null): { candidates: Candidate[]; note?: string }`.

- [ ] **Step 1: Write the failing test**

Create `broker/src/feeds/bundle.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBundle } from './bundle.ts';

const GOOD = JSON.stringify({
  candidates: [
    { kind: 'site', url: 'https://spring.io/blog.atom', label: 'Spring blog', evidence: 'feed in <head>', lastActivity: '2026-08-09' },
    { kind: 'github', url: 'https://github.com/spring-projects/spring-boot', label: 'spring-boot', evidence: '1.2k releases' },
  ],
});

test('a well-formed bundle yields its candidates', () => {
  const { candidates, note } = parseBundle(GOOD);
  assert.equal(candidates.length, 2);
  assert.equal(note, undefined);
  assert.equal(candidates[0]!.kind, 'site');
  assert.equal(candidates[1]!.label, 'spring-boot');
});

test('a missing file is a note, not a throw', () => {
  const { candidates, note } = parseBundle(null);
  assert.deepEqual(candidates, []);
  assert.match(note!, /no bundle file/i);
});

test('malformed JSON is a note naming the problem', () => {
  const { candidates, note } = parseBundle('{not json');
  assert.deepEqual(candidates, []);
  assert.match(note!, /could not be read/i);
});

test('an empty bundle is a note — the agent found nothing', () => {
  const { candidates, note } = parseBundle(JSON.stringify({ candidates: [] }));
  assert.deepEqual(candidates, []);
  assert.match(note!, /found no sources/i);
});

test('an UNSAFE candidate url is dropped and recorded — an agent-supplied url is untrusted', () => {
  const { candidates, note } = parseBundle(
    JSON.stringify({
      candidates: [
        { kind: 'site', url: 'http://169.254.169.254/latest/', label: 'metadata', evidence: 'x' },
        { kind: 'site', url: 'https://spring.io/blog.atom', label: 'blog', evidence: 'y' },
      ],
    }),
  );
  assert.deepEqual(candidates.map((c) => c.label), ['blog']);
  assert.match(note!, /169\.254\.169\.254/);
});

test('an unknown kind is dropped rather than stored as junk', () => {
  const { candidates } = parseBundle(
    JSON.stringify({ candidates: [{ kind: 'telepathy', url: 'https://x.test/a', label: 'l', evidence: 'e' }] }),
  );
  assert.deepEqual(candidates, []);
});

test('candidates missing a url or kind are dropped', () => {
  const { candidates } = parseBundle(
    JSON.stringify({ candidates: [{ kind: 'site', label: 'no url', evidence: 'e' }, { url: 'https://x.test' }] }),
  );
  assert.deepEqual(candidates, []);
});

test('missing evidence becomes empty rather than undefined, so the UI never renders "undefined"', () => {
  const { candidates } = parseBundle(
    JSON.stringify({ candidates: [{ kind: 'site', url: 'https://x.test/a', label: 'l' }] }),
  );
  assert.equal(candidates[0]!.evidence, '');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/feeds/bundle.test.ts`
Expected: FAIL — `Cannot find module './bundle.ts'`

- [ ] **Step 3: Write the implementation**

```ts
/**
 * The bundle a discovery agent writes to `.smith/topics/<id>.json` (spec §3.1).
 *
 * It is written by a CLI agent reading the open web, so every field is
 * untrusted: unknown kinds and unsafe URLs are DROPPED, and what was dropped
 * is reported in the note rather than swallowed.
 */
import type { Candidate } from './topics.ts';
import { urlRejectionReason } from './url-guard.ts';

const KINDS = new Set<Candidate['kind']>(['site', 'github', 'youtube', 'x']);

export function parseBundle(raw: string | null): { candidates: Candidate[]; note?: string } {
  if (raw === null) return { candidates: [], note: 'no bundle file was written' };

  let body: { candidates?: unknown };
  try {
    body = JSON.parse(raw) as { candidates?: unknown };
  } catch {
    return { candidates: [], note: 'the bundle file could not be read as JSON' };
  }

  const rejected: string[] = [];
  const candidates = (Array.isArray(body.candidates) ? body.candidates : []).flatMap((raw): Candidate[] => {
    const c = raw as Partial<Candidate>;
    if (!c.kind || !KINDS.has(c.kind) || typeof c.url !== 'string' || !c.url) return [];
    const refusal = urlRejectionReason(c.url);
    if (refusal) {
      rejected.push(`${c.url} (${refusal})`);
      return [];
    }
    return [
      {
        kind: c.kind,
        url: c.url,
        label: typeof c.label === 'string' && c.label ? c.label : c.url,
        // Never undefined: the review list renders this directly.
        evidence: typeof c.evidence === 'string' ? c.evidence : '',
        lastActivity: typeof c.lastActivity === 'string' ? c.lastActivity : undefined,
      },
    ];
  });

  if (!candidates.length && !rejected.length) return { candidates, note: 'the agent found no sources' };
  return { candidates, note: rejected.length ? `dropped unsafe: ${rejected.join(', ')}` : undefined };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd broker && node --import tsx --test src/feeds/bundle.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
cd broker && npm run typecheck
git add broker/src/feeds/bundle.ts broker/src/feeds/bundle.test.ts
git commit -m "feat: read the agent's bundle, trusting none of it"
```

---

### Task 3: Releases from an Atom feed

A GitHub release source has no package registry behind it, so versions come from the feed's own entries. This is also what closes the Maven security-patch gap.

**Files:**
- Create: `broker/src/feeds/atom-release.ts`
- Test: `broker/src/feeds/atom-release.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `function versionFromTitle(title: string): string | null` and
  `function latestFromAtom(xml: string): { version: string; notes: string; publishedAt?: string } | null`.

- [ ] **Step 1: Write the failing test**

Create `broker/src/feeds/atom-release.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/feeds/atom-release.test.ts`
Expected: FAIL — `Cannot find module './atom-release.ts'`

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Version and notes from a GitHub releases Atom feed — the version source for
 * a topic's github candidate, which has no package registry behind it
 * (spec §5).
 *
 * This is also what makes maven SECURITY patches detectable: Maven Central's
 * search API exposes no scm, so the registry path can never see release notes,
 * while GitHub's Atom entries carry them.
 */

/** The numeric core of a release title. Null when the title names no version. */
export function versionFromTitle(title: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(title)?.[1] ?? null;
}

function tagText(block: string, name: string): string {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? m[1]!.trim() : '';
}

/** The newest entry that actually names a version. Atom is newest-first. */
export function latestFromAtom(xml: string): { version: string; notes: string; publishedAt?: string } | null {
  for (const m of xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)) {
    const block = m[1]!;
    const version = versionFromTitle(tagText(block, 'title'));
    if (!version) continue; // a nightly or a rename is not a release
    return {
      version,
      notes: tagText(block, 'content') || tagText(block, 'summary'),
      publishedAt: tagText(block, 'updated') || undefined,
    };
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd broker && node --import tsx --test src/feeds/atom-release.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
cd broker && npm run typecheck
git add broker/src/feeds/atom-release.ts broker/src/feeds/atom-release.test.ts
git commit -m "feat: a release feed can name its own versions"
```

---

### Task 4: Approving candidates into sources

**Files:**
- Create: `broker/src/feeds/approve.ts`
- Test: `broker/src/feeds/approve.test.ts`

**Interfaces:**
- Consumes: `Candidate`, `Topic` (Task 1); `FeedSource` from `./types.ts`; `youtubeFeedUrl` from `./rss.ts`; `githubAtomUrl` from `./versions.ts`.
- Produces:
  `function sourceFor(topic: Topic, c: Candidate): FeedSource | null` and
  `function approve(topic: Topic, keepUrls: string[], baseline?: string): { topic: Topic; sources: FeedSource[]; baselines: Record<string, string> }`.

- [ ] **Step 1: Write the failing test**

Create `broker/src/feeds/approve.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approve, sourceFor } from './approve.ts';
import type { Candidate, Topic } from './topics.ts';

const site: Candidate = { kind: 'site', url: 'https://spring.io/blog.atom', label: 'Spring blog', evidence: 'e' };
const gh: Candidate = { kind: 'github', url: 'https://github.com/spring-projects/spring-boot', label: 'spring-boot', evidence: 'e' };
const yt: Candidate = { kind: 'youtube', url: 'https://www.youtube.com/channel/UC123', label: 'chan', evidence: 'e' };
const x: Candidate = { kind: 'x', url: 'https://x.com/springboot', label: '@springboot', evidence: 'e' };

const topic: Topic = {
  id: 'spring-boot',
  name: 'Spring Boot',
  status: 'pending',
  candidates: [site, gh, yt, x],
  declined: [],
};

test('a site candidate becomes an rss source tagged tech', () => {
  const s = sourceFor(topic, site)!;
  assert.equal(s.kind, 'rss');
  assert.equal(s.tag, 'tech');
  assert.equal(s.locator, 'https://spring.io/blog.atom');
  assert.equal(s.topicId, 'spring-boot');
  assert.match(s.reason!, /Spring Boot discovery/);
});

test('a github candidate becomes a RELEASE source pointed at the atom feed', () => {
  const s = sourceFor(topic, gh)!;
  assert.equal(s.tag, 'release');
  assert.equal(s.locator, 'https://github.com/spring-projects/spring-boot/releases.atom');
});

test('a youtube channel becomes its feed url, not the page url', () => {
  assert.equal(sourceFor(topic, yt)!.locator, 'https://www.youtube.com/feeds/videos.xml?channel_id=UC123');
});

test('an x candidate becomes an x source carrying the bare handle', () => {
  const s = sourceFor(topic, x)!;
  assert.equal(s.kind, 'x');
  assert.equal(s.locator, 'springboot');
});

test('approve keeps only what was ticked, and DECLINES the rest for good', () => {
  const { topic: next, sources } = approve(topic, [site.url, gh.url]);
  assert.deepEqual(sources.map((s) => s.label).sort(), ['Spring blog', 'spring-boot']);
  assert.deepEqual(next.declined.sort(), [x.url, yt.url].sort());
  assert.equal(next.status, 'active');
  assert.deepEqual(next.candidates, [], 'approved candidates stop being pending');
});

test('approving a github source records the baseline, so history is never carded', () => {
  const { baselines } = approve(topic, [gh.url], '4.0.0');
  assert.deepEqual(baselines, { 'spring-projects/spring-boot': '4.0.0' });
});

test('no baseline given still records one, because zero is not a version', () => {
  const { baselines } = approve(topic, [gh.url]);
  assert.equal(Object.keys(baselines).length, 1);
});

test('approving nothing leaves the topic pending rather than pretending it is active', () => {
  const { topic: next, sources } = approve(topic, []);
  assert.deepEqual(sources, []);
  assert.equal(next.status, 'pending');
  assert.match(next.note!, /nothing approved/i);
});

test('a previously declined url stays declined after another approval round', () => {
  const withDeclined = { ...topic, declined: ['https://old.test/gone'] };
  const { topic: next } = approve(withDeclined, [site.url]);
  assert.equal(next.declined.includes('https://old.test/gone'), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/feeds/approve.test.ts`
Expected: FAIL — `Cannot find module './approve.ts'`

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Ticked candidates become ordinary FeedSource rows (spec §4). Everything
 * downstream — ingest, digest, cards — then treats a topic's source exactly
 * like a manifest-derived one.
 */
import { youtubeFeedUrl } from './rss.ts';
import type { Candidate, Topic } from './topics.ts';
import type { FeedSource } from './types.ts';
import { githubAtomUrl } from './versions.ts';

/** owner/repo out of a GitHub URL — the key a baseline is stored under. */
export function repoKey(url: string): string | null {
  const m = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:$|[/#?])/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function sourceFor(topic: Topic, c: Candidate): FeedSource | null {
  const base = {
    id: `topic:${topic.id}:${c.kind}:${c.url}`,
    label: c.label,
    origin: 'derived' as const,
    reason: `from ${topic.name} discovery`,
    enabled: true,
    topicId: topic.id,
  };

  if (c.kind === 'github') {
    const atom = githubAtomUrl(c.url);
    if (!atom) return null;
    // A release source, so version/bump/security run from the Atom entries —
    // which is what gives a topic the same cards a dependency gets.
    return { ...base, kind: 'rss', locator: atom, tag: 'release' };
  }
  if (c.kind === 'youtube') {
    const feed = youtubeFeedUrl(c.url);
    if (!feed) return null;
    return { ...base, kind: 'rss', locator: feed, tag: 'tech' };
  }
  if (c.kind === 'x') {
    const handle = /x\.com\/@?([A-Za-z0-9_]+)/.exec(c.url)?.[1];
    if (!handle) return null;
    return { ...base, kind: 'x', locator: handle, tag: 'news' };
  }
  return { ...base, kind: 'rss', locator: c.url, tag: 'tech' };
}

export function approve(
  topic: Topic,
  keepUrls: string[],
  baseline?: string,
): { topic: Topic; sources: FeedSource[]; baselines: Record<string, string> } {
  const keep = new Set(keepUrls);
  const kept = topic.candidates.filter((c) => keep.has(c.url));
  const sources = kept.flatMap((c) => {
    const s = sourceFor(topic, c);
    return s ? [s] : [];
  });

  const baselines: Record<string, string> = {};
  for (const c of kept) {
    if (c.kind !== 'github') continue;
    const key = repoKey(c.url);
    // Without a baseline every historical release would be carded at once —
    // the same failure the manifest-seeded baselines already prevent.
    if (key) baselines[key] = baseline ?? '0.0.0';
  }

  const declined = [...new Set([...topic.declined, ...topic.candidates.filter((c) => !keep.has(c.url)).map((c) => c.url)])];

  if (!sources.length) {
    return { topic: { ...topic, declined, status: 'pending', note: 'nothing approved yet' }, sources, baselines };
  }
  return {
    topic: { ...topic, candidates: [], declined, status: 'active', note: undefined, },
    sources,
    baselines,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd broker && node --import tsx --test src/feeds/approve.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
cd broker && npm run typecheck
git add broker/src/feeds/approve.ts broker/src/feeds/approve.test.ts
git commit -m "feat: ticking a candidate makes it a real source"
```

---

### Task 5: Re-discovery diff

**Files:**
- Create: `broker/src/feeds/rediscover.ts`
- Test: `broker/src/feeds/rediscover.test.ts`

**Interfaces:**
- Consumes: `Candidate`, `Topic` (Task 1); `FeedSource`.
- Produces: `function diffBundle(input: { topic: Topic; fresh: Candidate[]; approved: FeedSource[]; now: string }): { additions: Candidate[]; flagged: string[] }`.

- [ ] **Step 1: Write the failing test**

Create `broker/src/feeds/rediscover.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffBundle } from './rediscover.ts';
import type { Candidate, Topic } from './topics.ts';
import type { FeedSource } from './types.ts';

const NOW = '2026-08-11T00:00:00Z';
const blog: Candidate = { kind: 'site', url: 'https://spring.io/blog.atom', label: 'blog', evidence: 'e' };
const tube: Candidate = { kind: 'youtube', url: 'https://www.youtube.com/channel/UC1', label: 'chan', evidence: 'e' };

const topic: Topic = { id: 'spring-boot', name: 'Spring Boot', status: 'active', candidates: [], declined: [], };
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
  // Additions are CANDIDATES awaiting a tick — never FeedSources.
  assert.equal('enabled' in (additions[0] as object), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/feeds/rediscover.test.ts`
Expected: FAIL — `Cannot find module './rediscover.ts'`

- [ ] **Step 3: Write the implementation**

```ts
/**
 * A fresh bundle, diffed against what was approved (spec §6).
 *
 * Returns CANDIDATES, never sources: re-discovery must never activate anything
 * by itself. Flagging is advisory — a flagged source keeps polling.
 */
import type { Candidate, Topic } from './topics.ts';
import type { FeedSource } from './types.ts';

/** Six months: long enough that a quiet-but-alive blog is not mistaken for a dead one. */
const QUIET_DAYS = 180;

export function diffBundle(input: {
  topic: Topic;
  fresh: Candidate[];
  approved: FeedSource[];
  now: string;
}): { additions: Candidate[]; flagged: string[] } {
  const declined = new Set(input.topic.declined);
  const approvedLocators = new Set(input.approved.map((s) => s.locator));

  const additions = input.fresh.filter(
    (c) => !declined.has(c.url) && !approvedLocators.has(c.url) && !input.topic.candidates.some((x) => x.url === c.url),
  );

  const cutoff = Date.parse(input.now) - QUIET_DAYS * 86_400_000;
  const freshByUrl = new Map(input.fresh.map((c) => [c.url, c]));
  const flagged = input.approved
    .filter((s) => {
      const match = freshByUrl.get(s.locator);
      if (!match) return true; // gone from the bundle entirely
      const last = match.lastActivity ? Date.parse(match.lastActivity) : Number.NaN;
      return !Number.isNaN(last) && last < cutoff;
    })
    .map((s) => s.id);

  return { additions, flagged };
}
```

> The `additions` filter compares `c.url` against `s.locator`. For a `site` candidate those are identical; for github/youtube they are not, which is why the approved set is keyed by locator and a re-offered github candidate would appear as an addition. Task 9's wiring passes `approved` already mapped through `sourceFor`, so the comparison is like-for-like — do not skip that mapping.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd broker && node --import tsx --test src/feeds/rediscover.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
cd broker && npm run typecheck
git add broker/src/feeds/rediscover.ts broker/src/feeds/rediscover.test.ts
git commit -m "feat: re-discovery proposes, it never decides"
```

---

### Task 6: The discovery brief and its correlation

**Files:**
- Create: `broker/src/feeds/discovery.ts`
- Test: `broker/src/feeds/discovery.test.ts`

**Interfaces:**
- Consumes: `Topic` (Task 1).
- Produces:
  `function discoveryBrief(topic: Topic, bundlePath: string): string`,
  `async function startDiscovery(deps: { dispatch(task: string): Promise<{ taskId: string } | { error: string }>; bundlePath(topicId: string): string }, topic: Topic): Promise<{ topic: Topic; taskId?: string }>`.

- [ ] **Step 1: Write the failing test**

Create `broker/src/feeds/discovery.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoveryBrief, startDiscovery } from './discovery.ts';
import type { Topic } from './topics.ts';

const topic: Topic = { id: 'spring-boot', name: 'Spring Boot', status: 'discovering', candidates: [], declined: [] };

test('the brief names the topic, the four kinds, and the file to WRITE', () => {
  const brief = discoveryBrief(topic, '.smith/topics/spring-boot.json');
  assert.match(brief, /Spring Boot/);
  for (const kind of ['site', 'github', 'youtube', 'x']) assert.match(brief, new RegExp(kind));
  assert.match(brief, /\.smith\/topics\/spring-boot\.json/);
  assert.match(brief, /write/i);
  assert.match(brief, /evidence/i);
  assert.match(brief, /do not print/i, 'terminal output is not a data format');
});

test('a successful dispatch records the taskId and keeps the topic discovering', async () => {
  const { topic: next, taskId } = await startDiscovery(
    { dispatch: async () => ({ taskId: 't-1' }), bundlePath: (id) => `.smith/topics/${id}.json` },
    topic,
  );
  assert.equal(taskId, 't-1');
  assert.equal(next.status, 'discovering');
  assert.equal(next.note, undefined);
});

test('a refused dispatch keeps the topic discovering and SAYS why', async () => {
  const { topic: next, taskId } = await startDiscovery(
    { dispatch: async () => ({ error: 'Osvaldo is busy with: refactor auth.' }), bundlePath: (id) => id },
    topic,
  );
  assert.equal(taskId, undefined);
  assert.equal(next.status, 'discovering');
  assert.match(next.note!, /busy with: refactor auth/);
});

test('the brief tells the agent what it is allowed to leave out', async () => {
  const brief = discoveryBrief(topic, 'p.json');
  assert.match(brief, /omit/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/feeds/discovery.test.ts`
Expected: FAIL — `Cannot find module './discovery.ts'`

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Discovery is a real research dispatch to a CLI agent, which has web access
 * the brain does not (spec §3).
 *
 * The agent WRITES a bundle file rather than printing it: getOutput() returns
 * raw terminal scrollback — ANSI codes, wrapping, the agent's own commentary —
 * and parsing a bundle out of that works while you watch and fails on a long
 * day.
 */
import type { Topic } from './topics.ts';

export function discoveryBrief(topic: Topic, bundlePath: string): string {
  return [
    `Find the places "${topic.name}" publishes. Look for up to four kinds of source:`,
    '',
    '  site    — the official blog or news page, and its RSS/Atom feed URL',
    '  github  — the main repository, if it has one',
    '  youtube — the official channel, if it has one',
    '  x       — the official X account, if it has one',
    '',
    `Write your findings as JSON to ${bundlePath} — do not print them to the terminal.`,
    '',
    'Shape:',
    '{ "candidates": [',
    '    { "kind": "site", "url": "…", "label": "…", "evidence": "…", "lastActivity": "2026-08-09" }',
    '] }',
    '',
    'For each: `url` is the FEED url for a site (look for <link rel="alternate">), the repo',
    'url for github, the channel url for youtube, the profile url for x. `evidence` is one',
    'short line on why you believe it is official. `lastActivity` is the date of the newest',
    'item you saw there.',
    '',
    'Omit any kind you cannot find or cannot verify as official — a missing source is much',
    'better than a wrong one. Write the file even if you find only one.',
  ].join('\n');
}

export async function startDiscovery(
  deps: {
    dispatch(task: string): Promise<{ taskId: string } | { error: string }>;
    bundlePath(topicId: string): string;
  },
  topic: Topic,
): Promise<{ topic: Topic; taskId?: string }> {
  const result = await deps.dispatch(discoveryBrief(topic, deps.bundlePath(topic.id)));
  if ('error' in result) {
    // Stays discovering: the timer retries. Every non-active status says why.
    return { topic: { ...topic, status: 'discovering', note: result.error } };
  }
  return { topic: { ...topic, status: 'discovering', note: undefined }, taskId: result.taskId };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd broker && node --import tsx --test src/feeds/discovery.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
cd broker && npm run typecheck
git add broker/src/feeds/discovery.ts broker/src/feeds/discovery.test.ts
git commit -m "feat: the brief that sends an agent looking"
```

---

### Task 7: `track_topic` in the brain

**Files:**
- Modify: `broker/src/brain.ts` — `ToolExecutors`, `TOOLS`, the dispatch if-chain
- Test: `broker/src/brain.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `ToolExecutors.track_topic(input: { name: string }): Promise<string>`.

> **Adding a tool needs THREE edits, not two:** the `ToolExecutors` type, the `TOOLS` array, and the **dispatch if-chain** near the bottom of `brain.ts`. Missing the third compiles fine and silently never calls the executor.

- [ ] **Step 1: Write the failing test**

Append to `broker/src/brain.test.ts`:

```ts
test('track_topic is offered as a tool and its input reaches the executor', async () => {
  const seen: unknown[] = [];
  const { factory, calls } = scripted([
    {
      textDeltas: [],
      final: {
        content: [{ type: 'tool_use', id: 't1', name: 'track_topic', input: { name: 'Spring Boot' } }],
        stop_reason: 'tool_use',
      },
    },
    { textDeltas: ['ok'], final: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } },
  ]);
  const brain = new BrokerBrain(factory, {
    ...NOOP_EXEC,
    track_topic: async (input) => {
      seen.push(input);
      return 'Osvaldo is looking into Spring Boot.';
    },
  });
  await brain.handleUtterance('track spring boot', { roster: '', onSpeech: () => {} });
  assert.deepEqual(seen, [{ name: 'Spring Boot' }]);
  assert.equal((calls[0]!.tools as Array<{ name: string }>).some((t) => t.name === 'track_topic'), true);
});
```

Also add `track_topic: async () => 'ok',` to this file's `NOOP_EXEC` and `FEED_EXEC` stubs.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/brain.test.ts`
Expected: FAIL — the executor is never called.

- [ ] **Step 3: Write the implementation**

In `ToolExecutors`:

```ts
  track_topic(input: { name: string }): Promise<string>;
```

In `TOOLS`:

```ts
  {
    name: 'track_topic',
    description:
      "Start following a subject the human names — a framework, a project, a company. An agent goes and finds where it publishes; the human ticks what to keep. Use when they say to track, follow, or keep an eye on something.",
    input_schema: {
      type: 'object' as const,
      properties: { name: { type: 'string' as const, description: 'The subject as the human said it, e.g. "Spring Boot"' } },
      required: ['name'],
    },
  },
```

In the dispatch if-chain, beside `check_feeds`:

```ts
      if (name === 'track_topic') return await this.executors.track_topic(input as { name: string });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd broker && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd broker && npm run typecheck
git add broker/src/brain.ts broker/src/brain.test.ts
git commit -m "feat: you can ask the crew to follow something"
```

---

### Task 8: Routes

**Files:**
- Modify: `broker/src/text-channel.ts` — a `topics` dep after `feeds`
- Test: `broker/src/text-channel.test.ts` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks (the dep is opaque here).
- Produces: `TextChannel` gains positional dep 27:
  `{ list(): Promise<unknown>; track(body: { name: string }): Promise<unknown>; approve(id: string, body: { keep: string[]; baseline?: string }): Promise<unknown>; rediscover(id: string): Promise<unknown>; remove(id: string): Promise<unknown> }`
  serving `GET /topics`, `POST /topics`, `POST /topics/:id/approve`, `POST /topics/:id/rediscover`, `DELETE /topics/:id`.

- [ ] **Step 1: Write the failing test**

Append to `broker/src/text-channel.test.ts`:

```ts
function topicStub(over: Partial<NonNullable<ConstructorParameters<typeof TextChannel>[27]>> = {}) {
  return {
    list: async () => ({ topics: [] }),
    track: async () => ({ ok: true }),
    approve: async () => ({ ok: true }),
    rediscover: async () => ({ ok: true }),
    remove: async () => ({ ok: true }),
    ...over,
  };
}

test('GET /topics lists; POST /topics starts tracking one', async () => {
  const tracked: unknown[] = [];
  const channel = channelWith({
    topics: topicStub({
      list: async () => ({ topics: [{ id: 'spring-boot', name: 'Spring Boot', status: 'active' }] }),
      track: async (body) => {
        tracked.push(body);
        return { ok: true, id: 'spring-boot' };
      },
    }),
  });
  const port = await channel.start(0);
  try {
    const listed = await fetch(`http://127.0.0.1:${port}/topics`);
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { topics: [{ id: 'spring-boot', name: 'Spring Boot', status: 'active' }] });

    const res = await fetch(`http://127.0.0.1:${port}/topics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Spring Boot' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(tracked, [{ name: 'Spring Boot' }]);
  } finally {
    await channel.stop();
  }
});

test('approve forwards the ticked urls and the baseline', async () => {
  const calls: unknown[] = [];
  const channel = channelWith({
    topics: topicStub({
      approve: async (id, body) => {
        calls.push([id, body]);
        return { ok: true };
      },
    }),
  });
  const port = await channel.start(0);
  try {
    await fetch(`http://127.0.0.1:${port}/topics/spring-boot/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keep: ['https://spring.io/blog.atom'], baseline: '4.0.0' }),
    });
    assert.deepEqual(calls, [['spring-boot', { keep: ['https://spring.io/blog.atom'], baseline: '4.0.0' }]]);
  } finally {
    await channel.stop();
  }
});

test('/approve and /rediscover are matched BEFORE the bare-id route so it never swallows them', async () => {
  const calls: string[] = [];
  const channel = channelWith({
    topics: topicStub({
      approve: async () => {
        calls.push('approve');
        return { ok: true };
      },
      rediscover: async () => {
        calls.push('rediscover');
        return { ok: true };
      },
      remove: async () => {
        calls.push('remove');
        return { ok: true };
      },
    }),
  });
  const port = await channel.start(0);
  try {
    await fetch(`http://127.0.0.1:${port}/topics/spring-boot/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keep: [] }),
    });
    await fetch(`http://127.0.0.1:${port}/topics/spring-boot/rediscover`, { method: 'POST' });
    await fetch(`http://127.0.0.1:${port}/topics/spring-boot`, { method: 'DELETE' });
    assert.deepEqual(calls, ['approve', 'rediscover', 'remove']);
  } finally {
    await channel.stop();
  }
});

test('the mutating topic routes refuse a disallowed browser Origin', async () => {
  const channel = channelWith({
    topics: topicStub({ track: async () => assert.fail('must not be reached') }),
  });
  const port = await channel.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/topics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify({ name: 'Spring Boot' }),
    });
    assert.equal(res.status, 403);
  } finally {
    await channel.stop();
  }
});
```

Extend `channelWith` with `topics?: ConstructorParameters<typeof TextChannel>[27]` and pass `opts.topics` as the last positional argument.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/text-channel.test.ts`
Expected: FAIL — `/topics` 404s.

- [ ] **Step 3: Write the implementation**

Add the dep after `feeds`, then routes modelled exactly on the `/feeds` block already in this file — `GET /topics` unguarded (read-only), everything else behind that block's `originBlocked()`. Match in this order, because a bare-id pattern would otherwise swallow the sub-routes:

1. `POST /^\/topics$/`
2. `POST /^\/topics\/([^/]+)\/approve$/`
3. `POST /^\/topics\/([^/]+)\/rediscover$/`
4. `DELETE /^\/topics\/([^/]+)$/`

Reuse the `/feeds` block's `readBody` helper for the two bodies.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd broker && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd broker && npm run typecheck
git add broker/src/text-channel.ts broker/src/text-channel.test.ts
git commit -m "feat: topics have a surface"
```

---

### Task 9: Wiring — dispatch, completion, timers, and github release polling

**Files:**
- Modify: `broker/src/main.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: no new exports.

- [ ] **Step 1: Wire the topic store and the `topics` dep**

Build `new TopicStore(feedsIo)` beside `feedStore` (extract the existing inline io object into a `const feedsIo` so both share it). Implement the dep:

- `list` → `{ topics: topicStore.all(), sources: feedStore.sources().filter((s) => s.topicId) }`
- `track` → `slugify(name)`; if the topic exists and is `discovering`, return `{ error: 'already looking' }`; otherwise `put({ id, name, status: 'discovering', candidates: [], declined: [] })` then `beginDiscovery(topic)`
- `approve` → `approve(topic, body.keep, body.baseline)`, then for each returned source `feedStore.putSource(s)`, merge `baselines` into `state.seenVersions`, and `topicStore.put(next)`
- `rediscover` → `beginDiscovery(topicStore.get(id))`
- `remove` → `topicStore.remove(id)` **and** `feedStore.removeSource(s.id)` for every source whose `topicId` matches

- [ ] **Step 2: Wire `beginDiscovery` and the completion handler**

```ts
const TOPICS_DIR = process.env.BROKER_TOPICS_DIR ?? '.smith/topics';
const bundlePath = (topicId: string) => `${TOPICS_DIR}/${topicId}.json`;

async function beginDiscovery(topic: Topic): Promise<void> {
  const { topic: next, taskId } = await startDiscovery(
    {
      dispatch: async (task) => {
        // The composer's own dispatch path: busy-refusal and task binding come
        // from there rather than being reimplemented.
        const r = await broker.dispatchWork({ agent: discoveryAgent(), task, inheritSessionRuntime: false });
        return 'error' in r ? { error: r.error } : { taskId: r.taskId };
      },
      bundlePath,
    },
    topic,
  );
  topicStore.put({ ...next, lastDiscoveredAt: new Date().toISOString() });
  if (taskId) {
    feedStore.patchState({ pendingDiscoveries: { ...feedStore.state().pendingDiscoveries, [taskId]: topic.id } });
  }
}
```

`discoveryAgent()` returns the first idle registry agent's name, falling back to the first agent; when the roster is empty it returns `''`, and `dispatchWork` then refuses with a reason the topic records.

In the existing `onSwarmEvent` handler, beside the `workCardRef` branch:

```ts
if (e.type === 'task:completed' || e.type === 'task:failed') {
  const topicId = feedStore.state().pendingDiscoveries[e.taskId];
  if (topicId) {
    const { [e.taskId]: _done, ...rest } = feedStore.state().pendingDiscoveries;
    feedStore.patchState({ pendingDiscoveries: rest });
    const topic = topicStore.get(topicId);
    if (topic) {
      let raw: string | null = null;
      try {
        raw = readFileSync(bundlePath(topicId), 'utf8');
      } catch {
        raw = null;
      }
      const { candidates, note } = parseBundle(raw);
      topicStore.put({ ...topic, status: 'pending', candidates, note });
    }
  }
}
```

- [ ] **Step 3: Poll a topic's github release source**

The existing `fetchSource` handles `kind: 'rss'` generically, which would store a topic's release entries as plain items with no `release` metadata — the exact bug this feature exists to fix. Add, **before** the generic rss branch:

```ts
if (source.kind === 'rss' && source.tag === 'release' && source.topicId) {
  const res = await fetch(source.locator);
  const latest = latestFromAtom(await res.text());
  if (!latest) return { ok: false, error: 'no versioned release found in the feed' };

  const key = repoKey(source.locator) ?? source.locator;
  const state = feedStore.state();
  const from = state.seenVersions[key];
  // Approval always sets a baseline, so an absent one means state was lost —
  // seed rather than announce, so history is still never carded.
  if (!from) {
    feedStore.patchState({ seenVersions: { ...state.seenVersions, [key]: latest.version } });
    return { ok: true };
  }
  const bump = classifyBump(from, latest.version);
  if (!bump) return { ok: true };
  const security = mentionsSecurity(latest.notes);
  feedStore.patchState({ seenVersions: { ...feedStore.state().seenVersions, [key]: latest.version } });
  if (!qualifies(bump, security)) return { ok: true };

  const [fresh] = feedStore.addItems([
    {
      id: `${source.id}@${latest.version}`,
      sourceId: source.id,
      tag: 'release',
      title: `${source.label} ${latest.version}`,
      publishedAt: latest.publishedAt ?? new Date().toISOString(),
      summary: latest.notes.slice(0, 400),
      release: { name: source.label, version: latest.version, bump, security },
    },
  ]);
  // A topic has no workspace of its own; cards go to the default one.
  if (fresh) void makeCard(fresh, defaultWorkspaceName, from);
  return { ok: true };
}
```

- [ ] **Step 4: The 30-day re-discovery timer**

```ts
const REDISCOVER_MS = 30 * 86_400_000;
setInterval(() => {
  const pending = new Set(Object.values(feedStore.state().pendingDiscoveries));
  for (const topic of topicStore.all()) {
    if (topic.status !== 'active' || pending.has(topic.id)) continue; // never two at once
    const last = topic.lastDiscoveredAt ? Date.parse(topic.lastDiscoveredAt) : 0;
    if (Date.now() - last < REDISCOVER_MS) continue;
    void beginDiscovery(topic);
  }
}, 60 * 60_000).unref();
```

The completion handler above sets `status: 'pending'` with the fresh candidates. Apply the diff there instead when the topic already had sources — pass `diffBundle({ topic, fresh: candidates, approved: feedStore.sources().filter((s) => s.topicId === topic.id), now })` and store `additions` as the candidates, so an unchanged bundle produces an empty pending list rather than re-offering everything.

- [ ] **Step 5: Wire `track_topic`**

In the brain's executors, beside `check_feeds`:

```ts
    track_topic: async ({ name }) => {
      const id = slugify(name);
      const existing = topicStore.get(id);
      if (existing?.status === 'discovering') return `Already looking into ${name}.`;
      const topic: Topic = existing ?? { id, name, status: 'discovering', candidates: [], declined: [] };
      topicStore.put(topic);
      await beginDiscovery(topic);
      const after = topicStore.get(id);
      return after?.note
        ? `Could not start: ${after.note}`
        : `Looking into ${name} — the sources will be in Settings › Topics when they land.`;
    },
```

- [ ] **Step 6: Verify**

```bash
cd broker && npm test && npm run typecheck
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add broker/src/main.ts
git commit -m "feat: discovery runs, lands, and a topic's releases become cards"
```

---

### Task 10: Settings › Topics

**Files:**
- Create: `control-plane/src/organisms/settings/TopicsGroup.tsx`
- Modify: `control-plane/src/api/types.ts`, `control-plane/src/api/broker.ts`, the settings modal
- Test: `control-plane/src/organisms/settings/TopicsGroup.test.tsx`

**Interfaces:**
- Consumes: the routes from Task 8.
- Produces: `TopicT`, `CandidateT` in `types.ts`; `getTopics`, `trackTopic`, `approveTopic`, `rediscoverTopic`, `removeTopic` in `broker.ts`; `<TopicsGroup />`.

- [ ] **Step 1: Write the failing test**

Create `control-plane/src/organisms/settings/TopicsGroup.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import * as api from "../../api/broker";
import { TopicsGroup } from "./TopicsGroup";

const PENDING = {
  id: "spring-boot",
  name: "Spring Boot",
  status: "pending",
  declined: [],
  candidates: [
    { kind: "site", url: "https://spring.io/blog.atom", label: "Spring blog", evidence: "feed in <head>" },
    { kind: "youtube", url: "https://youtube.com/channel/UC1", label: "channel", evidence: "last video 2023" },
  ],
};

describe("Settings › Topics", () => {
  it("shows each candidate WITH its evidence — that is what you decide on", async () => {
    vi.spyOn(api, "getTopics").mockResolvedValue({ topics: [PENDING], sources: [] } as never);
    render(<TopicsGroup />);
    expect(await screen.findByText("Spring blog")).toBeInTheDocument();
    expect(screen.getByText(/last video 2023/)).toBeInTheDocument();
  });

  it("approves only the ticked candidates", async () => {
    vi.spyOn(api, "getTopics").mockResolvedValue({ topics: [PENDING], sources: [] } as never);
    const approve = vi.spyOn(api, "approveTopic").mockResolvedValue(null);
    render(<TopicsGroup />);
    // Both start ticked; untick the dead channel.
    await userEvent.click(await screen.findByRole("checkbox", { name: /channel/i }));
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith("spring-boot", { keep: ["https://spring.io/blog.atom"], baseline: "" }),
    );
  });

  it("tracks a new topic by name", async () => {
    vi.spyOn(api, "getTopics").mockResolvedValue({ topics: [], sources: [] } as never);
    const track = vi.spyOn(api, "trackTopic").mockResolvedValue(null);
    render(<TopicsGroup />);
    await userEvent.type(await screen.findByLabelText(/track a topic/i), "Spring Boot");
    await userEvent.click(screen.getByRole("button", { name: /^track$/i }));
    await waitFor(() => expect(track).toHaveBeenCalledWith("Spring Boot"));
  });

  it("shows why a topic is stuck rather than looking healthy", async () => {
    vi.spyOn(api, "getTopics").mockResolvedValue({
      topics: [{ ...PENDING, status: "discovering", candidates: [], note: "Osvaldo is busy with: refactor auth." }],
      sources: [],
    } as never);
    render(<TopicsGroup />);
    expect(await screen.findByText(/busy with: refactor auth/)).toBeInTheDocument();
  });

  it("an active topic lists its sources and offers re-discovery", async () => {
    vi.spyOn(api, "getTopics").mockResolvedValue({
      topics: [{ ...PENDING, status: "active", candidates: [] }],
      sources: [{ id: "s1", label: "Spring blog", topicId: "spring-boot", tag: "tech", enabled: true }],
    } as never);
    render(<TopicsGroup />);
    expect(await screen.findByText("Spring blog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /re-discover/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd control-plane && npx vitest run src/organisms/settings/TopicsGroup.test.tsx`
Expected: FAIL — `Cannot find module './TopicsGroup'`

- [ ] **Step 3: Write the implementation**

Mirror `Topic`/`Candidate` into `types.ts` as `TopicT`/`CandidateT`, and `FeedSourceT` with `topicId`. Add the five API functions to `broker.ts` following `saveWorkspace`'s shape (POST/DELETE, JSON in, `{error}` out). Build `TopicsGroup.tsx` following the nearest existing settings group (`ApiKeysGroup.tsx`) for structure: an add row, then one block per topic. A `pending` topic renders its candidates as checkboxes — **all ticked by default** — each showing `label`, `kind`, and `evidence`, plus a baseline text input and an Approve button. An `active` topic lists its sources and a Re-discover button. Any topic with a `note` renders it. Register the group in the settings modal beside the others.

- [ ] **Step 4: Run the gates**

```bash
cd control-plane && pnpm test && pnpm lint && pnpm typecheck
cd ../broker && npm test && npm run typecheck
```
Expected: green. `MapStage.test.tsx`, `NewWorkspaceModal.test.tsx`, `SurfacePolicyPopover.test.tsx` are known load flakes — re-run any failure alone before treating it as a regression.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src
git commit -m "feat: Settings knows what the crew is following"
```

---

### Task 11: Live walk

**Files:** none — verification only.

- [ ] **Step 1: Restart the broker on the new code**

```bash
tmux send-keys -t smith-broker C-c && sleep 2 && tmux send-keys -t smith-broker "npm run serve" Enter
```

- [ ] **Step 2: Track a topic from chat**

Say "track Spring Boot" in the app. Expect Anderson to confirm he has sent someone, and `.smith/feeds/state.json` to gain a `pendingDiscoveries` entry.

- [ ] **Step 3: Watch the bundle land**

When the agent finishes, `.smith/topics/spring-boot.json` should exist and the topic should move to `pending` with candidates. **If the file is missing, the topic must say so** — confirm the note rather than an empty list.

- [ ] **Step 4: Approve in Settings**

Untick anything dead, set the baseline to the version you are actually on, approve. Confirm `sources.json` gains rows with `topicId: "spring-boot"` and that `seenVersions` gained the `owner/repo` baseline.

- [ ] **Step 5: Confirm the thing this feature exists for**

Wait for the ingest tick, then confirm a release **newer than your baseline** produced an item with `release` metadata and a Triage card on the Maintenance board — the behaviour a manually added feed could not produce.

- [ ] **Step 6: Confirm the guards**

`curl -X POST localhost:7790/topics -H 'content-type: application/json' -H 'Origin: http://evil.example' -d '{"name":"x"}'` → 403. Hand-edit a bundle file to include `http://169.254.169.254/` and re-run discovery → that candidate is absent and the note says it was dropped.

- [ ] **Step 7: Remove the stale Spring Boot feed**

The manual RSS source added during the feeds live walk (`https://github.com/spring-projects/spring-boot/releases.atom`) is superseded by the topic. Delete it so the same releases are not ingested twice: `curl -X DELETE localhost:7790/feeds/<id>`.

---

## Self-review

**Spec coverage.** §2 model → Task 1. §3 dispatch + correlation → Tasks 6, 9. §3.1 bundle-as-file → Tasks 2, 6, 9. §4 approve + SSRF → Tasks 2, 4. §5 github release + baseline → Tasks 3, 4, 9. §6 diff → Tasks 5, 9. §7 screen → Task 10. §8 failure table → Tasks 2, 6, 9 (each row has a named test). §9 invariants → each has a test. §10 testing → distributed. §11 out-of-scope → nothing implements them.

**Placeholder scan.** Tasks 9 and 10 step 3 describe wiring and screen structure in prose with the decisions pinned (route order, defaults, which helper to reuse, all-ticked-by-default) rather than full transcription; every piece of logic worth testing lives in Tasks 1–8, which are complete code. Task 9's steps 1–5 each carry their code except step 1, whose five bullets are one-line-each dep methods.

**Type consistency.** `Topic`/`Candidate` are defined once in `topics.ts`; `FeedSource.topicId` and `FeedState.pendingDiscoveries` are added in Task 1 and used in 4, 5, 9. `repoKey()` is defined in `approve.ts` (Task 4) and reused by Task 9's polling branch — same function, not a second copy. `latestFromAtom` returns `{version, notes, publishedAt}`, which is exactly what Task 9 destructures.

**Known gap, flagged not hidden.** A topic has no workspace of its own, so its cards go to `defaultWorkspaceName`. A dependency carries the workspace that declared it; a topic is global. If you later want per-topic workspaces, that is a field on `Topic` and one line in Task 9's polling branch.
