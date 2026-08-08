# Workspace board tabs + the six-board workflow system

Status: draft
Date: 2026-08-07
Supersedes parts of: `2026-08-06-kanban-work-boards-design.md`, `2026-08-06-capability-story-maps-design.md`

## Goal

Replace the shipped five-template board registry with a coherent six-board
workflow system, make a workspace hold many boards navigated by tabs, and add
a workspace context dropdown with a cross-workspace aggregate view.

Three things change at once because they are one feature: the six templates are
only useful if a workspace can hold several of them, several boards are only
navigable with tabs, and tabs are only meaningful once a board knows its own
type.

## Background

Boards shipped as `.smith/work/<id>.json`, one file per board, with columns
baked in as data at creation time. `WorkBoard.workspaceId` exists and
`BoardStage` already renders per-workspace `<optgroup>`s — but `POST
/work/boards` never reads a `workspaceId`, so only `ensureWorkspaceBoards()`
could mint one, and only the Capabilities/Delivery pair. That grouping render
path has been dead code since it landed.

The root cause is that `createBoard(name, template)` copies the template's
columns into the file and then discards the template. A board records *what
columns it has*, never *what kind of board it is*. Without that identity there
is nothing for a second board in a workspace to be, no key for a tab, and no
way to say where a routed card should land.

## Decisions

Settled with Edwin during brainstorming, recorded here because several are not
recoverable from the code:

| Decision | Ruling |
| --- | --- |
| Scope | Templates + tabs/dropdown + cross-board moves. No fan-out, no WIP limits. |
| Registry | `personal` + the six. `capabilities`/`delivery`/`support` retired; `maintenance` redefined. |
| Cardinality | One board per type per workspace. Exactly one personal board. |
| Auto-provision | A new workspace gets Ideation + Plan + Deliver. The rest via `+ add`. |
| Aggregate grouping | Cluster in-column under a workspace subheading. |
| Workspace colour | Tints the whole card. Settable, with a derived default. |
| Personal | Its own tab, present in every context, never aggregated. |
| Existing boards | Deleted outright. No migration. |

## Data model

`WorkBoard` gains a persisted `type`. This is the identity that tabs,
cardinality enforcement, and routing all key off.

```ts
export type BoardType =
  | 'personal' | 'ideation' | 'plan' | 'deliver'
  | 'release'  | 'reactive' | 'maintenance';

export interface WorkBoard {
  id: string;
  name: string;          // seeded from the type's label; renameable via PATCH
  type: BoardType;       // NEW, required
  columns: WorkColumn[];
  cards: WorkCard[];
  jira?: { connectorId: string; siteUrl: string; projectKey: string; jql?: string };
  workspaceId?: string;  // absent ⇒ the personal board
}
```

`type` is required, not inferred. Because every existing board file is deleted
(see Migration), there is no legacy shape to tolerate, and `assertBoard` can
reject a file without a valid `type` the same way it already rejects one
without `columns`.

`BoardTemplate` is renamed `BoardType` throughout. It stopped being a
seed-only concept the moment a board remembers it.

`WorkCard` gains a routing trace, appended on every cross-board move:

```ts
/** Appended each time this card is routed to another board. Never rewritten. */
routedFrom?: Array<{ boardId: string; boardType: BoardType; columnId: string; at: string }>;
```

This is what keeps a card's history legible after it has crossed two or three
boards — the card id is stable across a move, so the trace plus the id is a
complete provenance chain.

## Template registry

`BOARD_TEMPLATES` becomes seven entries. Column ids are the slugs shown.

| Type | Label | Columns (`id` → Name) |
| --- | --- | --- |
| `personal` | Personal | `todo` Todo · `doing` Doing · `done` Done · `not-doing` Not Doing |
| `ideation` | Ideation | `intake` Intake · `scoping` Scoping · `confirm` Confirm · `killed` Killed |
| `plan` | Plan | `spec` Spec · `tech-design` Tech design · `decomposed` Decomposed · `ready` Ready |
| `deliver` | Deliver | `ready` Ready · `in-progress` In progress · `review` Review · `verify` Verify · `merged` Merged |
| `release` | Release | `cut` Cut · `regression` Regression · `sign-off` Sign-off · `ship` Ship · `rollback` Rollback |
| `reactive` | Reactive | `triage` Triage · `diagnose` Diagnose · `fix` Fix · `verify` Verify · `closed` Closed |
| `maintenance` | Maintenance | `triage` Triage · `queued` Queued · `doing` Doing · `done` Done · `wont-do` Won't do |

Canonical tab order: ideation, plan, deliver, release, reactive, maintenance,
then personal last.

`Killed`, `Won't do`, and `Not Doing` are real terminal columns, not routes.
Boards that own an outcome get a terminal column; boards that hand work onward
get an exit instead — which is why Plan and Deliver have neither.

Reactive deliberately merges what the retired `support` template did: alerts,
tickets, and release defects all land in the same Triage.

