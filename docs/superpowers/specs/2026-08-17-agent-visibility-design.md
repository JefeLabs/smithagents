# Agent Visibility — Design

**Date:** 2026-08-17
**Status:** Approved design, ready for planning
**Part of:** spec 4 of 7 in the decomposition drawn from the Hamster / herdr /
Orca teardown.
**Depends on:** spec 1 (`2026-08-16-agent-status-reporting-design.md`) for the
states this renders. The design is complete without it; the surface is legible
but empty of meaning until spec 1 deploys — see §6.
**Defers:** the coordination map (register C3) to spec 6, which defines the
dispatch lineage the map would draw.

## Goal

Swarm knows which agents are running. Nothing shows it.

`GET /agent-sessions` has existed since the warm-session work
(`server.ts:1804`). The control-plane contains **zero** references to it. There
is no broker passthrough, no client query, no surface — the data is served and
unreachable, which is the same failure that has shipped twice before: a route
added on swarm, a UI that fetches the broker, and a silent fallback in between.

Meanwhile three unrelated things in this codebase are called status:

| concept | source | describes |
| --- | --- | --- |
| `RosterAgent.status` | broker roster | voice/meeting presence — ring, hand, listening |
| `SessionSummary` | broker text-channel frames | a chat/artifact session; **carries no status at all** |
| `AgentSessionInfo.status` | swarm session manager | the running agent — what spec 1 rewrites |

Only the third answers "is anything waiting on me", and it is the one with no
path to a screen.

Two consequences:

1. **Attention does not scale past one agent.** With a single session a human
   checks it. With a crew, finding the one that needs a decision means opening
   each in turn — which is the polling loop the system was supposed to remove.
2. **Work and agents cannot be seen together.** A work item records its
   `delegation`, and a session records its agent, but nothing joins them, so
   there is no view of *which work is blocked* as opposed to which process is.

## Settled decisions

- **The rollup is derived in swarm, not in the client.** `cli.ts` and
  `dashboard.ts` already render session state; "needs attention" must not be
  able to disagree between the terminal and the UI.
- **A card is a work item, not a session.** Work items are the unit that gets
  assigned, and one card should represent a whole swarm rather than one row per
  member.
- **Sessions with no work item get their own column.** A warm session created
  ad hoc is still a live agent holding a model session; it must not be
  invisible.
- **Its own stage, reusing the board molecules.** Agents are not work items and
  do not belong in a board-type union that swarm mirrors.
- **Degraded fidelity renders as `unknown`.** A board that shows confident wrong
  states is worse than one that admits what it cannot see.
- **The map waits for spec 6.** Without dispatch lineage it would draw
  containment the board already shows better.

## 1. The data path, and the test that guards it

Swarm needs no new route. Two halves are missing and **belong in one commit**:

1. A named passthrough in `broker/src/main.ts`, beside the existing
   *"Work boards: verbatim proxy to the swarm's `/work/*` routes"* entry.
2. A control-plane query polling it.

Polling is sufficient. This is a board a human reads; a few seconds of latency
costs nothing, and a push frame would add a third lockstep parser to keep in
sync across two packages — a maintenance cost the existing frame comments
already call out.

**A route-parity test is part of this spec, not a nicety.** Every swarm route
the UI depends on must have a broker passthrough, asserted mechanically. This
exact bug — route present on 7791, UI fetching 7790, silent fallback — has
shipped twice. It has been caught twice by a human noticing. A third occurrence
is prevented by a test or it is not prevented.

## 2. Joining sessions to work

The join is `delegation.agentId` ↔ `session.agentId`.

That is sound only because of an invariant that lives in another spec: *an
assignee holds one work item at a time*
(`2026-08-16-workspace-instances-and-assignment-design.md`). One agent maps to
one work item, so the agent id is a sufficient key. Were an assignee ever to
hold two items, the join becomes ambiguous and this board silently attributes a
session to the wrong work.

So the invariant is **asserted here with a test** rather than assumed. A spec
that depends on someone else's invariant and does not check it is one refactor
away from being wrong without anything failing.

`delegation` today is `{ agentId, taskId, state }` — a single agent. The
workspace-instances design states that *agents and swarms are assignees*, but
swarm-as-assignee is not yet built. §3 defines the rollup for both, so the board
does not need revisiting when it arrives.

## 3. The rollup

One severity order, defined once in swarm:

```
blocked > working > done > idle > starting > unknown > dead
```

