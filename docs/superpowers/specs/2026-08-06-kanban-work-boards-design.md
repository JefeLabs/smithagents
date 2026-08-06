# Kanban work boards — design

Date: 2026-08-06
Status: approved pending user review

## Goal

A kanban-style task manager in the control-plane, **for Edwin's own use first**. Boards are personal planning surfaces: dragging a card is a status change by the human, never an implicit action. Optionally, a card can be **explicitly** sent to an agent (the existing delegation machinery) and then displays that run's live state and PR; optionally, a card can link to a Jira issue (the existing Atlassian connector) with imports and best-effort status pushes. Neither linkage is required — a card with no agent and no ticket is fully supported.

## Decisions made with Edwin

- Board truth is **local-first** (swarm-persisted), tracker-linked — not a Jira projection.
- **Drag = the user's status change only.** Agent dispatch is an explicit per-card action; execution state renders as badges and never auto-moves a card.
- **Jira first** (existing Atlassian connector); Linear later behind the same field seam.
- **Multiple boards with data-driven column sets.** Two shipped templates: **Personal** (Backlog · Ready · In Progress · In Review · Done) and **Capability Pipeline** (Capability · Spec · Implementation PRD · User Stories · In Progress · Completed). Boards addable, columns renameable.
- Architecture: swarm owns storage + Jira calls; broker proxies + owns dispatch/events; board is a control-plane stage mode.

## 1. Data model (swarm)

One JSON file per board: `.smith/work/<boardId>.json`. Ids are slugs matching `/^[a-z0-9][a-z0-9-]{0,63}$/` (board) and any UUID/slug for cards.

```ts
interface WorkBoard {
  id: string;
  name: string;
  columns: Array<{ id: string; name: string; /** Jira status to transition to when a linked card lands here; absent = no push. */ jiraStatus?: string }>;
  cards: WorkCard[];
  /** Present only when the board is Jira-linked. */
  jira?: { connectorId: string; projectKey: string; jql?: string };
}

interface WorkCard {
  id: string;
  title: string;
  notes?: string;
  columnId: string;
  /** Sort position within the column (fractional-insert or full renumber on move — implementation detail, but order is per-column). */
  order: number;
  createdAt: string;  // ISO
  updatedAt: string;  // ISO
  jira?: { key: string; url: string; lastPushError?: string };
  delegation?: { agentId: string; taskId: string; state: 'working' | 'completed' | 'failed'; prUrl?: string };
}
```

New module `swarm/src/work-items.ts`: load/save/validate boards (malformed file → that board reports an error entry, others load), `BOARD_TEMPLATES` (the two above, data not code), column-move/reorder helpers, card CRUD helpers. All exported and unit-testable without booting the server (swarm test convention).

### Swarm routes

- `GET /work/boards` → `{ boards: WorkBoard[] , errors?: [{file, error}] }`
- `POST /work/boards` `{ name, template: 'personal' | 'capability' }` → 201 board
- `PATCH /work/boards/:id` `{ name?, columns?, jira? }` (merge; columns replace wholesale when sent)
- `DELETE /work/boards/:id`
- `POST /work/boards/:id/cards` `{ title, notes?, columnId? }` (default leftmost column, appended)
- `PATCH /work/boards/:id/cards/:cardId` `{ title?, notes?, columnId?, order?, jira?, delegation? }` — the single mutation route for edit, move, reorder, link/unlink, and delegation-state updates
- `DELETE /work/boards/:id/cards/:cardId`
- `POST /work/boards/:id/jira/import` → runs the board's JQL via its connector; creates cards (leftmost column) for unseen keys, updates title on known keys; idempotent by `jira.key`; response summarizes `{created, updated, errors}`
- Reset flow (`scope.agents` in `/reset` — reuse the same stamp block) additionally archives `.smith/work/` → `.smith/work-archived-<stamp>`.

**Jira push:** inside `PATCH .../cards/:cardId`, when the patch changes `columnId`, the card is Jira-linked, and the target column has `jiraStatus`: after saving, attempt the Jira transition (find transition whose target status name matches, case-insensitive; POST it). Failure never fails the PATCH — it sets `jira.lastPushError` (cleared on next success). Implemented in `swarm/src/jira-sync.ts` beside the connector registry, resolving credentials via the existing connector-instance store; unit-tested with a mocked fetch.

