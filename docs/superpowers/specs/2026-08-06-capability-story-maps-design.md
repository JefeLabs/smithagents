# Capability story maps — design

Date: 2026-08-06
Status: approved pending user review

## Goal

A **capability layer above the work boards**. Each workspace (product) can hold capabilities, each with a Patton-style user story map: **activities → steps → stories**. Slices carved across a map are the "appropriately sized" unit of work: a slice seeds a spec doc (its stories become the spec's `## Acceptance criteria`), the spec gets exactly one plan, and the slice is tracked as **linked cards** on the workspace's **Capabilities** board (authoring stages) and **Delivery** board (implementation). Story done/verified truth lives in the capability; card checklists are synced views of it.

## Relationship to the kanban work-boards spec (2026-08-06)

Amends that spec before implementation starts:

- Templates grow from two to **five**: `personal` (unchanged), `capabilities` (replaces `capability`), `delivery`, `maintenance`, `support`.
- `WorkBoard` gains optional `workspaceId`; `WorkCard` gains optional `capabilityRef`.
- **Supersedes** "stories are authored in a spec's `## Acceptance criteria` section": stories are authored **in the map** and *exported* to the spec. The deferred one-way *import from spec docs* flips to *export to spec docs* (shipped here); the deferred *cross-board story view* is absorbed by the map (story truth already rolls up there).
- Hand-entered checklists on standalone cards keep working exactly as specced; nothing else in that spec changes.

## Decisions made with Edwin

- **Map shape:** Patton story map — activity row, step row beneath it, story stacks under each step (Edwin's StoriesOnBoard reference). Slices are horizontal cuts across the map.
- **Slice seeds the spec doc.** Generating from a slice writes a skeleton markdown spec into the workspace repo with `## Acceptance criteria` pre-filled from the slice's stories. Brainstorming fills the rest. One spec → one plan (existing convention, now linked as data).
- **Explicit sends, linked cards.** Sending a slice to a board is an explicit action; one card per slice per board; a slice holds both refs. Cards never hop boards; nothing auto-moves (work-boards rule holds).
- **Workspace-scoped.** A capability belongs to a workspace; its generated specs land in that workspace's repo; its cards land on that workspace's board pair — no board chooser on send.
- **Auto-provision the pair only.** Creating a workspace's first capability creates its Capabilities + Delivery boards (sends depend on them existing). `maintenance` and `support` ship as **templates only** — created on demand, never auto-provisioned, no intake wiring in v1. Rationale (Edwin): depending on the ownership level, the user or team may not use those boards at all.
- **Story truth in the capability.** Linked-card checklists are **toggle-only** (done / `verifiedBy`); text edits, add, and remove happen only in the map. Standalone cards keep full local checklist CRUD.
- **Delivery send is gated on the spec existing** (`specPath` set). Plan linking is by hand in v1.

## 1. Data model (swarm)

New file kind `.smith/work/capabilities/<capabilityId>.json` (rides the existing `/reset` archive of `.smith/work/`). Ids are slugs matching the board-id rule. New module `swarm/src/capabilities.ts`: load/save/validate (malformed file → error entry, others load), CRUD + move/reorder helpers, slice helpers — all unit-testable without booting the server.

```ts
interface Capability {
  id: string;
  name: string;
  workspaceId: string;
  activities: Array<{ id: string; name: string; order: number;
                      steps: Array<{ id: string; name: string; order: number }> }>;
  /** Flat, keyed to a step (mirrors cards→columnId). Order is per-step. */
  stories: Array<{ id: string; stepId: string; order: number; text: string;
                   done: boolean; verifiedBy?: string }>;
  slices: Array<{
    id: string; name: string; order: number;
    /** Invariant: storyIds are disjoint across slices. Unsliced stories = backlog pool. */
    storyIds: string[];
    /** Workspace-relative path of the generated spec doc. */
    specPath?: string;
    /** Hand-linked when the plan is written. */
    planPath?: string;
    capCardRef?: { boardId: string; cardId: string };
    deliveryCardRef?: { boardId: string; cardId: string };
  }>;
  createdAt: string;  // ISO
  updatedAt: string;  // ISO
}
```

Board model amendments:

- `WorkBoard.workspaceId?: string` — present on the per-workspace pair, absent on personal/ad-hoc boards.
- `WorkCard.capabilityRef?: { capabilityId: string; sliceId: string }`.
- `BOARD_TEMPLATES` (still data, not code):
  - `personal` — Backlog · Ready · In Progress · In Review · Done
  - `capabilities` — Capability · Story Mapping · Spec · Plan · Ready for Delivery
  - `delivery` — Ready · In Progress · In Review · Verified · Done
  - `maintenance` — Reported · Triaged · In Progress · In Review · Done
  - `support` — Inbox · Triaged · Waiting on User · In Progress · Resolved

**Checklist sync rule.** `PATCH .../cards/:cardId` with `stories` on a `capabilityRef` card still wholesale-replaces on the wire, but swarm diffs by story id against the capability's slice stories: only `done`/`verifiedBy` may differ, else 400. Accepted toggles write through to the capability's story and update the copies on **both** linked cards in the same write. Cards with no `capabilityRef` behave exactly as the work-boards spec says.

## 2. Swarm routes

- `GET /work/capabilities?workspaceId=` → `{ capabilities, errors? }` (workspace filter optional)
- `POST /work/capabilities` `{ name, workspaceId }` → 201; **auto-provisions** the workspace's Capabilities + Delivery boards if missing (same creation path as templates; idempotent)
- `PATCH /work/capabilities/:id` — `{ name?, activities?, stories?, slices? }`; sub-arrays replace wholesale (same convention as board columns); slice-disjointness and stepId validity enforced on write
- `DELETE /work/capabilities/:id` — linked cards are **unlinked, not orphaned**: `capabilityRef` removed, their story copies become local
- `POST /work/capabilities/:id/slices/:sliceId/spec` — writes `docs/superpowers/specs/<date>-<slice-slug>-design.md` into the workspace repo (dir created if missing): title, `Date`, `Status: draft`, empty `## Goal`, `## Acceptance criteria` with one `- [ ] <story text>` line per story. Stores `specPath` on the slice. 409 if `specPath` already set or the file exists. The file is written, not committed — committing stays a human/git action.
- `POST /work/capabilities/:id/slices/:sliceId/send` `{ target: 'capabilities' | 'delivery' }` — creates one card on the workspace's target board (leftmost column): title = slice name, `stories` = copies of the slice's stories, `capabilityRef` set; stores the ref on the slice. 409 if that ref already exists. `delivery` refuses with 409 while `specPath` is unset.

## 3. Broker

- Proxy `/work/capabilities/*` to the swarm, same pattern as the `/work/*` proxy.
- New WS frame `{ type: 'capability-updated', capabilityId }` on the events socket, emitted alongside `board-updated` when a write-through toggle or capability edit lands.
- Delegation and completion machinery are untouched — a delivery card is a normal card; `POST /work/delegate` and the `workCardRef` completion PATCH already cover it.

## 4. Control-plane UX

- **Entry:** fourth `ToolRail` button ("Map") → new stage mode `MapStage` (same pattern as `BoardStage`).
- **Pickers:** workspace → capability (+ "New capability…" prompting name; creation triggers the pair auto-provision).
- **Map grid:** activity row, step row, story stacks beneath — dnd-kit with the established sensor/collision patterns; inline add/rename/delete at each tier; drag stories between steps (`PATCH` with wholesale-replaced `stories`).
- **Slices:** horizontal bands below the map. Assign/unassign stories to a slice (disjointness surfaced as a validation error inline). Each band shows name, done/total fraction, and four chips:
  - **Spec** — "Generate spec" → `POST .../spec`, then shows/opens the path
  - **Plan** — hand-entered `planPath`
  - **Cap card / Delivery card** — "Send" actions (delivery disabled with reason until spec exists); after send, chip jumps to the card
- **Board side:** `capabilityRef` cards show a capability chip (jumps to the map); their checklist is toggle-only with a `verifiedBy` input; face fraction chip unchanged.
- **Switcher grouping:** Personal boards first, then per-workspace groups (pair + any on-demand maintenance/support boards).
- **Live updates:** refetch the open capability on `capability-updated`; boards already refetch on `board-updated`.
- **Degraded modes:** same conventions as BoardStage (unreachable → read-only banner; malformed capability file → error entry in the picker).

## 5. Out of scope (v1)

- Personas overlay, map AI assist, releases/timeline views, StoriesOnBoard import.
- Importing stories from existing spec docs (authoring is map-first now; old specs stay as they are).
- Jira linkage on capability stories (Jira stays card-level, per the work-boards spec).
- Maintenance/support **intake** (channel-, Discord-, or Jira-fed cards) — templates ship, wiring is its own cycle.
- Plan auto-linking or plan-file generation (writing-plans stays the authoring path; `planPath` is hand-set).
- Cross-workspace rollups; multi-user presence on the map.

## 6. Testing

- **Swarm** `capabilities.test.ts`: load/save/validate + malformed-file isolation; CRUD and move/reorder helpers; slice-disjointness and stepId enforcement; write-through toggle updates the capability and both card copies atomically; toggle-only violation → 400; spec generation content + 409 cases; send gating (delivery before spec → 409) and idempotency (second send → 409); pair auto-provisioned exactly once; delete-unlinks behavior.
- **Broker:** route tests for the `/work/capabilities/*` proxy; `capability-updated` frame emitted on write-through.
- **Control-plane** `MapStage.test.tsx`: renders a fixture map (activities/steps/stories/slices); story drag issues the right PATCH; slice chips gate correctly (delivery send disabled until spec); generate/send post exact payloads; capability chip renders on linked cards; toggle-only checklist behavior on a linked card. `ToolRail` test gains the fourth button.
