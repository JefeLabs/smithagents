# Workspace Instances + Work Assignment — Design

**Date:** 2026-08-16
**Status:** Approved design, ready for phased planning
**Supersedes:** §1b of `2026-08-15-packaged-runtime-design.md` (per-workspace
directories). §1 of that spec — the `~/.smithagents` state root — stands, but its
`process.chdir(stateRoot)` mechanism does not; see §1.3.
**Closes:** the follow-up recorded in
`2026-08-07-session-creation-and-execution-mode-design.md` → *"the sessions ≡
active-agents invariant and PRD assignment remain their own future spec."*

## Goal

Make agent work simulate real developer activity. A developer clones a project,
picks up a ticket, branches, writes code, runs tests, commits, opens a PR,
responds to review, lands it, and moves on. Every one of those needs a home in
the model — and the ones that currently have none (review response, CI reaction,
rebase) are exactly where the system is incomplete.

Three problems today:

1. **Work directories are homeless.** A session for the `proving-ground`
   workspace materializes at
   `smithagents/swarm/.smith/worktrees/session-<uuid>` — a proving-ground
   worktree physically inside the *smithagents* swarm's private state. The
   workspace owns nothing.
2. **State is addressed by `process.cwd()`.** 91 occurrences of
   `resolve(process.cwd(), ".smith/…")` across swarm and broker. A process-global
   cwd can name exactly one location, which is why `containersPath()` silently
   reports Docker disabled when the swarm starts from the wrong directory.
3. **There is no inbound path.** Once an agent commits, nothing can reach it.
   Review comments, CI failures, and peer questions have nowhere to arrive.

## Settled decisions

- **A workspace is an unversioned runtime folder holding repos.** Not itself a
  git repo. It contains a **config repo** plus the project repos.
- **`~/.smithagents/` holds host facts and pointers only.** Machine-level
  settings and a registry mapping workspace name → absolute path. Everything
  about a workspace loads from that workspace's directory.
- **New workspaces default to `~/.smithagents/workspaces/<name>/`**, but the
  registry accepts any absolute path, so a workspace can live where the user
  keeps code.
- **`config/` is authored, `.runtime/` is recorded.** Settings, boards,
  artifacts, and diagrams-as-code are versioned. Chat history, logs, and work
  trees are not. The test for any future artifact: *would you review it in a PR?*
- **A workspace-instance is ephemeral.** Created when work is assigned,
  destroyed when work completes. It mirrors the whole workspace shape, so
  multi-repo work is the normal case.
- **The work item owns isolation; agents and swarms are assignees.** Isolation is
  between work items, not between agents. Two concurrent items in one workspace
  mean two assignees and two instances.
- **An assignee holds one work item at a time**, preserving sessions ≡ active
  agents. The *user* parallelizes by assigning, not the agent by context-switching.
- **Substrate is per assigned agent over the shared instance.** A local docgen
  agent and a Dockerized e2e agent work the same files; only the e2e agent gets
  its own ports and browser. This keeps the existing "a session's mode is
  immutable" decision intact.
- **Chat history is SQLite in `.runtime/`, never in the config repo.** A binary
  blob rewritten per message would grow the repo without bound, produce
  unresolvable merge conflicts, and slow the clone the config repo exists to make
  cheap.
- **Secrets are retrieved on demand, never held by the instance.** Agents call a
  local registry through an injected shim at use time. This makes rotation and
  revocation live operations, keeps credentials out of `ps` and out of the
  instance's files, and is what lets a human fix an expired key without
  restarting the agent that is blocked on it.
- **Escalation is a separate channel from the inbox.** Inbox events are delivered
  to an agent that keeps working; an escalation suspends the work item until a
  human acts.

## 1. Directory layout and state ownership

### 1.1 Host root

```
~/.smithagents/
├── cli-tools.json         machine fact: which CLIs are installed
├── containers.json        machine fact: docker enablement
├── auth.json              host auth
├── devices.json           device pairing
├── identity.json          host agent identity
├── master.key             encryption at rest (moves from ~/.smith/)
├── workspaces.json        registry: name → absolute path
├── agents/                global agent templates
├── squads/                global squad templates
├── avatars/               template avatars
├── blueprints/            document templates
└── workspaces/<name>/     DEFAULT location for new workspaces
```

