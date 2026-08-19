# Borrowed Primitives — the spec sequence

**Source:** the Hamster / herdr / Orca teardown, 44 findings.
**Status verified 2026-08-17**, renumbered 2026-08-19, by probing `swarm/src`,
`control-plane/src`, and `broker/src` — not by reading checkboxes. Control term
returned 96 matches, so the sweep was live; every feature probe returned zero.

Started as seven specs; spec 6 split during its brainstorm, so it is now **nine**.
Six are written. **None is implemented.**

---

## Status

| # | Spec | Design | Built | Foundation already in tree |
| --- | --- | --- | --- | --- |
| 1 | Agent status reporting | ✅ `2026-08-16-agent-status-reporting-design.md` | ✗ | `drivers/*.materialize`, `prepareWorkspace` |
| 2 | Session recovery | ✅ `2026-08-17-session-recovery-design.md` | ✗ | `session-reconcile.ts` |
| 3 | Instance provisioning | ✅ `2026-08-17-instance-provisioning-design.md` | ✗ | `workspace-instances.ts` (496 lines) |
| 4 | Agent visibility | ✅ `2026-08-17-agent-visibility-design.md` | ✗ | `GET /agent-sessions`, BoardColumn/BoardCard |
| 5 | Hibernation | ✅ `2026-08-17-hibernation-design.md` | ✗ | — |
| 6 | Dispatch entity and lifecycle | ✅ `2026-08-19-dispatch-entity-design.md` | ✗ | `work-items.delegation`, `dispatcher.ts` |
| 7 | Worker protocol | ✗ not brainstormed | ✗ | broker relay, `election.ts` AskFactory |
| 8 | Context projection | ✗ not brainstormed | ✗ | documents, work-items, skill emission |
| 9 | Coordination map | ✗ not brainstormed | ✗ | react-flow MapStage |

## Dependencies

```
1 status ──┬──► 4 visibility ──► 5 hibernation ◄── 2 recovery
           └──────────────────►

6 dispatch ──┬──► 7 worker protocol
             └──► 9 coordination map

3 provisioning   (independent)
8 context        (independent)
```

Independent and buildable today: **1, 2, 3, 6, 8**.

## Recommended order

1. **Spec 3 — provisioning.** No dependencies, and worktree-per-work-item stays
   theoretical while every instance is born unable to build.
2. **Spec 1 — status reporting.** Unblocks 4 and 5, and closes the failure class
   behind the warm-session incident.
3. **Spec 2 — recovery.** Smallest; largely one function and two driver methods.
4. **Spec 6 — dispatch entity.** Independent, and its both-ids rule is free to
   add now and a migration later.
5. **Spec 4 — visibility**, then **5 — hibernation**, then **7** and **9**.

Spec 8 (context projection) is a separate bet and can start at any time.

## What reading the code changed

Every spec's scope moved once the tree was read rather than assumed:

- **Spec 3 lost two of five register items.** Preserved branches is moot —
  `destroyInstance` never deletes branches. Cascade is done —
  `listMemberWorktrees` already finds member worktrees on disk. The `worktree
  add` DWIM trap is handled by `resolveStartPoint`.
- **Spec 3 gained a constraint.** §7 of the workspace-instances design says
  secrets are retrieved on demand and never held by the instance. Orca copies
  `.env` into every worktree; adopting that would have retired an approved
  decision silently.
- **Spec 1 changed mechanism.** The register proposed screen-scraping tmux
  (herdr's method). All five drivers support native hooks (Orca's), which is
  cheaper and authoritative rather than inferred.
- **Spec 2 got smaller.** Session ids are already pinned at launch, so recovery
  is a branch in an existing pure function plus two driver methods.
- **Spec 4 lost the map and gained a level.** The rollup is four levels —
  session → assignee → work item → workspace — because agents and swarms receive
  a workspace's work items. A swarm assignee is not a simple maximum.
- **Spec 4 found a route already stranded.** `GET /agent-sessions` has existed
  since the warm-session work; the control-plane has zero references to it.
- **Spec 5 added a dependency and removed a mechanism.** It depends on spec 4,
  whose rollup *is* its safety rule, and adds no wake path — sleeping produces
  exactly spec 2's `resumable` state.
- **Spec 6 split, and found the council turn is a different primitive.**
  `councilTurn` fans a *question* and returns positions; a dispatch is durable
  work returning commits. Orca's "Task" already exists here as the work item, so
  only the attempt was missing.

## Open risks carried by the written specs

- **agy's turn-end hook event is unconfirmed** (spec 1 §9). It is the one driver
  where hooks would own turn completion.
- **`curl` inside the container images is assumed** (spec 1 §9), not verified
  against the tracked Dockerfile.
- **Codex transcript lookup is a scan, not a stat** (spec 2 §4).
- **agy's recovery path ships dormant** (spec 2 §7) until spec 1 lands.
- **Ad-hoc sessions have no assignee** (spec 5 §9), so nothing sleeps them —
  though nobody is watching them either.
- **`idleMinutes` default of 30 is inherited from Orca, not measured** (spec 5 §9).

## Next action

Brainstorm spec 7, 8, or 9 — or take a written spec to `writing-plans` and
implement. Nothing in the sequence is blocked.
