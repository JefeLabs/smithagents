# Personal Tracking Feeds — Design

**Date:** 2026-08-11
**Status:** approved (Edwin, 2026-08-11)

## 1. What this is

The crew should live in the world. Two things follow from that, and this spec builds
both on one pipe:

1. **Small talk.** Ask what the weather is like and the answer comes back immediately
   and in character — not after a tool call and a "let me check". A person who glanced
   at their phone at breakfast *already knows*.
2. **"Tell me when a new version is out."** The crew knows Spring Boot matters, because
   it is in the stack — so when 4.1 ships, Anderson says so.

Edwin, 2026-08-11: *"i want to be able to small talk with the crew"*, *"if they know
spring boot is important i would like to be told new version is out"*, and the interest
set should be *"driving on their interest and mine"*.

This is deliberately **not** a screen you visit. There is no feed reader, no dashboard
widget, no bell. Feeds are a knowledge source behind conversations that already happen.

## 2. One pipe, four adapters

Everything lands in one item store, so there is one thing to search and one thing to
digest.

| Adapter | Covers | Credentials | Cadence |
|---|---|---|---|
| **RSS/Atom** | news, tech blogs, government notices, YouTube channels, **GitHub releases** | none | 20 min |
| **Weather** | Open-Meteo, keyless | none | 30 min |
| **X** | one poll per followed account | paid tier | 30 min, under a monthly budget (§9.3) |
| **Registry** | npm, Maven Central, crates.io version checks | none | 60 min |

**A release watch is just a feed.** `github.com/<owner>/<repo>/releases.atom` is a free
Atom feed, so "tell me when Spring Boot ships" needs no new fetcher — only something
that turns *you depend on Spring Boot* into that URL (§4).

YouTube needs no API key either: every channel exposes
`youtube.com/feeds/videos.xml?channel_id=…`.

Instagram is absent by necessity, not oversight: there is no read API for other people's
content since Basic Display was deprecated.

## 3. Item and source shapes

```ts
type FeedTag = 'news' | 'tech' | 'sports' | 'gov' | 'release' | 'weather';

interface FeedSource {
  id: string;
  label: string;
  kind: 'rss' | 'weather' | 'x' | 'registry';
  /** RSS/Atom URL, X handle, registry coordinate, or a lat/lon pair. */
  locator: string;
  tag: FeedTag;
  /** Manual sources are yours; derived ones are regenerated and carry `reason`. */
  origin: 'manual' | 'derived';
  /** Why this exists, shown in Settings: "from build.gradle", "you've mentioned RunPod 6×". */
  reason?: string;
  enabled: boolean;
  /** Set when a derived source is dismissed — regeneration must not resurrect it. */
  dismissed?: boolean;
}

interface FeedItem {
  id: string;            // stable per source+guid, so re-fetching never duplicates
  sourceId: string;
  tag: FeedTag;
  title: string;
  url?: string;
  publishedAt: string;
  summary: string;       // trimmed to 400 chars at ingest — the store is not an archive
  /** Release items only. */
  release?: { name: string; version: string; bump: 'major' | 'minor' | 'patch'; security: boolean };
  /** Release items only: set the moment the crew mentions it, so it is said ONCE. */
  spokenAt?: string;
}
```

Weather is not an item. It is a single current reading held in state (§9.1) and rendered
straight into the digest, because a temperature is not a document.

## 4. Interests come from three places

### 4.1 Manifests — what the stack actually uses

The broker already knows each workspace's repos (`repos: [{ name, path, github }]`).
For every repo path, direct dependencies are read from whichever manifests exist:
`package.json`, `build.gradle` / `build.gradle.kts`, `pom.xml`, `Cargo.toml`.

Only **direct** dependencies count. A transitive tree would watch hundreds of packages
nobody chose.

Each dependency resolves to a version source through its own ecosystem, all keyless:

| Ecosystem | Version check | Release notes |
|---|---|---|
| npm | `registry.npmjs.org/<pkg>/latest` | `repository.url` → GitHub releases.atom |
| Maven | Maven Central search API | `scm` → GitHub releases.atom |
| Cargo | `crates.io/api/v1/crates/<name>` | `repository` → GitHub releases.atom |

