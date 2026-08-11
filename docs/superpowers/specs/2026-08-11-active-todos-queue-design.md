# Active To-dos board with Queue intake — Design

**Date:** 2026-08-11
**Status:** Approved by Edwin (approach A; carry-over = Todo + Doing; trigger = midnight cron; escalation from triage on both boards)

## Problem

The personal board sits last in the tab order, is named "Personal", and has no
intake for work that arrives from elsewhere. Edwin wants it to be the first
thing he sees ("Active To-dos"), with a leftmost **Queue** column that collects
(a) cards he didn't finish the day prior and (b) items escalated from the
Maintenance and Reactive boards, so each morning he pulls from Queue into his
working set.

## Decisions (Edwin, 2026-08-11)

1. **Carry-over set:** cards left in **Todo or Doing** sweep to Queue at day
   rollover. Todo/Doing become a strictly-today working set rebuilt each
   morning from Queue.
2. **Trigger:** a **midnight cron** in the swarm server — not lazy-on-read,
   not both. Accepted consequence: if the swarm is down at 00:00, that day's
   sweep is skipped and leftovers wait for the next midnight. (The `sweptDay`
   stamp makes a boot-time catch-up a small later addition if this annoys.)
3. **Escalation sources:** the `triage` column on both `maintenance` and
   `reactive` boards — escalation is a triage decision, matching how
   reactive.triage already fans out to maintenance/ideation.
4. **Approach:** data migration + pure sweep helper + midnight timer (no
   generic template-versioning system, no client-computed virtual column).

## Design

### 1. Rename + tab order

In `swarm/src/work-items.ts` and its lockstep mirror
`control-plane/src/lib/board-aggregate.ts`:

- `BOARD_TYPE_ORDER`: `personal` moves from last to **first**. The
  "personal is always last" comments flip to first.
- `BOARD_TYPE_LABELS.personal` → `"Active To-dos"`.
- `WORKSPACE_BOARD_TYPES` continues to derive by filtering `personal` out —
  unchanged.

The personal tab label renders from the persisted `board.name`, so existing
installs rely on the migration in §3, not the label constant.

### 2. Queue column + quick-add default

Personal template columns become:

| id | name |
|----|------|
| `queue` | Queue |
| `todo` | Todo |
| `doing` | Doing |
| `done` | Done |
| `not-doing` | Not Doing |

Queue is pure intake: only the sweep and escalation routes put cards there;
the user drags cards out to pick them up.

`addCard` currently defaults to `board.columns[0]`, which would drop
quick-added cards into Queue. New helper in `work-items.ts`:

- `defaultColumnFor(board)` → `"todo"` when `board.type === "personal"`,
  otherwise `board.columns[0].id`. `addCard` uses it. Rationale: fresh
  to-dos are the user's intent; Queue holds only what the system routed there.

### 3. Lazy migration of the existing board file

`normalizePersonalBoard(board)` applied inside `loadBoards` to boards with
`type === "personal"`:

- Rename to `"Active To-dos"` **only if** the persisted name is exactly
  `"Personal"` (a user's custom rename is preserved).
- Prepend the `queue` column if no column with id `queue` exists.

Idempotent, in-memory on every read; persisted whenever the next mutation
saves the board. No one-shot rewrite pass.

### 4. Escalation routes

Two new `BOARD_ROUTES` entries (both lockstep files):

- `maintenance`: `{ from: "triage", toType: "personal", toColumn: "queue", label: "Escalate to Active To-dos" }`
- `reactive`: the same entry.

`findRouteDestination` gains one special case: when `exit.toType ===
"personal"`, match the singleton personal board and skip the
workspace-equality check (the personal board has no `workspaceId`).
Escalated cards keep their `routedFrom` provenance trail via the existing
`routeCard` mechanism — untouched.

### 5. Midnight sweep

- New optional persisted field `WorkBoard.sweptDay?: string` (local
  `YYYY-MM-DD`), stamped on the personal board only.
- Pure helper `sweepPersonalBoard(board, today)` in `work-items.ts`:
  - No-op (returns not-dirty) unless `type === "personal"` and
    `sweptDay !== today`.
  - Moves every card in `todo` and `doing` to the **end** of `queue` —
    Todo's cards first, then Doing's, relative order preserved; renumbers;
    stamps `updatedAt` on moved cards and `sweptDay` on the board.
  - Returns whether the board is dirty (sweptDay stamp alone counts — it
    must persist).
- `server.ts`: `setTimeout` scheduled for the next local midnight; on fire —
  load boards, sweep the personal board, save if dirty, reschedule. Same
  lifecycle shape as `reapTimer`: created on start, cleared on stop. The
  `sweptDay` guard makes double-fires no-ops.
- The ms-to-next-midnight computation is a pure exported function so it can
  be unit-tested; the timer wiring itself stays untested like `reapTimer`.
- No WS broadcast for the sweep; the UI sees it on the next fetch/refocus.

### 6. UI (control-plane)

Mostly data-driven, so free: tab order comes from the mirrored constant, the
tab label from `board.name`, columns render from persisted data (Queue just
appears), and the escalate action surfaces through the existing `exitsFor`
exits UI on maintenance/reactive triage cards.

### 7. Testing

- **work-items unit tests:** sweep semantics (Todo+Doing append to Queue in
  order, per-day idempotence via `sweptDay`, non-personal no-op, dirty flag
  on stamp-only change), normalize (exact-name-only rename, idempotent queue
  prepend), `defaultColumnFor`, `findRouteDestination` personal special case.
- **Server route test:** escalate a maintenance `triage` card → lands in
  personal `queue` with a `routedFrom` trace (existing route test pattern).
- **Pure timer math:** ms-to-next-midnight function.
- **Control-plane:** BoardTabs / BoardStage / board-aggregate tests updated
  for the new order and label.

## Out of scope

- Boot-time catch-up sweep (explicitly declined; revisit only if the
  down-at-midnight gap bites).
- Escalation from non-triage columns.
- Any generic template-versioning/migration machinery.
- WS push for sweep results.
