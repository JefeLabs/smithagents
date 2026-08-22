# Workspace Documents — Design

**Date:** 2026-08-22
**Status:** Approved design, ready for planning
**Supersedes:** §1.2 of `2026-08-16-workspace-instances-and-assignment-design.md`
(the contents of a workspace's `config/` — `artifacts/` and `diagrams/` never
shipped; this spec replaces them) and the per-workspace config repo shipped by
plan `../plans/2026-08-17-workspace-owns-its-repos.md` (one repo per workspace →
one repo per org, §1).
**Amends:** `2026-08-10-session-artifacts-design.md` and
`2026-08-10-document-editor-tiptap-design.md` (where documents persist — §3),
`2026-08-11-dock-sends-edit-artifact-design.md` (where proposals persist — §4),
plan `../plans/2026-08-17-workspace-registry.md` (the registry entry shape — §1.3).

## Goal

Specs and plans are the handoff contract between the council (research, plan,
architect with Edwin) and execution. Today that contract has no durable home:

1. **Two spec systems, neither where it belongs.** The broker has a real
   document system — blueprints with section ids, `required` flags, per-work-type
   activation, and section-targeted proposals — persisted as JSON in
   `broker/.smith/documents/d*.json`: broker-local, in the repo checkout, not
   per-workspace, not versioned, lost on `make reset`. Separately, the swarm
   writes a bare Markdown skeleton for a slice into the **project repo** at
   `docs/superpowers/specs/` and stores a repo-relative `specPath` on the slice.
   The shelf associates the two by *name matching* (`ArtifactShelf.tsx`, "when
   slices grow real doc refs, this is the one function to replace").
2. **Rules exist on paper only.** Blueprint `required` is declared and enforced
   nowhere; `Doc.status` has no mutator, so every document is `drafting` forever.
3. **A team of thirty workspaces would be thirty config repos** — thirty GitHub
   creates, thirty permission grants, thirty copies of the same blueprints
   drifting apart.

This spec makes documents workspace-owned Markdown files in one versioned org
repo, turns the blueprint into an enforced schema, stores pending edits as git
branches, and links documents to slices by reference instead of by name.

## Settled decisions

- **One config repo per org**, multi-workspace by construction. An org is a
  company by default, a department where an enterprise justifies it. A solo
  user is an org of one. There are no modes: every config repo has the
  `workspaces/<slug>/` shape.
- **Documents are Markdown files with flat frontmatter.** JSON was considered
  for validation and rejected: prose in JSON strings diffs as whole-line
  replaces, which defeats versioning, and every model writes Markdown natively.
  The validatable part — metadata — is small and lives in frontmatter.
- **The filename is the document id** and is never renamed. Rename changes
  `title` in frontmatter. Links to a document never break.
- **No author in the filename or frontmatter.** Git is the authorship record;
  a document can change hands. Consequently every commit into the config repo
  carries the acting identity as `--author`.
- **Anything being edited is under version control.** A pending proposal is a
  commit on a branch, not a sidecar file.
- **Three buckets, one rule each.** `config` (versioned, durable — anything
  edited), `files/` (unversioned, durable — anything uploaded), `.runtime/`
  (unversioned, derivable — anything rebuildable).
- **The swarm owns documents.** It owns workspace directories; a document is a
  file in one. The broker remains the UI's API and calls the swarm.
- **Rules bite at status transitions, not on every write.** A document may be a
  mess while drafting; it may not be a mess while driving work.
- **The link from slice to document is stored on the document** (`slices:` in
  frontmatter). The slice's `specId`/`planId` are derived at read.
- **Archive, never delete** during migration, per the existing
  `migrate-state.ts` rule.

## 1. The org repo and the workspace

### 1.1 Layout

```
<org config repo>/                          ONE git repo per org — any dir, pushable
├── settings.json                           org record: name, members, defaults
├── blueprints/<id>.json                    rules shared by every workspace (§6)
└── workspaces/
    └── <slug>/
        ├── settings.json                   the Workspace record
        ├── roster.json                     global agents/squads assigned here
        ├── boards/<boardId>.json
        ├── blueprints/<id>.json            optional per-workspace overrides (by id)
        ├── specs/                          ← spec, er, sequence blueprints
        │   └── 2026-08-22-1530-instance-provisioning-design.md
        ├── plans/                          ← implementation-plan blueprint
        │   └── 2026-08-22-1612-instance-provisioning.md
        ├── dashboards/                     ← dashboard blueprint
        └── files → <workspace>/files       untracked symlink (§5)

<workspace>/                                per-workspace, local, NOT in the org repo
├── files/                                  uploads — durable, unversioned (§5)
│   └── .trash/
├── <repo-name>/                            project clones (unchanged)
└── .runtime/                               derivable (unchanged except §8)
    └── instances/<workId>/
        ├── config/                         sparse worktree of the org repo (§8)
        ├── <repo-name>/
        ├── members/<member>/
        └── .runtime/updates.jsonl
```

`<workspace>/config/` no longer exists. The workspace's versioned half is the
subtree `workspaces/<slug>/` of the org repo.

Which folder a document lands in is declared by its blueprint (`folder`, §6.1),
not hardcoded: `spec`, `er`, `sequence` → `specs/`; `implementation-plan` →
`plans/`; `dashboard` → `dashboards/`. A new document kind is a blueprint with a
folder.

### 1.2 Why one repo per org

Settings, boards, specs, plans, and blueprints are all small text that people
and agents edit and reviewers read as diffs — one history is what git is for.
Blueprints are team conventions and want one home. One remote means one clone
and one onboarding step. Git handles tens of thousands of Markdown/JSON files
without effort; what hurts monorepos (binaries) is kept out by §5.

The one real cost: GitHub access control is per repo, so everyone with the repo
sees every workspace. That is why the unit is the org (a trust boundary), and
why the registry maps each workspace to a config repo rather than assuming one
per install — a second org is possible, not offered in the UI until needed.

Branch namespaces account for sharing: instance branches stay `smith/<workId>`
(work ids are UUIDs — `server.ts` `randomUUID()` — so they cannot collide across
workspaces); proposal branches are namespaced by workspace (§4) because document
ids are only unique within a workspace's folder.

### 1.3 Registry

`~/.smithagents/workspaces.json` entries become
`name → { dir: string, configRepo: string }`. The loader accepts the legacy
string form (`name → dir`) until migration rewrites it (§9.5). A fresh install
creates the org repo at `~/.smithagents/config/` and every new workspace joins
it unless told otherwise. Joining a team is "point `configRepo` at this clone."

`workspaceDir(paths, ws)` keeps its meaning (the local runtime folder). A new
`configDirFor(paths, ws)` returns `<configRepo>/workspaces/<slug>` and replaces
every `join(workspaceDir, "config")` in `workspaces.ts`, `workspace-repos.ts`,
`workspace-roster.ts`, `workspace-instances.ts`, `server.ts`, `migrate-state.ts`.

### 1.4 Commits into the org repo

`commitConfigFiles` stages only an explicit allowlist, now path-prefixed:
`workspaces/<slug>/{settings.json, roster.json, boards, blueprints, specs,
plans, dashboards}` and, for org-level writes, `settings.json`, `blueprints`. A
file dropped into the repo by hand is never staged on the user's behalf — the
guarantee `ensureConfigRepo` already protects.

Every commit carries `--author` set to the acting identity; the committer stays
`smithagents` (the tool that pressed the button):

- a human edit via the UI → the User's name and email. `User` has `name` and no
  `email` today; Settings gains an `email` field, prefilled from the GitHub
  connector when one exists, falling back to `<slug>@users.smithagents`.
- an agent edit or accepted agent proposal → `<agent id> <agent-id@agents.smithagents>`.

Commits are per mutation and the message names the target, so history reads as
an audit trail:

```
spec(instance-provisioning): approach          patchSection / accepted proposal
spec(instance-provisioning): status → review
plan(instance-provisioning): create
```

If per-section commits prove noisy, squash-on-status-change is the lever. Not a
cache.

The swarm never force-pushes or rewrites history in the org repo.

## 2. The document file

### 2.1 Naming

`{YYYY-MM-DD-HHMM}-{effort}[-design].md`, minted once at creation. The stem is
the document's `id` (replacing today's `d1`, `d2`). `effort` is a slug the
creator supplies, or `slugify(title)` when absent; it is what groups a spec
with its plans. The `-design` suffix is added for the `spec` blueprint only,
matching this repo's own `docs/superpowers/specs` convention. Lexical order is
timeline order.

