# smithagents

Talk to your agent crew like a team, not a chatbot. `smithagents` is a local-first
control plane where a cast of specialist AI agents — a Latino crew out of the
Dominican Republic — meet with you over text and voice, debate with meeting
etiquette, and take on real coding work that runs in git worktrees on your machine.

> Product design and concepts live in [`PRD.md`](./PRD.md).

## Monorepo layout

All TypeScript. Each package owns its build and tests; there is no shared
framework between them — services talk over HTTP/WS.

```
smithagents/            (git root)
  swarm/                orchestrator: agents-as-data, squads, tasks (git worktree +
                        tmux/docker CLI runs), workspaces, meetings, HTTP API :7777
  broker/               conversation coordinator: the meeting brain (Claude Haiku),
                        STT/TTS, etiquette, sessions, text channel :7790
  control-plane/        Tauri 2 + React UI (desktop + iOS from one codebase)
  voice/                voice-provider library (ElevenLabs, local binary, router)
  docs/                 design specs and implementation plans
  PRD.md  README.md
```

**Data over code — the product is configured by dropping files:**

| Path | What it defines |
|---|---|
| `swarm/.smith/agents/*.json` | composed agents: identity, role, `directives` (work prompt), `persona.style` (meeting voice), ElevenLabs `voice.voiceId`. May carry `archived: true` — hidden from the roster and delegation, kept on disk for history. |
| `swarm/.smith/workspaces/*.json` | workspaces → one or more repos (`{name, path, branch}`); delegations route here. May carry `archived: true` for the same soft-removal reason. Managed from the app (create/edit/remove); dropping a file by hand still works. |
| `broker/.smith/roster-state.json` | user-formed squads and roster edits (written by the UI's edit mode) |
| `broker/.smith/sessions/*.json` | sessions: per-conversation transcript + brain memory |

## Architecture

```
   ┌───────────────────────────── your machine ─────────────────────────────┐
   │                                                                        │
   │  control-plane (Tauri/React) ──────── ws/http :7790 ──────┐            │
   │    transcript · PTT mic · per-agent  ─ audio frames (mp3) │            │
   │    voices · roster edit mode · sessions                   ▼            │
   │                                                        broker          │
   │    Deepgram STT ◄── mic PCM        Claude Haiku brain (1 call/turn:    │
   │    ElevenLabs TTS ──► audio        text = speech, tool_use = routing)  │
   │    LiveKit room bridge (meetings)     │ delegate / check_status /      │
   │                                       │ raise_hand                     │
   │                                       ▼  http/ws :7777                 │
   │                                     swarm                              │
   │    tasks → git worktree (per workspace repo) → claude CLI in tmux      │
   │    squads (alpha/beta/gamma) · registry · meetings · events            │
   └────────────────────────────────────────────────────────────────────────┘
```

- **broker** owns the conversation: one Haiku call per turn where streamed text
  *is* speech and tool calls *are* routing decisions. Meeting etiquette is
  enforced in the prompt: every line is speaker-prefixed, only the addressed
  party answers, squads speak through their leader, and non-addressed agents
  raise a ✋ instead of interrupting.
- **swarm** owns execution: a delegated task gets a git worktree cut from the
  target workspace repo (branch `smith/<taskId>`) and a real coding CLI pinned
  to a tmux session, steerable and killable mid-run.
- **control-plane** renders it: live roster (solo agents + squads, iPhone-style
  edit mode with drag-to-form-squads), transcript with per-agent ElevenLabs
  voices, push-to-talk, glowing rings on working agents with click-to-watch
  work views, and workspace-scoped sessions.

## Prerequisites

- Node **≥ 24**, `tmux`, and the `claude` CLI (delegated tasks run it)
- Rust toolchain (for `tauri dev`)
- Optional for voice meetings: `livekit-server` (`--dev` mode is fine)

## Configure

Create a git-ignored `.env` at the repo root:

```bash
ANTHROPIC_API_KEY=sk-ant-...      # the meeting brain (Claude Haiku)
DEEPGRAM_API_KEY=...              # push-to-talk / meeting STT
ELEVENLABS_API_KEY=...            # agent voices (paid plan for library voices;
                                  # premade stand-ins kick in on free tier)
LIVEKIT_URL=ws://127.0.0.1:7880   # voice meetings (livekit-server --dev)
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
SMITH_API_TOKEN=                  # blank = loopback-only dev mode
```

Then register at least one workspace in `swarm/.smith/workspaces/<name>.json`:

```json
{
  "name": "jefelabs",
  "default": true,
  "repos": [{ "name": "smithagents", "path": "/abs/path/to/repo", "branch": "main" }]
}
```

## Run

```bash
# 1. orchestrator (:7777)
cd swarm && npm install && npm run serve

# 2. conversation broker (:7790 text channel; stdin doubles as a dev mic)
cd broker && npm install && npm run serve

# 3. the app (desktop window + vite on :1420)
cd control-plane && npm install && npm run tauri dev
```

Type at the crew, or hold the mic button and talk. Delegate real work
("have Ignacio refactor the composer") and watch the agent's ring glow —
click it to see live output, steer, or cancel.

## Tests

Each package: `npm test` (node:test) and `npm run typecheck`. The UI lints with
`npx biome check src`.

## Ports

| Port | Service |
|---|---|
| 7777 | swarm HTTP API + WS events (7778/udp heartbeat) |
| 7790 | broker text channel: REST + WS transcript/roster/audio + PTT |
| 1420 | control-plane dev server (Tauri window loads it) |
| 7880 | livekit-server (dev) |
