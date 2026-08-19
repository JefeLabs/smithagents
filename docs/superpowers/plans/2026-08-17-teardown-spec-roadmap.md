# Borrowed Primitives — the spec sequence

**Source:** the Hamster / herdr / Orca teardown, 44 findings.
**Status verified 2026-08-17**, renumbered 2026-08-19, by probing `swarm/src`,
`control-plane/src`, and `broker/src` — not by reading checkboxes. Control term
returned 96 matches, so the sweep was live; every feature probe returned zero.

Started as seven specs; spec 6 split during its brainstorm, so it is now **nine**.
**All nine are written. None is implemented.** The design pass is complete;
what remains is nine plan-and-build cycles. All merged to `main` @ `6ff1184`.

## The other live threads

This sequence is one of three. Verified in code on 2026-08-19, not from
checkboxes:

| thread | state |
| --- | --- |
| **Welcome wizard** | plans 1–3 shipped; **plan 4 in progress and red** (`broker/src/talk-prefs.test.ts` written, `talk-prefs.ts` absent); plans 5–6 not started |
| **This sequence** | 7 of 9 designed, 0 implemented |
| **herdr-web-broker** (separate repo) | substantially built — 302 TS files, 32 test files, daemon/http/auth/policy/projection present; two newer design commits sit on top of its plan |

The herdr-web-broker work is a plugin built *for* herdr, exposing its socket API
over REST/WS with parent↔child federation. It is not the same question as
adopting herdr as this system's runtime, which was considered and declined.

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
| 7 | Worker protocol | ✅ `2026-08-19-worker-protocol-design.md` | ✗ | `smith-delegate` shim pattern, broker relay |
| 8 | Context projection | ✅ `2026-08-19-context-projection-design.md` | ✗ | `driver.materialize()` (projects the persona today) |
| 9 | Coordination map | ✅ `2026-08-19-coordination-map-design.md` | ✗ | react-flow `MapStage`, `nodeTypes` registry |

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
5. **Spec 4 — visibility**, then **5 — hibernation**, then **7 — worker
   protocol** (which reduces how often spec 1's `blocked` is ever reached), then
   **9**.

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
- **Spec 9 inherited a test that had already paid for itself.** Spec 4's
  route-parity test covers the new dispatch route automatically — a route added
  without its broker passthrough now fails a test rather than shipping as an empty
  canvas. That is the second spec in the sequence it protects.
- **Spec 8 corrected a register error and dropped an item.** The register claimed
  smithagents already generates skill files; it does not — a whole-tree search for
  `SKILL.md` returns nothing against a control that matched 15 files. The index is
  therefore a section appended to the persona file `materialize()` already writes.
  "Blueprint" also turned out to be taken here for document templates, so the word
  is avoided. And D3 mostly dissolved: an assignee holds one work item, so
  excluding finished work is automatic rather than implemented.
- **Spec 7 deleted two of its own mechanisms.** No heartbeat — spec 1's hooks
  already report on every prompt and tool use, so `lastStatusReportAt` is
  liveness. No durable inbox — the dispatch record is the truth, nothing is
  consumed, so nothing needs replaying. Orca needs both because its coordinator
  is a CLI draining mail; here the coordinator reads state.
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
- **`smith-ask` must not inherit spec 1's `exit 0` convention** (spec 7 §5). The
  two shims sit in one directory and will be read side by side; making them
  consistent reintroduces the guessing the ask exists to prevent.
- **`idleMinutes` default of 30 is inherited from Orca, not measured** (spec 5 §9).

## Next action

Design is done. Take a spec to `writing-plans` and implement it. The recommended
first build is **spec 3 (provisioning)** — no dependencies, and worktree-per-work-item
stays theoretical while every instance is born unable to build.

The risk worth naming: nine specs is a lot of intent with nothing behind it. The
designs assume a tree that keeps moving — spec 4 already found a route stranded
since the warm-session work. Landing one spec end-to-end would show whether this
pass produced buildable plans or only coherent documents.