Existing host files keep their current names and shapes; only their location
changes. Consolidating them is a separate concern and not required here.

### 1.2 A workspace

```
<workspace>/                          unversioned runtime folder
├── config/                    ← git  AUTHORED
│   ├── settings.json                   workspace settings
│   ├── roster.json                     which global agents/squads are assigned here
│   ├── boards/*.json                   was swarm/.smith/work/<ws>-<board>.json
│   ├── artifacts/                      documents
│   └── diagrams/*.mmd                  diagrams as code
├── <repo-a>/                  ← git  project repos, cloned by the workspace
├── <repo-b>/                  ← git
└── .runtime/                         RECORDED — never versioned
    ├── chat.sqlite
    ├── logs/
    └── instances/<work-id>/          ephemeral workspace-instances
```

### 1.3 Paths are absolute, resolved from the workspace record

No `process.cwd()`, no `chdir`. This is the point on which this spec supersedes
the packaged-runtime plan: `process.chdir(stateRoot)` keeps every path
cwd-relative and merely changes what cwd is. It works only while all state sits
under one root, and it can never express two workspaces at once — which §2
requires.

Once a workspace is addressed by absolute path, a workspace on another disk, a
network mount, or inside a container is the same code path. Remote workers and
packaged mode fall out rather than needing their own plumbing.

## 2. Work items, assignment, and instances

### 2.1 The instance

A **workspace-instance** mirrors the workspace shape, with each repo as a
worktree of the workspace's clone:

```
<workspace>/.runtime/instances/work-42/
├── config/        worktree of <workspace>/config
├── repo-a/        worktree of <workspace>/repo-a
└── repo-b/        worktree of <workspace>/repo-b
```

It is a **workspace-level worktree** — the pattern the dispatcher already uses
per repo, lifted one level so the assignee sees the project as it actually is.
One instance cuts the same branch name in each repo it touches, so coordinated
cross-repo branches are the default rather than a special case.

Worktrees, not clones, because instances are disposable and share the workspace's
object store — which also makes §3.2's rebase local and instant.

**This is why `gitdirMount()` becomes unnecessary.** A worktree's `.git` is a
file pointing at an absolute path inside its parent's `.git`. Today the parent
lives elsewhere, so Docker received a dangling pointer and the parent `.git` had
to be bind-mounted separately. With both inside the workspace directory,
`-v <instance>:/workspace` resolves on its own.

### 2.2 Lifecycle

The lifecycle is a filesystem fact, not a status field someone must remember to
update:

```
assigned → instance created → work → committed → reviewed → completed
                                  ↑______________________|
                                   iterate in the same instance
                                                          ↓
                          workspace clone fast-forwarded, instance destroyed
```

Throughout this spec, **"the workspace clone"** means `<workspace>/<repo>/` — the
durable checkout an instance is worktreed from. It is never a reference to the
git branch named `main`, which is a separate thing an instance also branches from.

**The instance survives past commit.** All nine PRs on
`ecruz165/smith-agent-proving-ground` are still open, so review iteration is the
common case, not the edge. Destroying at commit would kill the instance exactly
when it is about to be needed again.

### 2.3 Swarm shapes

Chosen per assignment:

| | `delegated` | `federated` |
|---|---|---|
| Members | built-in subagents (`.claude/agents/*.md`) | separate CLI sessions |
| Engines | claude only | mixed — codex, opencode, copilot |
| Coordination | leader delegates via the Agent tool | brokered relay |
| Isolation | one session; `isolation: "worktree"` per member when parallel-mutating | session each |
| Permissions | `tools:` frontmatter — preventive | grants + compliance — detective |

`delegated` exists because Claude Code's own subagent mechanism already provides
what `squads.ts` hand-rolled. Member transcripts are already persisted as
sidechain entries in the leader's session file — `claude.ts:117` skips them
deliberately (`isSidechain` → `continue`), so per-member observability is a
filter change, not new infrastructure.

`federated` remains because the built-in path can only spawn Claude. A squad
whose value is engine diversity — a Codex member arguing with a Claude member —
can never use `delegated`.

**Members are generated, not authored.** A `delegated` instance's
`.claude/agents/*.md` are written from global template + workspace roster at
instance creation, the same way `ClaudeDriver.materialize()` already writes
`CLAUDE.md`.

