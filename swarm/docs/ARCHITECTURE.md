# Smith Agent Orchestrator

> **`@smith/agent-orchestrator`** — A fire-and-forget AI agent swarm controller that manages 10 named agents running concurrently across local and remote machines.

---

## What It Is

Smith is a **production-grade orchestration layer** for running multiple AI coding agents (Claude Code, Antigravity, Codex) as a persistent workforce. Think of it as a team of 10 developers, each with a name, each working on a separate branch, each reporting back when they're done.

You submit tasks. Smith assigns them to named agents. The agents run in isolated tmux sessions or Docker containers — locally or on remote machines connected via WebSocket. You can see what everyone's doing, steer them mid-task, kill them, and watch their output in real time. When an agent finishes, it either passes (exit 0 → verification) or fails (exit 1 → quarantine for human review). No retries. No ambiguity.

## Core Philosophy

- **Fire-and-forget**: Submit a task, walk away. The orchestrator handles everything.
- **Binary outcomes**: Exit 0 = completed. Exit 1 = failed. That's it. No intermediate states matter to the top level.
- **Named agents**: 10 human names (3 syllables each) for voice control. Say "What's Tobias doing?" or "Kill Natasha" and the system understands.
- **Runtime-agnostic**: The dispatcher doesn't know or care if it's talking to bare-metal tmux, a Docker container, or a machine across the network. Same interface everywhere.

---

## Architecture

```
                    ┌──────────────────────────────────────────────┐
                    │            ORCHESTRATOR SERVER               │
                    │               :7777                          │
                    │                                              │
  smith CLI ───────▶│  REST API (/tasks, /agents, /workers)        │
  Dashboard ───────▶│  WebSocket (/ws) — event stream              │
  Voice ───────────▶│  WebSocket (/workers/connect) — worker pool  │
                    │  UDP Multicast — heartbeat pings              │
                    │                                              │
                    │  ┌────────────┐  ┌───────────┐               │
                    │  │ Dispatcher │  │ WorkerPool│               │
                    │  └─────┬──────┘  └─────┬─────┘               │
                    │        │               │                     │
                    │  ┌─────▼──────────────▼──────┐              │
                    │  │     RuntimeAdapter         │              │
                    │  │  ┌───────┐ ┌──────┐ ┌────┐│              │
                    │  │  │ Tmux  │ │Docker│ │Remote│              │
                    │  │  └───────┘ └──────┘ └────┘│              │
                    │  └───────────────────────────┘              │
                    └──────────────────────────────────────────────┘
                              │               │
               ┌──────────────┘               └──────────────────┐
               ▼                                                 ▼
    ┌─────────────────────┐                        ┌──────────────────────┐
    │   LOCAL EXECUTION   │                        │   REMOTE WORKERS     │
    │                     │                        │                      │
    │  tmux sessions or   │                        │  smith-worker        │
    │  Docker containers  │                        │  connects via WS     │
    │  on this machine    │                        │  runs tasks locally  │
    │                     │                        │  streams output back │
    └─────────────────────┘                        └──────────────────────┘
```

---

## The 10-Agent Workforce

Smith manages a fixed roster of 10 named agents. Every name is 3 syllables and phonetically distinct — designed for voice control.

| Seat | Name | Phonetic | Notes |
|------|------|----------|-------|
| 1 | **Sebastian** | se-BAS-tian | |
| 2 | **Dominic** | DOM-i-nic | |
| 3 | **Nathaniel** | na-THAN-iel | |
| 4 | **Tobias** | to-BI-as | |
| 5 | **Cameron** | CAM-er-on | |
| 6 | **Dominic** | sa-MAN-tha | |
| 7 | **Natasha** | na-TA-sha | |
| 8 | **Camila** | ca-MI-la | |
| 9 | **Olivia** | o-LI-via | |
| 10 | **Vanessa** | va-NES-sa | |

- Names are **assigned on task submission** and **released on completion/kill**
- The name tracks the full lifecycle: branch → tmux session → container → worktree → logs → PR
- All CLI commands accept names: `smith output Tobias`, `smith kill Natasha`, `smith steer Cameron "focus on tests"`
- The `/agents` endpoint and TUI dashboard show all 10 seats permanently — working and idle

---

## Task Lifecycle