### 2.2 Format

```markdown
---
title: Instance provisioning
blueprint: spec
workType: feature
status: drafting
effort: instance-provisioning
slices: [instance-provisioning]
spec: 2026-08-22-1530-instance-provisioning-design
participants: [anderson]
pins: []
createdAt: 2026-08-22T15:30:00Z
updatedAt: 2026-08-22T16:04:12Z
---

## What this is {#overview}

…

## Approach {#approach}

…
```

- **Frontmatter is a flat subset**: `key: scalar` and `key: [a, b]`, no
  nesting, no comments. `spec` appears on plans only. Parsed by a hand-rolled reader in the style of `validSources` /
  `assertRoster`; unknown keys and nesting are reported with the key named. No
  YAML dependency — the shape is smaller than a parser.
- **Section ids ride on the heading as `{#id}`** (pandoc/kramdown heading
  attribute). A proposal names `approach`, not the heading text, so rewording a
  heading does not orphan it. The marker is plain text to remark, so
  `normalizeMarkdown` leaves it alone; the swarm strips it when handing section
  bodies to the broker and re-attaches it on write, so the Tiptap editor — which
  only sees bodies — never round-trips it.
- **Sections not in the blueprint are kept.** A heading without `{#id}` gets
  `slugify(heading)` as its id and survives a UI save. A `##` inside a fenced
  code block is not a section boundary.
