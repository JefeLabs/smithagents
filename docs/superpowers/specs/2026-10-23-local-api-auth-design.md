# Local API Auth — Design

**Date:** 2026-10-23 · **Status:** approved to plan (Edwin, 2026-10-23: "plan the auth change", questions skipped) · **Plan:** `docs/superpowers/plans/2026-10-23-local-api-auth.md`

## Why

Docker Desktop for Mac delivers a container's connection to `host.docker.internal:<port>` to the
host's **loopback**, and the host sees it arrive from `127.0.0.1`. This was measured on 2026-10-23
while fixing smith-delegate (`8c27fb2`). Both local services trust loopback, and both run with no
credential by default: the repo `.env` sets none of `SMITH_API_TOKEN`, `SMITH_BROKER_AUTH`, or
`SMITH_BROKER_TOKEN`. So any container on the machine, including a docker agent running untrusted
repo code, can drive either API.

- **Swarm (7777):** every route is open. `POST /tasks {"runtime":"tmux"}` launches a **host** agent
  with `--dangerously-skip-permissions`, because `resolveTaskRuntime` takes `requested ?? default`.
  `POST /agent-sessions` launches host agents too.
- **Broker (7790):** open mode, so every route is open. The routes include `POST /sessions` with a
  caller-chosen runtime, `POST /work/delegate`, and `DELETE /workspaces/:name`. The broker's Origin
  check refuses only a *present* disallowed Origin, and a script sends none. The broker holds the
  swarm credential, so locking only the swarm moves the hole one port over.
- **No address filter can fix it.** A container and the host are indistinguishable by source address.

The docker runtime exists to be the sandbox, and today it is not one.

## Goals

1. No route on either service answers without a credential, except a short, named exempt list.
2. The credential that grants full access **never enters an agent session's environment**.
3. A task can still delegate through `smith-delegate`, but only a sub-task in its own workspace and
   repo, on its own runtime, and only while it is running.
4. Edwin's daily flow stays the same: open `http://localhost:1420`. Touch ID is needed about once
   every 30 days.
5. A fresh install is secure with zero configuration.

## Non-goals

- **Host (tmux) agents.** They run as Edwin, so they can read any file he can. They are not a
  sandbox, by design. This design keeps credentials out of their env as hygiene, not as a boundary.
- **The git-mount escape** (see below). It gets a separate companion plan.
- **Fan-out limits.** Delegation *depth* is capped. Breadth (one parent spawning many children) is
  not.
- **Hosted cloud cells.** They already run the broker in required mode. Nothing here changes them.
- **The DELETE/kill session-name mismatch** found during recon: the server targets
  `agentName.toLowerCase()` while the dispatcher names the session `task-<uuid>`. That needs a
  separate fix.

## Anti-goals (a failure even if it "works")

- A login on every restart or every day.
- A secure default that silently breaks delegation, the CLI, or the Copilot/Claude bridges.
- A full-access credential in any session env, container env, or container mount.

## Design

### Credentials

| Credential | Held by | Grants | Lives in |
|---|---|---|---|
| Swarm admin token | broker, `smith` CLI, dashboard | every swarm route | `SMITH_API_TOKEN`, else `~/.smith/api-token` (generated) |
| Delegation token | one task's own session, as `SMITH_DELEGATE_TOKEN` | `POST /tasks` only, scoped to that task | minted at launch; stateless; nothing stored |
| Broker session cookie | Edwin's browser | every broker route | passkey login (existing); 30-day session |
| Broker bridge token | `smith-broker-send/check`, preset scripts | broker routes as `bridge` | `SMITH_BROKER_TOKEN`, else `~/.smith/broker-bridge-token` (generated) |

Generated secrets sit next to the existing `~/.smith/master.key`: 32 random bytes as base64url,
file mode `0600`, dir mode `0700`. `~/.smith` is never mounted into a container; only
`~/.smith/docker-auth` is. Creation is race-safe, because the swarm and the broker may boot at the
same instant: write a temp file, `link()` it into place, and let the loser read the winner's file.

### Swarm

- **Always-on admin auth.** `main()` always resolves a token: env first, else the file. The
  constructor keeps an explicit `apiToken: null` for tests only. Production has no open mode.
- **`?token=` is accepted on `/ws` only.** WebSocket clients can't set headers; every other route
  takes the header only.
- **Delegation token format:** `sdt1.<base64url(JSON claims)>.<base64url(HMAC-SHA256)>`.
  - Claims: `{task, workspace?, repo?, branch?, runtime, depth}`.
  - Key: HKDF-SHA256 of the admin token, info `smith-delegation-v1`. Rotating the admin token
    revokes every delegation token.