## 3. Integration

Everything missing from the model is the same shape: something arrives *after*
the agent thought it was done. One mechanism, not three.

### 3.1 The work item has an inbox

```
Work item
├── instance      files
├── assignee      agent or swarm
└── inbox         events, delivered as turns to the assignee's session
```

| Event | Producer |
|---|---|
| Review comment | PR |
| CI check failed | PR checks |
| Rebase needed | another instance landing |
| Question from a peer | another work item's assignee |

Delivery already exists: `sessionManager().send(id, text)` puts a turn into a
live session and returns the reply. **Collaboration and integration are the same
mechanism** — a peer question and a CI failure are both inbox events.

Rules:
- Assignee busy → queue, deliver on idle.
- Assignee session dead → the work item surfaces as blocked. Never silently
  dropped, matching the existing "death is surfaced, never silently respawned".

### 3.2 Rebase belongs to the assignee, at completion

The assignee rebases its own branch when moving to complete — not eagerly every
time another instance lands, which would interrupt agents for conflicts most will
never hit, since concurrent work usually touches different files.

The assignee does it because it is the only actor with context on its own
changes, and it is still alive. Instance worktrees share the workspace's object
store, so the workspace's refs are already visible: no fetch, no network.

**A conflict returns the work item to in-progress** with a rebase-needed inbox
event. It is a work event, not a failure state. Escalation to the user happens
only if the assignee cannot resolve it.

### 3.3 Session death does not kill the work

The instance is durable; the session is not. If a session dies or the swarm
restarts, the work item still has its files and its branch, and a new session for
the same assignee resumes it.

The work item records its assignee's session id, so recovery is
`--resume <known id>` rather than inferring which transcript belonged to whom.
This requires §5's `--session-id` change.

Reconciliation already works: a swarm restart on 2026-08-16 adopted four live
sessions with turn counts intact.

## 4. Migration

The "91 call sites" figure overstates the work: `users` (42) and `workspaces`
(33) account for 75 of them and are both host-scoped, so they do not move.

| Scope | Paths |
|---|---|
| **Host** | `users`, `workspaces` (→ registry), `cli-tools.json`, `api-keys.json`, `master.key`, `containers.json`, `devices.json`, `identity.json`, `auth.json`, `voice-cache`, `agents`, `squads`, `avatars`, `blueprints` |
| **Workspace → `config/`** | `work` (boards), `documents`, `topics`, `feeds`, `channels` |
| **Workspace → `.runtime/`** | `worktrees` (→ `instances/`), `sessions`, `api-sessions`, `logs`, `queue`, `permissions` |

### 4.1 The template-vs-instance rule

Several paths could plausibly live in either place. One rule settles all of them:

> **Definitions are global; assignments are per workspace.**

`agents`, `squads`, `avatars`, and `blueprints` are templates and live at the
host root. A workspace records which of them it uses in `config/roster.json`.
This is exactly what `532b2ed` already decided — *"agents are global templates +
global registry, assigned per workspace"* — and it is why §2.3 generates member
definitions into an instance rather than authoring them in either place.

`groups` resolves to the host registry: per `one-context-entity-shipped`, a group
is a workspace with members, not a separate entity.

### 4.2 Order, by risk

1. **State root + registry.** Host paths move to `~/.smithagents/`; add
   name → absolute-path resolution. Nothing workspace-scoped changes.
2. **Thread a workspace argument through workspace-scoped call sites.**
   Mechanical and wide. Kills the `process.cwd()` idiom and the class of bug it
   causes. **Valuable on its own even if instances never ship.**
3. **Boards and artifacts into config repos**, decoding the
   `<workspace>-<board>.json` filename convention.
4. **Instances last.** Only after paths are explicit.

### 4.3 Live sessions: drain, do not relocate

Sessions running in `swarm/.smith/worktrees/session-<uuid>` cannot be moved — a
tmux process holds that cwd. Let existing sessions finish and die on the old
layout; create new ones on the new. Drain needs no compatibility code, and
session death is already a surfaced, recoverable state.

### 4.4 Three paths that resolved on inspection

