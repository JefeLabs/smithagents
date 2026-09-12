# Crew Memory Vault — Design

**Date:** 2026-09-11
**Status:** Approved design, ready for planning
**Extends:** `broker/src/memory.ts` — crew memory keeps its `MemoryPort`, moves its
storage into the org repo, and gains a hybrid recall implementation behind the
same port ("leaves the door open for a similarity backend behind this same port",
memory.ts header; PRD §6.2).
**Depends on:** `2026-08-22-workspace-documents-design.md` for the org repo, the
per-repo write queue (§4), `--author` commits (§1.4) and the instance cone (§8) —
all shipped.
**Adopts:** `2026-08-19-worker-protocol-design.md` §1–§2 shim conventions for the
agent write path, and builds the endpoint/token plumbing those shims assume.
**Defers:** surfacing instance-branch note edits as proposals (documents §4, last
bullet).

## Goal

The crew knows things and cannot share them.

Crew memory is real and it works — durable facts behind a `MemoryPort`, recalled
into every turn — but it is a few hundred short entries in `broker/.smith/memory.json`,
written only when the brain calls `remember`, recalled lexically, invisible to the
console, and unreachable from a task worktree (PRD §6.2 names all four).

Nothing else holds knowledge either. Documents hold the specs and plans that
*drive* work. There is no home for what the team *learns*: a decision and the
reason behind it, how a service actually behaves, what Edwin prefers, what an
agent found out at 2am.

Three consequences:

1. **The same ground gets re-established every session.** What the crew worked
   out yesterday reaches today only if someone says it again.
2. **Agents cannot contribute what they learn.** A worker that discovers
   something true has nowhere to put it, so the discovery dies with the task.
3. **Edwin cannot see or curate it.** Memory is a JSON file in a checkout, not
   something to browse, search, correct, or read on a phone.

This spec makes crew memory a vault of markdown notes in the org repo: written
by the crew and by Edwin, attributed by git, searched hybridly through the same
port, reachable from the console and from task worktrees.

## Settled decisions

- **The vault is the truth.** Notes are markdown files in the org repo. Every
  index is derivable and rebuildable from them.
- **Crew memory *is* the shared brain.** It gains storage and recall; no second
  knowledge system appears beside it. "brain" remains the broker's per-turn model
  (`brain-engine.ts`, `cli-brain.ts`) and is not reused as a name here.
- **Direct writes, attributed by git.** An agent's note lands on `main` with that
  agent as `--author`. No proposal queue. Git history is the undo.
- **The index finds; the disk answers.** Search returns note ids; the text shown
  to anyone is read from the current file. A stale or over-full index costs
  ranking, never correctness.
- **helmsmith stays behind the port, in the broker only.** Per
  `broker-vs-swarm-boundary`: no `@helmsmith/*` dependency anywhere, and swarm
  never contacts a helmsmith process. The broker holds the one socket.
- **Hybrid recall is an upgrade, not a requirement.** With no edge-context
  socket, recall is today's lexical scoring over the vault. The daemons improve
  ranking; they are never load-bearing.
- **edge-memory is not used.** The vault is the store and crew memory is the
  model; a second key/value store would be a third source of truth.
- **Session-scoped memory stays broker-local.** It belongs to one conversation
  and is not shared knowledge.
- **Note ids are unique across the org repo**, like document ids, so a wikilink
  never needs a path and never resolves two ways.

## 1. The vault

### 1.1 Layout

```
<org config repo>/
├── settings.json
├── blueprints/<id>.json
├── notes/                              ← global crew memory
│   └── oidc-token-refresh.md
└── workspaces/<slug>/
    ├── specs/ plans/ dashboards/       (documents — unchanged)
    └── notes/                          ← workspace crew memory
        └── deploy-window.md
```

