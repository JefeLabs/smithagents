# Workspace External Connections (Jira, Confluence, GitHub) — Design

**Date:** 2026-08-04
**Status:** Approved (Edwin, 2026-08-04)
**Scope:** Let a Workspace connect to Jira/Confluence (one Atlassian connection) and
a WorkspaceRepo connect to GitHub (per-repo), then let the crew actually use those
connections — both from delegated coding work (swarm) and live in conversation
(broker). Three phases in one spec.

## Goal

A workspace today groups local repos and scopes sessions
(`swarm/.smith/workspaces/*.json`) but has no notion of the external systems that
work in it actually references — Jira tickets, Confluence docs, a GitHub repo's
issues/PRs beyond the local git remote. This spec adds reusable, named connection
records that workspaces/repos reference, then wires them into both the delegated
coding CLI and the meeting brain.

## Settled decisions

- **No new "project" layer.** PRD.md closed that door on 2026-07-26 ("project"
  means workspace); the 2026-07-28 lifecycle spec spent its effort *removing* the
  old separate project layer. This spec extends `Workspace`/`WorkspaceRepo`, it
  does not reopen that decision.
- **One shared token per connection — not per agent, not per human.** A
  Jira/GitHub PAT is inherently tied to one real account; this spec doesn't
  try to avoid that, but it also doesn't provision one per agent persona (no
  functional gain, real operational cost — rotating N tokens per workspace
  per system) or one per human operator (this system is single-operator
  today; if the hosted-switchboard multi-tenant future arrives, each
  subscriber gets their own workspaces, and workspace-scoped connections
  already give each subscriber their own credential for free). At the
  API level, actions land under the connection's one identity; the agent is
  identifiable by content, not login — `dispatcher.ts` already makes this
  same tradeoff for git commits (`-c user.name=${agent} (smith)`, so
  authorship is per-agent in git history) without needing any credential per
  agent. Phase 2/3's ticket comments and PR bodies extend that same
  content-level attribution ("posted by Wilkin via smithagents") rather than
  inventing distinct logins.
- **Connections are their own reusable registry**, referenced by name — not
  embedded inline in a workspace. Mirrors the `device` affinity field already
  planned in the hosted-switchboard design (a workspace field pointing at an
  external registry entry by id). This is what makes "shared across workspaces"
  free: multiple workspaces/repos can name the same connection record.
- **One Atlassian connection, not two.** Jira and Confluence are normally the
  same Atlassian Cloud site and credential, so they're one connection type
  (site + email + API token) with independent optional scopes — Jira project
  key(s), Confluence space key(s) — rather than two parallel connection types.
- **Atlassian connection attaches to the Workspace; GitHub connection attaches
  per-repo.** `WorkspaceRepo` already models repo-level granularity (path,
  branch, remote URL); a workspace's repos can span more than one GitHub
  org/credential, so GitHub connection follows that existing per-repo grain.
  A ticket tracker/doc space, by contrast, naturally spans the whole workspace.
- **Connection records are untracked (gitignored).** Agents and workspaces are
  git-tracked JSON (`swarm/.smith/agents/*.json`, `.../workspaces/*.json`,
  explicit `!` overrides in `.gitignore`) but neither has ever held a secret.
  Connections hold API tokens, so they stay under the existing blanket
  `swarm/.smith/*` ignore rule — no tracking override is added. Same trust
  model this app already applies to `.env` (ANTHROPIC_API_KEY et al.).
- **Three phases, one spec, not three:** connection CRUD/verify (plumbing) →
  swarm-side delegated-work access (the payoff that matters most, since the
  crew already writes code and opens PRs unattended) → broker-side
  conversational lookups (read-only, lower-risk given it's a lightweight
  per-turn model call, not a supervised task).

## 1. Data model

`swarm/.smith/connections/atlassian/*.json` (untracked):

```ts
interface AtlassianConnection {
  name: string;                     // slug, referenced by Workspace
  siteUrl: string;                  // https://your-org.atlassian.net
  email: string;                    // paired with the API token for Basic auth
  apiToken: string;                 // secret
  jiraProjectKeys?: string[];       // scopes lookups/writes; omitted = whole site
  confluenceSpaceKeys?: string[];   // same idea for Confluence
}
```