- **`.smith/project.json` and `.smith/projects/`** are not state. `server.ts:444`
  stats them only to warn that *"projects were removed; use .smith/workspaces/"*.
  They are a deprecation notice and should be dropped, or moved to the host root
  unchanged if the warning is still earning its keep.
- **`.smith/roster-state.json` and `.smith/memory.json`** are broker singletons
  (`BROKER_STATE_FILE`, `BROKER_MEMORY_FILE`). The broker keeps **one of each for
  all workspaces**, which this model wants split per workspace: roster state is
  runtime, so `<workspace>/.runtime/roster-state.json`, and broker memory is
  workspace context, so `<workspace>/.runtime/memory.json`. Both are already
  env-overridable, so the per-workspace path can be injected without touching the
  broker's own resolution logic.

That last point generalizes: **the broker is a host-level singleton serving
workspaces it has no per-workspace state for.** Splitting these two files is the
smallest instance of a question this spec does not otherwise address — whether
the broker eventually becomes workspace-aware or stays a router.

## 5. Required companion change: `--session-id`

`AgentSessionManager.create()` already generates a UUID per session and never
tells the CLI about it, then reverse-engineers which transcript is its own by
diffing the directory before and after launch. That inference is unsound the
moment two agents share a project directory — which `delegated` squads and
shared-instance work both cause.

Passing `--session-id <the id it already has>` makes the transcript path known.
This replaces the snapshot-diff in `agent-sessions.ts`, and it is a prerequisite
for §3.3's resume-by-id.

The same inference already caused a live defect: a relay turn returned an
earlier out-of-band exchange prepended to the agent's answer (fixed in
`a326c0f`, but the fix restores a correct baseline rather than removing the
inference).

## 6. Configuration refresh and escalation

A running instance holds a snapshot. When settings change, it must be able to
pick them up — and when it cannot proceed without a human, it must be able to say
so. §3 gave the work item an inbound path; this section adds the outbound one.

### 7.1 Three refresh classes

Where a value is *read from* determines whether a live instance can refresh it:

| Source | Refresh |
|---|---|
| **Workspace config repo** — boards, settings, artifacts, diagrams | **Pullable.** The instance's `config/` is a worktree sharing the object store, so refresh is a local checkout plus a steer. No network. |
| **Read-per-use files** — `api-keys.json` via `loadApiKeysFile` | **Automatic.** No caching, so the next call sees the new value with no steering at all. |
| **Process environment** — `GH_TOKEN`, `SMITH_ATLASSIAN_TOKEN` | **Impossible.** Env is fixed at exec. §7 removes this class by moving secrets to retrieval-on-demand. |

Until §7 lands, a rotated connector credential requires relaunching the session.
That is acceptable only because §5's `--session-id` lets the replacement resume
the same transcript — relaunch-and-resume, not start-over.

### 7.2 Config-changed is an inbox event

A workspace config commit produces a `config-changed` event in the inbox of every
work item whose instance is live. Delivery follows §3.1: the assignee refreshes
its `config/` worktree and continues. Busy assignees queue; dead ones surface.

### 7.3 Escalation is the mirror of the inbox

```
agent blocked  →  escalation  →  user acts in Settings  →  inbox event  →  agent continues
```

Escalation is a **separate channel from the inbox, not another event type**,
because the two have opposite semantics: an inbox event is delivered to an agent
that keeps working; an escalation **suspends the work item** until a human acts.
Collapsing them would make "CI failed" and "paste a new key" indistinguishable to
the user.

An escalation carries a classified reason. `auth failed for connector <id>` is
actionable; `task exited 1` is not. Credential failures in particular must be
classified at the point of failure — today an expired key surfaces with the same
shape as a syntax error, so a five-second fix in Settings looks like a broken
agent.

## 7. Secret registry

Secrets are **retrieved on demand by the agent**, never held by the instance.

### 8.1 What already exists

`swarm/src/api-keys.ts` is the registry: AES-GCM at rest under `master.key`,
`loadApiKeysFile` reading fresh per call, and a deliberate split between redacted
listings (`hasKey`, `last4`, `verified` — never the value) and a narrow retrieval
accessor. `GET /api-keys/:provider/credential` already serves raw values to one
caller.

**That split must be preserved.** The UI path and the agent path stay separate
routes with separate guards; retrieval never becomes a `?reveal=true` flag on the
listing route.

