# Borrowed Primitives — the seven-spec sequence

**Source:** the Hamster / herdr / Orca teardown, 44 findings.
**Status verified 2026-08-17** (spec 4 added same day) by probing `swarm/src`, `control-plane/src`, and
`broker/src` — not by reading checkboxes. Control term returned 96 matches, so
the sweep was live; all seven feature probes returned zero.

Four specs are written. **None of the seven is implemented.** Two of them sit on
foundations that already exist, which is why their scope is smaller than the
register implied.

---

## Status

| # | Spec | Design | Built | Foundation already in tree |
| --- | --- | --- | --- | --- |
| 1 | Agent status reporting | ✅ `2026-08-16-agent-status-reporting-design.md` | ✗ | `drivers/*.materialize`, `prepareWorkspace` |
| 2 | Session recovery | ✅ `2026-08-17-session-recovery-design.md` | ✗ | `session-reconcile.ts` (pure policy module) |
| 3 | Instance provisioning | ✅ `2026-08-17-instance-provisioning-design.md` | ✗ | `workspace-instances.ts` (496 lines, create/destroy/dirty) |
| 4 | Agent visibility | ✅ `2026-08-17-agent-visibility-design.md` | ✗ | `GET /agent-sessions`, BoardColumn/BoardCard |
| 5 | Hibernation | ✗ not brainstormed | ✗ | — |
| 6 | Coordination protocol | ✗ not brainstormed | ✗ | `dispatcher.ts`, broker relay |
| 7 | Context projection | ✗ not brainstormed | ✗ | documents, work-items, skill emission |

## Dependencies

```
1 status ──┬──► 4 visibility
           └──► 5 hibernation ◄── 2 recovery
3 provisioning   (independent)
6 coordination   (independent)
7 context        (independent)
```

Only 4 and 5 must wait. Specs 1, 2, 3, 6, and 7 can be executed in any order or
in parallel.

## Recommended order

1. **Spec 3 — provisioning.** Zero dependencies, and it unblocks the active
   architectural thread: worktree-per-work-item is theoretical while every
   instance is born unable to build.
2. **Spec 1 — status reporting.** Unblocks two downstream specs and closes the
   failure class behind the warm-session incident.
3. **Spec 2 — recovery.** The smallest of the three; mostly one function.
4. **Spec 5 — hibernation**, once 1 and 2 exist. It deliberately kills live
   processes knowing spec 2 can bring them back.
5. **Spec 4 — visibility.** Control-plane, so it can run in parallel with any
   swarm work once spec 1 has landed.

Specs 6 and 7 are separate bets, not continuations. Spec 6 is the largest in the
set, overlaps spec 1 — giving workers a structured way to *ask* reduces how often
a blocked state is reached at all — and **now also owns the coordination map**,
which spec 4 deferred to it.

## What the code review changed

Reading the tree before writing each spec moved real scope:

- **Spec 3 lost two of five register items.** Preserved branches (F3) is moot —
  `destroyInstance` never deletes branches. Cascade (F5) is done —
  `listMemberWorktrees` already finds member worktrees on disk. The DWIM trap is
  handled by `resolveStartPoint`.
- **Spec 3 gained a constraint.** §7 of the workspace-instances design says
  secrets are retrieved on demand and never held by the instance. Orca copies
  `.env` into every worktree; that would have retired an approved decision
  silently. Spec 3 provisions rebuildables and config only.
- **Spec 1 changed mechanism.** The register proposed screen-scraping tmux
  (herdr's method). All five drivers support native hooks (Orca's method), which
  is cheaper and authoritative rather than inferred.
- **Spec 2 got smaller.** Session ids are already pinned at launch, so recovery
  is a branch in an existing pure function plus two driver methods.
- **Spec 4 lost the map and gained a level.** The coordination map draws dispatch
  lineage that spec 6 has not defined, so it moved there. And the rollup is four
  levels, not two: session → assignee → work item → workspace, because agents and
  swarms receive a workspace's work items. A swarm assignee is not a simple
  maximum — any member blocked blocks the work, `done` requires every member, and
  one `unknown` member makes completion unprovable.
- **Spec 4 found a route already stranded.** `GET /agent-sessions` has existed
  since the warm-session work; the control-plane has zero references to it. The
  swarm-route-without-broker-proxy bug has shipped twice, so a route-parity test
  is part of that spec rather than a note.

## Open risks carried by the written specs

- **agy's turn-end hook event is unconfirmed** (spec 1 §9). agy is the one driver
  where hooks would own turn completion. Confirm before implementation.
- **`curl` inside the container images is assumed** (spec 1 §9), not verified
  against the tracked Dockerfile.
- **Codex transcript lookup is a scan, not a stat** (spec 2 §4) — its rollouts
  are not partitioned by working directory.
- **agy's recovery path ships dormant** (spec 2 §7) — `create()` refuses agy
  today, so there are no agy sessions to resume until spec 1 lands.

## Next action

Brainstorm spec 5, 6, or 7 — or take a written spec to `writing-plans` and
implement. Nothing in the sequence is blocked.
