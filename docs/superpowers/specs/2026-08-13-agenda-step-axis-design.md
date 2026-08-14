# Agenda as a Per-User Step Axis — Design

**Date:** 2026-08-13 · **Status:** DRAFT, awaiting Edwin's review · **Decision trail (chat):** hybrid owns-todos-and-mirrors → qualify on signals *and* human-gated columns → "option A" (agenda has its own lanes) → axis is scoped to the card's current team state → holder must be visible on the team board → per-user, not one holder → morning sweep resets intent

Edwin's model, in his words:

> "the agenda tab is not like the other boards — it's what the user is working on that is on the user's plate or needs their attention, where queue would show on their queue"

> "agenda is on another axis for the given state a card is in on team boards"

> "the team boards represent state of the workflow — agenda represent the state of the step by a user"

> "on team board i should be able to see edwin is doing the Spec"

> "every morning all cards assigned to user would just be thrown back to the queue and user would drag things as what they are actively working on"

## The model

Two independent axes over one card. Nothing is copied, mirrored, or dual-homed.

| Axis | Question it answers | Where it lives |
|---|---|---|
| **Workflow state** | Where is this work in the pipeline? | `card.columnId` on its home board |
| **Step state** | How is the current step going, and whose is it? | `card.agenda[]`, one entry per user |
| **Impediment** | Is it stuck? | `card.flag` (existing, unchanged) |

The step axis is **scoped to the column the card currently sits in**. It describes progress on *that step*, not a free-standing personal lane — which is why advancing a card clears it. `flag` is the existing precedent for an orthogonal axis: *"Orthogonal to columnId — a flagged card keeps its position."*

```
TEAM BOARD (plan/spec)              EDWIN'S AGENDA
  Auth rewrite                        Doing lane
  👤 Edwin · doing                    ┌──────────────────┐
  👤 Ana   · queue                    │ Auth rewrite     │
                                      │ Plan · spec      │
  organized by workflow state;        └──────────────────┘
  shows every holder's step state     organized by HIS step state;
                                      shows the workflow state
```

Each surface is organized by the axis the other one displays. Neither invents lanes belonging to the other.

## Part 1 — Schema

**`WorkCard` gains one field** (swarm `work-items.ts`):

```ts
/** Per-user state of the CURRENT step — orthogonal to columnId, like `flag`.
    Cleared wholesale when the card changes column: the step it described has ended. */
agenda?: Array<{
  by: string;        // user id, resolved against .smith/users for display
  state: StepState;
  since: string;     // ISO, stamped on entry into the state; survives a re-stamp of the same state
}>;

export type StepState = "queue" | "doing";
```

`done` is deliberately **not** a state. Finishing a step is expressed by advancing the card, which clears the entries; and the morning sweep (Part 4) would wipe a Done lane nightly anyway, so it could never accumulate meaning.

Multiple entries per card, at most one per user. A card with three holders is normal — three people each have their own state on the same step.

**`WorkColumn` gains one field:**

```ts
/** This column structurally waits on a human — arriving cards auto-queue for the
    operator (Part 3). Seeded by BOARD_TEMPLATES, toggled from the column config gear. */
gatesHuman?: boolean;
```

Seeded `true` on: `deliver/review`, `deliver/verify`, `release/sign-off`, `release/regression`, `reactive/triage`, `maintenance/triage`. Everything else false. This is the containment valve for the flooding risk — a board that buries you is one gear click from not doing so.

**`User` gains one field** (swarm `users.ts`):

```ts
/** Local YYYY-MM-DD of this user's last agenda sweep. Per-user because the sweep is per-user. */
agendaSweptDay?: string;
```

This supersedes `WorkBoard.sweptDay` for the agenda axis. `sweptDay` **stays** on the personal board, still governing that board's own cards (Part 4).

## Part 2 — Invariants

1. **The step axis never writes the workflow axis, and vice versa.** Dragging on a team board writes `columnId`. Dragging a team card on Agenda writes that user's `agenda[].state`. No helper does both.
   **Exception, personal-board cards:** they have no workflow axis, so their `columnId` *is* their Agenda lane. Dragging one on Agenda writes `columnId` and never touches `agenda`. The two card kinds take different write paths on the same surface; the drag handler branches on `board.type === "personal"`.
2. **A column change clears `agenda` entirely.** The step ended; every holder's state on it is void. Enforced in the one card-move helper, not at call sites.
3. **At most one entry per `by`.** Two distinct write modes, and conflating them is the likely bug:
   - **User action** (you drag on Agenda) — upsert: replaces your existing entry's state.
   - **Trigger** (Part 3) — insert-if-absent: adds a `queue` entry only when you have no entry at all, so an automated signal can never demote work you already pulled into `doing`.
4. **`since` survives a same-state re-stamp** and resets on a state change — mirroring `CardFlag.since`'s documented behavior exactly.
5. **An empty array is never persisted** — clearing the last entry drops the field, so `agenda?` absent and `agenda: []` never both mean "unclaimed".

## Part 3 — What puts a card on your queue

These add a `{ by: <current user>, state: "queue" }` entry. They never set `doing` — the machine can put work *on* your queue; only you declare what you're working on.

| Trigger | Rationale |
|---|---|
| `flag` set to blocked / at-risk / waiting | Someone marked it stuck; it needs a human |
| `delegation.state` → `completed` or `failed` | The agent handed it back to you |
| `jira.lastPushError` present | The integration broke and can't self-heal |
| Card enters a column with `gatesHuman` | The workflow structurally waits on a person |