| `MemoryScope` | Lives at | Why |
|---|---|---|
| global (`{}`) | `notes/<slug>.md` | Shared by every workspace |
| `{workspace}` | `workspaces/<slug>/notes/<slug>.md` | Beside that workspace's material; already inside the instance cone (§5.3) |
| `{agent}` | `about: <agentId>` in frontmatter | Memory *about* a teammate is a visibility filter, not a location |
| `{session}` | never a file | Private to one conversation; stays in `.smith/memory.json` (§7) |

### 1.2 The note file

```markdown
---
title: OIDC token refresh
kind: fact
tags: [auth]
createdAt: 2026-09-11T14:02:00Z
updatedAt: 2026-09-11T14:02:00Z
---

Refresh happens on the 401, not on a timer — the gateway rotates keys
without warning. See [[deploy-window]].
```

- Flat frontmatter, same rules as documents: no nesting, ISO timestamps, a
  closed key set (`title`, `kind`, `tags`, `about`, `createdAt`, `updatedAt`).
- **No author** — git is the authorship record (documents §1.4).
- `kind` is `fact` (written by `remember`) or `note` (written by a human or an
  agent deliberately). §2.2 is the only place it matters.
- No `status`, no blueprint, no sections. A note is prose; rules that exist to
  keep a spec fit to drive work would only get in the way here.

### 1.3 Ids and naming

The filename stem is the id, minted once from the title (or the `remember` key)
and never renamed; renaming edits `title`. Ids are checked free across the whole
org repo — the same guarantee documents already enforce — so `[[oidc-token-refresh]]`
resolves from any note in any workspace, and helmsmith's link resolver (which
matches on filename, case- and extension-insensitively) lands on exactly one file.

Slugging folds case, accents and punctuation, mirroring `tokenize()`'s folding in
`memory.ts`. A collision resolves per §2.2.

## 2. Writes

### 2.1 One path

```
brain `remember` ─┐
console frames  ──┼─► broker ──SwarmClient──► swarm ──► write queue ──► file + commit ──► note-committed
smith-remember  ──┘                                                                           │
                                              broker ◄───── SwarmEvent ───────────────────────┘
```

Every write is a swarm write: swarm owns the org repo, its queue serializes
mutations, and its commits carry the acting identity (`workspace-repos.ts`). The
broker never touches the repo.

- **Commits stage the exact file**, not the `notes/` prefix. Staging the prefix
  would sweep an uncommitted hand edit into a commit authored by someone else.
- **A dirty target refuses the write.** If the file has uncommitted changes, the
  route returns a refusal naming the path; the note is not overwritten. Hand
  edits are Edwin's to commit.
- **`note-committed`** carries `{id, path, scope, author}` and is added to swarm's
  event stream *and* to the broker's `SwarmEvent` union in `swarm-client.ts` —
  two layers, per `spec-mirror-x-enumerate-layers`.
- `forget` deletes the file in a commit; history keeps it.

### 2.2 `remember` still supersedes

`MemoryPort.remember` updates the entry with the same key in the same scope
rather than duplicating it. That survives: the key slugs to a filename, and the
same key rewrites the same file.

One guard: `remember` overwrites only a note whose `kind` is `fact`. If the slug
belongs to a `note`, the fact is written to `<slug>-2.md` instead (the `-2/-3`
convention documents already use on collision). A one-line fact must never
silently replace a note someone wrote.

### 2.3 Routes

```
GET    /notes                     list; ?workspace=<slug> narrows, default = global + that workspace
GET    /notes/:id                 body, frontmatter, updatedAt, and author = %an of the last commit
                                  touching the file
POST   /notes                     { key|title, body, scope: { workspace? }, kind? } → { id }
                                  mints the id and applies §2.2 — the only creation path
PUT    /notes/:id                 { body, title? }
DELETE /notes/:id
POST   /work/memory               the shim's write (§6) — token-authenticated, identity resolved here
```

Creation mints server-side because only the server can apply §2.2: the slug is
free (create), taken by a `fact` (update — this is what makes `remember`
supersede), or taken by a `note` (create `<slug>-2`). A caller cannot decide that
race for itself, and the write queue already serializes it.

`commitConfigFiles`' allowlist gains `notes` (org level) and
`workspaces/<slug>/notes`.