```
1. Submit      smith submit --agent claude --prompt "Fix the login bug"
                 │
2. Queue       ✓ Task queued as Tobias (#3 in queue)
                 │
3. Dispatch    Orchestrator dequeues → creates git worktree → injects tools
                 │
4. Launch      RuntimeAdapter.launch() → tmux session "tobias" or Docker container
                 │
5. Running     Agent works autonomously. Output streamed. Can be steered.
                 │
      ┌──────────┴──────────┐
      ▼                     ▼
6a. Exit 0              6b. Exit 1
    Completed               Failed
    → Verification           → Quarantine
    → Auto-PR (if configured) → Human review
      │                     │
7. Cleanup    Tear down session, release name, clean worktree
```

### Exit Codes

| Exit | Meaning | Action |
|------|---------|--------|
| `0` | Completed | Triggers verification pipeline. Creates PR if configured. |
| `1` | Failed | Immediate quarantine. No retries. Human review required. |
| `-9` | Killed | Force-killed via `smith kill`. Treated as failure. |

---

## Server & API

The orchestrator runs as a Fastify HTTP server on port `7777` with WebSocket support and UDP multicast heartbeat.

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/tasks` | Submit a new task |
| `GET` | `/tasks` | List active, queued, and completed tasks |
| `GET` | `/tasks/:id` | Get task status (accepts name or UUID) |
| `DELETE` | `/tasks/:id` | Cancel/kill a task |
| `GET` | `/tasks/:id/output` | Capture live output |
| `POST` | `/tasks/:id/steer` | Send keystrokes to agent |
| `POST` | `/tasks/:id/kill` | Force-kill a running agent |
| `GET` | `/agents` | Show the 10-seat roster |
| `GET` | `/workers` | List connected remote workers |
| `GET` | `/health` | Server health check |
| `GET` | `/quarantine` | List quarantined tasks |

### WebSocket Endpoints

| Path | Purpose |
|------|---------|
| `/ws` | Event stream for dashboard/CLI (task lifecycle events) |
| `/workers/connect` | Remote workers connect here to self-register |

### Task Resolution

All routes that accept a `:taskId` parameter resolve in this order:
1. Direct UUID match
2. Agent name lookup (case-insensitive) — e.g., `Tobias` → `abc123-def456`
3. UUID prefix match — e.g., `abc1` → `abc123-def456`

This means `smith output Tobias`, `smith output abc123`, and `smith output abc1` all work.

---

## CLI (`smith`)

### Task Management

```bash
smith submit --agent claude --prompt "Fix the auth middleware" \
             --runtime docker --location local --priority high

smith list                    # List all tasks
smith status Tobias           # Get status by name
smith cancel Tobias           # Cancel/kill by name
```

### Agent Control

```bash
smith agents                  # Show 10-seat roster (aliases: roster, who)
smith output Tobias           # Live output (aliases: out, log)
smith steer Natasha "focus on the unit tests"  # Send keystrokes (aliases: send)
smith kill Cameron            # Force-kill (aliases: stop)
```

### Monitoring

```bash
smith dashboard               # Live TUI dashboard (aliases: dash, ui)
smith health                  # Server health (aliases: ping)
smith workers                 # List remote workers (aliases: remotes)
smith quarantine              # List quarantined tasks
smith quarantine release <id> # Release from quarantine
```

### Submit Options

| Option | Required | Description |
|--------|----------|-------------|
| `--agent` | Yes | `claude`, `agy`, or `codex` |
| `--prompt` | Yes | Task description |
| `--runtime` | No | `tmux` or `docker` (default: config) |
| `--location` | No | `local`, `docker`, or `remote` (auto-derived) |
| `--priority` | No | `normal` or `high` (default: normal) |
| `--branch` | No | Git branch for context |
| `--files` | No | Comma-separated file paths |

---

## Runtime Adapters

The `RuntimeAdapter` interface is the abstraction that makes location-transparent execution possible. The dispatcher calls the same methods regardless of where the agent runs.

```typescript
interface RuntimeAdapter {
  launch(sessionName: string, command: string, cwd: string): Promise<void>;
  waitFor(sessionName: string): Promise<number>;
  exists(sessionName: string): Promise<boolean>;
  kill(sessionName: string): Promise<void>;
  killPattern(pattern: string): Promise<number>;
  listByPrefix(prefix: string): Promise<string[]>;
  captureOutput(sessionName: string): Promise<string>;
  sendKeys(sessionName: string, keys: string, target?: string): Promise<void>;
}
```

### Three Implementations

| Runtime | Class | What It Does |
|---------|-------|-------------|
| `tmux` | `TmuxRuntime` | Spawns bare-metal tmux sessions on the host. Fastest, no isolation. |
| `docker` | `DockerRuntime` | Runs Docker containers with tmux inside. Full isolation, repo cloned into container. |
| `remote` | `RemoteRuntime` | Wraps the `WorkerPool` — dispatches to remote machines over WebSocket. |

### Location vs Runtime

These are separate dimensions:

| Dimension | What It Answers | Values |
|-----------|----------------|--------|
| **Agent** (`--agent`) | WHO runs it | `claude`, `agy`, `codex` |
| **Runtime** (`--runtime`) | HOW it runs | `tmux`, `docker` |
| **Location** (`--location`) | WHERE it runs | `local`, `docker`, `remote` |

Location auto-derives from runtime when not specified:
- `tmux` → `local`
- `docker` → `docker`
- `remote` → must be set explicitly

---

## Remote Workers (WebSocket Protocol)

Remote machines join the workforce by running `smith-worker`, which connects TO the orchestrator via WebSocket — no port forwarding or static config needed.

### Setup

**On the remote machine:**
```bash
smith-worker \
  --orchestrator ws://192.168.1.10:7777 \
  --secret "my-shared-secret" \
  --capacity 5 \
  --name "gpu-box-01"
