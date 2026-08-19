# Context Projection — Design

**Date:** 2026-08-19
**Status:** Approved design, ready for planning
**Part of:** spec 8 of nine in the decomposition drawn from the Hamster / herdr /
Orca teardown. Independent — buildable with nothing in front of it.
**Extends:** `driver.materialize()`, which already projects the *agent* into every
worktree. This projects the *work*.
**Defers:** agent-authored checkpoints (register D5) to spec 7's line, which owns
the agent→system write path.

## Goal

An agent starts a turn knowing who it is and nothing about what it is doing.

`materialize()` writes a persona into every worktree — `CLAUDE.md` for Claude,
`AGENTS.md` for the others — so by the time the TUI starts the agent already *is*
its specialist. That projection is real and it works. It carries the agent's
role, directives, and domain, and it stops there.

The work does not travel with it. The card's title, its notes, its acceptance
criteria, the documents someone linked to it — all of that lives in swarm and
reaches the agent only if a human pastes it into a prompt. So the same
requirements get retyped per turn, drift between what the board says and what the
agent was told, and cannot be read at all by an agent that was started by a
routine rather than a person.

The fix is not a new subsystem. There is already a per-driver hook that writes
context files into the worktree and git-excludes them. It writes one kind of
context today.

Three consequences:

1. **Requirements are re-entered rather than read.** Every turn that needs the
   acceptance criteria needs a human to supply them.
2. **The board and the agent can disagree.** A card edited after a session
   started is invisible to that session, permanently.
3. **A council cannot deliberate on shared ground.** N agents reasoning about one
   work item from N differently-worded prompts will argue about premises rather
   than the problem — which is the failure mode the council exists to avoid.

## Settled decisions

- **Project only what already exists.** Work card, acceptance criteria, linked
  documents. No new knowledge entity.
- **The index is a section in the persona file**, not a generated skill.
- **Refresh on `send()`.** No watcher, no daemon.
- **Create fails on projection failure; refresh only warns.**
- **Never committed.** Git-excluded like everything else `materialize()` writes.

## 1. Two corrections this spec is built on

**smithagents writes no skill files.** The teardown register claimed otherwise —
"you already generate skills" — and that was wrong. A search of the whole tree
for `SKILL.md` returns nothing, verified against a control that matched 15 files.
Hamster generates a skill because it has no other channel into the agent's
session. This codebase has one already, which changes the cheapest answer
entirely.

**"Blueprint" is taken and means something else here.** In smithagents a
blueprint is a document *template* — `artifactKinds.ts` describes
"blueprint-instantiated documents split by render kind". Hamster's Blueprint is a
durable statement of what is true about a system. Borrowing the word would
collide with a shipped concept in the composer, so this spec does not use it, and
neither should the knowledge-artifact spec if one is ever written.

## 2. What projects

Into `<worktree>/.smith/context/`, beside spec 1's `.smith/status/`:

```
.smith/context/
├── work-item.md          # frontmatter: id, title, column, flags, capabilityRef
│                         # body: notes, then acceptance criteria
└── documents/<slug>.md   # documents linked to the work item
```

Markdown with YAML frontmatter, at stable paths. Stable matters more than it
looks: an agent that learns a path once should find the same thing there next
session, and a path that varies per run is a path nothing can be instructed
about.

The persona is deliberately **not** re-projected. `materialize()` owns it, and
two writers for one file is how a file ends up with content nobody can account
for.

Acceptance criteria live inside `work-item.md` rather than in their own file. The
card is one entity and the `stories` array is a field on it; splitting them would
model a separation the data does not have.

## 3. The index is a section, not a file

Each driver's `materialize()` gains a "Your current work" section appended to the
file it already writes, naming `.smith/context/`, what is in it, and when it was
written.

**One shared content builder, five per-driver call sites.** The filename differs
per CLI — `CLAUDE.md` versus `AGENTS.md` — but the words do not, and the section
is assembled once.

This is where the first correction pays off. Hamster's generated skill exists
because its CLI has no other way in. Building the equivalent here would mean five
formats for a mechanism only two of the five CLIs support natively, in order to
reach a file every one of them already reads at session start.

## 4. D3 mostly dissolves