## Route registry

`BOARD_ROUTES` sits beside `BOARD_TEMPLATES` as a second static data table.

```ts
export interface RouteExit {
  from: string;        // column id on the source board
  toType: BoardType;
  toColumn: string;    // column id on the destination board
  label: string;       // rendered on the pill
}

export const BOARD_ROUTES: Record<BoardType, RouteExit[]> = {
  plan:     [{ from: 'tech-design', toType: 'ideation',    toColumn: 'scoping',     label: 'Back to ideation' }],
  deliver:  [{ from: 'in-progress', toType: 'plan',        toColumn: 'tech-design', label: 'Back to plan' }],
  release:  [{ from: 'regression',  toType: 'deliver',     toColumn: 'in-progress', label: 'Drop change to deliver' },
             { from: 'rollback',    toType: 'maintenance', toColumn: 'triage',      label: 'To maintenance' }],
  reactive: [{ from: 'triage',      toType: 'maintenance', toColumn: 'triage',      label: 'To maintenance' },
             { from: 'triage',      toType: 'ideation',    toColumn: 'intake',      label: 'To ideation' }],
  ideation: [],
  maintenance: [],
  personal: [],
};
```

Routes are static rather than per-board configuration. Per-board `exits[]`
would be more flexible, but there is no UI to edit it — the same dead-config
trap that board `jira`/rename/delete already fell into, where the only way to
configure something is to hand-edit JSON. Static keeps every workspace's
workflow identical and keeps the pills honest.

Two flows in the source diagrams are deliberately not routes:

- Ideation's Confirm → Scoping loop is a same-board drag.
- Maintenance's "Scanners, rollbacks, triage" intake is descriptive. The
  Release → Maintenance route is the only code path into that board.

## Board identity and naming

- Workspace board id: `<ws-slug>-<type>`, extending the existing
  `workspaceBoardId()` whose target type widens from `'capabilities' |
  'delivery'` to `BoardType`.
- Personal board id: `personal`.
- `createBoard` stops deriving the id from the name. It takes
  `(type, workspaceId?)` and seeds `name` from the type's label.

Deriving the id from the type rather than the name means "default name based
on type" is structural, and a later rename via `PATCH /work/boards/:id` never
has to move a file on disk.

## API

### `POST /work/boards`

Body `{ type, workspaceId? }`. Name is derived; no `name` field is accepted.

- 400 on an unknown type.
- 400 when `type: 'personal'` is sent with a `workspaceId`, or when any of the
  six workspace types is sent without one. Personal is workspace-less by
  definition; the six are workspace-scoped by definition.
- 409 when that workspace already holds a board of that type, or when
  `type: 'personal'` and the personal board already exists.

### `POST /work/boards/:id/cards/:cardId/route`

Body `{ toType }`. Moves the card to another board.

1. Resolve the route: an entry in `BOARD_ROUTES[board.type]` whose `from`
   matches the card's current `columnId` and whose `toType` matches the body.
   400 if none — a card can only leave from a column that has an exit.
2. Resolve the destination: the board with `type === toType` and the same
   `workspaceId`. 404 with an actionable message when that board has not been
   added to the workspace yet.
3. Append to `routedFrom`, set `columnId` to the route's `toColumn`, and place
   the card last in that column.
4. **Write the destination board first, then remove the card from the source
   and write that.**

Step 4's ordering is the whole of the failure design. Two file writes cannot be
atomic, so the choice is which way a crash between them fails: destination-first
leaves a visible duplicate, source-first loses the card. A duplicate is
recoverable by deleting one; a loss is not.

The card keeps its UUID and carries `stories`, `jira`, `delegation`, and
`capabilityRef` intact. That is what makes it the same object on the far side.

### Slice send — unchanged wire, remapped internally

`POST /work/capabilities/:id/slices/:sliceId/send` keeps taking
`target: 'capabilities' | 'delivery'` and keeps storing refs under
`capCardRef` / `deliveryCardRef`. Inside the handler, `'capabilities'` resolves
to board type `plan` and `'delivery'` to `deliver`.

Those wire values and ref keys are persisted on every capability file. Renaming
them would mean migrating capability data for no user-visible gain.

### Provisioning

`ensureWorkspaceBoards()` mints **ideation + plan + deliver** for a workspace
that lacks them, replacing today's capabilities + delivery pair.

The personal board is not covered by that function, which is workspace-scoped.
`GET /work/boards` ensures the personal board exists before loading, so the
Personal tab always has something behind it — including on a fresh install and
immediately after the wipe. This is the only place a board is created as a side
effect of a read; the alternative is a Personal tab that renders an empty state
nobody can act on, since `+ add` does not offer personal.

## UI

`BoardStage.tsx`. The `<select>` board picker is replaced by a workspace
dropdown sitting above a tab row.

