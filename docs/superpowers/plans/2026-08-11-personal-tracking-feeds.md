# Personal Tracking Feeds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the crew a world to live in — small talk that needs no lookup, and "Spring Boot 4.1 is out" arriving as both a spoken remark and a Maintenance card with an action plan.

**Architecture:** One item store fed by four adapters (RSS/Atom, weather, X, package registries). Sources are partly yours and partly derived from your manifests, the crew's roles, and what you keep bringing up. Two consumers read the same store: a ≤150-token digest injected beside the roster in the brain's system prompt, and a `check_feeds` tool for depth. A qualifying release additionally becomes a Triage card.

**Tech Stack:** Broker — Node ≥24, TypeScript, `tsx`, `node:test`, **npm**. Control plane — React 19, HeroUI, TanStack Query, vitest, biome, **pnpm**.

**Spec:** `docs/superpowers/specs/2026-08-11-personal-tracking-feeds-design.md`

## Global Constraints

- Broker: `cd broker && npm test` (`node --import tsx --test src/*.test.ts`), `npm run typecheck`. **No biome in broker.**
- Control plane: `cd control-plane && pnpm test`, `pnpm lint`, `pnpm typecheck`. **pnpm, never npm.** `pnpm lint` exits 0 with 2 pre-existing config diagnostics.
- **Never run `pnpm test` inside a git worktree** — it tries to purge `node_modules`. Use `npx vitest run` there.
- **Every adapter takes an INJECTED fetcher.** No test ever touches the network — the same discipline as `brain.ts`'s `StreamFactory`.
- **Empty configuration ⇒ `turn.digest === ''`** and the brain's prompt is byte-for-byte unchanged. A fresh install pays no token tax.
- The digest never exceeds **150 tokens** and never waits on a network fetch.
- Only **direct** dependencies are watched.
- Nothing is watched without a `reason` visible in Settings and a way to turn it off. A `dismissed` source is never resurrected.
- A qualifying release is spoken exactly once (`spokenAt`) and carded exactly once per workspace (`cardedAt`).
- X never fetches beyond its monthly budget.
- Broker frame types and `control-plane/src/api/types.ts` are kept in lockstep **by hand**.

## File structure

| File | Responsibility |
|---|---|
| `broker/src/feeds/types.ts` | `FeedTag`, `FeedSource`, `FeedItem`, `FeedState` — shared shapes, no logic |
| `broker/src/feeds/store.ts` | Persistence + trimming (30 days / 500 items) + `spokenAt`/`cardedAt` markers |
| `broker/src/feeds/rss.ts` | RSS 2.0 + Atom parsing → `FeedItem[]` |
| `broker/src/feeds/weather.ts` | Open-Meteo reading → the digest's weather line |
| `broker/src/feeds/versions.ts` | npm/Maven/crates version lookup, semver bump, security matcher |
| `broker/src/feeds/manifests.ts` | Direct-dependency extraction from 4 manifest kinds |
| `broker/src/feeds/interests.ts` | Transcript candidates (promote/decay) + role attribution table |
| `broker/src/feeds/derive.ts` | Manifests + candidates → derived sources, dismiss-safe |
| `broker/src/feeds/x.ts` | X adapter behind a monthly budget |
| `broker/src/feeds/ingest.ts` | Scheduler: cadence, jitter, failure counter |
| `broker/src/feeds/digest.ts` | The ≤150-token block + unspoken-release priority |
| `broker/src/feeds/cards.ts` | Qualifying release → Triage card with an action plan |
| `broker/src/brain.ts` | `BrainTurn.digest` + the `check_feeds` tool |
| `broker/src/text-channel.ts`, `main.ts` | Routes + wiring |
| `control-plane/src/organisms/settings/FeedsGroup.tsx` | Settings › Feeds |

---

### Task 1: Shapes and the store

**Files:**
- Create: `broker/src/feeds/types.ts`, `broker/src/feeds/store.ts`
- Test: `broker/src/feeds/store.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the types verbatim from spec §3, plus
  `class FeedStore` with `constructor(io: { read(name: string): string | null; write(name: string, body: string): void })`,
  `sources(): FeedSource[]`, `putSource(s: FeedSource): void`, `removeSource(id: string): void`,
  `items(): FeedItem[]`, `addItems(items: FeedItem[]): FeedItem[]` (returns only the NEW ones),
  `markSpoken(ids: string[], at: string): void`, `markCarded(id: string, at: string): void`,
  `state(): FeedState`, `patchState(p: Partial<FeedState>): void`.

- [ ] **Step 1: Write the failing test**

Create `broker/src/feeds/store.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FeedStore } from './store.ts';
import type { FeedItem, FeedSource } from './types.ts';

function memoryIo() {
  const files = new Map<string, string>();
  return { files, read: (n: string) => files.get(n) ?? null, write: (n: string, b: string) => void files.set(n, b) };
}

const item = (id: string, publishedAt: string): FeedItem => ({
  id, sourceId: 's1', tag: 'news', title: id, publishedAt, summary: '',
});

const source: FeedSource = {
  id: 's1', label: 'Diario Libre', kind: 'rss', locator: 'https://example.test/rss',
  tag: 'news', origin: 'manual', enabled: true,
};

test('sources round-trip through the io seam', () => {
  const io = memoryIo();
  const store = new FeedStore(io);
  store.putSource(source);
  assert.deepEqual(new FeedStore(io).sources(), [source]);
});

test('putSource replaces by id rather than duplicating', () => {
  const store = new FeedStore(memoryIo());
  store.putSource(source);
  store.putSource({ ...source, enabled: false });
  assert.equal(store.sources().length, 1);
  assert.equal(store.sources()[0]!.enabled, false);
});

test('addItems returns only what was new — re-fetching a feed adds nothing', () => {
  const store = new FeedStore(memoryIo());
  const first = store.addItems([item('a', '2026-08-11T00:00:00Z'), item('b', '2026-08-11T01:00:00Z')]);
  assert.equal(first.length, 2);
  const second = store.addItems([item('a', '2026-08-11T00:00:00Z'), item('c', '2026-08-11T02:00:00Z')]);
  assert.deepEqual(second.map((i) => i.id), ['c']);
  assert.equal(store.items().length, 3);
});

test('trimming drops items older than 30 days', () => {
  const store = new FeedStore(memoryIo(), { now: () => new Date('2026-08-11T00:00:00Z') });
  store.addItems([item('old', '2026-06-01T00:00:00Z'), item('fresh', '2026-08-10T00:00:00Z')]);
  assert.deepEqual(store.items().map((i) => i.id), ['fresh']);
});

test('trimming caps at 500 items, keeping the newest', () => {
  const store = new FeedStore(memoryIo(), { now: () => new Date('2026-08-11T00:00:00Z') });
  const many = Array.from({ length: 520 }, (_, i) =>
    item(`i${i}`, new Date(Date.parse('2026-08-01T00:00:00Z') + i * 60_000).toISOString()),
  );
  store.addItems(many);
  assert.equal(store.items().length, 500);
  assert.equal(store.items().some((i) => i.id === 'i0'), false, 'the oldest go first');
  assert.equal(store.items().some((i) => i.id === 'i519'), true);
});

test('markSpoken and markCarded stamp the item and survive a reload', () => {
  const io = memoryIo();
  const store = new FeedStore(io);
  store.addItems([item('rel', '2026-08-11T00:00:00Z')]);
  store.markSpoken(['rel'], '2026-08-11T09:00:00Z');
  store.markCarded('rel', '2026-08-11T09:00:01Z');
  const reloaded = new FeedStore(io).items()[0]!;
  assert.equal(reloaded.spokenAt, '2026-08-11T09:00:00Z');
  assert.equal(reloaded.cardedAt, '2026-08-11T09:00:01Z');
});