## 3. The index

- **What:** every markdown file in the org repo — notes *and* documents — ingested
  as helmsmith's `prose-markdown` source type. Indexing specs and plans alongside
  notes is what lets a note link to a spec and a deliberate search reach one.
- **Where:** an edge-context instance dedicated to this org repo, on its own
  socket and its own database. Doc ids are file paths, so sharing an instance
  with any code ingest would let a `README.md` from elsewhere land on the same
  node.
- **When:** debounced 2s after `note-committed` (several commits inside the
  window collapse into one ingest), on a 10-minute sweep that catches hand edits
  made in Obsidian or an editor, and once at broker boot. Both intervals are
  configurable. Ingest is hash-gated upstream, so a sweep over an unchanged vault
  is cheap.
- **How:** the broker POSTs to the instance's ingest route over its UDS with a
  small `node:http` client, the same shape `edge-context-cli` uses. No
  `@helmsmith/*` package is installed in this repo.

## 4. Recall

### 4.1 The port goes async

`MemoryPort`'s four methods return promises. Two call sites exist today: the
`remember` tool (already async) and `describeMemoryForBrain`, which runs inside
the synchronous `makeTurn`. Recall moves out of `makeTurn` to the one caller that
passes an utterance — the human-turn path — which is already async:

```ts
const memories = await this.recallFor(text);      // budgeted; never throws
await this.deps.brain.handleUtterance(text, this.makeTurn(text, prefs, memories));
```

The two system-note turns pass no utterance and recall nothing, exactly as today.

### 4.2 What a recall does

1. Query edge-context inside a time budget (default 150ms, configurable).
2. On timeout, error, or no socket: score the corpus with today's lexical
   ranking. The turn is never blocked on a daemon.
3. Map hits to note ids, drop sections of the same note, and apply the caller's
   scope (`visibleIn`, unchanged).
4. Look each id up in the corpus; **drop ids with no file on disk**.
5. Build results from the *current* text — the section whose heading the hit
   names, else the note's opening — never from the indexed copy.

Steps 4 and 5 are why a reverted or deleted note cannot reach the brain, and why
helmsmith's pruning gap (§9.3) costs ranking rather than correctness.

### 4.3 The corpus

The broker keeps the vault's notes in memory, exactly as `LocalMemory` keeps its
entries today; the difference is that it is loaded from swarm rather than from a
JSON file, and refreshed by `note-committed` and by the sweep. It backs the
lexical fallback and steps 4–5 above, so a turn costs at most one UDS call.

### 4.4 Two kinds of recall

| | Reads | Used by |
|---|---|---|
| Automatic, per turn | `notes/` paths only | Every human turn, appended to the roster block as today |
| Deliberate | notes + specs + plans | The brain's new `recall` tool, the console, agents (§5) |

Per-turn recall stays narrow because it is injected into every turn's prompt; a
spec section would crowd the voice loop for no gain.

## 5. Surfaces

### 5.1 The meeting brain

- `remember` — unchanged shape, now writing a note. The author is Edwin: the
  brain calls it on his turn.
- `recall` — new, the local counterpart to `search_docs` (which searches
  Confluence, not this vault). Input `{ query, include?: "notes" | "all" }`,
  returning at most 5 results as title + excerpt capped at 300 characters, never
  whole documents. Automatic per-turn recall keeps `MemoryPort`'s existing
  default of 5.

### 5.2 The console (desktop + iOS)

Frames `memory.search`, `memory.list`, `memory.get`, `memory.save`,
`memory.forget`; the broker rebroadcasts `memory.changed` on `note-committed`.
The UI is a search box over result rows (title · author · updated · excerpt) and
a markdown view/edit pane. Per `swarm-routes-need-a-broker-passthrough`, each
route is two layers — swarm route *and* broker passthrough — and both are built
together.

### 5.3 Task agents

- **Read: files.** The instance's `config` member already cones
  `["blueprints", "workspaces/<slug>"]` (`workspace-instances.ts`), so workspace
  notes are present; the cone gains `notes` for the global ones. Agents grep and
  read them like any other file.
