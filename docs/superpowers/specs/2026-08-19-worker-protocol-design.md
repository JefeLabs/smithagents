# Worker Protocol — Design

**Date:** 2026-08-19
**Status:** Approved design, ready for planning
**Part of:** spec 7 of nine in the decomposition drawn from the Hamster / herdr /
Orca teardown. Split from the original spec 6 during brainstorming: spec 6 is the
dispatch entity, this is the conversation around it.
**Depends on:** spec 6 (`2026-08-19-dispatch-entity-design.md`) for the entity
every message resolves to; spec 1 (`2026-08-16-agent-status-reporting-design.md`)
for the shim plumbing and for liveness — see §2 and §6.
**Surfaces through:** spec 4's Needs You column
(`2026-08-17-agent-visibility-design.md`), which is where a parked ask lands.

## Goal

A worker that needs a decision has nowhere to put the question.

Its options today are to guess, or to open a prompt in its own TUI and wait for a
human who may never look. Spec 1 addresses the second case by detecting that the
agent is blocked — which is worth having, and is still a worse outcome than the
question having somewhere to go. Detection tells you an agent is stuck. It does
not get it unstuck.

The inverse is just as bad. A worker that finishes has no way to say so beyond
falling silent, and silence is indistinguishable from a crash. The coordinator —
human or agent — is left inferring completion from the absence of output, which
is the same ambiguity spec 1 removed from status and spec 2 removed from
recovery.

Transport for this already exists in pattern. `swarm/bin/smith-delegate` is a
POSIX shim copied into every worktree, pre-installed in the docker image, that
POSTs to a swarm route. What is missing is not a mechanism but a vocabulary: two
verbs a worker can use to ask and to report.

Note also that `election.ts`'s `AskFactory` — `(agentId, system, prompt) =>
Promise<string>` — runs the opposite direction. That is *system asks agent*,
one-shot and stateless, for election claims. Same word, opposite arrow; the two
should not be merged on the strength of the name.

## Settled decisions

- **Two shims: `smith-ask` and `smith-done`.** No heartbeat shim; §6.
- **Identity is resolved server-side, never supplied by the worker.**
- **`worker_done` exactly once, with an explicit outcome, including on failure.**
- **An unanswered ask escalates, then parks.** It never auto-proceeds and never
  fails the dispatch.
- **State on the dispatch is the truth; the relay carries notification.** No
  durable inbox, no acks, no replay.
- **The status shim fails silently; the ask shim fails loudly.** §5.
- **Decision gates are deferred**, having nothing to block on yet. §7.

## 1. The shims

Both live beside spec 1's reporter in `<worktree>/.smith/status/`, reading
`endpoint` and `token` from disk on every invocation.

```sh
smith-ask "Update the shared component, or only this page?" \
  --options shared,page-only --timeout 600
# prints the answer on stdout

