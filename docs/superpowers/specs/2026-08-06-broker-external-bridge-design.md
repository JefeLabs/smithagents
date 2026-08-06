# Broker External Bridge (Copilot/Claude → Broker) — Design

> **Status:** Approved design, pending implementation plan.
> **Date:** 2026-08-06

## Overview

Let GitHub Copilot and Claude Code (running locally, on the same machine as
the broker) hand a PRD to the broker for delegation to an agent or squad, and
later check whether that delegation finished — without either tool needing to
know swarm exists, and without changing the broker's brain/turn logic.

The broker's text channel (`127.0.0.1:7790`) already accepts exactly this
shape of input — `POST /utterance` is "the textual twin of the mic path," the
same entry point the Tauri app and curl use. Copilot/Claude become one more
loopback client at that same trust tier. The only real gap is **round-trip
correlation**: the brain's completion narration is LLM-authored prose (built
in `broker.ts`'s `onSwarmEvent`, "tell the human in one short sentence"), not
a structured signal, so a caller can't reliably `grep` the transcript to know
when a delegation is done. Swarm already solves this internally
(`GET /tasks/:taskId` → `{taskId, status, result}`); the broker just doesn't
expose it externally yet.

```
Claude Code / Copilot (shell)
        │  smith-broker-send <prd-path> "<instruction>"
        ▼
broker/bin/smith-broker-send.mjs
        │ POST /utterance + WS /events (brief)
        ▼
   Broker :7790  (brain/turn logic unchanged)
        │ [NEW] broadcasts {type:'task-dispatched', taskId, agent, task}
        │        at the exact point broker.ts already binds a delegated task
        ▼
Claude Code / Copilot, later:
        │  smith-broker-check <taskId>
        ▼
broker/bin/smith-broker-check.mjs
        │ GET /tasks/:taskId  [NEW passthrough → SwarmClient.getTask()]
        ▼
   Broker :7790 → swarm's existing GET /tasks/:taskId (swarm unchanged)
```

Everything besides the two broker additions below is a new, standalone
client — same trust tier as the Tauri app, nothing added to swarm, brain
prompt untouched. Scope is local-only: both tools run on the same box as the
broker, so this is loopback HTTP/WS, no tunneling, no auth beyond the
existing bind-address gate. Remote/hosted Copilot or cloud Claude Code
sessions are out of scope (would need the hosted-switchboard's BYOK
device-routing path, not loopback — see that design if it's ever needed).

## 1. Broker-side additions

Two small, additive changes — no brain prompt changes, no swarm changes, no
new persistence.

**a) `task-dispatched` broadcast.** In `broker.ts`, the `delegate` tool
handler already calls `this.deps.directory.bindTask(agent.id, {...})` right
after `submitTask` resolves, with `taskId` and `agent` in scope. Add:

```ts
this.deps.onTaskDispatched?.({ taskId, agent: agent.name, task: input.task });
```

Optional callback, same DI pattern as the existing `onRosterChange` /
`onTurnStart` hooks — nothing breaks if unset, no coupling added to the
brain/turn core. `main.ts` wires it to
`textChannel.broadcast({ type: 'task-dispatched', taskId, agent, task })`.

**b) `GET /tasks/:taskId` passthrough.** New route in `text-channel.ts`
alongside the existing `GET` handlers (`/agents`, `/workspaces`, `/me`, …),
backed by a new one-line `SwarmClient.getTask(taskId)`:

```ts
async getTask(taskId: string): Promise<{ taskId: string; status: string; result?: unknown }> {
  return this.http('GET', `/tasks/${encodeURIComponent(taskId)}`);
}
```

The route relays swarm's existing `GET /tasks/:taskId` JSON verbatim.
Copilot/Claude never learn swarm's port exists — the broker-vs-swarm
boundary (broker is the only client-facing surface, swarm is internal
plumbing) holds.

**c) New `ChannelFrame` variant** in `text-channel.ts`'s discriminated union:

```ts
| { type: 'task-dispatched'; taskId: string; agent: string; task: string }
```

## 2. The bridge