- **Ranked recall at dispatch.** `dispatchWork` is the one dispatch path for real
  work and it runs in the broker, so it recalls against the task prompt and puts
  the top note paths in the manifest (`context.memory`, beside `context.docs`).
  `materialize()` writes them into the worktree's `CLAUDE.md` / `AGENTS.md` as a
  short "What the crew remembers" list of **paths, not content** (documents §8.3).
  Sub-tasks started by `smith-delegate` bypass the broker and get the files only.
- **Write: `smith-remember`** (§6). Notes are read-only inside the worktree: an
  edit there would ride the task branch and never reach `main`. The projected
  instructions say so, and any `notes/` change in the config member is reported
  in the task result and left on the branch — never merged, never discarded
  silently. Turning such a change into a proposal is the documents §4 follow-on.

## 6. The agent write path

`smith-remember "<key>" "<text>" [--workspace]` follows spec 7 §1–§2:

- It reads `endpoint` and `token` from disk on every invocation, never from the
  environment. `smith-delegate`'s baked-in `SMITH_URL` is the dead-port failure
  spec 1 §2 identified: a worktree that outlives a swarm restart keeps posting
  into the void.
- **Identity is resolved server-side.** The token identifies the task, the task
  names the agent, and the agent becomes `--author`. An author supplied in the
  body is ignored.
- **It fails loudly** — non-zero exit, message on stderr. An agent that believes
  it recorded something must learn when it did not.

The endpoint/token plumbing spec 1 §2 assumes has not shipped. This spec builds
the minimal piece — a per-task token, and an endpoint file written when the
instance is created — so that `smith-ask` and `smith-done` inherit it rather than
inventing a second mechanism.

## 7. Migration

At boot, entries in `broker/.smith/memory.json` become notes: global entries in
`notes/`, workspace entries under their workspace, `kind: fact`, authored
`smithagents`, `createdAt`/`updatedAt` preserved. Session-scoped entries stay in
the file, which keeps serving them.

It runs **once**, and reports what it did. If swarm or the repo is unavailable it
says so loudly and leaves both stores readable — it does not promise to retry
next boot, which `workspace-documents-plan2-shipped` records as "a promise a
deterministic path cannot keep". A second run is a no-op; the file is renamed
`.smith/memory.migrated.json` only after a clean pass.

## 8. Failure modes

| Failure | Behaviour | Visible as |
|---|---|---|
| edge-context slow, down, or idle-closed | Lexical fallback inside the budget | Health flips to `lexical`; console badge; logged on transition, not per turn |
| Neo4j / embedder never installed | Same; nothing assumes they exist | Health reads `lexical` |
| Note deleted or reverted, still indexed | Hit dropped (§4.2 step 4) | Nothing |
| Write to a file with uncommitted edits | Refused, file untouched | Non-zero exit / console error |
| Write queue busy | Serialized; route reports queue position | The caller |
| Broker restart | Corpus reloaded from swarm; hash-gated re-ingest at boot | Nothing |
| Migration fails | One loud report; both stores readable | Console |

Health must distinguish `hybrid` from `lexical`. Lexical results look plausible,
so a brain that silently degraded a week ago is indistinguishable from a healthy
one — `verification-needs-a-positive-control` applied to a running system.

## 9. What helmsmith owes

1. **An edge-context instance with ingest wired and the idle close disabled**
   (blocker). Today's launcher wires query only, the standalone entry wires no
   backend, and the idle timer closes the Neo4j driver permanently after ten
   minutes — which guarantees a dead index every morning.
2. **Its own socket and database** for this org repo (§3).
3. **Pruning on re-ingest** — stale sections from shrunken notes, and notes whose
   files are gone. Quality, not correctness (§4.2).
4. **Frontmatter into the index** — `title` and `tags` for ranking and filters.
   Optional; titles already come from swarm.

Note-to-note link resolution (wikilinks, relative links, shortest-path
disambiguation) landed in `context-loader-core` on 2026-09-11 and needs nothing
further.