A dependency whose repository cannot be resolved is still version-watched; it simply has
no notes, so it can never qualify as a security release (§5).

### 4.2 Roles — a lens, not a source

An agent's role decides **who speaks a line**, never what gets fetched. Each derived
release interest is attributed to at most one agent by an explicit, ordered table —
first match wins, so attribution is deterministic:

| Owner role | Claims |
|---|---|
| Mobile Engineer | Cargo/Tauri deps; `react-native`, `expo`, `capacitor` |
| Frontend Engineer | npm deps that are UI or bundler (`react`, `vue`, `svelte`, `vite`, `next`, `tailwind`, `@heroui/*`) |
| Backend Engineer | every Maven dep; npm server frameworks (`express`, `fastify`, `nest*`) |
| DevOps / Platform | `docker*`, `terraform*`, `kubernetes*`, `*-cli` build tooling |
| Security Engineer | any release flagged `security: true`, regardless of ecosystem |
| Data / ML Engineer | `pandas`, `numpy`, `torch`, `langchain*`, `@anthropic-ai/*` |

A dependency matching no row is unattributed and Anderson delivers it himself. An owner
role with no agent currently on the roster is likewise unattributed — attribution never
invents a speaker.

The brain already supports this: a speech chunk prefixed `Name: text` sets the speaking
persona (broker.ts's sticky-speaker mechanism). So the digest carries the owner and the
line is delivered in that voice:

> *Osvaldo: Spring Boot 4.1 dropped Tuesday — the virtual-threads change touches what we do.*

An interest with no matching role is unattributed and Anderson delivers it himself.

### 4.3 Transcripts — what you keep bringing up

A token recurring in session transcripts becomes a **candidate** when it is
package-shaped — `/^@?[a-z0-9][a-z0-9._-]{2,}$/` (kebab/scoped package names) or
`/^[A-Z][A-Za-z0-9]{2,}$/` (proper nouns like `RunPod`) — and is not an agent name, a
workspace name, or in a stopword list of common English and Spanish words.

Promotion is deliberately hard to trigger and easy to undo:

- **Promote** at ≥ 3 mentions across ≥ 2 distinct sessions within 14 days, **and only if
  the name resolves in npm, Maven Central, or crates.io.** Resolution is the decisive
  filter: a thing that is not a real package cannot be version-watched anyway, so this
  drops nearly all conversational noise before it ever becomes a source.
- **Forget** an interest with no mention in 30 days — its derived source is removed,
  unless the same name is also manifest-derived (a dependency outranks a mention).
- Candidates below the bar are never fetched and never shown.

Every derived interest is visible in Settings with its `reason`, and dismissing one sets
`dismissed: true` so the next regeneration cannot resurrect it. **Nothing is watched
that you cannot see the reason for and turn off.**

## 5. Release watching

**Threshold:** major and minor releases reach you. Patches do not, unless their notes
name a CVE or a security advisory — matched as `/\bCVE-\d{4}-\d{4,}\b/i` or
`/security (fix|release|advisory|update)/i`.

**Cheap check, expensive detail.** The hourly registry poll compares the latest version
against the last seen one and computes the bump — no notes fetched. Notes are fetched
**only** when a version has already crossed the bar, or when a patch needs testing for a
security mention. A stack of 40 dependencies therefore costs 40 small JSON reads an hour
and almost no note fetches.

**Said once.** A qualifying release enters the digest's *unspoken* set. The moment the
crew mentions it, `spokenAt` is stamped and it leaves. There is no bell and no list
(Edwin's ruling, §12 risk 3), so this marker is the only thing standing between "you
were told" and "you were told four times".

## 5b. Releases become work

Edwin, 2026-08-11: *"news of upgrades might be a source of generating an action plan to
add to maintenance board."*

This answers a standing question about the six-board system — **how do the maintenance
and reactive boards get filled?** They are the boards for work that *arrives* rather
than work you chose, and both open with a **Triage** column. An upgrade is precisely
that kind of arriving work.

So a qualifying release (§5) does two things, not one: it enters the unspoken digest set
**and** it becomes a card.

| Release | Board | Column |
|---|---|---|
| `security: true` | **Reactive** | Triage |
| major or minor | **Maintenance** | Triage |

- **Title:** `Upgrade <name> <current> → <new>`
- **Notes:** a short action plan — at most 5 steps — generated **once**, by the same
  model client the elections use, from the release notes plus the version currently
  pinned in the manifest and which repo declared it. Not a paste of the changelog: what
  *this* repo would have to do.
- **Which board:** the workspace whose repo declared the dependency. Derivation already
  knows this (§4.1). A dependency declared in two workspaces yields a card in each.
- **Written through the existing path:** the broker's `workBoards.proxy` →
  `POST /work/boards/:id/cards`. No new write path, no direct file access.

**Idempotence.** A `cardedAt` marker on the item, alongside `spokenAt` — one card per
(dependency, version, workspace), ever. Re-running derivation, restarting the broker, or
re-fetching the feed never produces a second card.

**Independence.** Card creation and conversation are separate consumers of the same
event. If the board write fails, the release still reaches the digest and Anderson still
mentions it; the failure is recorded on the source, not swallowed. Nothing about small
talk depends on the boards existing.

## 6. Small talk: the digest

A block appended to the brain's system prompt, next to the roster. The seam already
exists — `system: this.persona + turn.roster` (brain.ts) — so `BrainTurn` gains one
field and the assembly becomes `this.persona + turn.roster + turn.digest`.

Format, held to a **150-token ceiling** by construction (one line per tag, longest
dropped first):

```
TODAY · Santo Domingo — 29°C, clear; rain likely 15:00.
tech — Spring Boot 4.1.0 (2d) [Osvaldo] · React 19.2 (5d) [Yesenia]
news — <top headline>
sports — Licey 5–2 Águilas
```

Rules:

- **Empty when nothing is configured.** With no sources and no derived interests,
  `turn.digest` is `''` and the prompt is byte-for-byte what it is today. A fresh
  install pays nothing.
- Only items from the last 48 hours; older ones are reachable through the tool, not the
  digest.
- Unspoken releases always take priority over headlines — that is the half you asked to
  be told about.
- The digest is rebuilt on a timer, not per turn, so a conversation never waits on a
  fetch.

## 7. Depth: the `check_feeds` tool

Alongside the brain's existing `search_docs` and `lookup_ticket`:

```ts
check_feeds(input: {
  query: string;              // free text matched against title + summary
  tag?: FeedTag;
  sinceDays?: number;         // default 7, max 30 (the retention window)
}): Promise<string>           // formatted items, newest first, capped at 10
```

Matching is keyword-based over title and summary. No embeddings, no vector store: the
corpus is a few hundred short items, and substring-plus-token matching answers "what
else did they say about the pricing change" perfectly well at this size.

## 8. Settings › Feeds

A third registry screen, the same shape as the API Keys and Connectors screens that
already exist.

- Add a source: paste a URL (RSS/Atom auto-detected, YouTube channel URLs converted to
  their feed form), choose a tag, save.
- Weather: a location, defaulting to Santo Domingo, DO.
- X: an account handle per source; the whole adapter is inert with a visible reason when
  no key is present.
- Derived sources are listed **read-only with their reason**, each with a dismiss
  control.
- Each row shows last-fetched, and a failing source shows its error.

Feeds are **global, not per-workspace** — personal feeds follow you across every
workspace. Interest derivation still reads every workspace's repos, since your stack is
the union of what you work on.

## 9. Storage, cadence, budget

### 9.1 Files

```
broker/.smith/feeds/sources.json   manual + derived sources
broker/.smith/feeds/items.json     rolling window: 30 days, hard cap 500 items
broker/.smith/feeds/state.json     per-source lastFetchedAt + consecutiveFailures,
                                   current weather reading, X monthly usage,
                                   transcript candidate counters
```

Trimming runs after each ingest: drop items older than 30 days, then drop oldest until
under 500. `spokenAt` markers ride the item, so a trimmed release cannot be re-announced.

### 9.2 Cadence

RSS 20 min · weather 30 min · X 30 min · registry 60 min · manifest scan on workspace
change and daily · transcript candidates daily. All jittered by up to 10% so a restart
does not fire every adapter at once.

### 9.3 The X budget — the only part that costs money

X is polled under an explicit monthly budget stored in `state.json`: a configurable cap
on requests per calendar month, defaulting to a deliberately low number. When the budget
is exhausted, X sources stop fetching and say so in Settings; nothing else is affected.
A 429 backs off exponentially and counts against nothing.

This is the one adapter that can generate a bill, so it is the one adapter with a hard
stop.

## 10. Failure behaviour

- A source failing **5 consecutive fetches** disables itself with the error recorded and
  shown in Settings. Silent decay is the failure mode most likely to go unnoticed for a
  month.
- Weather unavailable drops that line from the digest. The crew says nothing rather than
  something wrong.
- A malformed feed yields whatever items parsed; the rest are skipped, and a parse that
  yields zero items counts as a failure.
- No X key, or budget exhausted: inert, with a visible reason — never an error in
  conversation.
- Any ingest failure is contained to its source. **The digest always renders**, from
  whatever is present.

## 11. Invariants

1. With no sources configured, `turn.digest` is `''` and the brain's prompt is unchanged.
2. Nothing is watched without a `reason` visible in Settings and a way to turn it off.
3. A dismissed derived source is never resurrected by regeneration.
4. A qualifying release is mentioned exactly once (`spokenAt`).
5. The digest never exceeds 150 tokens, and never waits on a network fetch.
6. Only direct dependencies are watched.
7. X never fetches beyond its monthly budget.

## 12. Risks

1. **The digest is a permanent token tax** on every brain turn — a few hundred tokens on
   Haiku, including in conversations with nothing to do with feeds. Bounded by §6's
   ceiling and the empty-when-unconfigured rule, accepted knowingly.
2. **Transcript interests can drift into noise.** Mitigated by a hard promotion bar,
   30-day decay, and dismissibility — but this is the part most likely to need tuning
   once real transcripts run through it.
3. **No bell makes `spokenAt` load-bearing.** If Anderson's single mention doesn't land —
   you are mid-task and skim past it — that release is gone from the system. Edwin chose
   conversation as the only channel with this stated; revisiting means adding the alert
   surface, which the existing `AlertMenu` would make cheap.
4. **X pricing and limits move.** The budget guard exists so a tier change degrades to
   "inert with a reason" rather than a surprise bill.

## 13. Testing

**Pure, fixture-driven:** RSS/Atom parsing (a real feed fixture each for RSS 2.0, Atom,
and a YouTube channel); manifest parsing for all four manifest kinds, direct-only;
semver bump classification; the security-mention matcher (positive and negative cases);
the digest builder against a fixed item set, asserting the token ceiling and priority
order; transcript promotion and decay across a scripted timeline.

**Stateful:** `spokenAt` stamped exactly once across repeated digest builds; a dismissed
derived source surviving regeneration; the failure counter disabling at 5 and the error
surfacing; item trimming at both the age and count bounds; the X budget stopping fetches
at the cap.

**Integration:** `turn.digest` reaching the brain's system prompt; `check_feeds`
returning matches; an empty configuration producing an unchanged prompt.

**Network is never live in tests.** Every adapter takes an injected fetcher, the way
`brain.ts` takes its `StreamFactory`.

## 14. Out of scope

- **The bell / `AlertMenu`.** Conversation is the only channel (§12 risk 3).
- **Instagram** — no read API exists for this.
- **Dashboard widgets.** Feeds are a knowledge source, not a screen.
- **Per-workspace feeds.** Personal means global.
- **Embeddings / vector search.** §7.
- **Agents reading feeds directly.** The digest and the tool both sit on the brain; a CLI
  agent that needs current information has its own web access.