A card whose `delegation.state` is `working` gets nothing — it's on the agent's plate, not yours. That distinction is the point of the whole feature.

Stamping is idempotent: a trigger firing against an existing entry for that user is a no-op, so a card that's already in your `doing` is never yanked back to `queue` mid-day.

## Part 4 — The morning sweep

> "every morning all cards assigned to user would just be thrown back to the queue and user would drag things as what they are actively working on"

Generalizes the existing `sweepPersonalBoard`, which already rolls Todo/Doing into Queue at local midnight under a `sweptDay` idempotence guard.

```ts
/** Every agenda entry for `userId` in state "doing" reverts to "queue", across every board.
    Guarded by user.agendaSweptDay so a double-fire is a no-op. Pure: caller owns load, save, clock. */
export function sweepUserAgenda(boards: WorkBoard[], userId: string, today: string): boolean;
```

- **Cron-only**, preserving the 2026-08-11 ruling recorded at `server.ts:471`: if the server is down at 00:00 the sweep waits for the next one. No lazy on-read sweep.
- Runs in the same midnight timer that already fires `sweepPersonalBoard`, which continues to run unchanged for the personal board's own cards.
- `since` is re-stamped on revert, so "how long has this been on my queue" stays honest.

The daily wipe is what makes `doing` mean *actively working on today* rather than *touched this once in March*.

## Part 5 — Rendering

**Team board.** Each card renders a holder chip per `agenda[]` entry: avatar/initial, user name, step state. Unclaimed cards render nothing — no empty-state chrome.

**Agenda tab.** `useBoards()` already fetches every board in one query and `board-aggregate.ts` already supports one tab spanning many boards (`AggCard` carries `boardId`/`workspaceId`; `collectCards` gathers across boards). Changes:

- `tabsFor` currently gives the personal tab `boardIds: [personal.id]`. Agenda's descriptor becomes **every** board id.
- New sibling to `collectCards`:
  ```ts
  /** Cards where `userId` holds a step entry in `state`, tagged with provenance. */
  export function collectAgendaCards(boards: WorkBoardT[], userId: string, state: StepState): AggCard[];
  ```
- Team cards render a provenance badge — home board + workflow column ("Plan · spec") — which is how the workflow axis stays visible from the Agenda side.
- **Intra-lane order is two-tier**, because a lane mixes two card kinds with two different ordering stories: personal-board cards first, by their existing `order` (drag-reorderable, unchanged); then team cards, by `since` oldest-first — what's waited on you longest floats to the top of that group. `order` is per-column-per-board and the helpers renumber per board, so it cannot order a cross-board lane; team cards therefore have **no manual reordering** on Agenda.

**The personal board's own cards keep their existing five columns** (`queue/todo/doing/done/not-doing`), their existing drag-ordering, and their existing sweep. They are standalone todos with no workflow axis, so they render in the matching Agenda lane by `columnId`. Team-card entries only ever occupy Queue and Doing.

## Part 6 — Out of scope

- No assignment *by* someone else. Entries are self-claimed or auto-queued; there is no "assign to Ana" action in v1.
- No agent holders. `delegation` already tracks agent work; `agenda[].by` is humans only.
- No cross-user views ("what is Ana working on") beyond the chips already on the team board.
- No history of past steps. Entries are cleared on advance, not archived.

## Open decisions for Edwin

1. **Workspace scope.** `tabsFor`'s comment calls personal *"context-invariant — the one tab whose content is not a function of the dropdown."* Agenda now draws from workspace-scoped boards. **Recommendation: keep it context-invariant** — your plate is your plate regardless of which workspace you're filtered to. This does reverse the stated rule, so it needs your call.
2. **Identity.** `users.ts` is single-operator (`resolveCurrentUser`: "no auth in all-local mode") and the default record is `{ id: "me", name: "You" }`. For the chip to read "Edwin", that record's `name` must be set to Edwin. Confirm the chip shows `user.name` rather than a new display-name concept.
3. **Sweep target.** Confirm the sweep resets `doing → queue` only, and does not clear entries outright. Resetting keeps the card on your plate; clearing would drop it off entirely and rely on the Part 3 triggers to re-add it.

## Testing

Swarm (node test runner, pure helpers — no server boot):

- `agenda` upsert-by-user: second write for the same user replaces, never appends; `since` resets on state change and survives a same-state re-stamp.
- A column change clears `agenda`; a same-column reorder does not.
- Empty array is never persisted.
- Each Part 3 trigger stamps exactly one `queue` entry and is idempotent against an existing `doing` entry.
- `delegation.state: "working"` stamps nothing.
- `sweepUserAgenda`: `doing → queue` across several boards; second call same day is a no-op; other users' entries untouched; `agendaSweptDay` persists even when no entry moved.

Control-plane (vitest + jsdom):

- `collectAgendaCards` gathers a user's entries across boards, excludes other users'.
- Lane ordering: personal cards (by `order`) precede team cards (by `since` oldest-first).
- Team card on Agenda shows its provenance badge; personal card does not.
- Team board renders one chip per holder; unclaimed renders none.
- Dragging a **team** card on Agenda issues a step-state patch and **no** `columnId` patch.
- Dragging a **personal** card on Agenda issues a `columnId` patch and **no** step-state patch. Both directions of invariant 1 need a test, or the drag handler's branch silently collapses to one path.
