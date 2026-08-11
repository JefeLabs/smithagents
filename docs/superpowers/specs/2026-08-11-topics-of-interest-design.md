# Topics of Interest — Design

**Date:** 2026-08-11
**Status:** approved (Edwin, 2026-08-11)
**Builds on:** `2026-08-11-personal-tracking-feeds-design.md` (the pipe this sits above)

## 1. What this is

Today a feed source is a URL, so a *subject* has to be entered once per home: the
blog, the GitHub releases, the YouTube channel, the X account. Edwin, 2026-08-11:
*"maybe a tech stack of interest can become a summary of sources that an agent
collects like website, github, youtube and x feeds."*

So the **topic** becomes the unit you configure, and an agent goes and finds its homes.

This also fixes something the feeds work exposed on its first live run. A manually
added release feed is second-class: the Spring Boot Atom feed ingested 10 real
releases and produced **zero cards**, because only the registry path computes
`release` metadata (name, version, bump, security). A topic's GitHub source carries
that metadata, so a topic you configure behaves exactly like a dependency in your
manifests.

It supersedes the Settings › Feeds URL screen, which was specced but never built.
Configuring topics is the better screen; building the URL one first would be waste.

## 2. The model

A topic sits **above** the existing pipe. Everything downstream — ingest, the digest,
`check_feeds`, cards — is untouched.

```ts
interface Topic {
  id: string;                 // slug: "spring-boot"
  name: string;               // "Spring Boot"
  status: 'discovering' | 'pending' | 'active';
  /** Why it is in this status when something went wrong; shown in Settings. */
  note?: string;
  candidates: Candidate[];    // what discovery found, awaiting your decision
  /** Candidates you unticked. Re-discovery must not offer them again. */
  declined: string[];         // urls
  lastDiscoveredAt?: string;
}

interface Candidate {
  kind: 'site' | 'github' | 'youtube' | 'x';
  url: string;
  label: string;
  /** Why the agent believes this is the right source — shown in the review list. */
  evidence: string;
  /** ISO date of the newest thing found there; absent when unknown. */
  lastActivity?: string;
}
```

`FeedSource` gains one optional field: `topicId`. Manifest-derived sources simply have
none, so the two kinds of interest coexist without either knowing about the other.

Topics persist in `broker/.smith/feeds/topics.json`, beside the existing three files.
The in-flight `taskId → topicId` map lives in `state.json`'s `FeedState` instead, with
the other runtime bookkeeping — so a broker restart mid-discovery still recognises the
task when it completes.

## 3. Discovery is a real dispatch

"Track Spring Boot" calls the existing `Broker.dispatchWork()` — the same single path
the delegate tool, the work board, and the composer already use. The brain gets a
`track_topic` tool so the request can be made in conversation.

**Correlation is by `taskId`, held in state.** `SwarmEvent` carries `taskId` and
`workCardRef` and nothing else — there is no metadata field on the event to ride, so
the dispatch's returned `taskId` is recorded as `pendingDiscoveries[taskId] = topicId`
and looked up when `task:completed` arrives. This mirrors how the CLI bridge already
correlates its own dispatches.

### 3.1 The bundle arrives as a file, not as terminal output

The brief instructs the agent to **write `.smith/topics/<id>.json`** and not to print
the bundle. `swarm.getOutput()` returns raw terminal scrollback — ANSI codes, line
wrapping, and the agent's own commentary — and parsing a bundle out of that is the kind
of thing that works while you are watching and fails on a long day.

On `task:completed` for a correlated taskId the broker reads that file. Missing,
malformed, or empty puts the topic in `pending` **with `note` explaining exactly that**.
An agent that ignores the instruction produces a visible failure, never a wrong bundle.

The brief asks for, per candidate: the URL, what kind it is, one line of evidence, and
the date of the newest item found there. **`evidence` and `lastActivity` are what make
the review list worth reading** — "last video 2023" is the reason you would untick
YouTube, and without it you are approving URLs on faith.

## 4. Nothing polls until you approve

`discovering → pending → active`. A pending topic's candidates are **not** sources.
Approving turns the ticked ones into real `FeedSource` rows through the existing store,
each carrying `topicId` and a reason (`from Spring Boot discovery`).

Every candidate URL passes the existing SSRF guard (`url-guard.ts`) before it is stored.
**An agent-supplied URL is exactly as untrusted as a pasted one** — more so, since it
came from reading the open web.