## 2. Broker

- **Proxy:** all `/work/*` routes pass through to the swarm (same pattern as the agent-registry proxy; JSON in/out, `fail` → 500).
- **Dispatch:** `POST /work/delegate` `{ boardId, cardId, agentId, workspace, prompt }` → reuses the same internal delegation path as the brain's `delegate` tool: busy check (refuse with the same message shape), prompt = agent directives + card prompt, `metadata: { source: 'work-board', composedAgentId, workCardRef: { boardId, cardId } }`, workspace/repo context resolved as the meeting path does. On accept: PATCH the card's `delegation = { agentId, taskId, state: 'working' }` via the swarm and return `{ taskId }`. On refusal: `{ error }` → 409.
- **Completion:** the broker's existing swarm-event subscription, on `task:completed | task:failed`, additionally checks the task's `workCardRef` metadata; when present it PATCHes the card's delegation state (`completed` + `prUrl` when available, else `failed`) and broadcasts a new WS frame `{ type: 'board-updated', boardId }` on the existing events socket. Meeting narration is unchanged — the board is an additional consumer of the same events.
- The card is **never moved** between columns by the broker.

## 3. Control-plane UX

- **Entry:** a third `ToolRail` button ("Board", kanban icon) → a new stage mode `BoardStage` rendered in the layout's `stage` slot (like `WorkStage`), closed back to the voice stage via the rail.
- **Top bar:** board switcher (all boards + "New board…" prompting name + template), Add card, and — when the board is Jira-linked — "Import from Jira".
- **Columns/cards:** horizontal column row, vertical card lists; dnd-kit with `AgentRoster`'s established sensor/collision/`arrayMove` patterns. Cross-column drop = `PATCH {columnId, order}`; same-column reorder = `PATCH {order}`. Optimistic UI with rollback on error. Cards are draggable regardless of delegation state.
- **Card face:** title; Jira chip (`KEY-123`, click opens the issue URL; amber dot when `lastPushError`); delegation badge — agent portrait (reusing `Avatar` with the roster's avatar/ring data) with working/completed/failed state, PR chip when `prUrl`.
- **Card sheet** (click): edit title/notes; Jira link/unlink (enter a key; url derived from the connector's site); **Send to agent** — a picker of roster agents (busy and inactive-CLI agents shown disabled with the reason, mirroring the chooser's convention) × workspaces, prompt textarea prefilled `title + "\n\n" + notes`; confirm → `POST /work/delegate`. Delete card.
- **Live updates:** on `board-updated` frames for the open board (and on stage open), refetch the board.
- **Degraded modes:** broker unreachable → read-only banner; board file error → error card in the switcher; delegation refusal → inline error in the picker.

## 4. Out of scope (v1)

- Linear (the `jira` field name stays vendor-specific; a `tracker` generalization happens with the second vendor).
- Jira webhooks, background polling, rank/order sync, comment/attachment sync, issue creation FROM cards.
- Auto-moving cards on execution events; WIP limits; due dates; labels; multi-user presence; subtask/user-story generation from spec docs (future: Capability Pipeline cards could link their spec/plan artifacts — not in v1).
- Mobile layout beyond the stage's existing responsive behavior.

## 5. Testing

- **Swarm:** `work-items.test.ts` (templates valid, CRUD helpers, move/reorder invariants, malformed-file isolation, id validation) and `jira-sync.test.ts` (mocked fetch: transition match by status name, import idempotency by key, error → `lastPushError` set and PATCH still succeeds).
- **Broker:** `text-channel.test.ts` route tests for the `/work/*` proxy and `POST /work/delegate` (accept + busy-refusal shapes via stub handlers); an event-handler test that a `task:completed` with `workCardRef` triggers the card PATCH and the `board-updated` frame.
- **Control-plane:** `BoardStage.test.tsx` — renders boards/columns/cards from a fixture; drag handlers issue the right PATCHes (unit-level, mirroring AgentRoster's approach); delegate sheet posts the exact payload; badges render for each delegation state; Jira chip states. `ToolRail` gains a test that the third button opens the stage.
