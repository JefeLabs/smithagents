# One Context Entity + Unified Wizard — Design

**Date:** 2026-08-13 · **Approved:** Edwin (chat: "one command, create plan and execute" → "merge the entities now")

Edwin's model, now the data model: **"a group is a workspace made up of many workspaces"**, "workspace that add child workspace or other groups is a group", "so maybe there is a group attribute for workspace." One entity; being a group is an attribute (having members), not a type.

## Part 1 — The entity merge (swarm)

**One store.** Every context is a `Workspace` record in `.smith/workspaces/`. The record gains:

```ts
/** Present (even empty) = this context contains other contexts — it IS a group.
    Absent = a plain workspace. Presence is the kind, so an empty group stays a group. */
members?: string[];
```

`members` names other context records — plain workspaces or other groupish ones; which is which is derived from *their* records, never stored twice. Mixed containment (repos AND members) is invalid: a groupish record must have `repos: []`.

- **`groups.ts` folds in**: `expandGroup` becomes expansion over the one store (walk members, leaves are member records without `members`, cycle-safe via visited set). The write-time cycle guard keeps its semantics: a record may not become reachable from itself.
- **One namespace.** Names are now unique across all contexts. Creation of either kind 409s on any existing context name. (Previously groups and workspaces were disjoint namespaces — the `GROUP_PREFIX` UI keying survives harmlessly.)
- **Boot migration**, one-way and logged: each `.smith/groups/*.json` becomes a workspace record `{name, description, color, sprint, repos: [], members: [...workspaces, ...groups]}`; a name collision with an existing workspace renames the migrated group `<name>-group` (logged loudly); the old dir is renamed `.smith/groups.migrated`.

**Wire compatibility — routes become views over the one store; broker and control plane read/write the SAME shapes as today:**

- `GET /workspaces` → records **without** `members` (plain workspaces). Shape unchanged.
- `GET /groups` → records **with** `members`, shaped exactly as today's `GroupT`: direct members split into `workspaces`/`groups` by each member's own kind (dangling names list under `workspaces` — visible beats vanished), plus precomputed `expansion`.
- `POST /groups` / `PUT /groups/:name` accept today's `{workspaces[], groups[]}` body → stored as `members` (union, order preserved). Cycle refusal unchanged. `DELETE /groups/:name` deletes a groupish record only (404 for plain).
- Workspace `POST/PUT` refuse a groupish target / colliding name with the one-namespace 409.
- **Internal call-site audit**: everything inside the swarm that loads workspaces for work (dispatch resolution, `ensureWorkspaceBoards`, default-workspace pick, board seeding, capability workspaceIds) must see PLAIN workspaces only — groupish records can't host repos, sessions, or boards. One helper (`plainWorkspaces`) at the store; call sites audited in the plan.

Broker: **zero changes** (its `groupRecords` mirror and pins read the same wire). Control plane: **zero changes** outside the wizard.

## Part 2 — The unified wizard (control plane)

1. **One navbar command**: "New workspace…"/"New group…" collapse into **"New workspace or group…"** opening the wizard. (`openGroupForm`/`groupFormIntent` stay for the manager's own tab.)
2. **`NewContextModal`** (renamed from `NewWorkspaceModal`):
   - **Step 1 — Details**: containment radio at top — **Repositories** vs **Workspaces & groups** (default Repositories); name (label follows mode), description, Sprint Filter. Links render in repos mode only (groups carry none; hiding beats silently dropping).
   - **Step 2 — Colour**: unchanged.
   - **Step 3 — Repos *or* Members**: repos mode verbatim; members mode is two checkbox fieldsets (member workspaces, member groups; all offered — a new context can't be its own ancestor). Empty selection allowed.
   - **Submit fork**: repos → existing `save`; members → new `saveGroup` prop (`api.saveGroup`). `sprintFromForm` guards both. Button label "create workspace"/"create group". `onCreated` fires for workspaces only; a created group closes and arrives on the groups frame.
   - **Validation trap**: repo-row rules use RHF `validate(value, formValues)` to auto-pass in members mode, else hidden empty repo fields pin `isValid` false forever.
   - Stepper's third title follows the mode. The uiStore keeps the `newWorkspaceOpen` name (annotated).

## Testing

- Swarm: migration (group file → members record; collision rename; dir retired), kind-by-presence (empty group stays a group and off `GET /workspaces`), views round-trip today's wire shapes byte-compatibly, one-namespace 409 both directions, cycle refusal over the one store, expansion parity with the old `expandGroup` on nested fixtures, plain-workspaces helper filtering.
- CP: existing wizard tests pass untouched (repos default); members mode swaps step 3 + hides links; group submit posts via `saveGroup` with sprint, never `save`/`onCreated`; create enables despite empty repo rows; selector offers exactly one creation command.
- Live: after swarm restart, migrated `core` still lenses and resolves its sprint; wizard-create a group end-to-end; collision 409 surfaces in the wizard error line; cleanup by delete.

## Out of scope

Sessions/boards/dispatch on groupish contexts; links on groups; merging the manager's edit forms further; broker/CP wire changes.