Unticked candidates are recorded in `declined`, so re-discovery never offers them again.

## 5. A topic's GitHub source is a real release source

This is the part that fixes what the feeds work exposed.

A `github` candidate is stored with `tag: 'release'` and a locator carrying its
`owner/repo`, so the release path — version, bump, security — runs from the Atom
entries rather than from a registry. Two consequences:

- A topic you configure produces **Maintenance/Reactive Triage cards** exactly like a
  manifest dependency does.
- It **closes the Maven security-patch gap**: Maven Central exposes no `scm`, so a
  maven CVE patch is undetectable today, but GitHub's Atom entries carry the notes.

**Approval sets the version baseline.** You confirm which version you are on (defaulted
from the newest entry), and only *newer* releases are announced. Without this, approving
a topic would card every historical release at once — the same failure the registry
poll's manifest-seeded baselines already prevent.

A `github` candidate for a project whose releases are not on GitHub still works as a
plain feed; it simply produces no cards.

## 6. Re-discovery diffs, never auto-adds

Every 30 days per topic, discovery is re-dispatched and the result is **diffed against
what you approved**:

- A candidate you never saw → a pending addition.
- A candidate in `declined` → skipped silently.
- An approved source absent from the new bundle, or whose `lastActivity` is more than
  **180 days** old → flagged, not removed. Six months is chosen so a quiet-but-alive
  blog is not mistaken for a dead one; flagging is advisory and never disables.

Anderson mentions there is something waiting; the decision stays in Settings.
**Re-discovery never activates a source on its own.** Re-dispatch is skipped when the
topic already has a discovery in flight.

## 7. Settings › Topics

Replaces the unbuilt Feeds screen; manifest-derived release sources continue to be
listed read-only with their reasons, as that spec already required.

```
Topics
  [+ track a topic…]

  Spring Boot                                   PENDING
    ☑ spring.io/blog          site     feed found in <head>
    ☑ spring-projects/…       github   1.2k releases · newest 4 days ago
    ☐ @SpringSourceDev        youtube  last video 2023
    ☑ @springboot             x        posts weekly
    version you're on: [4.0.0]        [approve 3 selected]

  React                                     4 sources · ACTIVE
  Tauri                            DISCOVERING · Osvaldo, 2m ago
```

A topic whose every source is disabled shows as **dormant** rather than looking healthy
while producing nothing.

## 8. Failure behaviour

| What happens | Result |
|---|---|
| Dispatch refused (agent busy) | stays `discovering`, `note` says who is busy, retried on the next timer |
| Task fails / no file / bad JSON / zero candidates | `pending`, `note` explains which |
| A candidate URL fails the SSRF guard | dropped from the bundle, `note` records it |
| An approved source fails 5 times | disabled with its error, per the feeds spec; the topic shows dormant if all are |

Discovery failure never affects ingest of already-approved sources, and never touches
manifest-derived ones.

## 9. Invariants

1. No source is ever polled that you did not tick.
2. Every candidate URL passes the SSRF guard before storage.
3. A declined candidate is never offered again.
4. Re-discovery never activates a source by itself.
5. Approving a GitHub source sets a baseline, so history is never carded.
6. A topic with no `topicId` sources — i.e. manifest-derived ones — is unaffected by any
   of this.
7. Every non-active status carries a `note` saying why.

## 10. Testing

**Pure:** bundle parsing (valid, malformed, empty, unknown `kind`); the diff against an
approved set across all four cases in §6; candidate→`FeedSource` conversion including
the github release shape and the baseline; SSRF rejection of an agent-supplied URL;
status transitions with their notes.

**Stateful:** `taskId → topicId` correlation surviving a broker restart (it is in
`state.json`); re-discovery skipped while one is in flight; a declined candidate absent
from a second bundle.

**Integration:** `track_topic` reaching `dispatchWork` with the right brief; a
`task:completed` for an uncorrelated taskId being ignored; approval producing sources
that the existing ingest tick then polls.

**Never live:** discovery is scripted through an injected dispatcher, as every other
adapter in the feeds work is.

## 11. Out of scope

- **Editing a topic's sources by hand.** Tick, untick, re-discover — no URL editing;
  that is the screen this replaces.
- **Topics for anything but feeds.** A topic is a source bundle, not a saved search.
- **Discovery without an agent.** No convention-guessing fallback: one mechanism.
- **The X adapter's polling**, still unwired from the feeds work — a topic may hold an
  `x` source, and it will sit inert until that is finished.
