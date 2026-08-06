# New Workspace Creation Flow + Per-Workspace Runtime — Design

**Date:** 2026-08-06
**Status:** Approved (Edwin, 2026-08-06)
**Scope:** Replace the rail's "New session" button with a "New workspace" button
that opens a fast, focused workspace-creation flow (mandatory GitHub connector
per repo, a new "start from a folder" repo-definition mode with native folder
picking and `git init`), and add a per-workspace execution-environment choice
that surfaces swarm's already-built `tmux`/`docker`/`remote` runtime adapters
as a workspace-level setting instead of a server-wide default.

## Goal

Today, `ToolRail`'s only button is a pencil that toggles the Sessions panel
open — actual workspace creation lives inside the heavier `WorkspaceManagerModal`
("manage workspaces…"), and actual session creation lives inside the Sessions
panel itself. Creating a brand-new project workspace is several clicks removed
from the rail, doesn't require a GitHub connector, only supports pointing at
an already-existing repo path, and has no way to say "run this workspace's
tasks in Docker" even though swarm already has a working `DockerRuntime` and
`RemoteRuntime` sitting unused at the workspace level (`createRuntime()`
today only ever sees a per-task override or the server's single
`defaultRuntime`). This spec makes "start a new project" a first-class,
fast rail action, and makes execution mode a workspace property.

## Settled decisions

- **The plus-icon button replaces the pencil, it doesn't sit alongside it.**
  `ToolRail` goes from one button (pencil → toggles Sessions panel) to one
  button (plus → opens `NewWorkspaceModal` directly). Session creation still
  happens automatically as the LAST step of the new flow (create workspace →
  create + activate a session in it → land in chat) — there's no longer a
  rail shortcut to *just* open the Sessions panel to create a session in an
  *existing* workspace without going through workspace creation; instead,
  the currently-active session/workspace name already rendered in
  `HomePage`'s bottom hint (`"{session.title} · {session.workspace}"`)
  becomes clickable and opens the Sessions panel — this is where you switch
  to or create another session in an existing workspace.
- **`NewWorkspaceModal` is a new, separate, lean component — not a mode of
  `WorkspaceManagerModal`.** `WorkspaceManagerModal` remains the fuller
  admin surface (name, description, default flag, Atlassian, per-repo
  GitHub with an *optional* connector, edit/remove), reachable via "manage
  workspaces…" exactly as today. `NewWorkspaceModal` only asks for what a
  fast "start a new project" flow needs: workspace name, one-or-more repos,
  execution mode. Nothing this flow creates is inaccessible afterward —
  `WorkspaceManagerModal` can still edit anything `NewWorkspaceModal` set.
- **GitHub connector is required per repo in this flow, not optional.**
  Every repo added through `NewWorkspaceModal` must have a connector picked
  before the create button enables — a real, deliberate divergence from
  `WorkspaceManagerModal`'s existing soft-fail (`connectorId` stays optional
  there; editing an existing, possibly-pre-connector-registry workspace must
  never suddenly demand a pick it didn't require before). This requirement
  is scoped to the new flow only.
- **Two ways to define a repo, both ending in the same `WorkspaceRepo`
  shape.** *Existing repo*: an absolute path to an already-existing git
  clone (today's behavior). *New folder*: a folder — picked via a native OS
  folder dialog, not a text field — that becomes a fresh git repo if it
  isn't one already. "Adjacent" (repos conventionally living as siblings
  under a common dev directory) is a naming/UX convention only; the app
  doesn't scan for or enforce sibling relationships.
- **Native folder picking, added now, not deferred.** `@tauri-apps/plugin-dialog`
  (JS) + `tauri-plugin-dialog` (Rust), both current-stable `2.7.2`. This
  project's `src-tauri/capabilities/default.json` already exists with only
  `core:default` in its `permissions` array and `tauri.conf.json`'s security
  block has no explicit `capabilities` allowlist (meaning every file under
  `capabilities/` auto-loads) — so wiring this in is one dependency add, one
  `.plugin(tauri_plugin_dialog::init())` registration, and one permission
  string appended to the existing file. No new capability file, no
  `tauri.conf.json` change needed.
- **Execution mode is a real, already-built capability being surfaced, not
  new runtime engineering.** `swarm/src/runtime.ts` already has `TmuxRuntime`,
  `DockerRuntime`, and (via `remote-runtime.ts`) `RemoteRuntime`, unified
  behind `createRuntime(runtime, dockerConfig, workerPool)`. "In process" =
  `tmux`, "Local Docker" = `docker`, "Remote Docker" = `remote` (routes to
  a registered worker machine via the existing `WorkerPool`). This flow only
  picks *which* adapter a workspace's tasks use — it does not configure
  Docker images, resource limits, or worker-pool registration; those stay
  server-level operational config untouched by this feature.
- **Optional field, safe default, no migration.** `Workspace.runtime` is
  optional; an unset value falls back to `server.orchConfig.defaultRuntime`
  exactly as today — every workspace that predates this feature keeps
  working identically, with no data migration required.

## 1. Data model

