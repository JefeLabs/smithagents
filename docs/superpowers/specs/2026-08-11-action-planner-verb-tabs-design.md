# Action Planner, verb tabs, universal Queue — Design

**Date:** 2026-08-11
**Status:** Approved by Edwin (rename + distinguishing color; verb-form tabs with Release last; Queue leftmost on Deliver/React/Maintain, Maintain's Queued becomes it)

## Problem

The personal board's name ("Active To-dos") reads as a list, not the
planning surface it is; the workspace tabs are noun-form and Release sits
mid-strip; and only the personal board has the Queue intake pattern —
Deliver/React/Maintain have no leftmost lane for work that arrives from
elsewhere.

## Decisions (Edwin, 2026-08-11)

1. Personal board → **Action Planner**, first tab, with a distinguishing
   accent color on its tab.
2. Workspace tabs, in order after it: **Ideate | Plan | Deliver | React |
   Maintain | Release** (labels go verb-form; Release moves last).
3. **Queue leftmost** on Deliver and React (new column) and on Maintain —
   where the existing `queued` column is renamed **Queue** and moved
   leftmost (one queue, not two); its cards move with it. Feeds keep
   dropping into Maintain/React **Triage**.

## Design

### Constants (BOTH lockstep files: swarm/src/work-items.ts + control-plane/src/lib/board-aggregate.ts)

- `BOARD_TYPE_LABELS`: personal "Action Planner", ideation "Ideate",
  reactive "React", maintenance "Maintain" (plan/deliver/release keep
  their already-verb names).
- `BOARD_TYPE_ORDER`: `[personal, ideation, plan, deliver, reactive,
  maintenance, release]`.
- Escalate route label: "Escalate to Action Planner" (both files).
- Templates: deliver `[queue, ready, in-progress, review, verify,
  merged]`; reactive `[queue, triage, diagnose, fix, verify, closed]`;
  maintenance `[queue, triage, doing, done, wont-do]` (queued is gone
  from the template). Personal unchanged.

### Migration (swarm, lazy, in-memory — the normalizePersonalBoard pattern generalized)

`normalizeBoard(board)` applied in `loadBoards`:

- **Rename**: if `board.name` equals its type's old default label —
  personal: "Personal" or "Active To-dos"; ideation: "Ideation";
  reactive: "Reactive"; maintenance: "Maintenance" — it becomes the new
  label. Custom names are preserved.
- **Queue**: personal/deliver/reactive prepend `{ id: "queue", name:
  "Queue" }` if no `queue` column exists. Maintenance: if it has
  `queued` and no `queue`, the column is renamed to `queue`/"Queue" AND
  moved to the front, and every card with `columnId: "queued"` is
  rewritten to `"queue"` — cards travel with their lane. (A maintenance
  board with neither gets a plain prepend.)
- In-memory on every load; persisted on the next mutation, as before.

### defaultColumnFor generalizes

First column whose id is not `"queue"` (fallback `columns[0]`): the
personal special case dissolves. Quick-adds land Action Planner→Todo,
Deliver→Ready, React/Maintain→Triage. System intake (Jira import's
explicit leftmost, future routing) targets Queue everywhere it exists.

### Untouched

Midnight sweep (personal todo/doing→queue); every route's column ids —
plan→deliver lands `ready`, release rollback→maintain lands `triage`,
escalations land personal `queue`; the sweptDay stamp; cross-board drag.

### Tab color (control plane)

BoardTabs gives the personal tab a modifier class (keyed on
`tab.type === "personal"`); CSS tints it with the existing `--accent`
token (border/text/background mix) so all four themes inherit — distinct
from both idle and selected workspace tabs, composable with the selected
state.

### Testing

- work-items: template lists (three boards gain queue; maintenance loses
  queued), order, labels, `normalizeBoard` cases (rename chains,
  prepends, the queued→queue move WITH card columnId rewrite,
  idempotence, custom names kept), `defaultColumnFor` per type, escalate
  label, route/template validity (existing test auto-covers).
- capabilities: ensurePersonalBoard name → "Action Planner".
- control plane: aggregate labels/order mirror test, BoardTabs color
  modifier + fixtures, BoardStage/CardSheet fixture renames
  ("Active To-dos"→"Action Planner", "Escalate to Action Planner").
- Live smoke + swarm service restart (constants and migration live
  there).

## Out of scope

- Any route/flow changes into the new Deliver/React Queue lanes (they
  are empty intake for now; routing into them is future work).
- Renaming board type IDS (`reactive`, `maintenance` stay as ids —
  labels only).
- Tab color user-customization.
