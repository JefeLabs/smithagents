# Wizard Plan 4 — How I talk

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The wizard's Step 4 — small talk, and whether Anderson keeps up with the world — wired to what actually exists: a preference the brain's prompt honors, and the keyless feeds pipeline.

**Spec:** `docs/superpowers/specs/2026-08-18-welcome-wizard-local-setup.md`, Step 4.
**Roadmap:** `docs/superpowers/plans/2026-08-18-wizard-sequence-roadmap.md`

## What is already true — measured

| Claim | Reality |
|---|---|
| World-awareness | **Already exists, keyless, twice**: today's digest is injected into every brain turn (`broker/src/brain.ts:283` — `system: persona + roster + (digest ?? "")`), and the brain carries a read-deeper tool over the feeds store (`brain.ts:187`) |
| Topics machinery | Shipped and proxied: `GET/POST /topics`, `/topics/:id/approve`, `/:id/rediscover` (`text-channel.ts:1503-1533`). Topic → discovered sources → Maintenance cards |
| Brave / web search | **Nothing consumes a Brave key anywhere.** No live-search tool exists |
| Small talk | **Nothing models it.** Net-new preference |
| Broker reads the user | `swarm-client.ts:465 getMe()` exists |
| Setup persistence | merges; explicit sends; unknown fields survive (spread) |

### Ruling from the user — the feeds pipeline, no Brave

"Yes" wires to what exists: the digest plus topics of interest through the
shipped discovery machinery. **No key is asked for — nothing needs one.** Brave
returns when the brain gains a live-search tool that consumes it. Same ruling as
OpenAI keys and on-device voice; third instance of checking the credential
premise shrinking the work.

## Global Constraints

The standing set, abbreviated (full text in any Plan 3 brief): spec copy is the
deliverable, first person; pnpm never npm; vitest-filter trap; node runner for
broker/swarm; `brokerFetch` two failure shapes with HUMAN sentences; setup
merges → explicit sends, `skipDefault()` never `{}`, `skipLabel` never bare
"Skip"; obey `WizardSaveState`; never a dead end; questions `<h2>`, no `<h1>`
on setup steps; quiet controls ≥4.5:1 (`--text-2`); `--surface-raised` panel;
tsx no hot-reload (restart broker for new consts read at boot; swarm supervised
in tmux `smith-swarm`); first-run via `PUT setup.step`; 529 protocol —
incremental reports, resume by message. **Baselines on `8d2afbf`:**
control-plane **1140/2** (the two named, fail in isolation; five distinct
MapStage transients known — re-run before blaming), broker **701/0**, swarm
**667/0**, tsc 10/12/0, biome 1 info.

## File Structure

- `swarm/src/users.ts` — **modify.** `setup` gains `smallTalk?: boolean;
  worldAware?: boolean`.
- `broker/src/main.ts` (turn assembly) + test — **modify.** The two prefs read
  via `getMe()` and honored: a small-talk line joins the system prompt;
  `worldAware === false` suppresses the digest injection AND drops the
  read-deeper tool from the toolset.
- `control-plane/src/organisms/WizardTalkStep.tsx` + test — **create.**
- `control-plane/src/lib/wizardSteps.ts`, `WizardGate.tsx` + tests — **modify.**
  `talk` after `voice` → `Step n of 4`.
- `control-plane/src/api/types.ts` — mirror the two setup fields.

### Task 1: The brain honors the two answers

Widen `setup` both sides. In the broker's turn assembly: fetch the prefs
(cached sensibly — per digest build or with a short TTL, not per keystroke;
say what you chose), then:
- `smallTalk === false` → one system-prompt line in Anderson's register telling
  him to answer and get out of the way; `true`/absent → say hello properly
  (absent = default chatty — the product's personality is the default, the
  preference is the opt-out).
- `worldAware === false` → no digest in the prompt AND the feeds read-deeper
  tool absent from the tool list. Absent/`true` → today's behaviour.

Tests (node runner): the prompt line appears/disappears by pref; the tool list
shrinks; absent prefs = today's behaviour byte-identical. Discriminating case:
`worldAware: false` with a NON-EMPTY digest available — a lazy implementation
that only "suppresses" an already-empty digest passes on the broken build.
Broker restart + a live `getMe` read to verify. Commit.

### Task 2: The step — *How I talk*

Spec copy verbatim, two questions:
- "Should I make small talk?" — the two answers with their stated behaviours.
- "Should I keep up with what's happening in the world?" — per the ruling:
  Yes reveals a **topic entry** (chips; enter to add, click to remove) with
  Anderson saying what he'll do — follow the news and these topics, bring them
  up when they matter, and go find good sources (the discovery flow). No key
  field anywhere. No — "I'll stick to what I already know".
- Continue: explicit `{setup: {smallTalk, worldAware}}` both always present;
  on world-Yes, `POST /topics` per entered topic through the existing client
  path (create it if none exists — check `queries/http.ts` first), tolerating
  zero topics (Yes with none is valid — the news digest alone).
- Both failure shapes; save-state guard; no dead end (both questions always
  answerable; topics POST failures must not trap — surface and allow Continue
  retry or proceed-without, say which and why).
Tests first; the discriminating cases: explicit false emission for BOTH fields;
a topics POST failure not stranding. Commit.

### Task 3: Into the sequence

`talk` after `voice` → sources, roles, voice, talk (`Step n of 4`).
`skipLabel: "Skip — I'll say hello properly and stick to what I know"`,
`skipDefault: () => ({smallTalk: true, worldAware: false})` — chatty is the
product default; news ingestion is opt-in. Registry completeness compiles;
pick-for-me picks it up; resumeStep seeds a revisited step from stored answers
(both radios AND previously-posted topics are NOT re-posted — read what exists
via GET /topics and show them). Show the count arithmetic. Commit.

### Task 4: Walk it

All proofs to disk incrementally: No/No path (both explicit false in the FILE);
Yes-world path posts topics and they appear in `GET /topics`; revisit shows
them without duplicating; skip applies the stated default; `Step n of 4`
everywhere; the talk step's copy in Anderson's register; midnight + sand.
Also verify Task 1 live: with `worldAware:false` PUT directly, a brain turn's
system prompt lacks the digest (the broker logs or a test hook — say how you
observed it; if unobservable live, say so plainly rather than inferring).
Restore `setup.step: "done"`.

## Self-Review

Spec covered with the ruling substituting feeds for Brave; small talk default
= chatty (the personality IS the product; opt-out not opt-in); topics POST
reuses shipped machinery end to end. Out: Brave/live search (no consumer),
topic-source approval UI (Maintenance owns it). Risk named: Task 1's caching
choice must not make a pref change invisible until restart — bound the TTL and
test the refresh path.
