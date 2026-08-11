# Composer Target Selector — Design

**Date:** 2026-08-10
**Status:** approved (Edwin, 2026-08-10)

## 1. What this is

The composer's `Swarm ▾` control is decoration. It is a `<div role="button">` with a
tooltip and no handler, carrying the comment *"becomes a real menu trigger when routing
is wired"* (`control-plane/src/molecules/Composer.tsx`). This spec wires it.

Picking a target directs the message: the chief of staff (Anderson, the default), the
Entire Crew, a squad, a group, or one named agent. Directing at anyone other than the
host **dispatches the typed text as a task, with no brain turn** — what you type *is*
the task description.

Groups have no leader in the data model today. They get one, and the agents in a group
pick it themselves.

## 2. The one rule

**Every target resolves to exactly one addressable agent.** A collection is addressed
through whoever leads it — Edwin's rule: *"every swarm has a leader or project manager."*

| Menu entry | Resolves to | Dispatch kind |
|---|---|---|
| Anderson (default) | the brain | `brain` |
| Entire Crew | Anderson — the crew's leader | `brain` |
| Squad (Alpha/Beta/Gamma) | `squad.leader` (Gabriel/Gustavo/Graciela) | `agent` |
| Group | its elected leader (§5) | `agent` |
| Individual agent | itself | `agent` |

Two dispatch kinds exist, so there is exactly one new code path. `brain` is today's
behaviour, byte for byte.

**Entire Crew does not fan out.** It is a brain turn with the roster wide open. Sending
one task to every agent would spawn N tmux sessions per message; the leader rule already
gives the crew an address, and that address is Anderson.

**Sending never waits for an election.** If a group is addressed while its first election
is still in flight, resolution falls straight to the rank ladder (§4). The vote lands when
it lands and updates the stored leader; it never sits between you and a dispatch.

## 3. Direct dispatch rides the existing seam

`Broker.dispatchWork()` (`broker/src/broker.ts`) is documented as *"the one dispatch path
for real work — the meeting's delegate tool and the board's Send-to-agent both land here,
so busy-refusal, the directives-prefixed prompt, task binding, and roster refresh can
never drift apart."*

The composer becomes its **third caller**. Nothing about dispatch is reimplemented:

- Busy refusal already exists and already returns the required message shape:
  `` `${agent.name} is busy with: ${busy.taskSummary ?? busy.taskId}.` ``
- Task binding, `onTaskDispatched`, and `notifyRoster()` come for free.
- `inheritSessionRuntime: true` — a composer dispatch continues *this session*, matching
  the delegate tool rather than the board's standalone-card behaviour (human ruling
  2026-08-07, recorded in that method's doc comment).

## 4. Rank ladder — the permanent floor

An ordered list, highest first. It resolves leaderless groups, breaks election ties, and
is the fallback whenever an election cannot run.

| # | Matches | Why |
|---|---|---|
| 1 | `Product Manager` | coordination — beats technical seniority (Edwin: a scrum master would outrank a tech lead) |
| 2 | squad `leader` | structural position within a squad |
| 3 | `Architect` | |
| 4 | `Senior` | |
| 5 | everything else | `Developer`, `Frontend Engineer`, `QA Engineer`, … |

Two role vocabularies exist and both are read: structural `SquadRole`
(`leader | architect | senior | developer`, `swarm/src/squads.ts`) and persona job titles
(`Product Manager`, `Backend Engineer`, …, `swarm/src/personas.ts`). An agent's rank is
its **best (lowest-index) match across both**, so a Product Manager who is also a squad
developer ranks 1.

Matching is case-insensitive on the normalized role string. An unmatched role is rank 5,
never an error — the persona catalog is data-driven config, not an enum, and a new job
title must never crash routing.

**Ties beyond rank break on roster order** (the order the directory already returns), so
the answer is stable across calls and across restarts.

## 5. The election

### 5.1 Where it runs — and why not through the agents