```

**On the orchestrator:**
Workers auto-register. No config changes needed. Just run `smith workers` to see who's connected.

### Connection Flow

```
Remote Machine                           Orchestrator (:7777)
     │                                         │
     │──── WS connect /workers/connect ───────▶│
     │                                         │
     │──── { type: "register",                 │
     │       workerId: "worker-a1b2",          │
     │       name: "gpu-box-01",               │
     │       secret: "xxx",                    │
     │       capacity: 5,                      │
     │       agents: ["claude","agy"],         │
     │       runtimes: ["tmux"] } ────────────▶│
     │                                         │
     │◀─── { type: "registered",               │
     │       accepted: true,                   │
     │       message: "Welcome gpu-box-01      │
     │                (5 slots)" } ────────────│
     │                                         │
     │          ═══ connected ═══              │
     │                                         │
     │◀─── { type: "task:dispatch",            │
     │       taskId: "abc123",                 │
     │       sessionName: "tobias",            │
     │       command: "claude --prompt ...",    │
     │       cwd: "/repo" } ───────────────────│
     │                                         │
     │──── { type: "task:accepted" } ─────────▶│
     │                                         │
     │──── { type: "output:chunk",             │
     │       output: "..." } ─────────────────▶│  (every 2s)
     │                                         │
     │──── { type: "heartbeat",                │
     │       activeCount: 3 } ────────────────▶│  (every 10s)
     │                                         │
     │──── { type: "task:completed",           │
     │       exitCode: 0 } ───────────────────▶│
```

### WebSocket Message Protocol

#### Worker → Orchestrator

| Message | When | Key Fields |
|---------|------|------------|
| `register` | On WS connect | `workerId`, `name`, `secret`, `capacity`, `agents`, `runtimes` |
| `task:accepted` | After launch | `taskId`, `sessionName`, `workerId` |
| `task:completed` | Task exits cleanly | `taskId`, `exitCode` |
| `task:failed` | Task exits with error | `taskId`, `exitCode`, `error` |
| `output:chunk` | Every 2 seconds | `taskId`, `output`, `lines` |
| `heartbeat` | Every 10 seconds | `workerId`, `activeCount`, `capacity` |

#### Orchestrator → Worker

| Message | When | Key Fields |
|---------|------|------------|
| `registered` | After `register` | `accepted`, `orchestratorId`, `message` |
| `task:dispatch` | Work available | `taskId`, `sessionName`, `command`, `cwd`, `env` |
| `task:steer` | `smith steer <name>` | `taskId`, `keys`, `target` |
| `task:kill` | `smith kill <name>` | `taskId`, `sessionName` |
| `output:request` | On-demand output | `taskId`, `sessionName` |

### Worker Pool

The `WorkerPool` on the orchestrator side:
- Tracks all connected workers and their capacity
- Routes new tasks to the **least-loaded worker** with available capacity
- Maps sessions to workers for steer/kill/output routing
- Caches output from periodic pushes for instant retrieval
- Auto-cleans up when a worker's WebSocket disconnects

---

## TUI Dashboard

The live terminal dashboard (`smith dashboard`) shows all 10 agent seats permanently, with real-time updates via WebSocket.

```
  ┌────────────────────────────────────────────────────────────────────┐
  │  ⚡ SMITH ORCHESTRATOR    ▲ 4h 23m    ◉ 7/10 agents    ⋮ 2 queued │
  │  Memory: 124MB RSS / 67MB Heap                                     │
  ├────────────────────────────────────────────────────────────────────┤
  │                                                                    │
  │  WORKFORCE (7/10)                                                  │
  │  #  NAME          TOOL     LOC      STATUS      UPTIME   TASK      │
  │  ────────────────────────────────────────────────────────────────── │
  │  1  Sebastian     claude   local    ● running      42s   Fix login │
  │  2  Dominic       agy      docker   ● running    1m23s   Refactor  │
  │  3  Nathaniel     claude   remote   ● running      18s   Add API   │
  │▶ 4  Tobias        claude   local    ● running    3m07s   Update DB │
  │  5  Cameron       -        -        ○ idle                         │
  │  6  Samantha      agy      docker   ● running      55s   Fix CI    │
  │  7  Natasha       claude   remote   ● running    2m41s   Tests     │
  │  8  Camila        -        -        ○ idle                         │
  │  9  Olivia        codex    local    ● running      12s   Optimize  │
  │ 10  Vanessa       -        -        ○ idle                         │
  │                                                                    │
  │  QUEUE (2)                                                         │
  │  ◻ #1  a3f2…  claude                                               │
  │  ◻ #2  b7e1…  agy                                                  │
  │                                                                    │
  │  RECENT (3)                                                        │
  │  ✓ c8d4…  exit 0  127s                                             │
  │  ✗ e2f1…  exit 1  43s                                              │
  │  ✓ f9a3…  exit 0  89s                                              │
  ├────────────────────────────────────────────────────────────────────┤
  │  EVENT LOG                                                         │
  │  18:42:01  task:completed  Tobias exited 0                         │
  │  18:41:55  worker:connected  gpu-box-01 (5 slots)                  │
  │  18:41:30  task:dispatched  Olivia → codex                         │
  └────────────────────────────────────────────────────────────────────┘
  [↑↓] select  [o] output  [s] steer  [k] kill  [r] refresh  [h] help  [q] quit
```

### Dashboard Features

- **10-seat roster** — always visible, working agents in green, idle in dim
- **Location column** — color-coded: `local` (default), `docker` (cyan), `remote` (magenta)
- **Arrow key selection** — navigate agents, press `o` for output, `s` to steer, `k` to kill
- **Live event log** — WebSocket-driven, shows task lifecycle events and worker connections
- **Real-time refresh** — polls API every 2 seconds, WS events update instantly

---

## Project Configuration

Projects define defaults that every task inherits. Auto-detected from the current git repo or loaded from `.smith/project.json`.

```json
{
  "name": "my-project",
  "repository": "git@github.com:org/repo.git",
  "localPath": "/path/to/repo",
  "branching": {
    "baseBranch": "main",
    "branchPattern": "smith/{agent}/{name}",
    "remote": "origin"
  },
  "pullRequest": {
    "autoCreate": true,
    "titlePattern": "[Smith] {prompt}",
    "labels": ["ai-generated"],
    "reviewers": ["edwincruz"],
    "draft": true
  },
  "defaults": {
    "agent": "claude",
    "runtime": "docker",
    "location": "local",
    "priority": "normal"
  }
}
```

### Auto-Detection

When no `.smith/project.json` exists, the orchestrator auto-detects:
- **Repository**: from `git remote get-url origin`
- **Branch**: from `git branch --show-current`
- **Local path**: from `git rev-parse --show-toplevel`

---

## Quarantine

Failed tasks (exit 1) are quarantined — not retried, not discarded. They sit in `.smith/quarantine/` waiting for human review.

```bash
smith quarantine              # List quarantined tasks
smith quarantine release <id> # Release back to queue
```

The quarantine contains:
- The original task manifest
- Agent output/logs
- The git worktree (preserved for inspection)
- Exit code and timestamps

---

## File Inventory

```
packages/agent-orchestrator/src/
├── types.ts            (10KB)  All shared types: TaskManifest, ProjectConfig, etc.
├── runtime.ts          (15KB)  RuntimeAdapter interface + TmuxRuntime + DockerRuntime + factory
├── remote-types.ts      (4KB)  WebSocket message protocol (all WS message types)
├── remote-runtime.ts   (10KB)  WorkerPool + RemoteRuntime (RuntimeAdapter over WS)
├── worker.ts           (15KB)  SmithWorker — runs on remote machines, connects via WS
├── worker-cli.ts        (1KB)  smith-worker bin entry point
├── dispatcher.ts       (13KB)  Fire-and-forget dispatcher (worktree, launch, teardown)
├── server.ts           (29KB)  Fastify server: REST + WS + UDP + queue worker + worker pool
├── cli.ts              (15KB)  smith CLI: submit, list, agents, output, steer, kill, workers
├── dashboard.ts        (18KB)  Live TUI dashboard with 10-seat roster
├── names.ts             (5KB)  AgentNamePool with 10 voice-friendly names
├── project.ts           (9KB)  ProjectConfig loading, detection, manifest resolution
├── config.ts            (2KB)  OrchestratorConfig loader
├── quarantine.ts        (5KB)  QuarantineManager for failed tasks
└── index.ts             (1KB)  Barrel exports
```

**Total: 15 files, ~152KB of TypeScript**

---

## Hardware Requirements

Designed for a machine with:
- **96GB RAM** — ~9.6GB per agent slot
- **8TB Disk** — ample room for worktrees, Docker images, logs
- **10 concurrent agents** — the named roster matches `maxConcurrent`

Remote workers extend capacity by offloading to other machines.

---

## Quick Start

```bash
# Start the orchestrator
pnpm serve

# In another terminal, submit work
smith submit --agent claude --prompt "Fix the login E2E test"
# ✓ Task queued as Tobias
#   ID:       abc123-def456
#   Agent:    Tobias
#   Position: #1

# Watch the roster
smith agents

# See what Tobias is doing
smith output Tobias

# Steer mid-task
smith steer Tobias "also add a unit test for the edge case"

# Open the dashboard
smith dashboard

# Add a remote worker
# (on the remote machine)
smith-worker --orchestrator ws://YOUR_IP:7777 --secret "xxx" --capacity 5 --name "gpu-box"

# Check remote workers
smith workers
```

---

## The Squad Agent Architecture

To support massive parallel epics and deep architectural problem-solving, Smith extends beyond single-agent execution by provisioning **Squads**. A Squad is a fixed grouping of up to 4 AI models running concurrently in a single Docker container, orchestrated via `tmux`, and managed by a designated AI Team Leader.

### The 12-Seat Squad Matrix

The global 12-seat capacity is strictly organized into three highly predictable **G-F-O-S** development teams.

| Team | Pane | Name | Model | Phonetic | Role |
|------|------|------|-------|----------|------|
| **Squad Alpha** | `1` | **Gabriel** | Gemini Pro | ga-bri-el | Scrum Master / Leader |
| | `2` | **Fabian** | Claude Fable | fa-bi-an | Architect / Planner |
| | `3` | **Oliver** | Claude Opus | ol-i-ver | Senior Engineer / Core Logic |
| | `4` | **Samantha** | Claude Sonnet | sa-man-tha | Developer / View & Tests |
| | | | | | |
| **Squad Beta** | `1` | **Gideon** | Gemini Pro | gid-e-on | Scrum Master / Leader |
| | `2` | **Fiona** | Claude Fable | fi-o-na | Architect / Planner |
| | `3` | **Orlando** | Claude Opus | or-lan-do | Senior Engineer / Core Logic |
| | `4` | **Sebastian** | Claude Sonnet | se-bas-tian | Developer / View & Tests |
| | | | | | |
| **Squad Gamma** | `1` | **Genevieve** | Gemini Pro | gen-e-vieve | Scrum Master / Leader |
| | `2` | **Finnegan** | Claude Fable | fin-ne-gan | Architect / Planner |
| | `3` | **Orion** | Claude Opus | o-ri-on | Senior Engineer / Core Logic |
| | `4` | **Savannah** | Claude Sonnet | sa-van-nah | Developer / View & Tests |

### Container Constraints & Dispatching

The Smith Orchestrator enforces strict topological rules when provisioning a Docker container:

* **Solo Mode (1 Agent):** Booted with a single `tmux` pane. The agent reports directly to the orchestrator.
* **Squad Mode (2–4 Agents):** Any task requiring 2 or more agents **must** include a Gemini Team Leader (Gabriel, Gideon, or Genevieve). The orchestrator submits the prompt *only* to the Team Leader, who then assumes full control of the container.

### Human-in-the-Loop (`HITL`) Council

When deep architectural decisions are required, the swarm supports a 5-pane interactive grid, reserving **Pane 0** for the Human Architect (You).

```text
┌─────────────────────────────────────────────────────────────────────┐
│ PANE 0: HUMAN ARCHITECT (You)                                       │
│ > smith council join | Interactively steering and approving choices │
├──────────────────────────────────┬──────────────────────────────────┤
│ PANE 1: MODERATOR (Gemini Lead)  │ PANE 2: ARCHITECT (Claude Fable) │
│ > Synthesizes debate & delegates │ > Explores repo & drafts plan    │
├──────────────────────────────────┼──────────────────────────────────┤
│ PANE 3: SENIOR (Claude Opus)     │ PANE 4: DEVELOPER (Claude Sonnet)│
│ > Core logic & backend execution │ > Boilerplate, Biome & Playwright│
└──────────────────────────────────┴──────────────────────────────────┘
```

* **`smith council join <squad>`**: Drops you directly into Pane 0 of the active container.
* **`smith council overrule --option B`**: Forces the Team Leader to abandon its current consensus and execute your directive.

### Inter-Agent Communication

Once the Docker container boots, the Smith Orchestrator steps back. The Gemini Team Leader delegates to the other models entirely via **programmatic terminal execution** and **timestamped JSON contracts**.

#### 1. Tmux Send-Keys

The Team Leader issues commands to its sub-agents using `tmux send-keys`. This natively supports the interactive prompts of underlying CLIs (like `claude-code`) without requiring headless API wrappers.

* The leader uses literal mode (`-l`) to inject prompts safely.
* Complex architectural plans are passed by writing to disk or utilizing `tmux load-buffer`.

#### 2. The JSON Output Contract

To avoid brittle regex parsing of console output, every sub-agent must output a structured JSON file upon completing its delegated task.

These files are written directly into the working directory using a strict timestamp-agent convention:
`YYYY-MMDD-HH:MM.<agent-name>.json` (e.g., `2026-0724-21:30.samantha.json`)

The Team Leader polls the directory for this file to know when the sub-agent is finished.

**Standard Output Schema:**

```json
{
  "agent": "Samantha",
  "role": "Developer",
  "status": "SUCCESS",
  "exitCode": 0,
  "summary": "Generated Playwright E2E tests for the new component.",
  "changes": {
    "modifiedFiles": [],
    "createdFiles": ["tests/e2e/component.spec.ts"]
  },
  "verification": {
    "command": "pnpm playwright test",
    "passed": true,
    "details": "2/2 tests passed in 4.1s"
  },
  "error": null
}
```

#### 3. Failure & Recovery Loop

If an agent fails (e.g., a Biome.js linting error or Playwright test failure), it writes the error trace to the JSON file with `"status": "FAILED"` and `"exitCode": 1`.

* The Gemini Leader reads the JSON payload.
* The Leader can autonomously decide to issue a correction via `tmux send-keys` for a retry.
* If the task is unrecoverable, the Gemini Leader triggers a container-level `exit 1`.
* The Orchestrator intercepts the `exit 1`, tears down the container, and moves the entire worktree — complete with the timestamped JSON files outlining the swarm's decision history — into `.smith/quarantine/` for human review.

### Squad CLI

```bash
# Submit to a squad (auto-assigns next available)
smith squad submit --prompt "Build the new dashboard feature"

# Submit to a specific squad in council mode
smith squad submit --prompt "Redesign the auth system" --squad alpha --mode council

# See all 3 squads
smith squad list

# Check on a squad by leader name
smith squad status Gabriel

# View output from all panes
smith squad output alpha

# Steer a specific pane
smith squad steer alpha "focus on the database migration" --pane 3

# Kill a squad
smith squad kill beta

# Join as human architect (council mode)
smith council join alpha

# Override the leader's decision
smith council overrule alpha "Use option B — the event-driven approach"
```