- **Bodies pass through `normalizeMarkdown`** on the way in, as today.
- **Proposals are not in the file** (§4).

`Doc` gains `workspace: string` (from the file's location; the UI reads it,
never sets it) and drops `proposals` as stored state (it is derived, §4). The
wire shape the broker pushes in `documents` frames is otherwise unchanged.

## 3. Ownership and data flow

```
control-plane ──frames──▶ broker (7790) ──SwarmClient──▶ swarm (7777) ──▶ <org>/workspaces/<slug>/specs|plans|dashboards/*.md
                ◀── documents frame ──┘                                └──▶ refs/heads/proposals/…
```

- `DocumentManager` (pure logic over a `Doc`; imports only the normalizer) and
  `blueprints.ts` move from the broker to the swarm. The broker's `documents`
  frame handlers (`main.ts` create / rename / changeBlueprint / pin / unpin /
  acceptProposal / rejectProposal / patchSection) and the brain's rewrite flow
  (`runDocEditTurn` → propose or patch) call `SwarmClient` and rebroadcast.
- **Truth is the disk, not a cache.** The swarm reads the workspace's folders
  on every list/get. External edits (hand edits, merged instance branches)
  appear on the next read. Live push on external edit is out of scope.
- **No UI → swarm direct calls.** The broker is the only caller (the
  twice-shipped 404 trap in `swarm-routes-need-a-broker-passthrough`).

Swarm routes, workspace-scoped, fastify style as `/work/...`:

```
GET    /workspaces/:ws/documents
POST   /workspaces/:ws/documents                      {blueprintId, workType, title?, effort?}
PATCH  /workspaces/:ws/documents/:id                  {title? | status? | blueprintId?}
PUT    /workspaces/:ws/documents/:id/sections/:sid    {body}
POST   /workspaces/:ws/documents/:id/proposals        {sectionId, newBody, agentId, rationale}
POST   /workspaces/:ws/documents/:id/proposals/:pid/accept
POST   /workspaces/:ws/documents/:id/proposals/:pid/reject
GET    /workspaces/:ws/documents/:id/problems
GET    /blueprints?workspace=<ws>                     defaults + org + workspace overrides
```

Every document response carries `problems[]` (§6.3).

## 4. Proposals are branches

