# Workspace External Connections (Jira, Confluence, GitHub) — Design

**Date:** 2026-08-04
**Status:** Approved (Edwin, 2026-08-04)
**Scope:** Let a Workspace point at a Jira/Confluence site and a WorkspaceRepo
point at a GitHub repo, then let the crew actually use those — both from
delegated coding work (swarm) and live in conversation (broker) — always
authenticated as the requesting user, never as a separate agent or workspace
identity. Three phases in one spec.

## Goal

A workspace today groups local repos and scopes sessions
(`swarm/.smith/workspaces/*.json`) but has no notion of the external systems
work in it actually references — Jira tickets, Confluence docs, a GitHub
repo's issues/PRs beyond the local git remote. This spec adds that pointer at
the workspace/repo level, and pairs it at request time with the credential of
whoever is actually asking — so the crew never has more access than the human
they're acting for.

## Settled decisions

- **No new "project" layer.** PRD.md closed that door on 2026-07-26 ("project"
  means workspace); the 2026-07-28 lifecycle spec spent its effort *removing*
  the old separate project layer. This spec extends `Workspace`/
  `WorkspaceRepo`, it does not reopen that decision.
- **Config and credential are different axes, stored separately.** *Where*
  work lives — a Jira site + project key, a Confluence space, a GitHub
  owner/repo — is workspace/repo config: shared, not secret, safe to keep
  alongside the existing `repos[]` shape. *Who's allowed in* is a personal
  credential — a Jira/Confluence API token, a GitHub PAT — and belongs to the
  human making the request, not to the workspace. A workspace-owned "service"
  credential was considered and rejected: it would let the crew act with more
  privilege than the person who typed the request actually has.
