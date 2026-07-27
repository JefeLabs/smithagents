# agent-node: swarm session hardening + helmsmith bridge

**Date:** 2026-07-26
**Status:** Approved design (pre-implementation)
**Owner:** Edwin Cruz
**History:** Re-scoped from helmsmith's `docs/superpowers/specs/2026-07-26-agent-node-design.md`
(now retired). Originally designed as new helmsmith packages
(`agent-node-server` / `agent-node-broker`); moved here because swarm already
implements the node substrate, and under the factory/fleet model node
behavior belongs to the fleet. Companion (in helmsmith, unchanged):
`2026-07-26-adapter-provider-externalization-design.md`.

## 1. Model

- **helmsmith = the factory:** a queue of work following flows designed per
  task type. Manages agent *calls* — normalized, typed, retryable.
- **smithagents = the fleet:** workers with durable identities doing
  research, planning, and judgment review, solo or in squads. Manages agent
  *workers and sessions*.

Node behavior — tmux sessions, tool drivers, remote workers, profiles —
lives here, in swarm. Helmsmith never learns about tmux; the repos exchange
work orders, escalations, and results. The eventual code bridge is a thin
adapter (§6), not shared node machinery.

## 2. What swarm has today (baseline)

- `RuntimeAdapter` (`swarm/src/runtime.ts`) — launch / waitFor / exists /
  kill / killPattern / listByPrefix / captureOutput / sendKeys — with
  `TmuxRuntime` (bare metal) and `DockerRuntime` implementations. The
  dispatcher is runtime-agnostic; tasks opt into Docker via the manifest.
- Sessions are **task-scoped runs**: the CLI command is wrapped to write its
  exit code and signal a tmux `wait-for` channel; completion = process exit.
- Steering exists (`sendKeys` into claude/agy/codex TUIs mid-run);
  observation is `capture-pane` (the control-plane watch view).
- Work products flow through **git**: every task commits on its
  `smith/<taskId>` branch and opens a draft PR.
- Agents-as-data: `swarm/.smith/agents/*.json` — identity, role,
  `directives` (work prompt), `persona.style`, ElevenLabs `voice.voiceId`.
- Remote workers exist (`remote-runtime.ts`, `smith-worker` bin).

What's kept as-is, deliberately: exit-code task runs for fire-and-forget
work, git commits + draft PRs as the work-product channel, `capture-pane`
for the human watch view.

## 3. Gap 1 — warm conversational sessions

Today a session dies with its task; an agent cannot hold context across
turns or tasks. Add a **persistent session mode** alongside task runs:

- The TUI stays alive; the session is addressed by id across many turns.
- **Turn completion is detected from the tool's persisted session files**
  (the assistant message finalized on disk), never from process exit and
  never from screen state. tmux remains input-only (`send-keys`, bracketed
  paste); `capture-pane` remains a diagnostic/watch surface, not a data path.
- Output becomes a parsed, structured message stream tailed from session
  files — alongside (not replacing) the git work-product channel.
- Cancellation: `send-keys C-c`, escalate to `kill-session` on timeout.
- Session death loses accumulated context; no silent respawn — surfacing the
  death is the caller's signal to decide whether to rebuild.

This is the substrate for session resume (§6) and for agents that
accumulate research/planning context over days.

## 4. Gap 2 — per-tool drivers

Today the launched command is an opaque string and tool differences leak
into call sites. Introduce a driver per CLI tool, each owning five
responsibilities:

1. **Launch** — command, env, cwd; readiness probe (session file appears).
2. **Discover** — locate the tool's persisted session storage.
3. **Parse** — session-file format → normalized messages.
4. **Complete** — detect turn completion from persisted state.
5. **Materialize** — render the agent profile into the tool's native config
   surfaces (§5).

First driver: **claude** (already the primary tool in swarm). Then
**opencode**; then **agy** — whose first task is characterizing its
session-file format; if agy persists nothing usable, agy stays
steering-only (pane-scrape parsing is explicitly out of scope). copilot
after that if wanted.

## 5. Gap 3 — profile hardening

`.smith/agents/*.json` stays the source of truth (data-over-code stands).
Two additions:

- **Materialization:** persona + directives (and skills/context resources,
  when added to the schema) render into the tool's native surfaces in the
  task worktree — instructions file (`CLAUDE.md` / `AGENTS.md`), skills
  directory, tool config — instead of arriving only via the prompt. By the
  time the TUI starts, the agent already is that persona. (The injected
  `smith-delegate` tool already follows this pattern; generalize it, and
  keep such injected artifacts out of task commits as today.)
- **Pinning:** a persistent session pins the content hash of its agent file
  at start. Editing an agent never silently mutates a live session; a
  changed profile means a new session.

`voice.voiceId` and `persona.style` are broker/meeting concerns and are
untouched by materialization (a coding CLI has no use for a TTS voice).

## 6. Gap 4 — the helmsmith bridge (deferred until a flow needs it)

Swarm's HTTP API (:7777) is the stable node protocol. When a helmsmith flow
first needs a fleet worker, helmsmith gets a thin externally-registered
adapter — enabled by its provider-externalization refactor (v0, companion
spec): `AgentSpecRegistry` augmentation, `type: 'agent-node'`, spec
`{ profile, sessionId?, swarmUrl }`, one `invoke()` = one turn of a warm
session, `supportsSessionResume: true`. The adapter is a client of the API
above; swarm code does not move. Until then, the repos integrate through
work orders, escalations (harness approval/resume ↔ broker raise_hand), and
results — documents and events, not code.

## 7. Errors

Persistent-session failures get typed, not stringly: tool binary missing at
launch; session not found / dead on send; turn timeout (cancel path,
aborted); parse failure on a session file (driver bug — fail loud, attach
the offending excerpt). Swarm's existing task-run error handling is
untouched.

## 8. Testing

- **Driver parsers:** fixture session files per tool (the same pattern
  helmsmith's adapter lib uses for its CLI adapters).
- **Runtime/persistent sessions:** real tmux in tests, headless.
- **Turn completion:** fixture-driven — append to a session file, assert
  turn boundary detection.
- **Bridge (later):** helmsmith's conformance suite against a stub swarm API.

## 9. Phasing

- **h1 — warm sessions:** persistent session mode + claude driver
  (tail/parse/complete). Delivers resumable conversational workers.
- **h2 — identity:** materialization + profile pinning; opencode driver.
- **h3 — reach:** agy driver characterization; remote-worker enrollment
  hardening (heartbeat/liveness for `smith-worker`); helmsmith bridge
  adapter when a factory flow first needs a fleet worker (requires
  helmsmith v0 externalization to have landed).
