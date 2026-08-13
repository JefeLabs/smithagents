# One Context Entity + Unified Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **CLAIMED by the main session (d43af92a), 2026-08-13 — inline execution.**

**Goal:** One context entity in the swarm — a workspace with `members` IS a group — behind wire-compatible route views, plus the one-command unified creation wizard.

**Spec:** docs/superpowers/specs/2026-08-13-unified-context-wizard-design.md

## Global Constraints

- Broker and control plane keep today's wire shapes; only the wizard + selector change in CP.
- `members` PRESENCE is the kind (empty group stays a group). Groupish records have `repos: []`.
- One namespace: creation 409s on any existing context name, either kind.
- Migration is one-way, logged, collision-renaming; old dir retired as `.smith/groups.migrated`.
- Internal swarm work paths (dispatch, boards, defaults) see plain workspaces only.

### Task 1: The store merge (swarm)

**Files:** Modify `swarm/src/workspaces.ts` (Workspace.members + helpers), `swarm/src/groups.ts` (reshape to views over the store + migration), `swarm/src/server.ts` (route views + one-namespace gates + call-site audit); Test `swarm/src/groups.test.ts`, `swarm/src/workspaces.test.ts`.

**Interfaces:** `Workspace.members?: string[]`; `isGroupRecord(w) = w.members !== undefined`; `plainWorkspaces(all)`; `groupViews(all): GroupT-shaped[]` (split members by member kind, `expansion` precomputed, cycle-safe); `migrateGroupsDir(groupsDir, workspacesDir): Promise<string[]>` (returns log lines).

- [ ] `Workspace.members` + validation (strings; groupish ⇒ repos []); `plainWorkspaces`/`isGroupRecord` helpers.
- [ ] Expansion + write-time cycle guard over the one store (port `expandGroup` semantics; visited-set safe).
- [ ] `groupViews`: GroupT wire shape byte-compatible (name/description/workspaces/groups/color/sprint/expansion; dangling members under `workspaces`).
- [ ] Boot migration in server startup: convert `.smith/groups/*.json`, collision-rename `<name>-group`, rename dir `.smith/groups.migrated`, log each conversion.
- [ ] Routes: GET /workspaces filters to plain; GET /groups serves `groupViews`; POST/PUT /groups map `{workspaces,groups}` → members with cycle + one-namespace 409; DELETE /groups groupish-only; POST/PUT /workspaces 409 on any context name + refuse groupish targets.
- [ ] Call-site audit: every internal `loadWorkspaces` consumer (dispatch workspace resolution, ensureWorkspaceBoards, default workspace, board/doc seeding paths) goes through `plainWorkspaces`. List each touched site in the commit message.
- [ ] Tests per spec §Testing (migration, kind-by-presence, view parity on nested fixtures, 409s, cycles, plain filter).
- [ ] Swarm suite green; commit `feat(swarm): one context entity — a workspace with members IS a group`.

### Task 2: Unified wizard (control plane)

**Files:** Rename `src/organisms/NewWorkspaceModal.tsx` → `NewContextModal.tsx` (+ test file); Modify `src/molecules/WorkspaceSelector.tsx`, `src/pages/HomePage.tsx`; Tests `NewContextModal.test.tsx`, `WorkspaceSelector.test.tsx`.

- [ ] `NewContextModal` per spec Part 2: `contains` radio on Details (default repos), mode-following name label + third-step title, links repos-only, members checkboxes step (needs `workspaces: string[]` + `groups: GroupT[]` props), submit fork (`saveGroup` prop), repo rules `validate(value, formValues)` auto-pass in members mode, button label per mode, title "New workspace or group".
- [ ] `WorkspaceSelector`: one command "New workspace or group…" (`NEW_CONTEXT` sentinel) → `setNewWorkspaceOpen(true)`; `NEW_GROUP` command removed.
- [ ] HomePage: pass `workspaces`, `groups`, `saveGroup={api.saveGroup}` to the renamed modal.
- [ ] Tests: existing wizard tests pass under the rename (repos default); new members-mode tests per spec; selector's single-command test replaces the New group… one.
- [ ] CP suite green + biome; commit `feat(cp): one-command context wizard — containment decides workspace vs group`.

### Task 3: Verify and ship

- [ ] Swarm + CP + broker suites green.
- [ ] Restart swarm (migration runs — verify `core` converted, dir retired) + broker; reload tab. Live: `core` lens + its sprint resolution still work; wizard-create a group (appears in droplist), collision 409 shows in the wizard, delete the test group.
- [ ] Push (ecruz165); memory update (supersede "entities stay separate" rulings); tick checkboxes.