`swarm/src/workspaces.ts`:

```ts
export interface Workspace {
  name: string;
  description?: string;
  repos: WorkspaceRepo[];
  default?: boolean;
  archived?: boolean;
  atlassian?: {
    siteUrl: string;
    jiraProjectKeys?: string[];
    confluenceSpaceKeys?: string[];
    connectorId?: string;
  };
  /** Execution environment for this workspace's tasks. Unset = server's defaultRuntime (today's behavior, unchanged). */
  runtime?: 'tmux' | 'docker' | 'remote';
}
```

`WorkspaceRepo` is unchanged in shape (`{name, path, repository?, branch?,
github?: {owner, repo, connectorId?}}`) — the "new folder" mode produces the
exact same shape once `git init` has run; there is no separate on-disk
representation for a repo created this way versus one that already existed.

## 2. Repo initialization

`swarm/src/server.ts`'s `POST /workspaces` route accepts, per repo, an
optional `initGit: boolean`. When true and the submitted `path` is not
already a git repo (checked with the existing `isGitRepo` helper from
`workspaces.ts`), the route runs `git init` on it (`execFile('git', ['init'],
{cwd: path})`, mirroring the exact pattern already used throughout this
codebase's own tests) *before* `workspaceProblems`'s existing
`isGitRepo`-based validation runs — today that validation unconditionally
rejects a non-repo path; this flag is the one case where the route creates
the repo instead of rejecting the path. `initGit` is never persisted on the
`WorkspaceRepo` record itself — it's a one-time creation instruction, not a
workspace property.

## 3. Execution mode resolution

`swarm/src/dispatcher.ts`'s `dispatch()` currently resolves runtime type as
`manifest.runtime ?? this.orchConfig.defaultRuntime` (server-wide default,
optionally overridden per task). This becomes: `manifest.runtime ??
workspace.runtime ?? this.orchConfig.defaultRuntime` — the per-task override
(if a caller explicitly names one) still wins, then the task's resolved
workspace's own `runtime`, then the server default. The workspace is already
resolved earlier in `dispatch()`'s existing repo-path-matching logic (the
same lookup `resolveConnections()` already performs) — no new workspace
lookup is introduced, just one more field read off the workspace already in
hand.

## 4. UI — `NewWorkspaceModal`

New component, `control-plane/src/organisms/NewWorkspaceModal.tsx`. Fields:

- **Workspace name** (required, same slug rules as today's `POST /workspaces`).
- **Repos** (one or more, "+ add another"):
  - A toggle: "Existing repo" / "New folder".
  - *Existing repo*: absolute-path text input (unchanged from today's pattern).
  - *New folder*: a "Browse…" button opening `open({directory: true})` from
    `@tauri-apps/plugin-dialog`; the returned path (or `null` on cancel)
    fills the same path field the existing-repo mode uses — both modes
    converge on one path value, only the *source* of that value differs.
  - `owner`/`repo` text inputs (unchanged).
  - A connector-picker `<select>` (Task 14's existing pattern, reused
    verbatim), **required** — filtered to `vendorId === 'github'`, sourced
    from `listMyConnectors()`. The row's own remove button aside, this
    select has no "— none picked —" empty option; the create button stays
    disabled while any repo row's connector is unpicked.
- **Execution mode**: a 3-option control (In process / Local Docker / Remote
  Docker), defaulting to whatever the currently-active workspace's own
  `runtime` is set to, or "In process" if none — not hardcoded to always
  default to "In process" regardless of context.
- **Create** — on success: creates the workspace (`POST /workspaces`,
  `runtime` + each repo's `initGit` flag included), then immediately calls
  the existing session-creation flow for the new workspace, then closes.

## 5. `ToolRail` / `HomePage` wiring

`ToolRail.tsx`'s single `TOOLS` entry changes from `{icon: PenLine, label:
"New session"}` to `{icon: Plus, label: "New workspace"}`; its `onClick`
callback opens `NewWorkspaceModal` instead of toggling the Sessions panel.
`HomePage.tsx`'s bottom `hint` — currently plain text
(`{session.title} · {session.workspace} — agents raise ✋...`) — wraps the
`"{title} · {workspace}"` portion in a button that opens the Sessions panel,
replacing the rail's lost direct-open affordance.

## Out of scope (recorded)

- Configuring Docker images, resource limits, or registering/managing
  remote workers — this flow only *picks among* already-configured runtimes,
  it doesn't configure them.
- Editing an existing workspace's `runtime` or converting an
  existing-path repo to a freshly-initialized one via `WorkspaceManagerModal`
  — out of scope for this pass; `WorkspaceManagerModal` gaining a `runtime`
  picker of its own is a natural, small follow-up, not designed here.
- Repo-adjacency scanning, auto-discovery, or validation of any kind — the
  "adjacent" framing is purely descriptive.
- Any change to how `GH_TOKEN`/Atlassian credentials resolve at dispatch
  time — this spec only adds a *new*, required-at-creation-time UI gate on
  top of the already-existing (and already-optional-elsewhere) `connectorId`
  mechanism from the connector registry feature.