- **Agent privilege ceiling = the requesting user's own token.** There is no
  separate agent-level or workspace-level credential anywhere in this design
  — every Jira/Confluence/GitHub action the crew takes runs under the
  resolved user's own PAT. A 403 from the connected resource is expected
  behavior, not a bug to route around: if the user can't do it, the agent
  acting for them can't either. Tool executors (Phases 2/3) surface
  permission errors as plain text ("your Atlassian token doesn't have access
  to that") rather than masking them.
- **"Current user" resolves trivially today.** This system is single-operator
  (`all-local` mode has auth off, loopback-only); there's exactly one
  implicit user. The data model is user-shaped now so nothing has to be
  restructured when real auth lands — same "trivially resolved now, real
  later" move this codebase already made for device affinity in the
  hosted-switchboard design. **User management (add/remove/switch users) is
  out of scope** — Phase 1 exposes the current user's credentials as a single
  `/me` record, not a manageable list.
- **Atlassian config lives on the Workspace; GitHub config lives on the
  repo.** `WorkspaceRepo` already models repo-level granularity (path,
  branch, remote URL); a workspace's repos can span more than one GitHub
  org, so GitHub config follows that existing per-repo grain. A ticket
  tracker/doc space naturally spans the whole workspace instead.
- **Anything holding a credential is untracked (gitignored).** Agents and
  workspaces are git-tracked JSON (explicit `!` overrides in `.gitignore`)
  but neither has ever held a secret. `User` records will, so they stay under
  the existing blanket `swarm/.smith/*` ignore rule — no tracking override
  added. Same trust model this app already applies to `.env`.
- **Three phases, one spec, not three:** config plumbing (Phase 1) → swarm-
  side delegated-work access (Phase 2, the payoff that matters most, since
  the crew already writes code and opens PRs unattended) → broker-side
  conversational lookups (Phase 3, read-only, lower-risk given it's a
  lightweight per-turn model call rather than a supervised task).

## 1. Data model

**`Workspace` gains an inline, non-secret Atlassian pointer:**

```ts
export interface Workspace {
  // ...existing fields...
  atlassian?: {
    siteUrl: string;                  // https://your-org.atlassian.net
    jiraProjectKeys?: string[];       // scopes lookups/writes; omitted = whole site
    confluenceSpaceKeys?: string[];   // same idea for Confluence
  };
}
```

**`WorkspaceRepo` gains an inline, non-secret GitHub pointer** (explicit
`owner`/`repo` rather than parsing the existing informational `repository`
remote-URL string, which keeps its current PR/prompt-display purpose
unchanged):

```ts
export interface WorkspaceRepo {
  // ...existing fields...
  github?: { owner: string; repo: string };
}
```

**New `User` entity** (`swarm/.smith/users/*.json`, untracked — holds
credentials):

```ts
export interface User {
  id: string;
  name: string;
  default?: boolean;   // mirrors Workspace's default-invariant pattern
  atlassian?: { email: string; apiToken: string };  // secret
  github?: { token: string };                        // secret — PAT or App installation token
}
```

**`resolveCurrentUser(users)`** — a pure function returning the `default`-
flagged user, falling back to the sole file present, exactly mirroring how
`resolveRepo` already falls back to `live.find(w => w.default) ?? live[0]`
for workspaces. This is the one seam a real auth system replaces later.

**A connection, at use time, is the pairing of the two:** the resolved
user's `atlassian`/`github` credential + the current workspace's `atlassian`
config or the current repo's `github` config. Nothing stores that pairing —
it's computed fresh per request, so a credential update or a config change
takes effect immediately everywhere.

**API responses never round-trip the secret.** `GET /me` returns
`hasAtlassianToken`/`hasGithubToken` booleans in place of the actual
`apiToken`/`token`; `PUT /me` only touches a credential when the caller
explicitly supplies a new value for it.

## 2. API & UI (Phase 1)

**Swarm (`swarm/src/server.ts`):**
- `PUT /workspaces/:name` already accepts the full workspace body — it now
  also accepts/persists the optional `atlassian` block (validated the same
  way `workspaceProblems()` validates everything else: readable 400s, no new
  route needed).
- Repo rows already round-trip through the same PUT — the optional `github`
  block on each repo rides along.
- `GET /me`, `PUT /me` — the current user's profile + credential
  (redacted per above).
- `POST /me/verify-github` — the one credential-only check that's meaningful
  without extra context (`GET /user`), for a quick "is my PAT valid at all"
  in the account panel.
- **Verifying Atlassian, and verifying GitHub against a specific repo, both
  need config that only a workspace/repo has** (a site URL; an owner/repo),
  so those routes are workspace-scoped, not `/me`-scoped:
  `POST /workspaces/:name/verify-atlassian` (resolves current user's
  credential + this workspace's `atlassian` config, calls Jira
  `GET /rest/api/3/myself`, plus a Confluence space lookup when a space key
  is set) and `POST /workspaces/:name/repos/:repoName/verify-github`
  (resolves current user's token + this repo's `github` config, calls
  `GET /repos/:owner/:repo` — more precise than the account-panel check,
  confirms access to *this* repo specifically). Both return `{ ok, detail }`,
  same shape as other validation responses.
- New `swarm/src/users.ts` (mirrors `workspaces.ts` structurally):
  `loadUsersFromDir`, `saveUser`, `resolveCurrentUser`.

**Broker proxy (`broker/src/swarm-client.ts` + `text-channel.ts`):** thin
passthrough methods (`getMe`, `updateMe`, `verifyAtlassian`, `verifyGithub`)
through the existing `http()` helper, plus local `/me/...` routes on
`text-channel.ts`, same manual body-parse + `{error}` → status-code
translation as the adjacent `/workspaces` block.

**Control-plane UI:**
- `WorkspaceManagerModal.tsx`'s form gains an "Atlassian" fieldset (site URL,
  Jira project key, Confluence space key — no token field, this is shared
  config) with its own "Test connection" button calling
  `verify-atlassian` (meaningful here because this is where the site URL
  lives, paired implicitly with the signed-in user's saved credential).
  Each repo row gains GitHub owner/repo fields alongside `path`/`branch`,
  with its own "Test connection" calling that repo's `verify-github`.
- A new, small **account panel** (not a management screen — there's one
  implicit user) where the operator enters their own Atlassian email+token
  and GitHub PAT. Only the GitHub field gets a "Test connection" button here
  (`POST /me/verify-github` needs no repo context); Atlassian's test lives on
  the workspace form instead, since a token can't be verified without a site
  to call. Lives wherever session/profile-level settings already sit in the
  control-plane nav; out of scope to invent a new nav concept for it.

## 3. Phase 2 — swarm-side (delegated work)

`dispatcher.ts` has exactly two precedents for getting extra material into a
task today: `driver.materialize()` (writes files into the worktree, e.g.
`CLAUDE.md`) and `PATH`-prepending for `bin/smith-delegate`. There is no
`.mcp.json`/env-var injection mechanism yet, and
`RuntimeAdapter.launch(sessionName, command, cwd)` has no env parameter at
all — this phase adds both.

- **Resolution, per task:** `dispatcher.ts` resolves `resolveCurrentUser()`
  and the task's workspace (`atlassian` config) / repo (`github` config),
  then pairs them. Missing config or missing credential both mean "skip
  injection for that system" — the task still runs, just without that
  tool available, same as today.
- **Atlassian → MCP config file.** Claude's `materialize()` gains a second
  write alongside `CLAUDE.md`: an `.mcp.json` built from the workspace's
  `atlassian` config, with the credential referenced as
  `${SMITH_ATLASSIAN_TOKEN}` rather than embedded literally.
- **GitHub → env var, no MCP needed.** `gh` (already how `dispatcher.ts`
  creates PRs) honors a `GH_TOKEN` env override. The current user's GitHub
  token is injected as `GH_TOKEN` for that task's process — no new tool
  surface; the agent's existing `gh issue view`/`gh pr comment` calls start
  using the requesting user's identity instead of whatever `gh auth` happens
  to be active on the host.
- **New capability: env passthrough on launch.** `RuntimeAdapter.launch()`
  gains an optional `env` param, threaded from `dispatcher.ts` down to the
  tmux session. Secrets exist only as that task's process environment —
  never written to a worktree file.
- **Hard requirement: the `.mcp.json` must never reach the branch.** It lives
  inside the worktree the agent commits from, so `prepareWorktree()` adds it
  to that worktree's local `.git/info/exclude` *before* the agent's first
  commit — not the repo's tracked `.gitignore`, and not left to the agent's
  discretion.
- **Deterministic PR↔ticket link.** `delegate`'s tool schema
  (`broker/src/brain.ts`) gains an optional `ticketKey`, filled in when the
  human names one ("Ignacio, implement PROJ-123"). Threaded through the task
  manifest into `dispatcher.ts`'s existing `gh pr create` call as a body
  footer (`Closes PROJ-123`) — guaranteed traceability independent of
  whether the agent itself calls any Atlassian tool. Further ticket
  interaction (comments, status transitions, reading acceptance criteria
  mid-task) is the agent's own discretionary use of the Atlassian MCP tools,
  bounded by the same user's-own-privilege ceiling as everything else here.
- **Git commit authorship stays exactly as it is today** —
  `-c user.name=${agent} (smith)` — unaffected by any of this. It already
  gives per-agent attribution in git history for free, without needing a
  credential; this spec doesn't touch it.

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
resolves session → workspace (`atlassian` config) and pairs it with
`resolveCurrentUser()`'s credential. Two distinct friendly-fallback strings,
not one generic failure: "this workspace has no Jira/Confluence site
configured" vs. "you haven't added your Atlassian token in account
settings" — matching the existing convention that a failing tool always
yields brain-visible text rather than throwing.

Read-only for V1: no ticket writes from the meeting loop. A lightweight
per-turn Haiku call taking an unreviewed write action ("Ignacio, close
PROJ-123") is a materially different risk than the same action inside a
supervised, cancellable delegated task (Phase 2) — deferred, not designed
here.

## 5. Testing

- **Users:** `resolveCurrentUser` default/fallback logic, credential
  redaction on `GET /me`, partial-update semantics on `PUT /me` (updating
  one credential doesn't clear the other).
- **Workspace/repo validation:** `atlassian`/`github` blocks accepted by the
  existing `workspaceProblems()` path, readable 400s.
- **Routes:** verify-endpoint success/failure paths (stubbed HTTP).
- **Broker executors:** `lookup_ticket`/`search_docs` against a stubbed
  Atlassian client, covering all three failure modes (no workspace config /
  no user credential / permission-denied from the API) plus the success
  path.
- **Dispatcher:** resolution of user × workspace/repo config, `.mcp.json`
  materialization content, worktree-exclude write, env passthrough into
  `launch()`, ticketKey → PR-footer formatting — unit-testable without a
  live tmux/CLI process, same style as `buildAgentUpdate`.
- **Manual e2e:** add Atlassian/GitHub credentials to the account panel,
  configure a workspace's Jira site and a repo's GitHub pointer, delegate
  "implement PROJ-123" → verify the PR body contains the ticket link and the
  agent's `gh`/Atlassian calls authenticate as the operator; revoke/blank a
  credential and confirm the task still runs with that tool simply
  unavailable; ask the brain about a ticket in conversation with no
  delegation.

## Out of scope (recorded)

- OAuth flows for Atlassian/GitHub — V1 is API token / PAT only.
- Multi-user management — add/remove/switch users, per-user auth. The data
  model is user-shaped; the product surface is not, yet.
- Webhook-driven ticket transitions (PR merged → ticket auto-closed) — only
  agent-initiated writes during a Phase 2 task.
- Cloud/ECS credential storage (Secrets Manager) — same `.env`-shaped
  contract philosophy as the hosted-switchboard design, but not designed
  here since this spec assumes `all-local` mode.
- Broker write actions (Section-4 decision: read-only for V1).
- Multiple Atlassian sites per workspace, or multiple GitHub identities per
  repo — one of each for V1.