Four levels, each taking the highest severity beneath it:

```
session  →  assignee  →  work item  →  workspace
```

**For a swarm assignee**, three rules that are not simple maximum:

- Any member `blocked` ⇒ the assignee is `blocked`. One member waiting on a
  decision blocks the work, regardless of what the others are doing.
- `done` requires **every** member `done`. This is Orca's hibernation condition
  restated as a rollup rule — *"provider 'done' alone is not enough while
  children are still attached."* A leader that finished while its workers run is
  not finished.
- Any member `unknown` ⇒ the assignee cannot be `done`. An unreadable member
  makes completion unprovable, and reporting it anyway is the confident-wrong
  failure this spec exists to avoid.

The last two are the same principle from opposite directions: absence of
evidence is not evidence of completion.

## 4. The board

A stage of its own, composed from `BoardColumn` and `BoardCard` without joining
`BoardTypeT`. The molecules give the visual system; the union stays a
description of work boards, which swarm mirrors and every exhaustive switch
depends on.

| column | holds | default |
| --- | --- | --- |
| Needs You | work items whose assignee is `blocked` | shown |
| Working | assignee is `working` | shown |
| Done | assignee is `done`, not yet seen | shown |
| Idle | assignee is `idle` | **hidden** |
| Unassigned | sessions with no `delegation` | shown |

Idle is hidden by default because a quiet agent is not information; Orca reached
the same conclusion. It is revealed by a control on the board, not a global
setting.

**Cards are work items.** Title, workspace, assignee, rolled-up state, and time
in that state. A swarm assignee renders its members as chips carrying their own
states, so one card represents the whole crew and a five-member swarm blocked on
one decision occupies one row rather than five.

**Unassigned is the only column holding session cards.** It exists so that an
ad-hoc warm session — created through `POST /agent-sessions` with no delegation
— stays visible. Such a session is a live agent consuming a model session; a
work-centric board that hides it would make the most wasteful state the least
visible one.

Within Needs You, longest-blocked sorts first. A column named for a queue should
behave like one.

## 5. Fidelity is rendered

A session whose `statusFidelity` is `degraded` (spec 1 §5) renders as `unknown`
and is never placed in Needs You or Working. Its card carries a visible marker
saying status reporting is unavailable for it.

This is where spec 1's field earns its keep. The alternative — treating a silent
agent as idle — produces a board that looks calm precisely when its reporting is
broken.

## 6. Legibility before spec 1

If this spec ships first, every session reports `unknown` and every column
except Unassigned is empty.

That is a state to design for, not an edge case, because it is the state until
spec 1 deploys. The board says status reporting is not yet available, rather
than rendering four empty columns that look like a quiet system. An empty board
and a blind board must not look the same.

## 7. Errors and empty states

| condition | rendering |
| --- | --- |
| no sessions at all | empty state; not an error |
| sessions exist, all `unknown` | the §6 unavailable message |
| broker passthrough missing | surfaced as a connection error, never a silent empty board |
| work item with a delegation whose agent has no session | card shown, state `unknown` |
| session whose `agentId` matches no work item | Unassigned column |

The third row matters: the twice-shipped bug presented as an empty list, which
reads as "nothing is running". A missing passthrough must be loud.

## 8. Testing

- **Route parity:** every swarm route the UI depends on has a broker
  passthrough. Fails if one is added without the other.
- **Rollup table:** the severity order, plus the three swarm-assignee rules —
  any-blocked, all-done-required, and `unknown`-poisons-`done`.
- **The borrowed invariant:** an assignee holding two work items is rejected, so
  the §2 join stays sound.
- **Unassigned column:** a session with no delegation appears there and is not
  dropped.
- **Degraded rendering:** a degraded session never appears in Needs You or
  Working.
- **Blind versus empty:** all-`unknown` renders the unavailable message, and no
  sessions renders the empty state, and the two are distinguishable.

## Out of scope

- **The coordination map** (register C3) — spec 6, which defines the dispatch
  lineage worth drawing. Containment alone is what the board already shows.
- **Swarm-as-assignee plumbing.** §3 defines its rollup; building the assignee
  itself belongs to the workspace-instances line.
- **Mark-seen for the `done`/`idle` distinction.** Spec 1 leaves `done` decaying
  to `idle` on the next send; a real seen-timestamp is a later change and this
  board reads whatever spec 1 provides.
- **Push updates.** Polling until it measurably is not enough.