### 8.2 What to add

1. **A shim, following the `smith-delegate` precedent.** `bin/smith-secret <name>`
   is copied into the instance's `bin/` with PATH prepended — the same mechanism
   that already gives agents delegation. Agents call it at use time.
2. **Per-instance identity, and it is mandatory.** Today's guard is *"the swarm
   binds 127.0.0.1, and this route is deliberately absent from the broker's
   passthrough."* That is airtight for a single in-process caller and provides
   nothing once every agent can call it — and a Docker agent cannot reach host
   loopback at all, so serving containers means widening the only guard that
   exists. A token minted at instance creation and carried by the shim tells the
   registry **which work item is asking**.
3. **Scoping from data already present.** `repo.github.connectorId` already
   resolves tokens per repo — "two repos in the same workspace can legitimately
   resolve to two different tokens." A work item's grant set derives from its
   workspace and repos rather than being invented.
4. **Audit.** Log provider, work item, and timestamp on every retrieval. Never
   the value.

### 8.3 Why this is worth the work

- **Rotation and revocation start working.** A value in env cannot be changed or
  withdrawn from a running process; a capability can be refused on the next call.
- **Secrets leave `ps`.** `runtime.ts` documents its own limit: env passed via
  `tmux new-session -e` "remains visible in `tmux`'s own short-lived launch
  invocation and `ps` output for that one moment — an intrinsic property of
  process-based env passing on POSIX." Retrieval-on-demand removes the window
  rather than narrowing it.
- **Secrets stay out of the instance's files**, so an agent told to "stage and
  commit ALL your changes" cannot commit one.

This is the change that collapses §6.1's third row into its second, making
credential rotation a live operation and removing the relaunch path entirely.

## 8. Testing

- **Layout**: creating a workspace produces the §1.2 shape; no state is written
  under `process.cwd()`.
- **Isolation**: two concurrent instances in one workspace commit without
  touching each other's trees.
- **Multi-repo**: an instance spanning two repos cuts the same branch name in
  both.
- **Docker**: `-v <instance>:/workspace` gives a container working git with no
  `gitdirMount()`.
- **Inbox**: an event delivered to a busy assignee queues and lands on idle; to a
  dead assignee marks the work item blocked.
- **Rebase**: a conflict returns the item to in-progress rather than failing it.
- **Drain**: a session on the old layout survives the migration and completes.
- **Config refresh**: a config-repo commit reaches a live instance's `config/`
  worktree after one inbox event, with no relaunch.
- **Escalation**: a failed credential produces a classified, suspending
  escalation — distinguishable from a task failure, and it does not appear in the
  inbox.
- **Secret retrieval**: `smith-secret` returns a value for a granted provider,
  and **fails for a provider the work item was not granted** — the negative case
  is the one that matters, since an unscoped registry passes the positive test.
- **Rotation**: a key updated in Settings is returned by the very next
  `smith-secret` call from an already-running session.
- **No secrets at rest**: after a full task run, no credential value appears in
  the instance's files or in the launch environment.

Tests must assert observable behavior, not call shape. A `sendText` test that
asserted which tmux flags were passed would have stayed green through a total
input-delivery failure — the reason `ecdeca5` added a delivery test that checks
what the program actually received.

## Open decisions

- **Does `api-keys.json` stay host-scoped?** Listed as host because keys are user
  credentials rather than project config, but a workspace-scoped provider key is
  a coherent alternative — a client project with its own billing, for instance.
- **Is one implementation plan the right granularity?** §4.2 steps 1–2 (state
  root, explicit paths) deliver value independently of §2–§3 and touch far more
  files. They may deserve their own plan, with instances and the inbox following
  as a second.

## Out of scope (recorded)

- Wiring `buildSquadLaunchScript` — superseded by §2.3. The pane model, its
  permission grants, and `validateCompliance` are deletion candidates once
  `delegated` lands.
- CI event production (webhook vs poll). §3.1 defines the inbox; who fills it
  from GitHub is its own spec.
- Cross-workspace work items.
- Instance sharing between two assignees — one assignee per work item is settled.
- The 3 Dependabot advisories on the default branch (2 high, 1 moderate),
  surfaced on push 2026-08-16.