There is no API engine today: `engine: { cli: 'agy' | 'claude' | 'codex'; model: string }`
(`broker/src/swarm-client.ts`). Every agent is a coding CLI in a pinned tmux session.
Asking each member through their own runtime would spin up N coding CLIs, cost a full
agent start-up per voter, and mark the whole group **busy** for the duration of a vote.

So the election runs **inside the broker**, on its existing injected model client (the
same `StreamFactory` seam `brain.ts` uses, so tests script it). Each member gets one short
call seeded with **only that member's persona directives** — every agent answers as
itself, from its own character, blind to what the others said. Cost is N small calls in
parallel; nobody is marked busy; no tmux session is created.

### 5.2 Mechanics

Self-nomination, strongest claim wins. Each member is asked whether *they* should lead
this group and how strongly, and returns:

```ts
interface Claim {
  agent: string;        // agent id
  willing: boolean;
  confidence: number;   // 0..1, clamped
  reason: string;       // one line, shown in the UI
}
```

Resolution order:

1. Highest `confidence` among members with `willing: true`.
2. Tie → rank ladder (§4).
3. Nobody willing → rank ladder outright.
4. Model unavailable, or every response malformed → rank ladder outright.

A malformed or unparseable response is recorded as `willing: false, confidence: 0` with
the raw text in `reason`, and logged. It never aborts the election.

**A group is never leaderless.** The ladder sits underneath every path, so a model outage
degrades to a deterministic answer rather than an unroutable dropdown entry.

### 5.3 When it runs

On group create, and on any membership change — the compose ops that already flow through
`POST /compose`. Sending to a group never waits: it reads the stored leader.

Elections are **debounced per group** (250 ms), and a membership change supersedes an
in-flight election for that group — dragging three agents in quickly holds one vote, not
three. A superseded election's result is discarded, never written.

Edge cases: a one-member group elects that member without a model call. A zero-member
group is **not offered in the menu** at all.

### 5.4 What is not elected

Squads keep the leader the swarm gives them (`SwarmSquad.leader`). They are not ad-hoc,
they already have a designated lead, and re-electing it would fight the swarm's own model.

## 6. Data model

Group records gain two fields, persisted in the existing
`broker/.smith/roster-state.json` (`{ groups, squadEdits, groupSeq }`):

```ts
interface Group {
  id: string;
  name: string;
  memberIds: string[];
  /** Agent id. Absent only before the first election completes. */
  leader?: string;
  /** The vote behind `leader` — shown in the UI, and evidence when it looks wrong. */
  election?: { claims: Claim[]; at: string; method: 'vote' | 'rank' };
}
```

`method: 'rank'` records that the ladder decided (nobody willing, or the model was
unavailable), so a surprising leader is always explainable.

The WS roster frame's `groups` entries carry `leader` so the rail and the menu can show
who speaks for a group without a second fetch.

## 7. Modules

| File | Responsibility | Depends on |
|---|---|---|
| `broker/src/leadership.ts` *(new)* | The ladder. `rankOf(roles: string[]): number`, `deriveLeader(members): string \| null`, `pickLeader(claims, members): { leader, method }`. **Pure — no I/O, no model, no clock.** | nothing |
| `broker/src/election.ts` *(new)* | Runs the self-nomination round; returns `{ leader, claims, method }`. Owns the prompt, the parse, and the debounce. | `leadership.ts`, injected model factory |
| `broker/src/targets.ts` *(new)* | `resolveTarget(target, roster): { kind: 'brain' } \| { kind: 'agent'; name: string } \| { error: string }` | roster shape only |
| `broker/src/main.ts` | Wires the target through `POST /utterance`; triggers elections from compose ops | above |
| `control-plane/src/molecules/Composer.tsx` | The real menu; `onSend(text, target)` | roster |

`leadership.ts` is deliberately pure so the ladder — the part that must never fail — is
tested by a table with no mocks.

## 8. Routing

`POST /utterance` gains an optional `target`:

```ts
type Target =
  | { kind: 'host' }                    // Anderson — the default
  | { kind: 'crew' }
  | { kind: 'squad'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'agent'; id: string };
```

An object, not a `"agent:osvaldo"` string, because the broker's frame types and the
control-plane's `types.ts` are kept in lockstep by hand — a structured shape makes a
drifted parser a type error rather than a silent mis-parse.

| Outcome | Status | Body |
|---|---|---|
| Resolves to `brain` (or `target` absent) | 200 | `{ ok: true }` — existing behaviour |
| Resolves to `agent`, dispatched | 200 | `{ ok: true, taskId }` |
| Target busy | 409 | `{ error: "Osvaldo is busy with: refactor auth." }` |
| Target unknown / removed | 404 | `{ error: "unknown target" }` |

Absent `target` behaves exactly as today, so every other caller (mic PTT, stdin, Discord,
the CLI bridge) is untouched.

The route carries the same origin guard as the other mutating routes: an absent `Origin`
passes (the `smith-broker-send` bridge sends none), a present-and-disallowed one 403s.

## 9. Control plane

- The dead `.selector` div becomes a real menu (HeroUI `Menu`), grouped: **Anderson**,
  **Entire Crew**, then squads, then groups, then individual agents — the rail's own
  order, so the dropdown and the right rail read the same way.
- A group entry shows its leader as secondary text (`onboarding · Josefina leads`).
- `onSend(text, target)`. When `target.kind === 'host'` the call stays fire-and-forget as
  today; any other target is **awaited**, because a busy refusal has to come back.
- **The selector snaps back to Anderson after every send.** Directing is a per-message
  act; you can never leak a message to a CLI by forgetting a mode is set.
- A 409/404 renders inline above the composer and **preserves the typed text** — nothing
  is dispatched and nothing is lost.
- Zero-member groups are omitted. Busy agents are still listed; refusal happens on send,
  which is where it can name what they are busy with.

## 10. Invariants

1. A group always has a resolvable leader, in every failure mode.
2. No composer dispatch bypasses `dispatchWork()`.
3. An absent `target` is byte-for-byte today's behaviour.
4. An election never marks an agent busy and never starts a tmux session.
5. The selector's state after a send is always Anderson.
6. An unrecognised role ranks last; it never throws.

## 11. Testing

**`leadership.ts`** — pure table tests: full ladder order; both vocabularies read; best-of
-both for dual roles; unmatched role ranks last; ties break on roster order; empty member
list returns null.

**`election.ts`** — scripted model responses: clear winner; tie broken by rank; everyone
declines → rank with `method: 'rank'`; malformed JSON → decline, election still resolves;
model throws → rank; one-member group short-circuits with no call; debounce collapses
three rapid membership changes into one vote; a superseded election's result is discarded.

**`targets.ts`** — a resolution table over a fixture roster, one row per menu entry kind,
plus unknown id and zero-member group.

**Route** — `target` reaching `dispatchWork` with the resolved agent; busy → 409 with the
broker's own message; unknown → 404; absent `target` → the existing brain path, asserted
by the brain being called exactly as before.

**Control plane** — the menu lists rail entries in rail order; picking then sending calls
`onSend` with that target; the selector reads Anderson afterwards; a 409 renders inline
with the text preserved; zero-member groups absent.

## 12. Out of scope

- **A Scrum Master persona.** Edwin's natural fit for group leadership, but adding a
  catalog member is its own cycle (persona text, Gemini avatar, ElevenLabs voice, a 13th
  chooser card). It slots in at rank 1 later without touching routing.
- **An API engine for thinkers.** The election is designed to need no such thing; when one
  exists, `election.ts` can move its calls onto it behind an unchanged interface.
- **Re-election on demand.** No "hold an election" button; membership change is the only
  trigger.
- **Electing squad leaders.** §5.4.
- **Per-target transcripts.** One session, one transcript; a directed dispatch writes the
  user line and a broker line naming the agent and task, the shape `onTaskDispatched`
  already produces.