test('a corrupt file reads as empty rather than throwing — a bad write must not brick the broker', () => {
  const io = memoryIo();
  io.files.set('sources.json', '{not json');
  assert.deepEqual(new FeedStore(io).sources(), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/feeds/store.test.ts`
Expected: FAIL — `Cannot find module './store.ts'`

- [ ] **Step 3: Write `broker/src/feeds/types.ts`**

```ts
/** Shared feed shapes. No logic lives here — see spec §3. */

export type FeedTag = 'news' | 'tech' | 'sports' | 'gov' | 'release' | 'weather';

export interface FeedSource {
  id: string;
  label: string;
  kind: 'rss' | 'weather' | 'x' | 'registry';
  /** RSS/Atom URL, X handle, registry coordinate, or "lat,lon". */
  locator: string;
  tag: FeedTag;
  /** Manual sources are the human's; derived ones are regenerated and carry `reason`. */
  origin: 'manual' | 'derived';
  /** Why this exists, shown in Settings: "from build.gradle", "you've mentioned RunPod 6×". */
  reason?: string;
  enabled: boolean;
  /** Set when a derived source is dismissed — regeneration must never resurrect it. */
  dismissed?: boolean;
  /** Workspace whose repo declared this (derived release sources only) — decides the card's board. */
  workspace?: string;
}

export interface FeedItem {
  id: string;
  sourceId: string;
  tag: FeedTag;
  title: string;
  url?: string;
  publishedAt: string;
  /** Trimmed to 400 chars at ingest: the store is not an archive. */
  summary: string;
  release?: { name: string; version: string; bump: 'major' | 'minor' | 'patch'; security: boolean };
  /** Stamped when the crew mentions it — the only thing that stops a repeat (spec §5). */
  spokenAt?: string;
  /** Stamped when a card exists for it (spec §5b). */
  cardedAt?: string;
}

export interface FeedState {
  /** sourceId → fetch health. */
  sources: Record<string, { lastFetchedAt?: string; consecutiveFailures: number; lastError?: string }>;
  /** The current reading; not an item, because a temperature is not a document. */
  weather?: { text: string; at: string };
  /** X spend guard: calendar month key → requests made. */
  xUsage: Record<string, number>;
  /** Transcript candidates: name → { mentions, sessions, firstSeen, lastSeen }. */
  candidates: Record<string, { mentions: number; sessions: string[]; firstSeen: string; lastSeen: string }>;
  /** dependency name → last version we have already reacted to. */
  seenVersions: Record<string, string>;
}
```

- [ ] **Step 4: Write `broker/src/feeds/store.ts`**

```ts
/**
 * The one place feed data lives. Three files under .smith/feeds/, read and
 * written through an injected io seam so tests never touch a disk.
 *
 * Trimming runs on every write: 30 days, then a hard cap of 500 items. The
 * `spokenAt`/`cardedAt` markers ride the item, so a trimmed release can never
 * be announced or carded a second time.
 */
import type { FeedItem, FeedSource, FeedState } from './types.ts';

const MAX_ITEMS = 500;
const MAX_AGE_DAYS = 30;

export interface FeedIo {
  read(name: string): string | null;
  write(name: string, body: string): void;
}

const EMPTY_STATE: FeedState = { sources: {}, xUsage: {}, candidates: {}, seenVersions: {} };

export class FeedStore {
  constructor(
    private readonly io: FeedIo,
    private readonly opts: { now?: () => Date } = {},
  ) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /** A corrupt or absent file reads as the fallback: a bad write must not brick the broker. */
  private load<T>(name: string, fallback: T): T {
    try {
      const raw = this.io.read(name);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  sources(): FeedSource[] {
    return this.load<FeedSource[]>('sources.json', []);
  }

  putSource(source: FeedSource): void {
    const all = this.sources().filter((s) => s.id !== source.id);
    all.push(source);
    this.io.write('sources.json', JSON.stringify(all, null, 2));
  }

  removeSource(id: string): void {
    this.io.write('sources.json', JSON.stringify(this.sources().filter((s) => s.id !== id), null, 2));
  }

  items(): FeedItem[] {
    return this.load<FeedItem[]>('items.json', []);
  }

  /** Adds unseen items and returns ONLY those — re-fetching a feed yields nothing. */
  addItems(incoming: FeedItem[]): FeedItem[] {
    const existing = this.items();
    const known = new Set(existing.map((i) => i.id));
    const fresh = incoming.filter((i) => !known.has(i.id));
    if (fresh.length) this.writeItems([...existing, ...fresh]);
    return fresh;
  }

  private writeItems(all: FeedItem[]): void {
    const cutoff = this.now().getTime() - MAX_AGE_DAYS * 86_400_000;
    const kept = all
      .filter((i) => Date.parse(i.publishedAt) >= cutoff)
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      .slice(0, MAX_ITEMS);
    this.io.write('items.json', JSON.stringify(kept, null, 2));
  }

  markSpoken(ids: string[], at: string): void {
    const set = new Set(ids);
    this.writeItems(this.items().map((i) => (set.has(i.id) ? { ...i, spokenAt: at } : i)));
  }

  markCarded(id: string, at: string): void {
    this.writeItems(this.items().map((i) => (i.id === id ? { ...i, cardedAt: at } : i)));
  }

  state(): FeedState {
    return { ...EMPTY_STATE, ...this.load<Partial<FeedState>>('state.json', {}) };
  }

  patchState(patch: Partial<FeedState>): void {
    this.io.write('state.json', JSON.stringify({ ...this.state(), ...patch }, null, 2));
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd broker && node --import tsx --test src/feeds/store.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Typecheck and commit**

```bash
cd broker && npm run typecheck
git add broker/src/feeds/types.ts broker/src/feeds/store.ts broker/src/feeds/store.test.ts
git commit -m "feat: one store for everything the crew reads"
```

---

### Task 2: RSS and Atom

**Files:**
- Create: `broker/src/feeds/rss.ts`
- Test: `broker/src/feeds/rss.test.ts`

**Interfaces:**
- Consumes: `FeedItem`, `FeedSource` from `./types.ts` (Task 1).
- Produces: `function parseFeed(source: FeedSource, xml: string): FeedItem[]`, `function youtubeFeedUrl(url: string): string | null`.

- [ ] **Step 1: Write the failing test**

Create `broker/src/feeds/rss.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFeed, youtubeFeedUrl } from './rss.ts';
import type { FeedSource } from './types.ts';

const SOURCE: FeedSource = {
  id: 's1', label: 'Test', kind: 'rss', locator: 'https://example.test/rss',
  tag: 'tech', origin: 'manual', enabled: true,
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/feeds/rss.test.ts`
Expected: FAIL — `Cannot find module './rss.ts'`

- [ ] **Step 3: Write the implementation**

Create `broker/src/feeds/rss.ts`. Hand-rolled rather than a dependency: two element shapes, no namespaces to honour, and adding a parser dependency to the broker for this is not worth it.

```ts
/**
 * RSS 2.0 and Atom, the two shapes that cover news, blogs, government notices,
 * YouTube channels and GitHub releases (spec §2).
 *
 * Regex, not a DOM: the broker has no XML parser and this reads two known
 * element shapes from feeds we chose. Anything unparseable yields fewer items,
 * never an exception — ingest treats zero items as a failure (Task 10).
 */
import type { FeedItem, FeedSource } from './types.ts';

const SUMMARY_MAX = 400;

function decode(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Decode entities FIRST, then strip tags — otherwise escaped markup survives. */
function plain(text: string): string {
  return decode(text).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX);
}

function tagText(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? decode(m[1]!).trim() : undefined;
}

/** Stable per source+guid so a re-fetch is a no-op in the store. */
function idFor(sourceId: string, guid: string): string {
  let hash = 0;
  for (const ch of `${sourceId}|${guid}`) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return `${sourceId}-${(hash >>> 0).toString(36)}`;
}

export function parseFeed(source: FeedSource, xml: string): FeedItem[] {
  const blocks = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]!);
  return blocks.flatMap((block): FeedItem[] => {
    const title = tagText(block, 'title');
    if (!title) return [];
    const link =
      tagText(block, 'link') ?? /<link[^>]*href="([^"]+)"/i.exec(block)?.[1];
    const guid = tagText(block, 'guid') ?? tagText(block, 'id') ?? link ?? title;
    const raw = tagText(block, 'pubDate') ?? tagText(block, 'updated') ?? tagText(block, 'published');
    const parsed = raw ? Date.parse(raw) : Number.NaN;
    return [
      {
        id: idFor(source.id, guid),
        sourceId: source.id,
        tag: source.tag,
        title: plain(title),
        url: link,
        // No date is not a reason to drop an item — treat it as arriving now.
        publishedAt: Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString(),
        summary: plain(tagText(block, 'description') ?? tagText(block, 'content') ?? tagText(block, 'summary') ?? ''),
      },
    ];
  });
}

/** Every YouTube channel exposes an RSS feed — no Data API key required (spec §2). */
export function youtubeFeedUrl(url: string): string | null {
  const m = /youtube\.com\/channel\/([A-Za-z0-9_-]+)/.exec(url);
  return m ? `https://www.youtube.com/feeds/videos.xml?channel_id=${m[1]}` : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd broker && node --import tsx --test src/feeds/rss.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
cd broker && npm run typecheck
git add broker/src/feeds/rss.ts broker/src/feeds/rss.test.ts
git commit -m "feat: read RSS and Atom, which is most of the world"
```

---

### Task 3: Versions, bumps, and security

**Files:**
- Create: `broker/src/feeds/versions.ts`
- Test: `broker/src/feeds/versions.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Ecosystem = 'npm' | 'maven' | 'cargo'`
  - `function classifyBump(from: string, to: string): 'major' | 'minor' | 'patch' | null` — null when `to` is not newer
  - `function mentionsSecurity(notes: string): boolean`
  - `function qualifies(bump: 'major'|'minor'|'patch', security: boolean): boolean`
  - `function latestVersion(fetchJson: (url: string) => Promise<unknown>, eco: Ecosystem, name: string): Promise<string | null>`

- [ ] **Step 1: Write the failing test**

Create `broker/src/feeds/versions.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyBump, mentionsSecurity, qualifies, latestVersion } from './versions.ts';

test('classifyBump reads semver, ignoring a leading v', () => {
  assert.equal(classifyBump('4.0.7', '5.0.0'), 'major');
  assert.equal(classifyBump('4.0.7', '4.1.0'), 'minor');
  assert.equal(classifyBump('4.0.7', '4.0.8'), 'patch');
  assert.equal(classifyBump('v4.0.7', 'v4.1.0'), 'minor');
});

test('classifyBump returns null when the version is not newer — no re-announcing', () => {
  assert.equal(classifyBump('4.1.0', '4.1.0'), null);
  assert.equal(classifyBump('4.1.0', '4.0.9'), null);
});

test('classifyBump tolerates prerelease and build suffixes', () => {
  assert.equal(classifyBump('4.0.0', '4.1.0-RC1'), 'minor');
  assert.equal(classifyBump('4.0.0', '4.0.1+build.7'), 'patch');
});

test('unparseable versions are null rather than a crash', () => {
  assert.equal(classifyBump('', '4.1.0'), null);
  assert.equal(classifyBump('4.0.0', 'latest'), null);
});

test('mentionsSecurity finds CVEs and security wording', () => {
  assert.equal(mentionsSecurity('Fixes CVE-2026-1234 in the actuator'), true);
  assert.equal(mentionsSecurity('This is a security release'), true);
  assert.equal(mentionsSecurity('security advisory published'), true);
  assert.equal(mentionsSecurity('Improved performance and docs'), false);
  assert.equal(mentionsSecurity('secure by default, as always'), false);
});

test('qualifies: major and minor always; a patch only when it is security', () => {
  assert.equal(qualifies('major', false), true);
  assert.equal(qualifies('minor', false), true);
  assert.equal(qualifies('patch', false), false);
  assert.equal(qualifies('patch', true), true);
});

test('latestVersion reads each ecosystem, and a failure is null not a throw', async () => {
  const npm = async () => ({ version: '19.2.0' });
  assert.equal(await latestVersion(npm, 'npm', 'react'), '19.2.0');

  const maven = async () => ({ response: { docs: [{ latestVersion: '4.1.0' }] } });
  assert.equal(await latestVersion(maven, 'maven', 'org.springframework.boot:spring-boot'), '4.1.0');

  const cargo = async () => ({ crate: { max_stable_version: '2.4.0' } });
  assert.equal(await latestVersion(cargo, 'cargo', 'tauri'), '2.4.0');

  const dead = async () => {
    throw new Error('offline');
  };
  assert.equal(await latestVersion(dead, 'npm', 'react'), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/feeds/versions.test.ts`
Expected: FAIL — `Cannot find module './versions.ts'`

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Cheap check, expensive detail (spec §5). Comparing versions is a small JSON
 * read per dependency per hour; release NOTES are fetched only once a version
 * has already crossed the bar, or to test a patch for a security mention.
 */

export type Ecosystem = 'npm' | 'maven' | 'cargo';

/** Leading v, prerelease and build metadata all stripped before comparison. */
function parts(version: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function classifyBump(from: string, to: string): 'major' | 'minor' | 'patch' | null {
  const a = parts(from);
  const b = parts(to);
  if (!a || !b) return null;
  if (b[0] !== a[0]) return b[0] > a[0] ? 'major' : null;
  if (b[1] !== a[1]) return b[1] > a[1] ? 'minor' : null;
  if (b[2] !== a[2]) return b[2] > a[2] ? 'patch' : null;
  return null; // identical — nothing happened
}

/**
 * `secure by default` must NOT match: the word alone is marketing. A CVE id or
 * an explicit "security <noun>" is the bar.
 */
export function mentionsSecurity(notes: string): boolean {
  return /\bCVE-\d{4}-\d{4,}\b/i.test(notes) || /security\s+(fix|release|advisory|update|patch)/i.test(notes);
}

export function qualifies(bump: 'major' | 'minor' | 'patch', security: boolean): boolean {
  return bump !== 'patch' || security;
}

/** One small JSON read. Any failure is null — a dead registry must not stop ingest. */
export async function latestVersion(
  fetchJson: (url: string) => Promise<unknown>,
  eco: Ecosystem,
  name: string,
): Promise<string | null> {
  try {
    if (eco === 'npm') {
      const body = (await fetchJson(`https://registry.npmjs.org/${name}/latest`)) as { version?: string };
      return body.version ?? null;
    }
    if (eco === 'cargo') {
      const body = (await fetchJson(`https://crates.io/api/v1/crates/${name}`)) as {
        crate?: { max_stable_version?: string };
      };
      return body.crate?.max_stable_version ?? null;
    }
    const [group, artifact] = name.split(':');
    const url = `https://search.maven.org/solrsearch/select?q=g:"${group}"+AND+a:"${artifact}"&rows=1&wt=json`;
    const body = (await fetchJson(url)) as { response?: { docs?: Array<{ latestVersion?: string }> } };
    return body.response?.docs?.[0]?.latestVersion ?? null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd broker && node --import tsx --test src/feeds/versions.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
cd broker && npm run typecheck
git add broker/src/feeds/versions.ts broker/src/feeds/versions.test.ts
git commit -m "feat: know a minor from a patch, and a CVE from marketing"
```

---

### Task 4: Manifests — what the stack actually uses

**Files:**
- Create: `broker/src/feeds/manifests.ts`
- Test: `broker/src/feeds/manifests.test.ts`

**Interfaces:**
- Consumes: `Ecosystem` from `./versions.ts` (Task 3).
- Produces: `interface Dependency { name: string; eco: Ecosystem; version: string; manifest: string }` and
  `function readManifests(io: { read(path: string): string | null }, repoPath: string): Dependency[]`.

- [ ] **Step 1: Write the failing test**

Create `broker/src/feeds/manifests.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readManifests } from './manifests.ts';

function io(files: Record<string, string>) {
  return { read: (p: string) => files[p] ?? null };
}

test('package.json yields DIRECT dependencies only — never devDependencies', () => {
  const deps = readManifests(
    io({
      '/repo/package.json': JSON.stringify({
        dependencies: { react: '^19.0.0', vite: '5.2.0' },
        devDependencies: { vitest: '^4.0.0' },
      }),
    }),
    '/repo',
  );
  assert.deepEqual(deps.map((d) => d.name).sort(), ['react', 'vite']);
  assert.equal(deps.every((d) => d.eco === 'npm'), true);
  assert.equal(deps.find((d) => d.name === 'react')!.version, '19.0.0', 'range markers stripped');
});

test('build.gradle yields group:artifact coordinates', () => {
  const deps = readManifests(
    io({ '/repo/build.gradle': `dependencies {\n  implementation 'org.springframework.boot:spring-boot:4.0.0'\n}` }),
    '/repo',
  );
  assert.deepEqual(deps, [
    { name: 'org.springframework.boot:spring-boot', eco: 'maven', version: '4.0.0', manifest: 'build.gradle' },
  ]);
});

test('pom.xml yields group:artifact coordinates', () => {
  const deps = readManifests(
    io({
      '/repo/pom.xml': `<project><dependencies><dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot</artifactId>
        <version>4.0.0</version>
      </dependency></dependencies></project>`,
    }),
    '/repo',
  );
  assert.equal(deps[0]!.name, 'org.springframework.boot:spring-boot');
  assert.equal(deps[0]!.eco, 'maven');
});

test('Cargo.toml yields crates, in both the short and table forms', () => {
  const deps = readManifests(
    io({ '/repo/Cargo.toml': `[dependencies]\ntauri = "2.0.0"\nserde = { version = "1.0.200", features = ["derive"] }\n` }),
    '/repo',
  );
  assert.deepEqual(deps.map((d) => `${d.name}@${d.version}`).sort(), ['serde@1.0.200', 'tauri@2.0.0']);
});

test('several manifests in one repo all contribute', () => {
  const deps = readManifests(
    io({
      '/repo/package.json': JSON.stringify({ dependencies: { react: '19.0.0' } }),
      '/repo/Cargo.toml': `[dependencies]\ntauri = "2.0.0"\n`,
    }),
    '/repo',
  );
  assert.equal(deps.length, 2);
});

test('no manifests, or unreadable ones, yield nothing rather than throwing', () => {
  assert.deepEqual(readManifests(io({}), '/repo'), []);
  assert.deepEqual(readManifests(io({ '/repo/package.json': '{not json' }), '/repo'), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/feeds/manifests.test.ts`
Expected: FAIL — `Cannot find module './manifests.ts'`

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Direct dependencies, from whichever manifests a repo happens to have
 * (spec §4.1). DIRECT only — a transitive tree would watch hundreds of
 * packages nobody chose.
 *
 * devDependencies are excluded on purpose: a test runner shipping a minor is
 * not news about your product.
 */
import type { Ecosystem } from './versions.ts';

export interface Dependency {
  name: string;
  eco: Ecosystem;
  version: string;
  manifest: string;
}

/** `^19.0.0` / `~1.2` / `>=3` all reduce to the numeric core. */
function bareVersion(raw: string): string {
  return /(\d+\.\d+(?:\.\d+)?)/.exec(raw)?.[1] ?? '';
}

export function readManifests(io: { read(path: string): string | null }, repoPath: string): Dependency[] {
  const out: Dependency[] = [];
  const read = (name: string) => io.read(`${repoPath}/${name}`);

  const pkg = read('package.json');
  if (pkg) {
    try {
      const body = JSON.parse(pkg) as { dependencies?: Record<string, string> };
      for (const [name, range] of Object.entries(body.dependencies ?? {})) {
        out.push({ name, eco: 'npm', version: bareVersion(range), manifest: 'package.json' });
      }
    } catch {
      /* unreadable manifest contributes nothing */
    }
  }

  for (const file of ['build.gradle', 'build.gradle.kts']) {
    const gradle = read(file);
    if (!gradle) continue;
    for (const m of gradle.matchAll(/['"]([\w.-]+):([\w.-]+):([\w.+-]+)['"]/g)) {
      out.push({ name: `${m[1]}:${m[2]}`, eco: 'maven', version: bareVersion(m[3]!), manifest: file });
    }
  }

  const pom = read('pom.xml');
  if (pom) {
    for (const m of pom.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
      const block = m[1]!;
      const group = /<groupId>([^<]+)<\/groupId>/.exec(block)?.[1];
      const artifact = /<artifactId>([^<]+)<\/artifactId>/.exec(block)?.[1];
      const version = /<version>([^<]+)<\/version>/.exec(block)?.[1] ?? '';
      if (group && artifact) {
        out.push({ name: `${group}:${artifact}`, eco: 'maven', version: bareVersion(version), manifest: 'pom.xml' });
      }
    }
  }

  const cargo = read('Cargo.toml');
  if (cargo) {
    // Only the [dependencies] table; [dev-dependencies] is excluded like npm's.
    const section = /\[dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(cargo)?.[1] ?? '';
    for (const line of section.split('\n')) {
      const short = /^\s*([\w-]+)\s*=\s*"([^"]+)"/.exec(line);
      const table = /^\s*([\w-]+)\s*=\s*\{[^}]*version\s*=\s*"([^"]+)"/.exec(line);
      const hit = short ?? table;
      if (hit) out.push({ name: hit[1]!, eco: 'cargo', version: bareVersion(hit[2]!), manifest: 'Cargo.toml' });
    }
  }

  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd broker && node --import tsx --test src/feeds/manifests.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
cd broker && npm run typecheck
git add broker/src/feeds/manifests.ts broker/src/feeds/manifests.test.ts
git commit -m "feat: the stack declares its own interests"
```

---

### Task 5: Transcript candidates and role attribution

**Files:**
- Create: `broker/src/feeds/interests.ts`
- Test: `broker/src/feeds/interests.test.ts`

**Interfaces:**
- Consumes: `FeedState` from `./types.ts` (Task 1), `Dependency` from `./manifests.ts` (Task 4).
- Produces:
  - `function extractCandidates(text: string, exclude: string[]): string[]`
  - `function recordMentions(state: FeedState, names: string[], sessionId: string, at: string): FeedState['candidates']`
  - `function promotable(candidates: FeedState['candidates'], at: string): string[]`
  - `function expired(candidates: FeedState['candidates'], at: string): string[]`
  - `function ownerRole(dep: Dependency, security: boolean): string | null`

- [ ] **Step 1: Write the failing test**

Create `broker/src/feeds/interests.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractCandidates, recordMentions, promotable, expired, ownerRole } from './interests.ts';
import type { FeedState } from './types.ts';

const EXCLUDE = ['Anderson', 'Osvaldo', 'jefelabs'];

test('extracts package-shaped and proper-noun tokens', () => {
  const found = extractCandidates('I keep looking at RunPod and spring-boot for this', EXCLUDE);
  assert.equal(found.includes('RunPod'), true);
  assert.equal(found.includes('spring-boot'), true);
});

test('never extracts agent names, workspace names, or common words', () => {
  const found = extractCandidates('Anderson can ask Osvaldo about jefelabs. The Thing works.', EXCLUDE);
  assert.deepEqual(found, []);
});

test('a name must be mentioned enough, across enough sessions, to promote', () => {
  let c: FeedState['candidates'] = {};
  c = recordMentions({ candidates: c } as FeedState, ['RunPod'], 's1', '2026-08-01T00:00:00Z');
  c = recordMentions({ candidates: c } as FeedState, ['RunPod'], 's1', '2026-08-02T00:00:00Z');
  assert.deepEqual(promotable(c, '2026-08-03T00:00:00Z'), [], 'two mentions in ONE session is not enough');

  c = recordMentions({ candidates: c } as FeedState, ['RunPod'], 's2', '2026-08-03T00:00:00Z');
  assert.deepEqual(promotable(c, '2026-08-03T00:00:00Z'), ['RunPod']);
});

test('mentions spread beyond 14 days do not accumulate into a promotion', () => {
  let c: FeedState['candidates'] = {};
  c = recordMentions({ candidates: c } as FeedState, ['RunPod'], 's1', '2026-07-01T00:00:00Z');
  c = recordMentions({ candidates: c } as FeedState, ['RunPod'], 's2', '2026-07-02T00:00:00Z');
  c = recordMentions({ candidates: c } as FeedState, ['RunPod'], 's3', '2026-08-01T00:00:00Z');
  assert.deepEqual(promotable(c, '2026-08-01T00:00:00Z'), []);
});

test('an interest unmentioned for 30 days expires', () => {
  const c: FeedState['candidates'] = {
    RunPod: { mentions: 9, sessions: ['s1', 's2'], firstSeen: '2026-06-01T00:00:00Z', lastSeen: '2026-07-01T00:00:00Z' },
    Tauri: { mentions: 9, sessions: ['s1', 's2'], firstSeen: '2026-08-01T00:00:00Z', lastSeen: '2026-08-10T00:00:00Z' },
  };
  assert.deepEqual(expired(c, '2026-08-11T00:00:00Z'), ['RunPod']);
});

test('ownerRole attributes by an ordered table, first match winning', () => {
  const dep = (name: string, eco: 'npm' | 'maven' | 'cargo') => ({ name, eco, version: '1.0.0', manifest: 'm' });
  assert.equal(ownerRole(dep('react', 'npm'), false), 'Frontend Engineer');
  assert.equal(ownerRole(dep('org.springframework.boot:spring-boot', 'maven'), false), 'Backend Engineer');
  assert.equal(ownerRole(dep('tauri', 'cargo'), false), 'Mobile Engineer');
  assert.equal(ownerRole(dep('torch', 'npm'), false), 'Data / ML Engineer');
});

test('a security release is the Security Engineer\'s, whatever the ecosystem', () => {
  assert.equal(ownerRole({ name: 'react', eco: 'npm', version: '1', manifest: 'm' }, true), 'Security Engineer');
});

test('an unmatched dependency is unattributed — attribution never invents a speaker', () => {
  assert.equal(ownerRole({ name: 'left-pad', eco: 'npm', version: '1', manifest: 'm' }, false), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/feeds/interests.test.ts`
Expected: FAIL — `Cannot find module './interests.ts'`

- [ ] **Step 3: Write the implementation**

```ts
/**
 * What the human keeps bringing up, and who on the crew owns a given release.
 *
 * Promotion is deliberately hard and reversal is easy (spec §4.3): three
 * mentions across two sessions inside 14 days, and the caller must ALSO
 * resolve the name in a package registry before it becomes a source — that
 * resolution is what drops conversational noise.
 */
import type { Dependency } from './manifests.ts';
import type { FeedState } from './types.ts';

const PROMOTE_MENTIONS = 3;
const PROMOTE_SESSIONS = 2;
const PROMOTE_WINDOW_DAYS = 14;
const EXPIRE_DAYS = 30;

/** Words that look like proper nouns in ordinary prose. Not exhaustive; the registry check is the real filter. */
const STOPWORDS = new Set([
  'the', 'this', 'that', 'thing', 'today', 'tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday',
  'friday', 'saturday', 'sunday', 'ok', 'okay', 'yes', 'no', 'hola', 'gracias', 'bueno', 'claro',
  'ahora', 'manana', 'hoy', 'and', 'but', 'for', 'you', 'i', 'we', 'it',
]);

const PACKAGE_SHAPED = /^@?[a-z0-9][a-z0-9._-]{2,}$/;
const PROPER_NOUN = /^[A-Z][A-Za-z0-9]{2,}$/;

export function extractCandidates(text: string, exclude: string[]): string[] {
  const banned = new Set(exclude.map((e) => e.toLowerCase()));
  const seen = new Set<string>();
  for (const token of text.split(/[^\w@./-]+/)) {
    if (!token || banned.has(token.toLowerCase()) || STOPWORDS.has(token.toLowerCase())) continue;
    // A package name must contain a separator; a bare lowercase word is prose.
    const isPackage = PACKAGE_SHAPED.test(token) && /[-._@]/.test(token);
    if (isPackage || PROPER_NOUN.test(token)) seen.add(token);
  }
  return [...seen];
}

export function recordMentions(
  state: Pick<FeedState, 'candidates'>,
  names: string[],
  sessionId: string,
  at: string,
): FeedState['candidates'] {
  const next = { ...state.candidates };
  for (const name of names) {
    const prior = next[name];
    next[name] = prior
      ? {
          mentions: prior.mentions + 1,
          sessions: prior.sessions.includes(sessionId) ? prior.sessions : [...prior.sessions, sessionId],
          firstSeen: prior.firstSeen,
          lastSeen: at,
        }
      : { mentions: 1, sessions: [sessionId], firstSeen: at, lastSeen: at };
  }
  return next;
}

export function promotable(candidates: FeedState['candidates'], at: string): string[] {
  const now = Date.parse(at);
  return Object.entries(candidates)
    .filter(([, c]) => {
      const withinWindow = now - Date.parse(c.firstSeen) <= PROMOTE_WINDOW_DAYS * 86_400_000;
      return withinWindow && c.mentions >= PROMOTE_MENTIONS && c.sessions.length >= PROMOTE_SESSIONS;
    })
    .map(([name]) => name);
}

export function expired(candidates: FeedState['candidates'], at: string): string[] {
  const now = Date.parse(at);
  return Object.entries(candidates)
    .filter(([, c]) => now - Date.parse(c.lastSeen) > EXPIRE_DAYS * 86_400_000)
    .map(([name]) => name);
}

/**
 * Who speaks a release line (spec §4.2). Ordered — first match wins, so
 * attribution is deterministic. A miss is null: Anderson delivers it himself
 * rather than a speaker being invented.
 */
const OWNERS: Array<{ role: string; match: (d: Dependency) => boolean }> = [
  { role: 'Mobile Engineer', match: (d) => d.eco === 'cargo' || /^(react-native|expo|capacitor)/.test(d.name) },
  {
    role: 'Frontend Engineer',
    match: (d) => d.eco === 'npm' && /^(react|vue|svelte|vite|next|tailwind|@heroui)/.test(d.name),
  },
  { role: 'Backend Engineer', match: (d) => d.eco === 'maven' || /^(express|fastify|nest)/.test(d.name) },
  { role: 'DevOps / Platform', match: (d) => /^(docker|terraform|kubernetes)/.test(d.name) || /-cli$/.test(d.name) },
  { role: 'Data / ML Engineer', match: (d) => /^(pandas|numpy|torch|langchain|@anthropic-ai)/.test(d.name) },
];

export function ownerRole(dep: Dependency, security: boolean): string | null {
  // Security outranks the table: a CVE is the Security Engineer's business
  // whatever ecosystem it arrived from (spec §4.2).
  if (security) return 'Security Engineer';
  return OWNERS.find((o) => o.match(dep))?.role ?? null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd broker && node --import tsx --test src/feeds/interests.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
cd broker && npm run typecheck
git add broker/src/feeds/interests.ts broker/src/feeds/interests.test.ts
git commit -m "feat: what you keep mentioning, and whose beat it is"
```

---

### Task 6: Derivation

**Files:**
- Create: `broker/src/feeds/derive.ts`
- Test: `broker/src/feeds/derive.test.ts`

**Interfaces:**
- Consumes: `FeedSource` (Task 1), `Dependency` (Task 4), `promotable`/`expired` (Task 5).
- Produces:
  `function deriveSources(input: { deps: Array<Dependency & { workspace: string }>; promoted: Array<{ name: string; eco: Ecosystem; mentions: number }>; existing: FeedSource[] }): FeedSource[]`
  — the full derived set, preserving `dismissed`, and `function releaseSourceId(name: string, workspace: string): string`.

- [ ] **Step 1: Write the failing test**

Create `broker/src/feeds/derive.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveSources, releaseSourceId } from './derive.ts';
import type { FeedSource } from './types.ts';

const dep = (name: string, workspace = 'jefelabs') => ({
  name, eco: 'maven' as const, version: '4.0.0', manifest: 'build.gradle', workspace,
});

test('a dependency becomes a derived release source carrying its reason', () => {
  const [source] = deriveSources({ deps: [dep('org.springframework.boot:spring-boot')], promoted: [], existing: [] });
  assert.equal(source!.origin, 'derived');
  assert.equal(source!.tag, 'release');
  assert.equal(source!.workspace, 'jefelabs');
  assert.match(source!.reason!, /build\.gradle/);
});

test('the same dependency in two workspaces yields a source for each', () => {
  const sources = deriveSources({
    deps: [dep('org.springframework.boot:spring-boot', 'jefelabs'), dep('org.springframework.boot:spring-boot', 'acme')],
    promoted: [],
    existing: [],
  });
  assert.equal(sources.length, 2);
  assert.deepEqual(sources.map((s) => s.workspace).sort(), ['acme', 'jefelabs']);
});

test('a promoted transcript interest becomes a source, and says why', () => {
  const [source] = deriveSources({
    deps: [],
    promoted: [{ name: 'runpod', eco: 'npm', mentions: 6 }],
    existing: [],
  });
  assert.match(source!.reason!, /mentioned.*6/i);
});

test('a DISMISSED derived source is never resurrected', () => {
  const existing: FeedSource[] = [
    {
      id: releaseSourceId('org.springframework.boot:spring-boot', 'jefelabs'),
      label: 'spring-boot', kind: 'registry', locator: 'maven:org.springframework.boot:spring-boot',
      tag: 'release', origin: 'derived', enabled: true, dismissed: true, workspace: 'jefelabs',
    },
  ];
  const sources = deriveSources({ deps: [dep('org.springframework.boot:spring-boot')], promoted: [], existing });
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.dismissed, true, 'the dismissal survives regeneration');
});

test('a dependency that disappears from the manifest drops its source', () => {
  const existing: FeedSource[] = [
    {
      id: releaseSourceId('gone', 'jefelabs'), label: 'gone', kind: 'registry', locator: 'npm:gone',
      tag: 'release', origin: 'derived', enabled: true, workspace: 'jefelabs',
    },
  ];
  const sources = deriveSources({ deps: [dep('kept')], promoted: [], existing });
  assert.deepEqual(sources.map((s) => s.label), ['kept']);
});

test('manual sources are never touched by derivation', () => {
  const manual: FeedSource = {
    id: 'm1', label: 'Diario Libre', kind: 'rss', locator: 'https://x.test/rss',
    tag: 'news', origin: 'manual', enabled: true,
  };
  const sources = deriveSources({ deps: [], promoted: [], existing: [manual] });
  assert.deepEqual(sources, [], 'deriveSources returns only the DERIVED set');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/feeds/derive.test.ts`
Expected: FAIL — `Cannot find module './derive.ts'`

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Manifests and promoted interests become derived sources (spec §4).
 *
 * Returns the DERIVED set only — the caller merges it with manual sources, so
 * a bug here can never delete something the human added by hand.
 */
import type { Dependency } from './manifests.ts';
import type { Ecosystem } from './versions.ts';
import type { FeedSource } from './types.ts';

/** Stable, so regeneration updates a source in place instead of duplicating it. */
export function releaseSourceId(name: string, workspace: string): string {
  return `rel:${workspace}:${name}`;
}

export function deriveSources(input: {
  deps: Array<Dependency & { workspace: string }>;
  promoted: Array<{ name: string; eco: Ecosystem; mentions: number }>;
  existing: FeedSource[];
}): FeedSource[] {
  const dismissed = new Set(input.existing.filter((s) => s.dismissed).map((s) => s.id));
  const out = new Map<string, FeedSource>();

  const add = (name: string, eco: Ecosystem, workspace: string, reason: string) => {
    const id = releaseSourceId(name, workspace);
    if (out.has(id)) return;
    out.set(id, {
      id,
      label: name.includes(':') ? name.split(':')[1]! : name,
      kind: 'registry',
      locator: `${eco}:${name}`,
      tag: 'release',
      origin: 'derived',
      reason,
      enabled: true,
      // A dismissal is a standing instruction, not a one-off (spec §4.3).
      dismissed: dismissed.has(id) ? true : undefined,
      workspace,
    });
  };

  for (const dep of input.deps) {
    add(dep.name, dep.eco, dep.workspace, `from ${dep.manifest} in ${dep.workspace}`);
  }
  for (const p of input.promoted) {
    add(p.name, p.eco, '', `you've mentioned ${p.name} ${p.mentions}×`);
  }
  return [...out.values()];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd broker && node --import tsx --test src/feeds/derive.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
cd broker && npm run typecheck
git add broker/src/feeds/derive.ts broker/src/feeds/derive.test.ts
git commit -m "feat: sources you never had to type"
```

---

### Task 7: Weather

**Files:**
- Create: `broker/src/feeds/weather.ts`
- Test: `broker/src/feeds/weather.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `function weatherLine(body: unknown): string | null` and
  `function weatherUrl(lat: number, lon: number): string`.

- [ ] **Step 1: Write the failing test**

Create `broker/src/feeds/weather.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { weatherLine, weatherUrl } from './weather.ts';

const BODY = {
  current: { temperature_2m: 29.4, weather_code: 0 },
  hourly: {
    time: ['2026-08-11T14:00', '2026-08-11T15:00', '2026-08-11T16:00'],
    precipitation_probability: [10, 80, 20],
  },
};

test('renders a short line: temperature, sky, and the rain hour if there is one', () => {
  assert.equal(weatherLine(BODY), '29°C, clear; rain likely 15:00.');
});

test('no likely rain means no rain clause', () => {
  const dry = { ...BODY, hourly: { ...BODY.hourly, precipitation_probability: [5, 10, 5] } };
  assert.equal(weatherLine(dry), '29°C, clear.');
});

test('weather codes map to words a person would use', () => {
  assert.match(weatherLine({ ...BODY, current: { temperature_2m: 25, weather_code: 61 } })!, /rain/i);
  assert.match(weatherLine({ ...BODY, current: { temperature_2m: 25, weather_code: 3 } })!, /overcast/i);
  assert.match(weatherLine({ ...BODY, current: { temperature_2m: 25, weather_code: 95 } })!, /storm/i);
});

test('an unusable body is null, so the digest simply drops the line', () => {
  assert.equal(weatherLine({}), null);
  assert.equal(weatherLine(null), null);
  assert.equal(weatherLine({ current: {} }), null);
});

test('the URL asks for exactly the two things the line needs — and no API key', () => {
  const url = weatherUrl(18.48, -69.93);
  assert.match(url, /latitude=18\.48/);
  assert.match(url, /longitude=-69\.93/);
  assert.match(url, /current=temperature_2m,weather_code/);
  assert.equal(/key|token|appid/i.test(url), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/feeds/weather.test.ts`
Expected: FAIL — `Cannot find module './weather.ts'`

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Open-Meteo: no key, no account, no quota worth worrying about.
 *
 * Weather is not an item (spec §3) — it is one current reading rendered
 * straight into the digest, because a temperature is not a document.
 */

/** WMO weather codes, collapsed to words a person would actually say. */
function sky(code: number): string {
  if (code === 0) return 'clear';
  if (code <= 2) return 'partly cloudy';
  if (code === 3) return 'overcast';
  if (code >= 95) return 'storms';
  if (code >= 80) return 'showers';
  if (code >= 61) return 'rain';
  if (code >= 45) return 'fog';
  return 'clear';
}

export function weatherUrl(lat: number, lon: number): string {
  return (
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,weather_code&hourly=precipitation_probability&forecast_days=1`
  );
}

export function weatherLine(body: unknown): string | null {
  const b = body as {
    current?: { temperature_2m?: number; weather_code?: number };
    hourly?: { time?: string[]; precipitation_probability?: number[] };
  } | null;
  const temp = b?.current?.temperature_2m;
  if (typeof temp !== 'number') return null;

  const base = `${Math.round(temp)}°C, ${sky(b?.current?.weather_code ?? 0)}`;
  const times = b?.hourly?.time ?? [];
  const probs = b?.hourly?.precipitation_probability ?? [];
  const idx = probs.findIndex((p) => p >= 60);
  if (idx === -1 || !times[idx]) return `${base}.`;
  return `${base}; rain likely ${times[idx]!.slice(11, 16)}.`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd broker && node --import tsx --test src/feeds/weather.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
cd broker && npm run typecheck
git add broker/src/feeds/weather.ts broker/src/feeds/weather.test.ts
git commit -m "feat: the crew can tell you it's going to rain"
```

---

### Task 8: X, behind a budget

**Files:**
- Create: `broker/src/feeds/x.ts`
- Test: `broker/src/feeds/x.test.ts`

**Interfaces:**
- Consumes: `FeedItem`, `FeedSource`, `FeedState` (Task 1).
- Produces:
  `interface XBudget { monthKey(at: string): string; remaining(state: FeedState, at: string, cap: number): number }`,
  `function parsePosts(source: FeedSource, body: unknown): FeedItem[]`,
  `async function fetchX(deps: { fetchJson(url: string, token: string): Promise<unknown>; token: string | null; cap: number; now(): string }, source: FeedSource, state: FeedState): Promise<{ items: FeedItem[]; usage: number; skipped?: string }>`

- [ ] **Step 1: Write the failing test**

Create `broker/src/feeds/x.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchX, parsePosts } from './x.ts';
import type { FeedSource, FeedState } from './types.ts';

const SOURCE: FeedSource = {
  id: 'x1', label: '@dr1com', kind: 'x', locator: 'dr1com', tag: 'news', origin: 'manual', enabled: true,
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

test('a fetch counts against the month\'s budget', async () => {
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/feeds/x.test.ts`
Expected: FAIL — `Cannot find module './x.ts'`

- [ ] **Step 3: Write the implementation**

```ts
/**
 * The one adapter that can generate a bill, so the one adapter with a hard
 * stop (spec §9.3).
 *
 * Every outcome is a value, never an exception: no key, over budget, or rate
 * limited all come back as `skipped` with a reason the Settings screen shows.
 */
import type { FeedItem, FeedSource, FeedState } from './types.ts';

export function monthKey(at: string): string {
  return at.slice(0, 7); // YYYY-MM — a calendar month, matching how the bill arrives
}

export function parsePosts(source: FeedSource, body: unknown): FeedItem[] {
  const data = (body as { data?: Array<{ id?: string; text?: string; created_at?: string }> })?.data ?? [];
  return data.flatMap((post) => {
    if (!post.id || !post.text) return [];
    return [
      {
        id: `${source.id}-${post.id}`,
        sourceId: source.id,
        tag: source.tag,
        title: post.text.slice(0, 200),
        url: `https://x.com/${source.locator}/status/${post.id}`,
        publishedAt: post.created_at ?? new Date().toISOString(),
        summary: post.text.slice(0, 400),
      },
    ];
  });
}

export async function fetchX(
  deps: { fetchJson(url: string, token: string): Promise<unknown>; token: string | null; cap: number; now(): string },
  source: FeedSource,
  state: FeedState,
): Promise<{ items: FeedItem[]; usage: number; skipped?: string }> {
  const key = monthKey(deps.now());
  const used = state.xUsage[key] ?? 0;

  if (!deps.token) return { items: [], usage: used, skipped: 'no API key configured' };
  if (used >= deps.cap) return { items: [], usage: used, skipped: `monthly budget reached (${used}/${deps.cap})` };

  try {
    const url = `https://api.x.com/2/tweets/search/recent?query=from:${encodeURIComponent(source.locator)}&max_results=10&tweet.fields=created_at`;
    const body = await deps.fetchJson(url, deps.token);
    return { items: parsePosts(source, body), usage: used + 1 };
  } catch (err) {
    // A rate limit costs nothing and must not count against the budget.
    return { items: [], usage: used, skipped: String((err as Error).message ?? err) };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd broker && node --import tsx --test src/feeds/x.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
cd broker && npm run typecheck
git add broker/src/feeds/x.ts broker/src/feeds/x.test.ts
git commit -m "feat: X, on a leash"
```

---

### Task 9: The digest

**Files:**
- Create: `broker/src/feeds/digest.ts`
- Test: `broker/src/feeds/digest.test.ts`

**Interfaces:**
- Consumes: `FeedItem`, `FeedState` (Task 1).
- Produces: `function buildDigest(input: { items: FeedItem[]; weather?: string; owners: Record<string, string>; now: string }): { text: string; unspokenIds: string[] }`.

- [ ] **Step 1: Write the failing test**

Create `broker/src/feeds/digest.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDigest } from './digest.ts';
import type { FeedItem } from './types.ts';

const NOW = '2026-08-11T12:00:00Z';
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();

const news = (id: string, title: string, hours = 2): FeedItem => ({
  id, sourceId: 'n', tag: 'news', title, publishedAt: hoursAgo(hours), summary: '',
});

const release = (id: string, name: string, version: string, spoken?: string): FeedItem => ({
  id, sourceId: 'r', tag: 'release', title: `${name} ${version}`, publishedAt: hoursAgo(4), summary: '',
  release: { name, version, bump: 'minor', security: false },
  spokenAt: spoken,
});

test('an empty store yields an EMPTY digest — a fresh install pays no token tax', () => {
  assert.deepEqual(buildDigest({ items: [], owners: {}, now: NOW }), { text: '', unspokenIds: [] });
});

test('the weather leads', () => {
  const { text } = buildDigest({ items: [], weather: '29°C, clear.', owners: {}, now: NOW });
  assert.match(text, /^TODAY .*29°C, clear\./m);
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/feeds/digest.test.ts`
Expected: FAIL — `Cannot find module './digest.ts'`

- [ ] **Step 3: Write the implementation**

```ts
/**
 * The block that rides in the brain's system prompt beside the roster
 * (spec §6). Small, bounded, and built on a timer so a conversation never
 * waits on a fetch.
 *
 * Empty in, empty out: with nothing configured the prompt is byte-for-byte
 * what it was before this feature existed.
 */
import type { FeedItem } from './types.ts';

const WINDOW_HOURS = 48;
/** 150 tokens at the standard ~4-chars-per-token estimate. */
const MAX_CHARS = 600;
const TAG_ORDER: Array<'tech' | 'news' | 'sports' | 'gov'> = ['tech', 'news', 'sports', 'gov'];

export function buildDigest(input: {
  items: FeedItem[];
  weather?: string;
  /** dependency name → agent name, so a release line can be spoken in that voice. */
  owners: Record<string, string>;
  now: string;
}): { text: string; unspokenIds: string[] } {
  const cutoff = Date.parse(input.now) - WINDOW_HOURS * 3_600_000;
  const recent = input.items
    .filter((i) => Date.parse(i.publishedAt) >= cutoff)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));

  const unspoken = recent.filter((i) => i.release && !i.spokenAt);
  const lines: string[] = [];

  if (input.weather) lines.push(`TODAY · ${input.weather}`);

  // Releases first: this is the half the human asked to be told about.
  if (unspoken.length) {
    const rendered = unspoken.slice(0, 4).map((i) => {
      const owner = input.owners[i.release!.name];
      return `${i.release!.name} ${i.release!.version}${owner ? ` [${owner}]` : ''}`;
    });
    lines.push(`releases — ${rendered.join(' · ')}`);
  }

  for (const tag of TAG_ORDER) {
    const top = recent.filter((i) => i.tag === tag && !i.release).slice(0, 2);
    if (top.length) lines.push(`${tag} — ${top.map((i) => i.title).join(' · ')}`);
  }

  // Trim from the END: weather and releases are the lines worth keeping.
  let text = lines.join('\n');
  while (text.length > MAX_CHARS && lines.length > 1) {
    lines.pop();
    text = lines.join('\n');
  }
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS - 1)}…`;

  return { text: text ? `\n\n${text}\n` : '', unspokenIds: unspoken.slice(0, 4).map((i) => i.id) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd broker && node --import tsx --test src/feeds/digest.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
cd broker && npm run typecheck
git add broker/src/feeds/digest.ts broker/src/feeds/digest.test.ts
git commit -m "feat: 150 tokens of world, beside the roster"
```

---

### Task 10: The ingest scheduler

**Files:**
- Create: `broker/src/feeds/ingest.ts`
- Test: `broker/src/feeds/ingest.test.ts`

**Interfaces:**
- Consumes: `FeedStore` (Task 1), `parseFeed` (Task 2), `FeedSource`/`FeedState`.
- Produces:
  `const CADENCE_MS: Record<FeedSource['kind'], number>`,
  `function dueSources(sources: FeedSource[], state: FeedState, now: number): FeedSource[]`,
  `function recordOutcome(state: FeedState, sourceId: string, outcome: { ok: boolean; at: string; error?: string }): FeedState`,
  `function isDisabled(state: FeedState, sourceId: string): boolean`.

- [ ] **Step 1: Write the failing test**

Create `broker/src/feeds/ingest.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CADENCE_MS, dueSources, recordOutcome, isDisabled } from './ingest.ts';
import type { FeedSource, FeedState } from './types.ts';

const NOW = Date.parse('2026-08-11T12:00:00Z');
const rss: FeedSource = {
  id: 's1', label: 'a', kind: 'rss', locator: 'u', tag: 'news', origin: 'manual', enabled: true,
};
const EMPTY: FeedState = { sources: {}, xUsage: {}, candidates: {}, seenVersions: {} };

test('a never-fetched source is due', () => {
  assert.deepEqual(dueSources([rss], EMPTY, NOW).map((s) => s.id), ['s1']);
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/feeds/ingest.test.ts`
Expected: FAIL — `Cannot find module './ingest.ts'`

- [ ] **Step 3: Write the implementation**

```ts
/**
 * When each source is next due, and what a failure does (spec §9.2, §10).
 *
 * Pure scheduling decisions — the actual fetching lives in main.ts's wiring,
 * so this file can be tested against a clock with no network at all.
 */
import type { FeedSource, FeedState } from './types.ts';

export const CADENCE_MS: Record<FeedSource['kind'], number> = {
  rss: 20 * 60_000,
  weather: 30 * 60_000,
  x: 30 * 60_000,
  registry: 60 * 60_000,
};

/** Five consecutive failures disables a source: silent decay is the failure nobody notices. */
const MAX_FAILURES = 5;

export function isDisabled(state: FeedState, sourceId: string): boolean {
  return (state.sources[sourceId]?.consecutiveFailures ?? 0) >= MAX_FAILURES;
}

export function dueSources(sources: FeedSource[], state: FeedState, now: number): FeedSource[] {
  return sources.filter((source) => {
    if (!source.enabled || source.dismissed || isDisabled(state, source.id)) return false;
    const last = state.sources[source.id]?.lastFetchedAt;
    if (!last) return true;
    // ±10% jitter so a restart does not fire every adapter at the same instant.
    const jitter = CADENCE_MS[source.kind] * 0.1;
    return now - Date.parse(last) >= CADENCE_MS[source.kind] - jitter;
  });
}

export function recordOutcome(
  state: FeedState,
  sourceId: string,
  outcome: { ok: boolean; at: string; error?: string },
): FeedState {
  const prior = state.sources[sourceId] ?? { consecutiveFailures: 0 };
  return {
    ...state,
    sources: {
      ...state.sources,
      [sourceId]: {
        lastFetchedAt: outcome.at,
        consecutiveFailures: outcome.ok ? 0 : prior.consecutiveFailures + 1,
        lastError: outcome.ok ? undefined : outcome.error,
      },
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd broker && node --import tsx --test src/feeds/ingest.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
cd broker && npm run typecheck
git add broker/src/feeds/ingest.ts broker/src/feeds/ingest.test.ts
git commit -m "feat: a schedule, and a feed that dies loudly"
```

---

### Task 11: Releases become cards

**Files:**
- Create: `broker/src/feeds/cards.ts`
- Test: `broker/src/feeds/cards.test.ts`

**Interfaces:**
- Consumes: `FeedItem` (Task 1).
- Produces:
  `function boardTypeFor(item: FeedItem): 'reactive' | 'maintenance'`,
  `function cardTitle(item: FeedItem, currentVersion: string): string`,
  `async function cardForRelease(deps: { boards(): Promise<Array<{ id: string; type: string; workspaceId?: string }>>; addCard(boardId: string, card: { title: string; notes: string; columnId: string }): Promise<void>; plan(item: FeedItem, currentVersion: string): Promise<string>; now(): string }, item: FeedItem, ctx: { workspace: string; currentVersion: string }): Promise<{ carded: boolean; reason?: string }>`

- [ ] **Step 1: Write the failing test**

Create `broker/src/feeds/cards.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardTypeFor, cardTitle, cardForRelease } from './cards.ts';
import type { FeedItem } from './types.ts';

const rel = (over: Partial<FeedItem['release']> = {}): FeedItem => ({
  id: 'r1', sourceId: 's', tag: 'release', title: 'spring-boot 4.1.0',
  publishedAt: '2026-08-11T00:00:00Z', summary: 'Virtual threads by default.',
  release: { name: 'spring-boot', version: '4.1.0', bump: 'minor', security: false, ...over },
});

const BOARDS = [
  { id: 'b-maint', type: 'maintenance', workspaceId: 'jefelabs' },
  { id: 'b-react', type: 'reactive', workspaceId: 'jefelabs' },
  { id: 'b-maint-other', type: 'maintenance', workspaceId: 'acme' },
];

function deps(sink: unknown[]) {
  return {
    boards: async () => BOARDS,
    addCard: async (boardId: string, card: { title: string; notes: string; columnId: string }) =>
      void sink.push({ boardId, ...card }),
    plan: async () => '1. Read the notes\n2. Bump the version',
    now: () => '2026-08-11T10:00:00Z',
  };
}

test('an ordinary release lands on Maintenance, in Triage', async () => {
  const sink: unknown[] = [];
  const result = await cardForRelease(deps(sink), rel(), { workspace: 'jefelabs', currentVersion: '4.0.7' });
  assert.equal(result.carded, true);
  assert.deepEqual(sink, [
    {
      boardId: 'b-maint',
      title: 'Upgrade spring-boot 4.0.7 → 4.1.0',
      notes: '1. Read the notes\n2. Bump the version',
      columnId: 'triage',
    },
  ]);
});

test('a security release lands on Reactive instead', async () => {
  const sink: unknown[] = [];
  await cardForRelease(deps(sink), rel({ security: true }), { workspace: 'jefelabs', currentVersion: '4.0.7' });
  assert.equal((sink[0] as { boardId: string }).boardId, 'b-react');
});

test('the card goes to the board of the workspace that declared the dependency', async () => {
  const sink: unknown[] = [];
  await cardForRelease(deps(sink), rel(), { workspace: 'acme', currentVersion: '4.0.0' });
  assert.equal((sink[0] as { boardId: string }).boardId, 'b-maint-other');
});

test('an already-carded item is never carded twice', async () => {
  const sink: unknown[] = [];
  const result = await cardForRelease(
    deps(sink),
    { ...rel(), cardedAt: '2026-08-10T00:00:00Z' },
    { workspace: 'jefelabs', currentVersion: '4.0.7' },
  );
  assert.equal(result.carded, false);
  assert.deepEqual(sink, []);
});

test('a missing board is reported, not thrown — conversation must not depend on the boards', async () => {
  const result = await cardForRelease(
    { ...deps([]), boards: async () => [] },
    rel(),
    { workspace: 'jefelabs', currentVersion: '4.0.7' },
  );
  assert.equal(result.carded, false);
  assert.match(result.reason!, /no maintenance board/i);
});

test('a failing board write is reported, not thrown', async () => {
  const result = await cardForRelease(
    {
      ...deps([]),
      addCard: async () => {
        throw new Error('swarm unreachable');
      },
    },
    rel(),
    { workspace: 'jefelabs', currentVersion: '4.0.7' },
  );
  assert.equal(result.carded, false);
  assert.match(result.reason!, /swarm unreachable/);
});

test('boardTypeFor and cardTitle stand alone', () => {
  assert.equal(boardTypeFor(rel()), 'maintenance');
  assert.equal(boardTypeFor(rel({ security: true })), 'reactive');
  assert.equal(cardTitle(rel(), '4.0.7'), 'Upgrade spring-boot 4.0.7 → 4.1.0');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/feeds/cards.test.ts`
Expected: FAIL — `Cannot find module './cards.ts'`

- [ ] **Step 3: Write the implementation**

```ts
/**
 * A qualifying release becomes work (spec §5b).
 *
 * This answers how the maintenance and reactive boards get filled: they are
 * the boards for work that ARRIVES rather than work you chose, and both open
 * with a Triage column. An upgrade is exactly that.
 *
 * Card creation is a SEPARATE consumer from the digest. If this fails, the
 * release is still spoken — nothing about small talk depends on the boards.
 */
import type { FeedItem } from './types.ts';

export function boardTypeFor(item: FeedItem): 'reactive' | 'maintenance' {
  return item.release?.security ? 'reactive' : 'maintenance';
}

export function cardTitle(item: FeedItem, currentVersion: string): string {
  return `Upgrade ${item.release!.name} ${currentVersion} → ${item.release!.version}`;
}

export async function cardForRelease(
  deps: {
    boards(): Promise<Array<{ id: string; type: string; workspaceId?: string }>>;
    addCard(boardId: string, card: { title: string; notes: string; columnId: string }): Promise<void>;
    /** The action plan: at most 5 steps, generated once, about THIS repo. */
    plan(item: FeedItem, currentVersion: string): Promise<string>;
    now(): string;
  },
  item: FeedItem,
  ctx: { workspace: string; currentVersion: string },
): Promise<{ carded: boolean; reason?: string }> {
  if (!item.release) return { carded: false, reason: 'not a release' };
  if (item.cardedAt) return { carded: false, reason: 'already carded' };

  const wanted = boardTypeFor(item);
  try {
    const board = (await deps.boards()).find((b) => b.type === wanted && b.workspaceId === ctx.workspace);
    if (!board) return { carded: false, reason: `no ${wanted} board for ${ctx.workspace}` };

    const notes = await deps.plan(item, ctx.currentVersion);
    await deps.addCard(board.id, { title: cardTitle(item, ctx.currentVersion), notes, columnId: 'triage' });
    return { carded: true };
  } catch (err) {
    return { carded: false, reason: String((err as Error).message ?? err) };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd broker && node --import tsx --test src/feeds/cards.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
cd broker && npm run typecheck
git add broker/src/feeds/cards.ts broker/src/feeds/cards.test.ts
git commit -m "feat: an upgrade arrives as work, in Triage"
```

---

### Task 12: The brain learns the world

**Files:**
- Modify: `broker/src/brain.ts` — `BrainTurn` (line ~25), `ToolExecutors` (line ~14), `TOOLS` (line ~47), the system assembly (line ~233)
- Test: `broker/src/brain.test.ts` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks (the digest arrives as a string).
- Produces: `BrainTurn.digest?: string`; `ToolExecutors.check_feeds(input: { query: string; tag?: string; sinceDays?: number }): Promise<string>`.

- [ ] **Step 1: Write the failing test**

Append to `broker/src/brain.test.ts`:

```ts
test('the digest rides in the system prompt, after the roster', async () => {
  const captured: Array<{ system: string }> = [];
  const brain = makeBrain((params) => {
    captured.push({ system: params.system });
    return scriptedStream('ok'); // this file's existing helper
  });
  await brain.handleUtterance('morning', {
    roster: '\n\nROSTER: Anderson idle',
    digest: '\n\nTODAY · 29°C, clear.\n',
    onSpeech: () => {},
  });
  assert.match(captured[0]!.system, /ROSTER: Anderson idle[\s\S]*29°C, clear/);
});

test('NO digest leaves the prompt byte-for-byte unchanged — a fresh install pays nothing', async () => {
  const withOut: string[] = [];
  const brain = makeBrain((params) => {
    withOut.push(params.system);
    return scriptedStream('ok');
  });
  await brain.handleUtterance('morning', { roster: '\n\nROSTER: x', onSpeech: () => {} });
  await brain.handleUtterance('morning', { roster: '\n\nROSTER: x', digest: '', onSpeech: () => {} });
  assert.equal(withOut[0], withOut[1]);
});

test('check_feeds is offered as a tool and its result reaches the model', async () => {
  const calls: unknown[] = [];
  const brain = makeBrainWithTools(
    { check_feeds: async (input: unknown) => {
        calls.push(input);
        return 'Fly.io changed pricing on Tuesday.';
      } },
    'check_feeds',
    { query: 'fly.io pricing' },
  );
  await brain.handleUtterance('is fly still cheap?', { roster: '', onSpeech: () => {} });
  assert.deepEqual(calls, [{ query: 'fly.io pricing' }]);
});
```

> **Note for the implementer:** `makeBrain`, `scriptedStream`, and the tool-calling helper already exist in `brain.test.ts` under whatever names that file uses — read its top and reuse them rather than adding parallel helpers. `makeBrainWithTools` above stands for "the existing helper that scripts a tool_use turn"; use the real one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/brain.test.ts`
Expected: FAIL — `digest` is not in the system prompt; `check_feeds` is not a tool.

- [ ] **Step 3: Write the implementation**

In `broker/src/brain.ts`, extend the turn:

```ts
export interface BrainTurn {
  roster: string;
  /**
   * What the crew already knows about today — weather, headlines, unspoken
   * releases (spec §6). Empty string when no feeds are configured, so the
   * prompt is unchanged for anyone who never set this up.
   */
  digest?: string;
  onSpeech: (chunk: string) => void;
}
```

Extend the executors:

```ts
check_feeds(input: { query: string; tag?: string; sinceDays?: number }): Promise<string>;
```

Add the tool to `TOOLS`:

```ts
{
  name: 'check_feeds',
  description:
    "Look deeper into what the crew has been reading — news, tech, sports, government notices, and release notes. Use when the conversation goes past what you already know from today's digest. Read-only.",
  input_schema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string' as const, description: 'Free text matched against titles and summaries' },
      tag: { type: 'string' as const, description: 'Optional: news, tech, sports, gov, or release' },
      sinceDays: { type: 'number' as const, description: 'How far back to look; default 7, max 30' },
    },
    required: ['query'],
  },
},
```

And the assembly:

```ts
system: this.persona + turn.roster + (turn.digest ?? ''),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd broker && npm test`
Expected: PASS — the whole suite, since every other caller of `handleUtterance` omits `digest`.

- [ ] **Step 5: Commit**

```bash
cd broker && npm run typecheck
git add broker/src/brain.ts broker/src/brain.test.ts
git commit -m "feat: the crew reads the room, and can look closer"
```

---

### Task 13: Wiring — routes, search, and the scheduler

**Files:**
- Modify: `broker/src/main.ts`, `broker/src/text-channel.ts`
- Test: `broker/src/text-channel.test.ts` (append)

**Interfaces:**
- Consumes: everything from Tasks 1–12.
- Produces: `TextChannel` gains a `feeds` dep (positional, after `directed`):
  `{ list(): Promise<unknown>; add(body: { url: string; tag: string }): Promise<unknown>; update(id: string, body: { enabled?: boolean; dismissed?: boolean }): Promise<unknown>; remove(id: string): Promise<unknown>; weather(body: { location: string }): Promise<unknown> }`
  serving `GET/POST /feeds`, `PATCH/DELETE /feeds/:id`, `PUT /feeds/weather`.

- [ ] **Step 1: Write the failing test**

Append to `broker/src/text-channel.test.ts`:

```ts
test('GET /feeds lists sources; POST adds one', async () => {
  const added: unknown[] = [];
  const channel = channelWith({
    feeds: {
      list: async () => ({ sources: [{ id: 's1', label: 'Diario Libre' }] }),
      add: async (body) => {
        added.push(body);
        return { ok: true };
      },
      update: async () => ({ ok: true }),
      remove: async () => ({ ok: true }),
      weather: async () => ({ ok: true }),
    },
  });
  const port = await channel.start(0);
  try {
    const listed = await fetch(`http://127.0.0.1:${port}/feeds`);
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { sources: [{ id: 's1', label: 'Diario Libre' }] });

    const res = await fetch(`http://127.0.0.1:${port}/feeds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.test/rss', tag: 'news' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(added, [{ url: 'https://example.test/rss', tag: 'news' }]);
  } finally {
    await channel.stop();
  }
});

test('PATCH /feeds/:id dismisses a derived source; DELETE removes a manual one', async () => {
  const calls: unknown[] = [];
  const channel = channelWith({
    feeds: {
      list: async () => ({ sources: [] }),
      add: async () => ({ ok: true }),
      update: async (id, body) => {
        calls.push(['update', id, body]);
        return { ok: true };
      },
      remove: async (id) => {
        calls.push(['remove', id]);
        return { ok: true };
      },
      weather: async () => ({ ok: true }),
    },
  });
  const port = await channel.start(0);
  try {
    await fetch(`http://127.0.0.1:${port}/feeds/rel%3Ajefelabs%3Aspring-boot`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dismissed: true }),
    });
    await fetch(`http://127.0.0.1:${port}/feeds/m1`, { method: 'DELETE' });
    assert.deepEqual(calls, [
      ['update', 'rel:jefelabs:spring-boot', { dismissed: true }],
      ['remove', 'm1'],
    ]);
  } finally {
    await channel.stop();
  }
});

test('the mutating feed routes refuse a disallowed browser Origin', async () => {
  const channel = channelWith({
    feeds: {
      list: async () => ({ sources: [] }),
      add: async () => assert.fail('must not be reached'),
      update: async () => ({ ok: true }),
      remove: async () => ({ ok: true }),
      weather: async () => ({ ok: true }),
    },
  });
  const port = await channel.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/feeds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify({ url: 'https://example.test/rss', tag: 'news' }),
    });
    assert.equal(res.status, 403);
  } finally {
    await channel.stop();
  }
});
```

> Extend `channelWith` with a `feeds` key mapped to the new positional argument, following the pattern already in that helper.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/text-channel.test.ts`
Expected: FAIL — `/feeds` 404s.

- [ ] **Step 3: Write the implementation**

Add the dep to `TextChannel`'s constructor, after `directed`:

```ts
/** Settings › Feeds. The mutating routes carry the same origin guard as every other write. */
private readonly feeds?: {
  list(): Promise<unknown>;
  add(body: { url: string; tag: string }): Promise<unknown>;
  update(id: string, body: { enabled?: boolean; dismissed?: boolean }): Promise<unknown>;
  remove(id: string): Promise<unknown>;
  weather(body: { location: string }): Promise<unknown>;
},
```

Add the routes beside the blueprints/documents block, reusing that block's `json()` and `originBlocked()` helpers — `GET /feeds` unguarded (read-only), the rest guarded. Match on `/^\/feeds$/`, `/^\/feeds\/weather$/` (PUT, matched BEFORE the bare-id route so it is never swallowed), and `/^\/feeds\/([^/]+)$/`.

In `broker/src/main.ts`:

1. Build the store with a file io seam over `.smith/feeds/`, mirroring `sessionStore`/`rosterStore`.
2. Wire the `feeds` dep: `add` resolves a YouTube URL through `youtubeFeedUrl` first, then stores an `rss` source with a generated id.
3. Register a `setInterval` (60 s) tick that calls `dueSources`, fetches each due source through its adapter with the **real** `fetch`, calls `store.addItems`, and records the outcome via `recordOutcome`.
4. Rebuild the digest after each tick: `buildDigest({ items, weather, owners, now })`, hold it in a module-level `let currentDigest = ''`, and pass it as `turn.digest` where `turn.roster` is already passed.
5. After a turn in which the digest was included, call `store.markSpoken(unspokenIds, now)` — the crew has now said them.
6. For each newly qualifying release, call `cardForRelease` with `plan` implemented via the same `anthropic.messages.create` helper the elections use, prompted for **at most 5 steps**, then `store.markCarded(item.id, now)`.
7. Implement `check_feeds` in the brain's executors: filter `store.items()` by `sinceDays` (default 7, max 30) and optional tag, keep items whose title or summary contains any query token case-insensitively, newest first, cap 10, and render as `- <title> (<relative age>)\n  <summary>`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd broker && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add broker/src/text-channel.ts broker/src/text-channel.test.ts broker/src/main.ts
git commit -m "feat: the pipe runs, and the crew is told"
```

---

### Task 14: Settings › Feeds, and the live walk

**Files:**
- Create: `control-plane/src/organisms/settings/FeedsGroup.tsx`
- Modify: `control-plane/src/api/types.ts`, `control-plane/src/api/broker.ts`, the settings modal that renders the other groups
- Test: `control-plane/src/organisms/settings/FeedsGroup.test.tsx`

**Interfaces:**
- Consumes: the routes from Task 13.
- Produces: `FeedSourceT` in `types.ts` (mirroring `FeedSource`), `getFeeds`/`addFeed`/`patchFeed`/`removeFeed`/`setWeatherLocation` in `broker.ts`, and `<FeedsGroup />`.

- [ ] **Step 1: Write the failing test**

Create `control-plane/src/organisms/settings/FeedsGroup.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import * as api from "../../api/broker";
import { FeedsGroup } from "./FeedsGroup";

const SOURCES = [
  { id: "m1", label: "Diario Libre", kind: "rss", tag: "news", origin: "manual", enabled: true },
  {
    id: "rel:jefelabs:spring-boot", label: "spring-boot", kind: "registry", tag: "release",
    origin: "derived", enabled: true, reason: "from build.gradle in jefelabs",
  },
];

describe("Settings › Feeds", () => {
  it("shows manual and derived sources, and says WHY a derived one is watched", async () => {
    vi.spyOn(api, "getFeeds").mockResolvedValue(SOURCES as never);
    render(<FeedsGroup />);
    expect(await screen.findByText("Diario Libre")).toBeInTheDocument();
    expect(screen.getByText(/from build\.gradle in jefelabs/)).toBeInTheDocument();
  });

  it("adds a source by URL", async () => {
    vi.spyOn(api, "getFeeds").mockResolvedValue([] as never);
    const add = vi.spyOn(api, "addFeed").mockResolvedValue(null);
    render(<FeedsGroup />);
    await userEvent.type(await screen.findByLabelText(/feed url/i), "https://example.test/rss");
    await userEvent.click(screen.getByRole("button", { name: /add feed/i }));
    await waitFor(() => expect(add).toHaveBeenCalledWith("https://example.test/rss", "news"));
  });

  it("dismisses a derived source rather than deleting it, so it cannot come back", async () => {
    vi.spyOn(api, "getFeeds").mockResolvedValue(SOURCES as never);
    const patch = vi.spyOn(api, "patchFeed").mockResolvedValue(null);
    render(<FeedsGroup />);
    await userEvent.click(await screen.findByRole("button", { name: /dismiss spring-boot/i }));
    expect(patch).toHaveBeenCalledWith("rel:jefelabs:spring-boot", { dismissed: true });
  });

  it("shows a failing source's error instead of letting it decay silently", async () => {
    vi.spyOn(api, "getFeeds").mockResolvedValue([
      { ...SOURCES[0], enabled: false, lastError: "ENOTFOUND example.test" },
    ] as never);
    render(<FeedsGroup />);
    expect(await screen.findByText(/ENOTFOUND example\.test/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd control-plane && npx vitest run src/organisms/settings/FeedsGroup.test.tsx`
Expected: FAIL — `Cannot find module './FeedsGroup'`

- [ ] **Step 3: Write the implementation**

Mirror `FeedSource` into `control-plane/src/api/types.ts` as `FeedSourceT`, adding the read-only `lastError?: string` the list route returns. Add the five API functions to `broker.ts` following `getWorkspaceRecords`/`saveWorkspace`'s shape. Build `FeedsGroup.tsx` following whichever existing settings group (`GeneralGroup.tsx` and its siblings) is closest in structure — a list, an add row, and per-row controls; derived rows show `reason` and a dismiss button, manual rows a delete button; a disabled row shows `lastError`. Register it in the settings modal beside the other groups.

- [ ] **Step 4: Run the gates**

```bash
cd control-plane && pnpm test && pnpm lint && pnpm typecheck
cd ../broker && npm test && npm run typecheck
```

Expected: both suites green. `MapStage.test.tsx`, `NewWorkspaceModal.test.tsx`, and `SurfacePolicyPopover.test.tsx` are known load flakes — re-run any failure in isolation before treating it as a regression.

- [ ] **Step 5: Live walk**

```bash
tmux send-keys -t smith-broker C-c && sleep 2 && tmux send-keys -t smith-broker "npm run serve" Enter
```

1. Settings › Feeds: add an RSS URL and confirm it appears; confirm derived release sources are listed with their reason.
2. Wait one tick (60 s) and confirm `.smith/feeds/items.json` fills.
3. Ask the crew "what's the weather like?" — the answer should come back without a tool call.
4. Confirm a qualifying release produced a Triage card on the Maintenance board, with an action plan in its notes.
5. Ask a follow-up that needs depth and confirm `check_feeds` is called.
6. Point a source at a dead URL, let it fail five times, and confirm it disables itself with the error shown.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src
git commit -m "feat: Settings knows what the crew reads"
```

---

## Self-review

**Spec coverage.** §2 adapters → Tasks 2, 7, 8, 3. §3 shapes → Task 1. §4.1 manifests → Task 4. §4.2 roles → Task 5 (`ownerRole`). §4.3 transcripts → Task 5. §5 threshold → Task 3. §5b cards → Task 11. §6 digest → Task 9 + Task 12 injection. §7 tool → Tasks 12, 13. §8 Settings → Task 14. §9 storage/cadence/budget → Tasks 1, 10, 8. §10 failures → Task 10 + per-adapter value-returns. §11 invariants → each has a named test. §13 testing → distributed.

**Placeholder scan.** Task 13 steps 3.1–3.7 and Task 14 step 3 describe wiring in prose rather than full code. That is deliberate and bounded: both are composition-root work whose exact form depends on the surrounding file, and every *decision* (defaults, caps, order of operations, which helper to reuse) is stated. All logic worth testing lives in Tasks 1–11, which are complete code.

**Type consistency.** `FeedSource`/`FeedItem`/`FeedState` are defined once in `types.ts` and imported everywhere. `Ecosystem` is defined in `versions.ts` and imported by `manifests.ts` and `derive.ts`. `Dependency` comes from `manifests.ts`, used by `interests.ts` and `derive.ts`. Digest ↔ store agree on `spokenAt`; cards ↔ store agree on `cardedAt`. `columnId: 'triage'` matches the `triage` column id both boards declare in `swarm/src/work-items.ts`.

**Known gap, flagged not hidden:** Task 13 assumes `workBoards.proxy` can reach `GET /work/boards` and `POST /work/boards/:id/cards`. The proxy exists; the exact response shape of the board list is unverified against a running swarm. Task 11's `boards()` dep is injected precisely so that a shape surprise is a one-line adapter change in `main.ts` rather than a redesign.