## 10. Build order

Three plans, each shippable alone, each written against the code as it stands
when the previous one lands (the documents convention).

1. **Vault and writes** — §1, §2, §7. Swarm's routes, the allowlist entry and
   `note-committed`; the port stores into the vault; migration runs. End state:
   crew memory lives in the org repo, attributed by git, recalled lexically.
   No surface changes.
2. **Surfaces** — §5, §6, and the one cone line. Console frames and view; the
   cone gains `notes`; recall results at dispatch; `smith-remember` with the
   token/endpoint plumbing. It consumes whatever recall the port offers, which
   after plan 1 is lexical.
3. **Hybrid recall** — §3, §4.2 steps 1–2, the health split in §8, and
   helmsmith's §9.1–9.2. The edge-context adapter, index-on-commit, the sweep,
   and `hybrid` vs `lexical` health.

Plan 3 is last deliberately: it is the only one that needs a daemon, and every
surface from plan 2 keeps working without it.

## 11. Testing

Conventions: `node --test` under tsx (`tsc --noEmit` is the only type gate), pure
modules on literal strings, git behaviour against real temp repos.

**Pure units.** Scope→path as a table (including "session is never a path");
key→slug folding, same key → same file, collision with a `note` → `-2` and the
original untouched; `visibleIn` unchanged (a session note never leaks, a
workspace fact reaches every session in it); result assembly from fake hits +
corpus — current text, ids missing from the corpus dropped, sections of one note
collapsed, scope and limit respected.

**Git behaviour — temp org repo per test.** One write commits exactly one path;
an unrelated hand edit stays uncommitted; `--format=%an/%cn` reads
`anderson/smithagents` for a shim write and `edwin/smithagents` for a console
write; a dirty target refuses; `forget` removes the file in a commit; an instance
for workspace A cones `notes/` and `workspaces/a/` and not `workspaces/b/`.

**Both ports.** Each `memory` frame calls `SwarmClient` and rebroadcasts; one
live smoke — start swarm and broker, save through 7790, assert the file on disk,
in `git log`, and returned by a search. The `work-kinds` bug (route on swarm,
client fetching the broker) survived four reviews; only a test crossing both
ports catches it.

**Positive controls for the fallback.** The fake edge-context adapter returns a
hit sharing no terms with the query — something lexical scoring cannot produce —
and the test asserts it comes back: proof hybrid ran. Then the adapter times out:
results still arrive, the turn finishes inside its budget on a fake clock, and
health flips to `lexical`. Without the first test, every recall test would pass
forever on the fallback.

**Index and staleness.** Several commits inside the debounce window produce one
ingest call; the sweep ingests with nothing committed; an index hit for a deleted
note yields no result, and a hit on changed text yields the current text.

**Migration.** Fixture with global, workspace and session entries → two notes,
sessions left in place, second run a no-op; with swarm unavailable it reports and
leaves both stores readable.

**The shim.** Endpoint read from disk each call (rewrite the file, next call goes
elsewhere); non-2xx → non-zero exit; an author in the body is ignored.

**Gates.** `tsc --noEmit` in swarm, broker and control-plane — the async port is
exactly the change tsx hides; biome counts compared before and after (baselines
have drifted); full swarm and broker suites.

## 12. Out of scope, recorded

- **Passive extraction.** Notes are written when someone decides to write one.
  Mining transcripts for facts is its own design (PRD §6.2).
- **Moving a note between scopes.** Global ↔ workspace means moving the file and
  re-checking the id; nothing offers it yet.
- **Surfacing instance-branch note edits** as proposals (documents §4).
- **Remote sync of the org repo.** Unchanged from documents §11: the repo has no
  remote, so the vault is local to this machine.
- **A second brain tool for `forget`.** The console deletes; the meeting does not
  need to.
- **Ranking work** — per-scope weighting, recency decay tuning, or pinning. The
  existing lexical tilt and edge-context's fusion weights stand until the corpus
  says otherwise.