smith-done succeeded "Fixed footer overlap; no follow-ups."
smith-done failed "Auth stub unavailable; could not verify."
```

They deliberately do **not** follow `smith-delegate`'s convention of baking
`SMITH_URL` in from the environment at launch. That is the dead-port failure spec
1 §2 already identified: a worktree that outlives a swarm restart keeps posting
to an address that no longer answers, and nothing reports it. Reading the
endpoint from disk each time is the same fix, and these shims live in the
directory that already holds the file.

## 2. Identity is resolved, not supplied

The shim sends its per-session credential and nothing else. Swarm resolves
session → dispatch → work item.

This is a stronger form of spec 6's rule. G2 requires both ids on every message
*so that a stale retry cannot complete the wrong dispatch*; supplying them from
the worker makes that a convention the worker is trusted to follow. Resolving
them server-side makes it a property of the system: a session belonging to a
superseded attempt resolves to its own settled dispatch and is rejected, and a
worker cannot report against another attempt even deliberately.

It also removes a class of agent error entirely. An id an agent must copy into a
command is an id an agent can mis-copy, and the resulting message is
well-formed, plausible, and wrong.

## 3. `worker_done`

Sent exactly once per session, carrying `succeeded` or `failed` and a short
summary of what was done, what was found, and what remains.

**Failure is a completion.** A worker that gives up must say so; falling silent
leaves the coordinator unable to distinguish a considered failure from a crashed
process, and the two call for different responses.

**For a swarm assignee, every member reports and the dispatch settles only when
all have.** That is spec 4's rollup rule — `done` requires every member — arriving
as a settlement condition. One member's success does not settle work the others
are still doing.

A second report from a session that already reported is recorded and ignored,
mirroring spec 6 §9's handling of stale completions. It is evidence of a confused
worker and is worth keeping, not worth acting on.

## 4. `ask`

The shim reports `blocked` for its session, then waits. The question is
`pendingAsk` on the dispatch:

```ts
pendingAsk?: {
  sessionId: string;
  question: string;
  options?: string[];
  askedAt: string;
  escalatedAt?: string;
  answer?: string;
  answeredBy?: string;
};
```

The ladder, in order:

1. **Coordinator answers** — the shim returns the answer on stdout and the
   session reports `working` again. The worker continues with a decision it did
   not have to invent.
2. **Window elapses** — `escalatedAt` is stamped and the question is put to the
   human. The worker keeps waiting; nothing changes for it.
3. **Still unanswered** — the dispatch **parks**. The session stays `blocked`,
   the dispatch stays `working`, and it appears in spec 4's Needs You column,
   sorted longest-blocked first.

Parking is the deliberate outcome, not a fallback. The alternatives are worse in
specific ways: proceeding on a default makes the worker take exactly the decision
it flagged as needing one, and does so with an audit trail that reads as
sanctioned. Failing the dispatch discards a worktree of real work because nobody
was at their desk. Waiting costs an idle session, which spec 5 can hibernate and
spec 2 can wake.

**First answer wins.** A second answer to an answered ask is ignored, matching
the first-frame-wins correlation the broker bridge already uses.

## 5. The two shims fail differently, and must

| shim | cannot reach the server | why |
| --- | --- | --- |
| spec 1's reporter | exits 0, silent | a status hook that breaks the turn is worse than no status |
| `smith-done` | exits non-zero, retries | a lost completion strands the dispatch |
| `smith-ask` | **exits non-zero, loudly** | a quiet failure returns the worker to guessing |

The last row is the important one and is the opposite of spec 1's rule. That
asymmetry is deliberate and should survive review: the status shim exists to
observe without interfering, so silence is correct when it fails. The ask shim
exists precisely because the worker refused to guess — returning nothing, quietly,
hands it the guess anyway, and does so at the moment it had asked not to.

Anything that copies spec 1's `exit 0` convention into `smith-ask` because the
scripts look alike has introduced the bug this spec exists to prevent.

## 6. There is no heartbeat

G5 called for workers to heartbeat during long work. That mechanism already
exists, built by spec 1: hooks fire on prompt submit and on tool use, so every
active worker is continuously reporting.

`lastStatusReportAt` is the heartbeat. A dispatch in `working` whose sessions
have not reported within a staleness window is **surfaced as stale** — never
auto-failed, since spec 2 may yet recover the session and spec 6 §9 already
declines to fail a dispatch because a process exited.

Adding a second liveness mechanism would mean two answers to "is this worker
alive", and the interesting question would become which one to believe.

## 7. Decision gates are deferred

Orca's gates block a task in a DAG until a coordinator records a decision. Spec 6
defines no dependency graph between work items, so a gate here would have nothing
to block on and no ordering to protect.

Deferred rather than dropped, on the same reasoning that moved the coordination
map out of spec 4: a mechanism specced against data that does not exist locks in
assumptions the spec defining that data should still be free to change.

`pendingAsk` is deliberately shaped so a coordinator-authored question fits it
later without a second concept.

## 8. Notification without a queue

The dispatch record is the truth. `worker_done` sets state and outcome, an ask
sets `pendingAsk`, an escalation stamps `escalatedAt`. Nothing is consumed, so
nothing needs replaying: a coordinator that crashes mid-read re-reads the record
and sees exactly what it saw before.

Orca needs an acked FIFO inbox because its coordinator is a CLI process draining
mail exactly once and in order. Here the coordinator reads state — through spec
4's board if human, through the same route if an agent — and notification rides
the broker relay that already carries directed sends and is proven on a
four-agent run.

Building a durable queue would add ack semantics, replay, and
peek-without-consume in order to guarantee something the record provides by not
losing anything in the first place.

## 9. Errors

| condition | outcome |
| --- | --- |
| ask or done from a session with no dispatch | rejected, logged |
| done for an already-settled dispatch | recorded as stale, ignored |
| second done from a session that reported | recorded, ignored |
| answer to an already-answered ask | ignored; first answer wins |
| ask whose dispatch is cancelled while waiting | shim returns non-zero with a reason; worker stops |
| sessions stale while dispatch is `working` | surfaced as stale; never auto-failed |

## 10. Testing

- **Stale-session rejection:** a session belonging to a superseded dispatch
  cannot settle the current one — the §2 property, asserted directly.
- **Done semantics:** exactly-once per session; a swarm dispatch settles only
  when every member has reported; `failed` settles as a completion.
- **The ask ladder:** answered returns; unanswered escalates; still unanswered
  parks. Explicitly assert that **no path auto-proceeds** — that is the property
  the whole design rests on.
- **Shim failure asymmetry:** with the server unreachable, the status reporter
  exits 0 and `smith-ask` exits non-zero. A single test, because the two scripts
  will be read side by side and made consistent by someone who means well.
- **No second heartbeat:** liveness comes only from spec 1's reports.
- **First answer wins** on a doubly-answered ask.

## Out of scope

- **Decision gates** — §7, deferred until a dependency graph exists.
- **The coordinator being an agent that drains an inbox** — there is no inbox;
  §8.
- **Group addressing** (`@all`, `@idle`, `@codex`). Orca has it; the broker relay
  already has directed sends, and fan-out addressing is a relay concern rather
  than a worker-protocol one.
- **Retry policy.** Spec 6 owns retries; this spec only reports outcomes that a
  retry decision might read.