A proposal is a suggested edit to one section, held until accepted or
dismissed — today an inline `Proposal[]` on the Doc, created when a doc
instruction is directed at a crew agent (`main.ts` `runDocEditTurn`; the host
applies directly, an agent proposes). Under "anything being edited is under
version control," the pending text is a commit on a branch:

```
refs/heads/proposals/<slug>/<docId>/<n>       one open proposal = one branch, one commit
```

| Proposal field / state | Git form |
|---|---|
| `newBody` for `sectionId` | the commit's diff — only that section changes |
| `agentId`, `rationale`, `createdAt` | commit author, message, date |
| `open` | branch exists, not merged into `main` |
| `accepted` | merged into `main` (`spec(x): accept proposal 3 — approach`); branch deleted |
| `rejected` | branch deleted; reachable in reflog only — rejected text does not haunt the spec |
| `stale` | `main` has touched that section since the branch point |

- The commit is built with plumbing (`hash-object` → `update-index` →
  `write-tree` → `commit-tree` → `update-ref`) against the branch: no worktree,
  no checkout, the live tree is never disturbed. `<n>` is the next free number
  under that doc's ref prefix.
- Accept is `git merge` into `main` in the live checkout, safe because the
  swarm commits every write (the tree is clean unless hand-edited; a dirty tree
  refuses the accept with the dirty paths named). A merge conflict *is* stale.
- `Doc.proposals[]` is derived: `for-each-ref refs/heads/proposals/<slug>/<docId>/`
  plus one diff per branch. The UI flow is unchanged.
- An agent editing a spec inside an instance commits on `smith/<workId>`; at
  integration, divergence on a document surfaces in the same review list as a
  proposal. Wiring that surfacing is a follow-on; the shape makes it free.
- If rejected proposals ever need to be durable, `refs/rejected/…` instead of
  delete is the one-line change.

## 5. Uploads

`<workspace>/files/` holds what a user uploads as-is — PDFs, images, decks,
exports. Durable but unversioned: a binary has no meaningful diff and does not
belong in a clone.

- Stored as `{YYYY-MM-DD-HHMM}-{slug}.{ext}`, original name in the slug. No
  index file: the listing is the index, mime comes from the extension, nothing
  is versioned so there is no author.
- Delete moves to `files/.trash/` — the only irreversible action in a workspace
  becomes reversible for one line of code.
- **Referenced from documents by relative path**: `../files/<name>` from any of
  `specs/`, `plans/`, `dashboards/`. The untracked symlink
  `workspaces/<slug>/files → <workspace>/files` (gitignored in the org repo)
  makes the same relative link resolve in the live checkout and inside an
  instance's sparse worktree (§8). `ensureOrgRepo` writes the org repo's
  `.gitignore` with `workspaces/*/files`. Binaries are never copied per instance.
- **Upload ≠ import.** Opaque bytes go to `files/`. A text file the user wants
  *as a document* goes through the document create route and lands versioned.
  The UI offers both; the swarm never guesses from an extension.
- Routes: `GET/POST /workspaces/:ws/files`, `GET/DELETE /workspaces/:ws/files/:name`,
  streamed, size-capped at upload, broker passthrough as in §3.
- No per-file metadata (uploader, description, owning doc). The reference from
  a document is the ownership record; a file nothing references is in the
  library. An "unattached files" view, if wanted, is a listing, not a schema.

## 6. Rules and validation

### 6.1 The blueprint is the schema

Defaults stay in code. Org rules live in `<org>/blueprints/<id>.json`;
a workspace may override by id in `workspaces/<slug>/blueprints/<id>.json`.
Resolution: workspace over org over defaults, same as today's user-files-over-
defaults. The broker-local `.smith/blueprints/` goes away (§9.1).

Two additions to `BlueprintSection` / `Blueprint`:

```jsonc
{ "id": "acceptance", "heading": "Acceptance criteria", "required": true, "shape": "checklist" }
```

- `shape` is a closed set: `prose` (default) · `checklist` (every non-blank line
  is `- [ ]` or `- [x]`) · `mermaid` (exactly one fenced `mermaid` block). It
  covers every section of the five existing blueprints; a new shape is a new
  case in one switch. Deliberately not a regex field — a regex in a JSON file is
  a rule nobody can read back.