The register carried "keep finished work out of the projection", taken from
Hamster, where a whole active backlog projects and archived briefs must be
filtered out.

That assumption does not hold here. **An assignee holds one work item at a time**
— the invariant spec 4's join already depends on — so the projection is that one
item and exclusion is automatic rather than implemented.

What survives is thin: an archived document linked to the card does not project.
Worth stating rather than claiming a delivered feature, because a spec that
reports work it did not do teaches the next reader to distrust the rest of it.

## 5. Staleness rides `send()`

A teammate edits the card in the browser and the worktree copy is stale.

Hamster solves this with `hamster sync --watch`, a daemon holding a live
connection and rewriting files as they change. That is the right answer for a
tool whose agent sessions are driven by a human at a keyboard for hours.

Here the projection is rewritten **immediately before each turn is delivered**,
inside the existing `send()` path. The agent's next action always reads current
context. No watcher, no daemon, no new lifecycle to supervise, and no window in
which a file is being rewritten while an agent reads it — `send()` is already the
one moment that matters, because it is the only moment the agent is about to act.

Cost is one write per turn against a handful of small files, which is noise
beside the turn itself.

## 6. Failure is asymmetric

| when | failure | why |
| --- | --- | --- |
| session create | **fail the create** | an agent that starts ungrounded produces confident work against context it never saw |
| refresh before a turn | **warn, deliver anyway** | the agent already has the previous version; killing the turn costs more than the staleness |

The same operation, two consequences, decided by what is already true. Spec 7
draws the same distinction between its two shims for the same reason: the cost of
failing is not a property of the operation, it is a property of the state it
leaves behind.

## 7. Never committed

The projection directory is appended to `.git/info/exclude` exactly as
`materialize()`'s output already is.

This is not hygiene. Agents are routinely told to stage and commit their changes,
and an agent that commits `.smith/context/` puts a snapshot of internal work
state into the user's repository history. Spec 3 guards the same hazard for
secrets; the mechanism is identical and already exists.

## 8. Errors

| condition | outcome |
| --- | --- |
| work card missing at create | fail the create, naming the card id |
| linked document unreadable | project the rest, note the omission in the file |
| projection write fails at create | fail the create |
| projection write fails at refresh | warn, deliver the turn |
| card has no acceptance criteria | project without that section; not an error |
| session has no work item | project nothing; the persona still applies |

The last row matters for spec 4's Unassigned column: an ad-hoc session with no
delegation is legitimate and simply has no work to project.

## 9. Testing

- **Content fidelity:** the projected file matches the card's title, notes,
  flags, and acceptance criteria.
- **Per-driver index:** all five drivers gain the section, in the file each one
  actually writes. Five fixtures, because the filename is the part that varies
  and is therefore the part that breaks.
- **Refresh:** a card edited between turns is reflected on the next `send()`.
- **Asymmetry:** a projection failure fails `create()` and does *not* fail a
  refresh. Asserted as two tests, since the whole point is that they differ.
- **Never committed:** after a projection, `git status` in the worktree reports
  nothing to commit from `.smith/`.
- **No work item:** a session with no delegation projects nothing and starts
  normally.

## 10. Authoring guidance, not a mechanism

Hamster's sharpest rule is that a Blueprint describes *state* and a Brief
describes *change* — which is why their knowledge documents do not decay into
changelogs.

There is no state artifact here to apply it to, and this spec deliberately does
not invent one. The rule is recorded so that whenever a durable knowledge
document does arrive, it arrives with the constraint that keeps it useful, rather
than acquiring it after the first year of drift.

## Out of scope

- **A knowledge artifact** describing what a system is today. Considered and
  deferred; it needs authoring, curation, and a staleness story of its own.
- **Agent-authored checkpoints** (register D5) — spec 7's line owns the
  agent→system write path, and adding a second one here would need reconciling.
- **Relationship-first retrieval** (register E1). Projection is one item deep;
  walking the graph to decide what *else* is relevant is a different capability.
- **Code indexing** (register E2), already scoped to the authoring surface only.
- **Live sync while a turn is in flight.** Refresh happens between turns by
  design; rewriting files under a running agent is a race with no upside.
