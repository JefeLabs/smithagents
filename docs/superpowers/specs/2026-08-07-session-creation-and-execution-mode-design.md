# Session-Level Execution Mode + Chat-Screen Session Creation — Design

**Date:** 2026-08-07
**Status:** Approved (Edwin, 2026-08-07)
**Scope:** Move execution mode from the workspace to the session, replace
modal-driven session creation with a chat-screen-first composer, gate the
mode picker by real machine/worker capability (with a new Settings →
Workspace → Containers group for Docker), redefine workspace as
repo + default context (description + links now, attachments later), and
make session creation lazy across every channel (UI, voice, Discord).

## Goal

Yesterday's workspace-creation spec
(`2026-08-06-workspace-creation-and-runtime-design.md`) put execution mode
on the workspace (`Workspace.runtime`). That was the wrong altitude: the
workspace defines *what the project is* (repos, description, links — the
ambient context every session inherits); *how a given working session
executes* is a per-session choice made at creation time. This spec moves
execution mode to the session, makes "new session" an initial chat screen
instead of a modal (name derived from the first prompt, record created
lazily on first send), and surfaces only the execution modes that are
actually available on this machine right now.

## Settled decisions

- **`Workspace.runtime` is deleted, not deprecated.** The field is one day
  old; no migration, no fallback clause. Dispatch resolution returns to
  `manifest.runtime ?? orchConfig.defaultRuntime`. The workspace is
  repo + default context only.
- **Four execution modes, session-level:** `local-in-process`,
  `local-docker`, `remote-in-process`, `remote-docker`. The session's mode
  is stamped onto every task the broker delegates from that session via the
  already-existing per-task `manifest.runtime` override slot — no new
  dispatcher plumbing.
- **Capability-gated picker, invisible not greyed.** `local-in-process` is
  always offered. `local-docker` appears only when Docker is enabled in
  Settings → Workspace → Containers. `remote-in-process` / `remote-docker`
  appear only when a registered worker advertises `tmux` / `docker` in its
  `runtimes` — data workers already send at registration. Gating and
  routing read the same source.
- **Remote routing is by advertisement, not protocol change.** Swarm's
  `RuntimeType` gains `'remote-tmux'` and `'remote-docker'`;
  `WorkerPool.launch` gains a kind filter that picks a worker advertising
  the requested runtime. The worker binary and WS protocol are untouched —
  no version skew with deployed workers. Bare `'remote'` survives as the
  legacy "any worker" alias.
- **Lazy creation everywhere.** The new-session screen is pure composer
  state; the session record is born on the first send. Voice/Discord follow
  the same rule: an inbound utterance with no active session creates one —
  local voice in the **default workspace**, Discord in the **workspace whose
  Discord config is currently attended** (attendance is per-workspace via
  `switchDiscordForWorkspace`, so the arriving message already implies its
  workspace) — `local-in-process`, titled from the utterance. Broker
  `init()` no longer fabricates "Session 1".
- **Naming: truncate now, brain retitles once.** Title at creation = the
  cleaned first ~40 chars of the initial prompt. After the first broker
  reply, one background brain call generates a short title and renames the
  session exactly once.
- **Workspace default context = description + links, injected at session
  start.** `Workspace.links?: string[]` is added; description already
  exists. Both are injected as ambient context into the brain when a
  session is created in that workspace. Attachments are real file-storage
  infrastructure and get their own spec later.
- **A session's mode is immutable.** If its capability disappears later
  (worker gone, Docker disabled), dispatch fails clean with a message
  suggesting a new session. Mode-editing is a recorded follow-up.

## 1. Data model

**Broker** (`broker/src/sessions.ts`):

```ts
export type ExecutionMode =
  | 'local-in-process'
  | 'local-docker'
  | 'remote-in-process'
  | 'remote-docker';

export interface Session {
  id: string;
  title: string;
  workspace: string;
  runtime: ExecutionMode; // absent on legacy persisted records → 'local-in-process'
  createdAt: string;
  updatedAt: string;
  transcript: TranscriptLine[];
  brainHistory: HistoryEntry[];
}
```

`SessionSummary` gains `runtime` too — the Sessions panel displays it, and
the composer derives its default mode from it (most recent session's mode
in the selected workspace, else `local-in-process`).

`SessionManager.create(workspace, opts)` accepts `{runtime, prompt}`;
`POST /sessions` becomes the single atomic entry point:
`{workspace, runtime, prompt}` → create + title-by-truncation + inject
workspace context + run the prompt through the brain. The old bare-create
behavior (no prompt) is removed along with all three of its callers — the
Sessions panel row, `NewWorkspaceModal`'s auto-create step, and broker
`init()`'s "Session 1" fabrication.

**Swarm** (`swarm/src/workspaces.ts`, `swarm/src/types.ts`):

- `Workspace.runtime` deleted; `Workspace.links?: string[]` added.
- `RuntimeType` = `'tmux' | 'docker' | 'remote' | 'remote-tmux' | 'remote-docker'`.
- Broker maps at the seam: `local-in-process→tmux`, `local-docker→docker`,
  `remote-in-process→remote-tmux`, `remote-docker→remote-docker`.
- `dispatch()`: `manifest.runtime ?? this.orchConfig.defaultRuntime` — the
  workspace clause added on 2026-08-06 is removed.

## 2. Availability + Containers settings

Swarm exposes execution-mode availability, reached by the control plane
through the broker's existing origin-guarded `/work/*` proxy:

- `local-in-process` — always `true`.
- `local-docker` — `true` iff the Containers toggle is ON. The toggle is a
  machine-level swarm setting (same tier as CLI tool registry state; it is
  not a secret and not per-workspace).
- `remote-in-process` / `remote-docker` — `true` iff ≥1 registered worker's
  advertised `runtimes` includes `tmux` / `docker` respectively.

**Settings → Workspace → Containers** is a new group
(`control-plane/src/organisms/settings/ContainersGroup.tsx`) under the
existing "Workspace" nav heading in `SettingsPanel`. It holds a Docker
enable toggle plus a Verify button (the `verifyWorkspaceDiscord` pattern)
that pings the Docker daemon and reports status inline. The group is
structured as a provider list so future container options (podman, etc.)
are additional rows, not a redesign. Enabling does not require a passing
verify — verify is diagnostic; a dead daemon surfaces at dispatch as a
normal task failure.

## 3. UI — new-session chat screen (composer)

A third `HomePage` state alongside the existing two chat states. No modal.

**Entered from:**
- The Sessions panel's "new session" row (which today fires a bare
  `POST /sessions` immediately — that call is removed).
- `NewWorkspaceModal` completion — replacing today's auto-create-session
  final step; the composer opens scoped to the just-created workspace.
- First run / zero sessions: the app opens directly on the composer.

**Shows:**
- Workspace picker — pre-selected and locked when entered from a workspace
  context (new-workspace completion, "new session" on a filtered panel);
  free choice only when not in a workspace.
- Execution-mode picker — renders only available modes; defaults to the
  workspace's most recent session's mode, else `local-in-process`.
- Ambient context preview — the workspace's description + links, so the
  user sees what the session inherits.
- The prompt composer.

**On send:** one `POST /sessions {workspace, runtime, prompt}`; the UI
flips to the normal chat state streaming the reply. After the first reply,
the brain retitles once and the sessions list updates.

**Backing out** (Esc, picking another session) persists nothing.

`NewWorkspaceModal` loses its execution-mode picker and gains optional
description + links fields. `WorkspaceManagerModal` gains links editing
beside its existing description field.

## 4. Delegation + worker routing

Every task the broker delegates from a session carries the session's mapped
`RuntimeType` as `manifest.runtime`. Tasks dispatched outside any session
keep the server default.

`WorkerPool.launch(sessionName, command, cwd, env, kind?)`: when `kind`
(`'tmux' | 'docker'`) is given, candidate workers are filtered to those
whose advertised `runtimes` include it before the existing selection logic
runs. `createRuntime()` maps `remote-tmux`/`remote-docker` to a
`RemoteRuntime` that passes the corresponding kind; bare `'remote'` passes
none. All other pool operations address sessions by name exactly as today.

## 4b. Zero-session broker state

Removing init()'s auto-create makes "no sessions at all" a legal, durable
broker state that today's code never sees:

- `SessionManager.activeId` may be empty; every session-assuming read path
  (transcript append targets, brain history swap, `GET /sessions` active
  flag) must tolerate it.
- The text-channel hello/session frame gains an explicit
  no-active-session representation (`session: null` alongside the existing
  shape). This is a frame-shape change: **both lockstep parsers update
  together**, same discipline as `RETIRED_SURFACES`.
- At init with zero sessions, Discord attends the **default workspace's**
  Discord config (instead of following a nonexistent active session), so
  the crew stays reachable after a restart; the first inbound message
  lazy-creates a session there, and attendance then follows the active
  session exactly as today.

## 5. Error handling

- **Mode vanishes between render and send** (worker deregistered, Docker
  toggled off): `POST /sessions` re-validates availability → `409` with
  detail. The UI keeps the composer text, refreshes the picker, and asks
  for a re-pick.
- **Docker enabled but daemon down at dispatch:** the task fails through
  the existing failure path with a clear message in the transcript.
- **No matching worker at launch** for a remote kind: clear, named error
  (`no worker advertising docker`) through the same failure path.
- **Legacy persisted sessions** without `runtime` behave as
  `local-in-process` everywhere.

## 6. Testing

- **Broker** (`sessions.test.ts` + brain/channel tests): atomic
  create-with-prompt; truncation titling; retitle-exactly-once; legacy
  fallback; voice lazy-create in default workspace; Discord lazy-create in
  the attended workspace; init() no longer auto-creates; zero-session
  hello frame round-trips through both lockstep parsers; workspace
  description+links injection.
- **Swarm:** dispatch resolution without the workspace clause; pool kind
  filtering (routes to advertising worker; clear error when none);
  `createRuntime` mapping for both new types.
- **Control plane:** composer renders only available modes; default-mode
  derivation; locked vs free workspace picker; back-out persists nothing;
  send → chat-state transition; `NewWorkspaceModal` without mode picker,
  with description/links; `ContainersGroup` toggle + verify.

## Out of scope (recorded)

- Attachments as workspace default context — own spec (storage location,
  size limits, how CLI sessions read them).
- Editing an existing session's execution mode.
- Worker Docker image / resource-limit configuration; worker-side protocol
  changes of any kind.
- Removing the legacy `'remote'` runtime alias.
- Manual session rename UI.
- Warm agent CLI sessions (`swarm/src/agent-sessions.ts`, `smith-warm-*`) —
  untouched by session execution mode; the sessions ≡ active-agents
  invariant and PRD assignment remain their own future spec.
- Additional container providers beyond Docker (the Containers group is
  shaped for them, not populated).