- `folder` on the blueprint: `specs` | `plans` | `dashboards` (§1.1).

### 6.2 Fixed frontmatter rules

`blueprint` resolves; `workType` ∈ that blueprint's `workTypes`; `status` ∈
`drafting | review | final`; `spec` (plans only) names a document in the same
workspace's `specs/`; every `slices` entry resolves to a capability slice;
`createdAt`/`updatedAt` are ISO; no unknown keys; no nesting.

### 6.3 Gates

Writes always succeed and return `problems[]`. Only status transitions refuse:

| Transition | Must hold |
|---|---|
| `drafting → review` | frontmatter valid · every section the blueprint activates for this `workType` present · no section violates its `shape` |
| `review → final` | all of the above · every `required` section non-empty · a plan's `spec` is `final` |
| `final → drafting` | always allowed (reopen); a commit like any other |

The swarm never auto-repairs a hand-edited file: a missing blueprint section is
a reported problem, not silently re-added. Repair is a human or agent edit with
an author.

`swarm/src/document-rules.ts` is pure: `validate(blueprint, parsedDoc,
resolvers) → Problem[]`, `Problem = { where: "frontmatter.<key>" |
"section:<id>", message }`, with cross-document lookups passed in as
resolvers. No fs, no git — the `provisioning.ts` discipline.

## 7. Links — slices, the map, the shelf

- **The document owns the link.** `slices: [<sliceId>]` in frontmatter. The
  slice's `specId` / `planId` are derived in `server-enrich` by scanning the
  workspace's documents. `specPath` / `planPath` are dropped from the slice
  record after migration (§9.4). `ArtifactShelf.isSpotlit`'s name matching is
  replaced by the derived ids; the map's spec/plan nodes show the document
  title, not a path.
- **Creating a spec from a slice** (`POST /work/capabilities/:id/slices/:sid/spec`)
  becomes a document create: blueprint `spec`, `effort = slugify(slice.name)`,
  `slices: [sid]`, acceptance section seeded from the slice's stories as a
  checklist. The repo-less refusal on that route goes away — a workspace with
  no code can hold a spec. `…/plan` is the same for the plan blueprint with
  `spec` prefilled.
- **Delivery gate.** "Send to delivery" requires a linked spec with
  `status: final` (today: any spec file exists). Stricter by design — `final`
  is what makes §6 mean something.
- Shelf lists the session's workspace documents plus pinned ones; `pins` keep
  their meaning (extra targets — a group, another workspace — whose sessions
  also inherit the doc).

## 8. Instances

`createInstance` changes in three places:

1. **Sparse worktree of the org repo** on `smith/<workId>`:
   `git sparse-checkout set --cone blueprints workspaces/<slug>`. The agent sees
   its own workspace and the shared rules — not other workspaces' material.
2. **`files` symlink** inside the worktree at `workspaces/<slug>/files`, pointing
   at `<workspace>/files`, so `../files/<name>` resolves as it does live.
3. **Documents by path in the manifest.** `manifest.context.docs: { spec?:
   string; plan?: string }`, paths relative to the instance root
   (`config/workspaces/<slug>/specs/<id>.md`). The task prompt names them —
   "your spec is at …; your plan is at …; tick acceptance boxes in the plan as
   you go." Nothing pastes document content into prompts.

`destroyInstance` treats the sparse worktree like any other member. Squad
member worktrees (`members/<name>/`) are unchanged — they are worktrees of
project repos, not of the org repo.

## 9. Migration

One idempotent step in `migrate-state.ts`, gated by the `state-version.json`
marker. Each sub-step skips when its target exists, so a crashed run resumes
without duplicating. Archive, never delete.

