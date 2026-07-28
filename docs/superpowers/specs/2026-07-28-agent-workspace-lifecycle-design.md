# Agent & Workspace Lifecycle Management — Design

**Date:** 2026-07-28
**Status:** Approved (Edwin, 2026-07-28)
**Scope:** Complete agent management (removal lifecycle) and workspace management
(full CRUD) across swarm, broker, and control-plane. Remove the legacy project
config layer.

## Goal

Make agents and workspaces fully manageable from the product — no hand-dropped
JSON, no API-only lifecycle operations — using one consistent lifecycle model
for both record types.

## Settled decisions

- **"Project" means workspace.** The PRD hierarchy stands (workspace → repos,
  workspace → sessions). The legacy `project.ts` layer is removed, not
  completed.
- **Full agent edit is already shipped** (`PUT /agents/:id`, wizard reopens
  pre-filled from edit mode, busy-lock). This spec does not re-cover it.
- **Removal rule:** hard-delete only if never used; otherwise archive.
- **"Used" means any durable trace:** the agent ever spoke in a session
  transcript, ran a task, or had a warm session. For workspaces: any session
  or task ever referenced it.

## 1. Lifecycle model

Both record types gain an optional `archived: true` field, set **in place** —
the file never leaves `swarm/.smith/agents/` / `swarm/.smith/workspaces/`.

- Loaders read every file and expose two views:
  - **active** — feeds the roster, delegation, agent catalog, and workspace
    pickers. Excludes archived records.
  - **all** — feeds transcript replay and name/avatar/voice resolution, so an
    old session never hits a missing agent.
- The reset feature's wholesale `*-archived-<timestamp>` rename convention is
  untouched (different feature: teardown). Per-record archiving uses the field
  precisely because renamed files fall outside the load path and would break
  transcript resolution.
- Un-archive is API-only for now: `PUT` clears the field. No UI.

**Removal is one intent with a server-decided outcome.** The UI only says
"remove"; the system answers "deleted" or "archived".

- **Swarm** exposes mechanics and its own facts:
  - `GET /agents/:id/usage` → counts from swarm's durable records (task
    records/worktrees, warm session records). Same for
    `GET /workspaces/:name/usage`.
  - `POST /agents/:id/archive` / `POST /workspaces/:name/archive` — sets the
    field.
  - `DELETE /agents/:id` / `DELETE /workspaces/:name` — hard delete. Re-checks
    swarm-side usage and 409s if any exists (defense in depth).
- **Broker decides**, because only it sees both evidence sources: its own
  session transcripts plus swarm's usage endpoint. The UI calls the broker;
  the broker aggregates evidence, picks the outcome, calls the matching swarm
  route, and returns `{ outcome: "deleted" | "archived" }`.
- The broker also exposes the same aggregation as a **side-effect-free
  preview** (a GET), which is what the confirm sheet reads — the sheet and
  the eventual removal share one decision path.
- The decision is a pure function — `resolveRemoval(usage) → 'delete' |
  'archive'` — following the `session-reconcile.ts` testable-policy pattern.

## 2. Agent removal UX (control-plane)

- Jiggle edit mode: solo agents get the iPhone-style ✕ badge.
- Tapping ✕ opens a confirm sheet that **states the outcome before commit**,
  e.g. "Wilkin has never worked or spoken — removed permanently" vs. "Ignacio
  has history — will be archived." (Broker pre-computes the outcome via the
  usage aggregation so the sheet is honest.)
- Busy/warm agents are locked from removal — same lock as editing, and
  enforced server-side too: swarm's archive and delete routes 409 while the
  agent has a running task or live warm session (the UI lock is a courtesy,
  not the enforcement).
- Squad members show no ✕; drag the member out first. Preserves the
  solo-XOR-squad invariant and keeps removal rules to one case.

## 3. Workspace CRUD

### API (swarm)

- `POST /workspaces`, `PUT /workspaces/:name`, `DELETE /workspaces/:name`,
  plus `archive`/`usage` per Section 1.
- Validation, readable 400s (matching the agent wizard's pattern):
  - unique name slug;
  - every repo `path` must exist and be a git repository (`git rev-parse`
    check at registration time);
  - `branch` defaults to `main`.
- **Default-workspace invariant:** exactly one default whenever any workspace
  exists. Setting a new default atomically clears the old. Removing the
  default while others exist → 409 "set another default first". Removing the
  last workspace is allowed → UI lands in the first-run empty state.

### UX (control-plane)

- Workspace switcher at the top of the SessionsPanel (sessions are already
  workspace-scoped).
- "Manage workspaces…" opens a modal in the AddAgentModal style: workspace
  list; create/edit form (name, description, repo rows with path + branch,
  default toggle); remove with the same outcome-stating confirm sheet.
- Broker proxies the new routes through `swarm-client` / `text-channel`, same
  pattern as agent create/edit. UI refetches on mutation response; no new WS
  frame types.

## 4. Legacy project layer removal

- Delete `swarm/src/project.ts`; remove its exports from the `index.ts`
  barrel; remove dead types (`ProjectConfig`, `BranchingStrategy`,
  `PullRequestConfig`, and friends) from `types.ts`.
- No data migration: the live `.smith/` has no `projects/` dir. Boot logs a
  pointed warning if `.smith/project.json` or `.smith/projects/` is ever
  found.

## 5. Errors & edge rules

- Every 409/400 reason surfaces in the UI. (The PRD flags today's silent
  composition errors; these surfaces establish the corrected pattern.)
- **Archived ids are reserved:** creating an agent or workspace whose slug
  matches an archived record → 409 "name belongs to an archived agent/
  workspace". Historical transcripts never suffer identity collisions.
- Hard-delete of an agent with in-flight work is impossible twice over: the
  UI busy-lock and swarm's own usage re-check.

## 6. Testing

- **Policy:** `resolveRemoval` — every branch, pure, no processes.
- **Registry:** active/all filtering for both record types; archived-id
  reservation.
- **Routes:** validation 400s, default-workspace invariant transitions,
  repo-path validation against a temp git repo, usage re-check 409 on hard
  delete.
- **Broker:** evidence aggregation with a stubbed swarm client (transcript
  hit / task hit / no hits).
- **UI:** typecheck + biome; manual e2e pass — create → use → remove →
  verify archived; create → remove → verify hard-deleted.

## Out of scope

- Voice preview before save; agent cloning (not selected).
- Un-archive UI (API-only).
- Editing an agent while it is inside a squad (edit remains solo-only, as
  shipped; drag out first).
- Making user-formed squads executable; anything helmsmith-related.
