# Repo-less Contexts — Design

**Status:** design, awaiting review
**Date:** 2026-08-15
**Blocks:** a documents-only workspace in the welcome wizard
**Related:** [welcome wizard](2026-08-15-welcome-wizard-design.md)

## Problem

A workspace cannot exist without a git repo. `assertContext` demands
`repos.length > 0`, each with an absolute local path:

```ts
Array.isArray(o.repos) && o.repos.length > 0 &&
o.repos.every(r => typeof r.name === "string" && isAbsolute(r.path))
```

So someone who wants the design side — diagrams, documents, dashboards, boards,
the council sketching a schema — must point at a repo they may not have and will
never use.

## The design side needs no git at all

Verified rather than assumed, 2026-08-15:

- Documents live in `BROKER_DOCUMENTS_DIR ?? ".smith/documents"` — the broker's
  own state directory, never a repo. (A reset that day found all 60 documents
  there.)
- `documents.ts` and `doc-edit.ts` contain **zero** git references — no `git`,
  no worktree, no `.git`.
- `CliResearch` spawns with **no `cwd`**, inheriting the broker's directory, so a
  generation turn never enters a user repo.
- Boards, workspaces and squads are plain JSON under `.smith/`.

The dependency line falls cleanly between the product's halves:

| Half | Needs git? | Why |
|---|---|---|
| Design (broker) — documents, diagrams, dashboards, boards, council | **No** | JSON state; the CLI runs outside any repo |
| Code (swarm) — dispatch, worktrees, branch commits | **Yes** | worktrees are cut from a local clone |

A repo-less context is therefore a **complete** workspace for everything except
running coding agents — not a degraded one.

## The change

Relax the workspace branch of `assertContext` to allow `repos.length === 0`.

**This does not collide with groups.** `isGroupRecord()` keys on
`members !== undefined`, and `assertContext` branches on `Array.isArray(members)`
*before* repos are considered, so "group" is identified by members and never by
an empty repo list. The two shapes stay distinguishable:

| Shape | `members` | `repos` |
|---|---|---|
| group | present | must be empty |
| workspace, coding | absent | one or more |
| workspace, design-only | absent | **empty** — new |

The validator change is a single clause. The consequences are downstream, and
each must be handled explicitly rather than discovered:

- **Dispatch soft-fails with a reason.** A task aimed at a repo-less context has
  nowhere to build a worktree. It must report "this context has no repo — add one
  to run agents" and decline, never throw, and never quarantine confusingly.
- **Repo-reading callers need an empty state.** Anything reading `repos[0]` —
  repo pickers, branch selectors, worktree paths — needs to tolerate an empty
  array rather than index into it. Every caller must be enumerated; a spec that
  says "mirror the existing pattern" without listing sites has shipped a
  non-functional feature in this repo before.
- **Adding a repo later upgrades in place.** A design-only context becomes a
  coding one the moment a repo is attached. Nothing is migrated or recreated, and
  no card, board or document moves.

## Error handling

- A repo-less context must never appear *broken* in the UI — no empty repo
  widget, no "0 repos" warning. It is a valid shape, and should read as one.
- Agent creation may still be offered in a repo-less context; only *dispatch*
  fails, and it fails with the sentence above rather than a stack trace.

## Testing

Unit: `assertContext` accepts an empty `repos` on a workspace, still rejects a
group with non-empty repos, and still rejects a workspace with a malformed repo.
Dispatch into a repo-less context returns the refusal rather than throwing.

**Positive control required on the validator test.** Assert that the *old*
validator rejects the empty-repos workspace, so the new test cannot pass against
an unchanged code path.

**Live smoke:** create a design-only context through the API, add a document and
a board to it, attempt a dispatch and see the refusal, then attach a repo and see
a dispatch succeed — all against running services. Green tests do not prove
reachability; three defects shipped this session with passing suites.

## Out of scope

Multi-repo workspaces (already supported, unchanged), converting a context back
to repo-less by removing its last repo, and any change to group semantics.