`swarm/.smith/connections/github/*.json` (untracked):

```ts
interface GithubConnection {
  name: string;    // slug, referenced by WorkspaceRepo
  owner: string;    // org or user
  repo: string;
  token: string;     // secret — PAT or GitHub App installation token
}
```

`Workspace`/`WorkspaceRepo` gain optional name-references (both optional — a
workspace with none behaves exactly as today):

```ts
export interface Workspace {
  // ...existing fields...
  atlassianConnection?: string;   // name of an AtlassianConnection
}

export interface WorkspaceRepo {
  // ...existing fields...
  githubConnection?: string;      // name of a GithubConnection
}
```

**API responses never round-trip the secret.** List/get routes return
`hasToken: true` in place of `apiToken`/`token`; the update route only touches
the stored token when the caller explicitly supplies a new one.

## 2. API, proxy & UI (Phase 1)

Mirrors the shipped `/workspaces` CRUD surface exactly — same layers, same
idioms.

**Swarm (`swarm/src/server.ts`, alongside the existing `/workspaces` block):**
- `POST/PUT/DELETE /connections/atlassian/:name`,
  `POST/PUT/DELETE /connections/github/:name`
- `GET /connections/atlassian`, `GET /connections/github` — list, token-redacted
- `POST /connections/atlassian/:name/verify`,
  `POST /connections/github/:name/verify` — live check (Jira:
  `GET /rest/api/3/myself`; Confluence: space lookup if a space key is set;
  GitHub: `GET /repos/:owner/:repo`). Returns `{ ok, detail }`, same
  readable-400 pattern as `workspaceProblems()`.
- New `swarm/src/connections.ts` (mirrors `workspaces.ts`):
  `loadConnectionsFromDir`, `saveConnection`, `removeConnectionFile`, plus
  `referencedBy(connections, workspaces)` so delete can warn/block while a
  workspace still points at the connection (same spirit as
  `defaultViolation`).

**Broker proxy (`broker/src/swarm-client.ts` + `text-channel.ts`):** identical
passthrough-method pattern as `createWorkspace`/`updateWorkspace` — thin calls
through the existing `http()` helper — plus local `/connections/...` routes on
`text-channel.ts` next to the existing `/workspaces` block, same manual
body-parse + `{error}` → status-code translation.

**Control-plane UI:** extend `WorkspaceManagerModal.tsx`'s form — an
"Atlassian connection" picker (select existing by name, or "+ new" inline)
next to `default`, and a "GitHub connection" picker per repo row next to
`path`/`branch`. "+ new" opens a small `ConnectionForm` (site/owner+repo
fields, token input, a "Test connection" button hitting `verify`) — same
`canSave` client-gate + server-error-surface pattern as the existing form. No
standalone "Manage connections" screen for V1; connections are created/edited
in the context of the workspace/repo that needs them.

## 3. Phase 2 — swarm-side (delegated work)

`dispatcher.ts` has exactly two precedents for getting extra material into a
task today: `driver.materialize()` (writes files into the worktree, e.g.
`CLAUDE.md`) and `PATH`-prepending for `bin/smith-delegate`. There is no
`.mcp.json`/env-var injection mechanism yet, and
`RuntimeAdapter.launch(sessionName, command, cwd)` has no env parameter at
all — this phase adds both.

- **Atlassian → MCP config file.** Claude's `materialize()` gains a second
  write alongside `CLAUDE.md`: an `.mcp.json` scoped to the resolved
  workspace's `atlassianConnection` (site URL + project/space scopes), with
  the credential referenced as `${SMITH_ATLASSIAN_TOKEN}` rather than
  embedded literally.
- **GitHub → env var, no MCP needed.** `gh` (already how `dispatcher.ts`
  creates PRs) honors a `GH_TOKEN` env override. The repo's
  `githubConnection` token is injected as `GH_TOKEN` for that task's process
  — no new tool surface; the agent's existing `gh issue view`/`gh pr comment`
  calls start using the connection's identity instead of the operator's
  personal `gh auth`.
