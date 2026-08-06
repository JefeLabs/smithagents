# Surface Presence Modes & Eject — Design

> **Status:** Approved design, pending implementation plan.
> **Date:** 2026-07-29

## Overview

Give the operator per-agent, per-surface control over where each agent attends,
from the control-plane. Hovering an agent's avatar opens a popover listing the
agent's surfaces — `tauri`, `discord` (text), `discord-voice` — each with a
three-state mode:

| Mode | Meaning |
|---|---|
| `autojoin` | Agent attends whenever the crew does (today's behavior). |
| `on-request` | Agent attends only after the operator clicks **Join now** in the popover. |
| `disabled` | Agent never attends. Flipping to `disabled` disconnects immediately — **this is the eject action**. There is no separate eject button and no hidden suspended state. |

The control-plane is the single presence authority: nothing inside Discord
(mentions, commands) can summon an agent, and the brain does not join agents on
its own.

## 1. Data model & migration

`channels` in `swarm/.smith/agents/*.json` upgrades from an array to a map:

```json
"channels": { "tauri": "autojoin", "discord": "on-request", "discord-voice": "disabled" }
```

- One shared parser in the broker — `surfaceModes(agent)` — accepts both shapes.
- **Legacy array** (`["tauri", "discord"]`) reads as: listed surface → `autojoin`,
  unlisted → `disabled`. Existing agent files keep today's behavior with zero edits.
- Map form: absent key → `disabled`. Unknown surface keys are preserved verbatim
  on rewrite (forward compatibility).
- The UI writes through the existing `PUT /agents/:id`; the file is rewritten in
  map form. Hand-dropping or hand-editing a file remains first-class
  (data-over-code doctrine).

## 2. Broker enforcement & API

**Voice presence machine untouched.** `VoicePresence` (single-room rule,
human-triggered join/leave) keeps its exact semantics and tests. What changes is
*who moves* when it fires: `join-crew` joins only agents whose `discord-voice`
mode is `autojoin`.

**Per-agent voice operations.** The voice surface gains `joinAgent(id)` and
`leaveAgent(id)` alongside `joinAll`/`leaveAll`. The per-agent connections
already exist (`agentMouths` map, per-agent bot tokens); this exposes them
individually.

**Mode changes take effect immediately.** The broker diffs modes on every agent
`PUT`:

- → `disabled`: the agent disconnects from that surface *now*. Voice drops
  their connection; Discord text stops relaying them; `tauri` removes them from
  the in-app meeting directory.
- `disabled`/`on-request` → `autojoin` while the crew is currently in a voice
  channel: the agent joins now. Autojoin means "be there whenever the crew is."
- → `on-request`: no automatic action; the agent is out until summoned.

**On-request join.** `POST /agents/:id/surfaces/:surface/join`:

- Voice: returns `409` with a clear message if the crew is not currently in a
  voice channel (single-room rule — humans pick the room; the button cannot).
- Text (`discord`) and `tauri`: no room precondition — the agent is admitted
  immediately (starts being relayed on Discord text / added to the in-app
  meeting directory). Returns `409` if the surface isn't available at all
  (e.g. Discord not configured on the broker).
- An admitted on-request agent stays until ejected (mode → `disabled`) or —
  for voice — the crew leaves at zero humans.
- Admissions are runtime state only — deliberately reset on broker restart.
  Configured modes persist in the agent files; admissions do not.

**Presence surfaced.** `GET /agents` gains a per-agent `presence` block (voice
from `connectedAgentIds()`; text/tauri from the adapter filters) so the UI
shows truth, not intent.

## 3. Control-plane UI

New `SurfacePolicyPopover` (molecule), anchored to `AgentAvatar`:

- **Open:** hover on desktop; tap-and-hold on touch (Tauri iOS ships the same
  UI and has no hover). Stays open while the pointer is inside; closes on
  leave / Escape.
- **Rows:** one per surface, reusing the existing `SegmentedControl` atom:

```
Ignacio — surfaces
──────────────────────────────────────
● Tauri app      [autojoin | on request | disabled]
● Discord text   [autojoin | on request | disabled]
○ Discord voice  [autojoin | on request | disabled]  [Join now]
```

- The dot is **live presence** (from the `presence` block), not configured
  mode — an admitted on-request agent shows filled.
- **Join now** renders only when mode is `on-request` and the agent is not
  currently present.
- Mode changes fire `PUT /agents/:id` optimistically.
- If Discord is not configured on the broker (no token), the two Discord rows
  render grayed with a short note instead of pretending to work.

## 4. Error handling

- **PUT fails:** revert the optimistic mode; show the broker's error text
  inline in the row.
- **Join now with no active VC:** the broker's `409` message renders inline
  ("the crew isn't in a voice channel yet — join one on Discord first").
  The button stays enabled for retry.
- **Disconnect races:** `leaveAgent` follows the existing `leaveAll` isolation
  pattern — `VoiceConnection.destroy()` throws on an already-destroyed
  connection, so each teardown is individually guarded. Ejecting one agent
  mid-crash cannot take down the ear or other agents' mouths.
- **Broker restart:** modes persist (agent files); on-request admissions reset.

## 5. Testing

**Broker** (colocated `*.test.ts`, existing style):

- `surfaceModes` parser: legacy array, map form, absent keys, unknown surfaces
  preserved.
- Mode-diff enforcement: `disabled` disconnects exactly one agent; `autojoin`
  flip joins only when a room is active; `on-request` flip is inert.
- Join endpoint: `409` without a room; joins with one.
- Presence reporting in `GET /agents`.
- `VoicePresence` machine untouched → its existing tests stay green (a design
  goal, not an accident).

**Control-plane:** component tests for the popover — rows render from agent
data, mode click produces the right `PUT` payload, **Join now** visibility
rules, grayed rows when Discord is unconfigured.

## Out of scope

- Per-Discord-channel granularity (surfaces only; the allowlists stay env-level).
- Summoning from inside Discord (mentions/commands).
- Brain-driven joins/leaves.
- A separate crew-wide eject action.