Two Node scripts in `broker/bin/` — same colocation and CLI-not-framework
style as `swarm/bin/smith-delegate` (that script is `sh`+curl; these need
Node because `send` briefly listens on the WebSocket, which plain `sh`+curl
can't do).

**`smith-broker-send.mjs <prd-path> [instruction...]`**

- Builds the utterance text: `"Edwin (via <source>): delegate <prd-path> —
  <instruction>"`. `<source>` comes from `SMITH_BRIDGE_SOURCE`
  (`claude-code` | `copilot`) so one script serves both callers, and the
  transcript always shows which tool originated the line — same
  attribution convention as the existing `"<Name> (via discord-voice):"`
  pattern.
- Opens `WS /events`, then `POST /utterance`, then waits up to a 45s
  timeout for a `task-dispatched` frame.
- **Frame arrives:** prints `{taskId, agent, task}` as JSON to stdout, exits
  0. That JSON is the handle for `smith-broker-check`.
- **Timeout, no dispatch:** prints the brain's actual spoken reply instead
  (e.g. the brain asked a clarifying question, or declined) and exits
  non-zero, so the caller knows no delegation happened and can react —
  ask the human, retry with more detail — instead of polling forever for
  a task that was never created.
- PRD content is **never** inlined into the utterance text — only the file
  path. The delegated agent gets full repo access in its worktree and
  reads the file itself. Keeps the voice-first brain's ~200-char speech
  chunking sane regardless of PRD length.

**`smith-broker-check.mjs <taskId>`**

- Plain `GET /tasks/:taskId` on the broker. Prints `{status, prUrl?,
  summary?}`, mapped from swarm's `active | queued | completed | failed |
  quarantined` outcome.
- Stateless — safe to call any time after dispatch, minutes or hours
  later. No missed-event risk, since it's a status *read*, not a stream
  the caller had to stay subscribed to.

Claude Code and Copilot each drive their own wait/poll loop using their own
background-task primitives — the bridge doesn't run anything long-lived of
its own, and neither tool needs MCP or a daemon for this.

**Deliberately not building an MCP server for v1.** It would be a thin
wrapper around these same two calls; adding one later as a shared shim over
this core is cheap if typed-tool discovery in Copilot/Claude turns out to
matter. YAGNI.

## 3. Correlation & known soft spot

`smith-broker-send` does **not** thread a caller-supplied correlation token
through the brain — the LLM free-forms the `task` field when it calls
`delegate`, so nothing external can be forced into that string reliably.
The rule is: **first `task-dispatched` frame received on the connection
opened for this call, within the 45s timeout.**

For single-human, one-PRD-at-a-time usage this is a non-issue. It would only
misattribute if a *second*, unrelated delegation (from Discord, from the
Tauri app) lands in that same ~45s window — worth documenting, not worth
engineering around for v1.

## 4. Error handling

- **PRD path doesn't exist / unreadable by the delegated agent:** not the
  bridge's problem to catch. The delegated agent's CLI fails fast on
  read; that failure flows through the existing `task:failed` →
  completion-note path like any other delegation failure, and
  `smith-broker-check` reports `status: 'failed'`.
- **Broker not running:** both scripts fail fast on connection refused,
  matching `smith-delegate`'s existing behavior — no retry loop baked in.
- **Brain declines to delegate / asks a clarifying question:** covered by
  `smith-broker-send`'s timeout-without-dispatch path above.
- **Meeting etiquette / addressing:** the tagged instruction is ordinary
  chat text, so it goes through the exact same team-address / squad-address
  rules as anything typed in the Tauri UI — no special-casing needed.

## 5. Testing

**Broker** (colocated `*.test.ts`, existing style):

- `onTaskDispatched` callback fires with the right `{taskId, agent, task}`
  at the point `bindTask` runs; unset callback is a no-op (existing DI
  pattern, same as `onRosterChange` tests).
- `GET /tasks/:taskId` passthrough: maps swarm's response verbatim,
  propagates swarm's 404.
- `SwarmClient.getTask` — request shape, response parsing.

**Bridge scripts:** integration-style tests against a stub broker
(`text-channel.test.ts`-style in-process HTTP+WS server) covering:
`send` happy path (dispatch frame → JSON handle), `send` timeout path
(reply text → non-zero exit), `check` happy/failed/not-found paths.

## Out of scope

- MCP server wrapper (deferred, see §2).
- Remote/hosted Copilot or cloud Claude Code sessions (needs
  [[hosted-switchboard-direction]]-style reachability, not loopback).
- Explicit `--agent`/`--squad` flag on `send` — folded into the free-text
  instruction for v1, routed by the brain's existing addressing logic.
- Caller-supplied correlation tokens threaded through the delegate call.
- Any change to swarm (`GET /tasks/:taskId` already exists and is reused
  as-is).