1. **Create the org repo** at `~/.smithagents/config/` with `settings.json`
   (org name: the wizard asks; default is the user's slug) and `blueprints/`
   from `broker/.smith/blueprints/*.json` if present.
2. **Each workspace's `config/` repo → `workspaces/<slug>/`** as one import
   commit per workspace. History is not rewritten into the org repo (a
   single-user install has a handful of `Update workspace config` commits; a
   `filter-repo` pass is not worth its risk). The old repo is renamed
   `config-archived-<stamp>` beside the workspace.
3. **Broker documents → files.** For each `broker/.smith/documents/d*.json`:
   workspace = first pin, else the default workspace; filename from `createdAt`
   + `slugify(title)`; folder from the blueprint; sections written with `{#id}`.
   Open proposals become branches; accepted/rejected ones are dropped (already
   applied or refused). `documents/` is archived.
4. **Slice `specPath`/`planPath` → documents.** If the file exists in the
   project repo it is imported (`blueprint: spec`, `effort = slugify(slice.name)`,
   `slices: [id]`, body split on `##`, unknown headings kept). The project-repo
   file is left untouched — it is the user's repo. A missing file drops the
   field and the boot log says so. The slice loses the path fields either way.
5. **Registry rewrite** to `{ dir, configRepo }`; the loader accepts the string
   form until then.

Fresh install: `ensureOrgRepo` at init; the first workspace is created directly
as `workspaces/<slug>/`.

## 10. Testing

Conventions: `node --test` under tsx (`tsc --noEmit` is the only type gate),
pure modules on literal strings, git behaviour against real temp repos as the
instance tests do.

**Pure units.**
- `document-file.ts`: round-trip is the identity for every blueprint skeleton;
  `{#id}` survives `normalizeMarkdown`; unknown `## Open questions` kept as
  `open-questions`; frontmatter rejects nesting and unknown keys naming the key;
  `##` inside a fence is not a split.
- `document-rules.ts`: one test per rule with a minimal failing document; a
  table test over the §6.3 matrix, allowed and refused directions; each `shape`
  has a pass and a fail.
- Blueprint resolution: defaults, org override, workspace override, unknown
  `folder` refused.

**Git behaviour — temp org repo per test.**
- Proposals: create → branch exists and the live tree is clean; accept → file
  updated, branch gone, message names the section; reject → branch gone, file
  unchanged; stale → `main` edits the same section, proposal reports `stale`,
  accept refuses; two proposals on different sections both accept.
- Authorship: `git log --format=%an/%cn` shows `edwin/smithagents` for a UI
  edit and `anderson/smithagents` for an accepted agent proposal.
- Sparse worktree: an instance for workspace A contains `blueprints/` and
  `workspaces/a/` and not `workspaces/b/`; the `files` symlink resolves to A's
  uploads from inside the worktree.
- `commitConfigFiles`: only allowlisted paths under `workspaces/<slug>/`; a
  stray file is never committed.

**Migration.** Fixture: old per-workspace `config/` repo + `d1.json`, `d2.json`
+ a slice whose `specPath` file exists and one whose doesn't. Run twice: the
second run is a no-op, archives exist, nothing from the fixture deleted, the
missing-file slice loses its path and the log says so.

**Both ports.** A broker test that each `documents` frame handler calls
`SwarmClient` and rebroadcasts; one live smoke in the plan's verification —
start swarm and broker, create a spec through 7790, assert the file is on disk
and in `git log` of the org repo.

**Positive controls.** Every validator suite includes a deliberately invalid
document that must fail.

**Gates.** `tsc --noEmit` in swarm, broker, control-plane; biome counts measured
before and after (baselines have drifted — compare, don't assume zero); the
full swarm suite.

## 11. Out of scope, recorded

- **Remote sync.** The org repo has no remote today. Sharing with teammates
  means fetch/rebase-before-push on the swarm's writes and conflict handling
  when two machines edit one spec. This layout (one repo, subtree per
  workspace, per-commit authors, no force-push) is what makes it possible;
  nothing here forecloses the choice. Its own spec.
- **Live push on external edit** (hand edit, merged instance branch). Next read
  sees it; no watcher.
- **Surfacing instance-branch document edits as proposals** at integration
  (§4, last bullet).
- **A second org in the UI.** The registry supports it; nothing offers it.
- **History-preserving import** of per-workspace config repos (§9.2).
