# Dispatch Entity and Lifecycle — Design

**Date:** 2026-08-19
**Status:** Approved design, ready for planning
**Part of:** spec 6 of nine in the decomposition drawn from the Hamster / herdr /
Orca teardown. The original spec 6 split during brainstorming: this covers the
entity and its lifecycle, spec 7 covers the worker protocol that references it.
**Complements:** `2026-08-15-council-turn-design.md`. That primitive fans one
*question* to independent minds and reports divergence; this one tracks durable
supervised *work*. See §1.
**Sharpens:** spec 5's eligibility condition 6
(`2026-08-17-hibernation-design.md`).

## Goal

A retry destroys the record of the attempt it replaces.

A work item carries `delegation: { agentId, taskId, state, prUrl? }` — one
embedded record naming who holds it. That is enough to answer "who is working on
this" and nothing else. Reassign the item and the previous attempt is gone: what
was tried, where it ran, why it failed, and whether its worker is still out there
somewhere believing it owns the work.

The last of those is not hypothetical. With one mutable record there is no way to
tell a completion sent by the *current* holder from one sent by a holder that was
replaced ten minutes ago. Both name the same work item, both look valid, and
applying the wrong one marks work finished that nobody finished. Orca states the
requirement plainly — completion messages carry both ids *"so stale retries
cannot complete the wrong dispatch"* — which is a design that has clearly been
paid for.

Three consequences today:

1. **Attempts have no history.** Nothing records that a work item failed twice on
   one host and succeeded on another, so nothing can learn from it.
2. **Late messages are indistinguishable from current ones.** The system cannot
   reject a completion it should reject, because it has no identity to check it
   against.
3. **Nothing prevents two holders.** `delegation` is a field, so assigning twice
   overwrites rather than conflicts, and two workers can believe they own one
   item.

## Settled decisions

- **The work item is the task; a Dispatch is one attempt at it.** Orca's Task
  already exists here. Only the attempt is missing.
- **Dispatches are append-only.** A retry is a new dispatch, never a mutation.
- **Every message about work carries both ids.** A completion applies only to a
  dispatch that is still working.
- **Retry re-runs placement and never inherits it.**
- **Release on settle; retain is an explicit exception.**
- **One working dispatch per work item**, enforced at creation.
- **Dispatch lives in swarm.** It is an attempt at a work item, beside work
  items, sessions, and worktrees. The messaging that references it rides the
  existing broker relay (spec 7) rather than a second bus.

## 1. What this is not

The broker already has a designed multi-agent primitive:

```
councilTurn({ question, agents, context }) → { opinions, divergence }
```

That fans one question to independent minds and reports where they disagree. It
is ephemeral, single-round, and produces *positions*.

A dispatch is durable, multi-round, and produces *commits*. The two overlap only
in involving several agents. Neither replaces the other, and a coordinating agent
may well use a council turn to decide *what* to dispatch.

Stating the boundary matters because "multi-agent" is the kind of phrase that
makes two unrelated systems look like duplicates and invites someone to merge
them.

## 2. The entity

```ts
export interface Dispatch {
  id: string;
  workItemId: string;
  assignee: { kind: "agent" | "swarm"; id: string };
  /** Sessions doing the work — several when the assignee is a swarm. */
  sessionIds: string[];
  /** Where this attempt ran. Recorded, never inherited by a retry. */
  placement: { host: string; instanceId: string };
  state: "pending" | "working" | "completed" | "failed" | "cancelled";
  /** Set when settled. `failed` is a completion, not a silence. */
  outcome?: "succeeded" | "failed";
  startedAt: string;
  settledAt?: string;
  /** The dispatch this one replaces. Lineage only — see §4. */
  retryOf?: string;
  /** Set when a coordinating agent created this dispatch from another. Spec 9 draws it. */
  parentDispatchId?: string;
  prUrl?: string;
}
```

Held append-only on the work item. `delegation` becomes the first entry and is
then derived — "the dispatch that is currently `working`, if any" — so existing
readers keep working through one accessor rather than through a duplicated field
that can drift.

`sessionIds` is a list because an assignee may be a swarm. That matches spec 4's
rollup and spec 5's sleep unit: the three specs agree that the assignee, not the
session, is the unit of work.

## 3. Both ids, and the failure they prevent

Every message about work carries `workItemId` **and** `dispatchId`. A completion
is applied only when its `dispatchId` names a dispatch in state `working`.

The failure this prevents is specific and quiet. Attempt A stalls; a human or a
coordinator retries as attempt B; A eventually finishes and reports success. With
only a work item id, that report is indistinguishable from B's and the item is
marked done — by an attempt that was abandoned, possibly against a worktree that
no longer exists, while B is still running.

