# Workspace groups as first-class entities — Design

**Date:** 2026-08-11
**Status:** SHIPPED (main @ 061f7c3 — swarm entity+routes, broker proxy/frame/seeding, popover pins, lens navbar, manager section, group scope chips, text cards; live-smoked end to end)

## Problem

Pinned docs and dashboards attach to a single workspace today (`Doc.pins: string[]` of workspace names, session seeding by exact match). Edwin's direction: "implement the grouping feature of workspaces that represent the context of the dashboard … the dashboard then is always relevant to the logical grouping the person is interested in." A group is that logical grouping — a first-class entity you can pin to, view through, and scope dashboards by.

## Decisions (Edwin rulings)

1. **v1 scope — all four:** pin target + session seeding; Board/Map group view; dashboard scope chips = groups; group tier in the navbar selector.
2. **Membership is nested:** "Groups can contain any combination of Groups and Workspaces." Flat sets were offered and declined.
3. **Pins never flow up:** "Create a group that includes workspaces and groups will not adopt its pinned shelf items." A parent group's pinned set is only what is pinned directly to it.
4. **Pins flow down:** a doc pinned to group `frontend` seeds new sessions in any workspace transitively inside `frontend`. ("Down yes, up no" — confirmed.)
5. **Viewing follows the same rule:** "user will have to go to specific workspace to see those pinned shelf items" — no view aggregates member pins upward; a group lens shows only the group's own pins.
6. **Dashboards direction (phase 2, recorded):** "dashboards … should be a summary of the boards which are scoped by the boards and the date range (date range has not been added to kanban board)." Real board-data summaries + a date dimension on cards are the NEXT spec, built on groups.
7. **Text cards ride along now:** "a dashboard can have text cards maybe with answers provided by some chat thread … in session history or artifact under its nested context." Cheap: spec render + chat-written content.
8. **Architecture A — swarm-owned:** groups live beside workspaces in the swarm; the broker proxies and mirrors; phase 2's board aggregation gets membership for free. (B broker-owned and C control-plane-only were declined.)

## Design

### 1. Entity (swarm)

`swarm/src/groups.ts`, mirroring `workspaces.ts`:

```ts
export interface WorkspaceGroup {
  name: string;               // unique id, like workspaces
  description?: string;
  workspaces: string[];       // member workspace names
  groups: string[];           // member group names (nesting)
  color?: string;             // UI falls back to hash of name
}
```

- One JSON file per group under `swarm/.smith/groups/` (gitignored with the rest of `.smith`).
- `loadGroupsFromDir(dir)` with an assert that requires `name`, `workspaces[]`, `groups[]` (arrays may be empty — a group may hold only groups, only workspaces, or be empty while being built).
- `expandGroup(name, all: WorkspaceGroup[], workspaces: Workspace[]): Set<string>` — transitive member workspaces. Cycle-safe via a visited set; missing members (deleted group/workspace) are skipped silently; archived workspaces are excluded.
- **Cycle guard on write:** POST/PUT rejects (400) any group that would transitively reach itself.
- Routes on the swarm server: `GET /groups`, `POST /groups`, `PUT /groups/:name`, `DELETE /groups/:name`. Delete does NOT cascade: other groups' dangling references to it are skipped by `expandGroup` and cleaned lazily on their next save.

### 2. Broker proxy + frame

- `broker/src/swarm-client.ts` gains `getGroups / createGroup / updateGroup / deleteGroup`.
- `broker/src/text-channel.ts` proxies them (`/groups...`), writes originBlocked — same shape as the workspace routes.
- The pushed **workspaces frame grows a `groups` array** (`{ workspaces, groups }`) so the control plane receives both in one push; a broker-side mirror backs pin resolution. Control-plane `useWorkspaces` keeps its shape; a sibling `useGroups` pushed query reads the same frame.

### 3. Pins to groups

- One pins array, two namespaces: workspace entries stay bare names; group entries are stored as `group:<name>`. A workspace named like a group can never collide.
- **PinButton becomes a "Pin to…" popover**: rows for the active session's workspace and every group, each an aria-pressed toggle calling the existing `POST/DELETE /documents/:id/pins` with the (possibly `group:`-prefixed) target. No new broker routes.
- **Seeding** (`startSession`): attach every doc where `pins` contains the session's workspace, OR contains `group:<g>` where the workspace is in `expandGroup(g)`. Dedup is inherent (addArtifact by doc id). Down-only, never up.
- A pin naming a deleted group is skipped at seed time and rendered as a stale row in the popover (toggle removes it).

### 4. Group lens (navbar + Board/Map)

- The workspace selector gains a **GROUPS tier** above the workspaces, plus a `New group…` command (sentinel-keyed, like `New workspace…`).
- Picking a group applies a **lens**: `viewedWorkspaces` is set to the group's expansion (Board/Map already filter on it), and the selector displays the group name. The active session is untouched — a session always lives in exactly one workspace.
- Picking a workspace behaves exactly as today (activates its newest session there) and **clears the lens**.
- Lens state lives in `uiStore` (`activeLens: { group: string } | null`) alongside `viewedWorkspaces`; it is view state, never dispatch state.
- The lens adds **no pin shelf** (decision 5): it filters Board/Map and labels the selector, nothing more. Group pins surface through session seeding and SAVED; workspace pins are seen in their workspace.

### 5. Management UI

- `WorkspaceManagerModal` grows a **Groups section**: list, create, edit, delete. Editing shows two checkbox pickers (member workspaces, member groups) and a color. Server-side cycle rejections surface as an inline error on the save row.

### 6. Dashboard scope + SAVED

- Launcher SCOPE chips become **"all workspaces" + one chip per group**. The board-type chips (plan/deliver/…) retire — board+date scoping is phase 2's dimension, not a workspace grouping.
- The chosen scope keeps flowing into the doc's question section as `scope: <name>` (mock compose unchanged this phase).
- SAVED card meta lists pin targets, group names included (`group:` prefix stripped for display).

### 7. Text cards (DashSpec)

- `DashSpec` gains `texts?: Array<{ title: string; body: string; source?: string }>`.
- `DashboardBoard` renders them as prose answer cards in the grid alongside KPIs/charts/table.
- Dock-send edit turns write them via the existing all-or-nothing spec rewrite; `source` is an informational label ("session s12", "doc d34") — no navigation/linking in v1.

## Out of scope (phase 2 — next spec)

- Dashboards computed from real board data, scoped by boards + date range.
- Date dimension on kanban cards (prerequisite for the above).
- Per-user Agenda boards (separate direction, sequenced with identity).
- Linking text-card `source` labels to their session/artifact.

## Testing

- **swarm (node:test):** loader asserts; `expandGroup` transitivity, cycle safety, archived/missing skips; write-time cycle rejection; route CRUD.
- **broker (node:test):** swarm-client group calls (route contract test extension); seeding contract — group pin attaches in member workspace, not elsewhere; deleted-group pin skipped.
- **control-plane (vitest):** PinButton popover toggles both namespaces; selector lens (group pick sets viewedWorkspaces + label, workspace pick clears); Groups section CRUD in the manager modal; scope chips list groups; `parseDashSpec`/`DashboardBoard` text-card rendering.
