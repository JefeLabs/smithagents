---
name: using-agent-orchestrator
description: >
  Use when dispatching coding tasks to claude, agy, or codex agents, managing
  running agents, checking agent output, steering agents mid-task, or killing
  stuck agents.
---

# Using the Agent Orchestrator

## Overview

The `smith` CLI dispatches coding tasks to AI agents (`claude`, `agy`, `codex`) via a Fastify server on **port 7777**. Tasks run in `tmux` (bare-metal) or `docker` (containerized) runtimes with a max of **11 concurrent tasks at 8 GB each**. The dispatcher is fire-and-forget: exit 0 = completed, exit 1 = failed. Failed tasks go to quarantine immediately — there are no retries.

Set `SMITH_SERVER_URL` if the server is not at `http://localhost:7777`.

## Quick Reference

| Action | Command |
|---|---|
| Submit task | `smith submit --agent claude --prompt "..."` |
| Submit (docker) | `smith submit --agent agy --prompt "..." --runtime docker` |
| List tasks | `smith list` / `smith ls` |
| Task status | `smith status <taskId>` |
| Live output | `smith output <taskId>` / `smith out` / `smith log` |
| Steer agent | `smith steer <taskId> "instruction"` |
| Kill task | `smith kill <taskId>` / `smith stop` |
| Cancel task | `smith cancel <taskId>` / `smith rm` |
| Health check | `smith health` / `smith ping` |
| Quarantine list | `smith quarantine` / `smith q` |
| Release quarantine | `smith quarantine release <taskId>` |

## REST API

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/tasks` | Submit a task |
| `GET` | `/tasks` | List all tasks |
| `GET` | `/tasks/:id` | Get task status |
| `DELETE` | `/tasks/:id` | Cancel queued or kill running |
| `GET` | `/tasks/:id/output` | Live tmux capture |
| `POST` | `/tasks/:id/steer` | Send steering input |
| `POST` | `/tasks/:id/kill` | Force kill |
| `GET` | `/health` | Server health |
| `GET` | `/quarantine` | List quarantined tasks |
| `POST` | `/quarantine/:id/release` | Release from quarantine |
| `WS` | `/ws` | Real-time event stream |

## Typical Workflow

1. Check server health: `smith ping`
2. Submit a task: `smith submit --agent claude --prompt "Run the login e2e test"`
3. Monitor output: `smith output <taskId>`
4. Steer if needed: `smith steer <taskId> "skip the flaky assertion"`
5. If stuck, kill it: `smith kill <taskId>`
6. Check quarantine for failures: `smith q`
7. Investigate and release: `smith quarantine release <taskId>`

## Runtime Selection

- **tmux** (default) — bare-metal, uses host toolchain directly.
- **docker** — containerized with Node 24, Java 25, PostgreSQL 16, and Playwright Chromium. Use `--runtime docker` when tasks need an isolated environment or database access.

## Common Mistakes

- **Forgetting `--agent`** — the `submit` command requires `--agent claude`, `--agent agy`, or `--agent codex`.
- **Expecting retries** — there are none. Failed tasks go straight to quarantine. Check `smith q` and fix the root cause before releasing.
- **Ignoring the concurrency cap** — max 11 tasks. Excess submissions queue; they do not fail. Monitor with `smith ls`.
- **Using `kill` vs `cancel`** — `kill` force-terminates a running task. `cancel` removes a queued task or kills a running one. Prefer `cancel` when unsure.
- **Not checking quarantine** — silent failures accumulate. Run `smith q` regularly.