- **New capability: env passthrough on launch.** `RuntimeAdapter.launch()`
  gains an optional `env` param, threaded from `dispatcher.ts` (which
  resolves the task's connections and their secrets) down to the tmux
  session. Secrets exist only as that task's process environment — never
  written to a worktree file.
- **Hard requirement: the `.mcp.json` must never reach the branch.** It lives
  inside the worktree the agent commits from, so `prepareWorktree()` adds it
  to that worktree's local `.git/info/exclude` *before* the agent's first
  commit — not the repo's tracked `.gitignore`, and not left to the agent's
  discretion. Same leak Section 1 avoided for the connection registry,
  reappearing one stage downstream if not closed here too.
- **Deterministic PR↔ticket link.** `delegate`'s tool schema
  (`broker/src/brain.ts`) gains an optional `ticketKey`, filled in when the
  human names one ("Ignacio, implement PROJ-123"). Threaded through the task
  manifest into `dispatcher.ts`'s existing `gh pr create` call as a body
  footer (`Closes PROJ-123`) — guaranteed traceability independent of whether
  the agent itself calls any Atlassian tool. Further ticket interaction
  (comments, status transitions, reading acceptance criteria mid-task) is the
  agent's own discretionary use of the Atlassian MCP tools — same autonomy
  model as its existing commit/push/PR behavior.

## 4. Phase 3 — broker-side (conversational, read-only)

Two additions to the `TOOLS` array in `broker/src/brain.ts`:
`lookup_ticket({ ticketKey })` and `search_docs({ query })`, plus matching
`ToolExecutors` entries and `execute()` branches — same shape as
`delegate`/`check_status`/`raise_hand`. Implementations land in
`broker/src/broker.ts`'s `executors` object, backed by a new
`broker/src/atlassian-client.ts` (direct authenticated REST calls — Jira
`/rest/api/3/issue/:key`, Confluence CQL search — not MCP, since the brain's
tool executors are plain async functions).

**Resolution:** a session is already workspace-scoped, so the executor
resolves session → workspace → `atlassianConnection` → connection record +
secret. No connection configured → a friendly string ("this workspace has no
Jira/Confluence connection configured"), matching the existing convention
that a failing tool always yields brain-visible text rather than throwing.

Read-only for V1: no ticket writes from the meeting loop. A lightweight
per-turn Haiku call taking an unreviewed write action ("Ignacio, close
PROJ-123") is a materially different risk than the same action inside a
supervised, cancellable delegated task (Phase 2) — deferred, not designed
here.

## 5. Testing

- **Registry:** `connections.ts` load/save/remove, token redaction,
  `referencedBy` guard.
- **Routes:** validation 400s, verify-endpoint success/failure paths
  (stubbed HTTP).
- **Broker executors:** `lookup_ticket`/`search_docs` against a stubbed
  Atlassian client (found / not-found / no-connection-configured).
- **Dispatcher:** `.mcp.json` materialization content, worktree-exclude
  write, env passthrough into `launch()`, ticketKey → PR-footer formatting —
  unit-testable without a live tmux/CLI process, same style as
  `buildAgentUpdate`.
- **Manual e2e:** create an Atlassian + GitHub connection, attach to a
  workspace, delegate "implement PROJ-123" → verify the PR body contains the
  ticket link and the agent's `gh`/Atlassian calls used the connection's
  identity; ask the brain about a ticket in conversation with no delegation.

## Out of scope (recorded)

- OAuth flows for Atlassian/GitHub — V1 is API token / PAT only.
- Multiple Atlassian connections per workspace (one at a time).
- Webhook-driven ticket transitions (PR merged → ticket auto-closed) — only
  agent-initiated writes during a Phase 2 task.
- Cloud/ECS secret storage (Secrets Manager) — same `.env`-shaped contract
  philosophy as the hosted-switchboard design, but not designed here since
  this spec assumes `all-local` mode.
- Broker write actions (Section-4 decision: read-only for V1).
- Standalone "Manage connections" screen (Section-2 decision: inline-only
  for V1).