- **Acceptance:**
  - The signature must verify.
  - The route must be exactly `POST /tasks`; anything else gets 403.
  - The parent task must be in `activeTasks`; otherwise 401. Tasks are in memory only, so after a
    swarm restart a surviving session's delegation fails closed. Those sessions are already
    orphaned (no commit, no PR, no teardown), so failing closed costs nothing new.
- **Scope:**
  - A body that names a different workspace, repo, or runtime gets **403**, not a silent override.
  - Workspace and repo are filled from the claims. Runtime is the parent's.
  - Metadata is reduced to `source`, which drops `workCardRef` (board-card patching) and
    `composedAgentId`. Location and priority are dropped.
  - The child gets `delegation: {parentTaskId, depth}`.
  - Depth is capped at 3.
- **Sessions:** every session gets `SMITH_DELEGATE_TOKEN`, plus `SMITH_API_TOKEN=""` to override
  anything inherited through the tmux server's environment. `smith-delegate` sends only the
  delegation token.
- **Mount guard:** `DockerRuntime` refuses any mount that would expose a `~/.smith` secret, e.g. a
  `SMITH_DOCKER_CLAUDE_DIR` pointed at `~/.smith` or `$HOME`.

### Broker

- **Required mode is the default.** `SMITH_BROKER_AUTH=open` is the explicit opt-out; it is
  loopback-only, as today, and logs a loud warning.
- **Swarm token and bridge token** come from env, else the `~/.smith` files.
- **First run:** when no passkey is enrolled, the broker mints a 24-hour invite at boot and prints
  `http://localhost:1420/#invite=XXXX-XXXX`. It mints a new one on every boot until someone enrolls.
  This also covers `make reset`, which wipes `broker/.smith/auth.json`.
- **WebSocket:** `/events` closes with 4403 when it sees a present, disallowed `Origin`. Today the
  upgrade has no Origin check, and once the cookie is same-site a page on any other `localhost`
  port would ride it.
- **Login challenges:** pending challenges expire after 5 minutes. Today `/auth/login/options` is
  unauthenticated and its Set only ever grows.

### UI

- **The SPA calls the broker on the page's own hostname** (`localhost:1420` → `localhost:7790`).
  Today it calls `127.0.0.1:7790`. That is cross-site from `localhost`, so the `SameSite=Lax`
  session cookie would never be stored or sent.
- **Passkeys need `localhost`.** An IP address can't be a WebAuthn RP ID, so on `127.0.0.1` the
  login screen says so and links to `localhost`.
- **`AuthGate` always asks `/auth/me`, not only in cloud mode.** Any 401 from `brokerFetch` drops
  to the login screen. The existing 4401 socket path already does, and the page remount reconnects
  the socket.
- **The login screen prefills `#invite=`** from the first-run link and then clears it from the URL.

## Companion: the git-mount escape (separate plan; should land with or before this one)

Found by the same recon:

- `swarm/src/runtime.ts:289-300` mounts the registered repo's real `.git` **read-write** into a
  docker task.
- After the container exits, `swarm/src/dispatcher.ts:617-640` runs `git status`, `git add -A`, and
  `git commit` **on the host** in that worktree, with hooks enabled.

A container can write `.git/hooks/*`, or `core.fsmonitor`/`include.path` in `.git/config`. That
code then runs on Edwin's Mac as Edwin, both in the dispatcher's auto-commit and in Edwin's own
next git command in that repo. From there it can read `~/.smith/api-token`. **The protection in this
design depends on that fix.**

Direction:
- Mount `.git` read-only, with read-write overlays only for `objects/`, `refs/heads/smith/`,
  `logs/refs/heads/smith/`, and `worktrees/<task>/`.
- Run host-side git on a container-touched worktree with `core.hooksPath=/dev/null` and
  `core.fsmonitor=false`.
- Prove it with image contract tests.

## Calls made without asking (check these)

1. Secrets live in `~/.smith/`, next to `master.key`, not in the state root.
2. Delegation tokens are stateless HMAC tokens keyed from the admin token. Liveness is "the parent
   is in `activeTasks`", and fails closed after a restart.
3. A scope mismatch gets 403 rather than a silent override. A missing runtime is filled from the
   claims.
4. Delegated tasks keep only `metadata.source`. Depth is capped at 3.
5. The broker requires login by default; `open` is the opt-out.
6. The first-run invite link is printed to the broker's terminal (tmux `smith-broker`) and lasts
   24 hours.
7. The UI calls the broker on the page's hostname. Tauri keeps `127.0.0.1:7790`, since it is a
   retired surface.