Nothing about that failure is loud. The item looks finished, the PR link points
somewhere plausible, and B's eventual completion arrives to find its own work
already closed. **The check costs one field and is free to add before any of this
exists; retrofitting it means a data migration and a period where the bug is
live.**

A message naming an unknown or already-settled dispatch is **recorded and
ignored**, never silently dropped. A stale completion is evidence that something
upstream is confused, and discarding it discards the only signal of that.

## 4. Retry placement is explicit

`retryOf` records lineage. It carries no placement, no host, no instance.

Placement selection re-runs from scratch for every dispatch, including retries.
Orca is explicit that `--retry-of` does not inherit `--on` or the worktree, and
the reasoning holds generally: inherited placement sends the retry to the host
that just failed, which is the least likely place for it to succeed. A retry that
lands on a broken host produces a second identical failure and looks like
confirmation that the work itself is at fault.

## 5. Release and retain

When a dispatch settles, its sessions are **released**: output is persisted to
the dispatch record, then the sessions are reaped.

`retain` is an explicit per-dispatch flag for debugging. Orca's guidance is blunt
and worth adopting — *do not leave completed worker terminals open just to re-read
output* — because a long run otherwise ends as dozens of finished sessions nobody
dares close.

**Retained sessions remain hibernation-eligible.** They are `done`, they meet
spec 5's conditions, and sleeping them costs nothing since spec 2 wakes them on
demand. This is a genuinely good composition: retain keeps work *inspectable*
without keeping it *resident*, which removes the usual reason not to retain.

## 6. One working dispatch per work item

Creating a dispatch for a work item that already has one in `pending` or
`working` is rejected.

This is Hamster's constraint — one active delivery per brief, unlimited across
briefs — and it removes a class of write conflict with no locking machinery at
all. Two agents on one work item share a worktree and a branch; serializing at
admission is cheaper and more comprehensible than reconciling afterwards.

Parallelism comes from work items, which is where isolation already lives.

## 7. What this sharpens elsewhere

**Spec 5, condition 6.** "No active dispatch on its work item, per
`delegation.state`" becomes "no dispatch in `pending` or `working`". Same rule,
now with an entity precise enough to state it against.

**Spec 9's map.** `retryOf` and `parentDispatchId` are the edges. They are
defined here, where the entity lives, and drawn there. Spec 4 deferred the map
precisely because this data did not exist yet.

## 8. Migration

`delegation` becomes the first entry in `dispatches`, with `state` mapped
(`working`→`working`, `completed`→`completed`, `failed`→`failed`) and `placement`
backfilled from the work item's instance where it can be resolved, left absent
where it cannot.

Readers and migration change in one commit, with a test loading a
`delegation`-shaped work item and asserting the derived accessor returns the
right dispatch. This is the third spec in the sequence to state that rule; it is
the failure mode the workspace-registry incident actually was.

## 9. Errors

| condition | outcome |
| --- | --- |
| completion names an unknown dispatch | recorded, ignored, logged at warn |
| completion names a settled dispatch | recorded as a stale report, ignored |
| completion omits `dispatchId` | rejected — the message is malformed |
| create while another dispatch is `working` | rejected, naming the holder |
| assignee has no sessions at create | dispatch stays `pending`; never `working` with nothing running |
| session dies mid-dispatch | dispatch stays `working`; spec 2 decides whether the session is recoverable |

The last row is deliberate. A dead session is not a failed dispatch — spec 2 may
resume it, and marking the attempt failed because a process exited would discard
recoverable work.

## 10. Testing

- **Stale-retry table:** a completion from a superseded dispatch does not settle
  the current one, and is recorded rather than dropped.
- **Retry placement:** a retry of a dispatch that ran on host A re-runs selection
  and is not pinned to A.
- **Admission:** a second dispatch on a work item with one `working` is rejected.
- **Migration:** a `delegation`-shaped work item loads with one dispatch, and the
  derived accessor agrees with the old field's meaning.
- **Release and retain:** settling releases sessions by default; `retain` keeps
  them, and retained sessions still satisfy spec 5's eligibility.
- **Dead session does not fail the dispatch.**

## Out of scope

- **The worker protocol** — `ask`, decision gates, `worker_done` message shape,
  heartbeats, acked FIFO delivery, escalation to the human. All spec 7, which
  references this entity.
- **The coordination map** — spec 9.
- **Choosing a placement.** This spec records where a dispatch ran and requires
  retries to re-select; the selection policy itself is the dispatcher's and
  unchanged.
- **Cross-host dispatch.** `placement.host` is recorded so the model does not
  need reshaping later; federating work across hosts is not designed here.