```
┌ All workspaces ▾ ┐
┌──────────┬──────┬─────────┬─────────────┬──────────┬───┐
│ Ideation │ Plan │ Deliver │ Maintenance │ Personal │ + │
└──────────┴──────┴─────────┴─────────────┴──────────┴───┘
```

**Dropdown**: `All workspaces`, then each workspace by name. No Personal entry.

**Workspace scope**: tabs are that workspace's boards in canonical type order,
labelled with `board.name`. `+ add` offers only the six workspace types not yet
present — never `personal`, which belongs to no workspace.

**All workspaces**: tabs become board *types* — only those present in at least
one workspace. No `+ add`, since there is no workspace to create into. Within
each column, cards cluster under a workspace subheading, and each card is
tinted with its workspace's colour. A workspace that holds no board of the
selected type simply contributes no cluster; it is not shown as empty.

Columns unify for free: every board of a type was minted from the same template,
so all `*-plan` boards share identical column ids and the union renders in one
column set with no reconciliation. Cards do not — `WorkCard` carries no
workspace field, so the aggregator tags each card with its source board on the
way in.

**Personal**: always the last tab before `+`. Its content is identical in every
dropdown context — it is the one tab whose content is not a function of the
dropdown. Never clustered, never tinted. This is modelled explicitly in the tab
state rather than falling out of a `workspaceId === undefined` filter, so it
cannot be quietly folded into the aggregate later.

**Drag**: unchanged within a single board. In the aggregate view, drag is
confined to a workspace cluster and a cross-cluster drop is rejected —
`applyMove` PATCHes a single board id, and a cross-workspace move has no
meaning under that route. Grouping doubles as the drag fence.

`SortableContext` keeps one flat `items` array per column while the render
nests, so grouping does not touch `resolveDrop`.

**Route pills**: rendered in `CardSheet` for whichever exits match the open
card's current column. They work in the aggregate view too, since the card's
source board resolves its workspace.

## Workspace colour

`Workspace` gains an optional colour, defaulting to a hash of the name into a
fixed eight-hue palette, editable as a swatch row in `NewWorkspaceModal` and
`WorkspaceManagerModal`.

```ts
export interface Workspace {
  // …
  /** Optional; falls back to a hash of `name` into the standard palette. */
  color?: string;
}
```

A derived default means colours are stable with zero configuration, and the
override means a rename does not shift a workspace's colour out from under the
user. `BoardStage` already fetches `/workspaces` but discards everything except
`name`; it starts keeping `color`.

Tinting the whole card is a deliberate trade. The source diagrams used card
fill to encode card *kind* — purple for a change, teal for a job card, red for
a defect. That encoding does not exist in the code today (all cards render one
uniform fill), so workspace tint costs nothing currently shipped. It does
foreclose adding a kind encoding later without finding a second channel.

## Migration

Every existing board file is deleted. There are four, holding two cards
between them:

| File | Cards |
| --- | --- |
| `jefelabs-capabilities.json` | 0 |
| `jefelabs-delivery.json` | 0 |
| `support.json` | 0 |
| `skoolscout.json` | 2 — "Manage Agents", "Usr can pay with Mastercard" |

Neither card carries a Jira link, delegation, stories, or capability ref. Both
are discarded by Edwin's ruling.

Deleting a board would orphan any story-map slice pointing at it, and because a
set `capCardRef`/`deliveryCardRef` makes the send route 409 with "Slice already
sent" — with no UI to clear it — an orphaned ref would permanently block
re-sending. Both capability files (`jefelabs-store-management`,
`jefelabs-video-conference`) have zero slices, so nothing references a card and
the wipe is clean. **Re-verify this before deleting**, since slices may be
authored between now and implementation.

After the wipe, `ensureWorkspaceBoards` remints ideation/plan/deliver on the
next workspace load, and the personal board is created empty.

## Testing

Helpers-only unit tests, matching the existing convention in
`work-items.test.ts` — routes stay thin and tests never boot the server.

- Route resolution: valid exit resolves; wrong column rejects; unknown
  `toType` rejects; missing destination board 404s.
- Cardinality: a second board of the same type in one workspace 409s; a second
  personal board 409s.
- `createBoard` derives `<ws-slug>-<type>` ids and seeds the type's label.
- `assertBoard` rejects a file with a missing or invalid `type`.
- The routed card keeps its id and carries `stories`/`jira`/`capabilityRef`,
  and `routedFrom` gains exactly one entry per move.
- The pure group-by-workspace function behind the aggregate view.

Destination-first write ordering is asserted by unit-testing the move helper's
returned write plan rather than by simulating a crash.

## Out of scope

- Plan → Deliver fan-out (parent retires at Decomposed, spawning linked job
  cards). The next natural increment.
- WIP limits on Deliver.
- Release intake — how a release card gets cut in the first place is not drawn
  in the source diagrams. Release cards are hand-authored for now.
- Cross-workspace card moves.
