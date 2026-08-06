# Tauri is not a joinable surface

**Date:** 2026-08-06
**Status:** Approved by Edwin (approach A: hard removal; clean agent files; PRD note).

## Problem

The broker told Edwin "Ignacio is working on your spec" while the AGENTS rail
showed nobody. Delegation reads the swarm registry (every agent, always), but
the tauri roster frame is filtered by `SurfacePolicy.attends(id, 'tauri')`
(`broker/src/main.ts:353`). Both live agents currently carry
`"tauri": "on-request"` in their channel maps, and nothing in the delegation
path records an admission — so working agents are invisible in the app.

**Decision:** the Tauri app is the management console. Every agent —
freestanding or part of a swarm — always appears there. Join/admission
semantics apply to external surfaces (Discord text, Discord voice) only.
Tauri is removed from the surface concept entirely.

## Broker changes

- `broker/src/surface-modes.ts`:
  - `KNOWN_SURFACES = ['discord', 'discord-voice']`.
  - `surfaceModes()` never emits a `tauri` key: a `tauri` entry in a map is
    dropped; a legacy array's `"tauri"` element is skipped; the absent-field
    default stays `{ discord: 'autojoin', 'discord-voice': 'disabled' }`.
- `broker/src/main.ts`:
  - Roster frame (`toRosterEntries`, line ~353): the
    `.filter((p) => policy.attends(p.agent.id, 'tauri'))` is removed —
    `roster.agents` maps through unfiltered, matching squads/freed/groups
    which were never filtered.
  - Presence payload (line ~805): the `tauri:` row is dropped; entries carry
    `discord` and `discord-voice` only.
  - Join endpoint (line ~830): `tauri` is no longer accepted — it falls into
    the unknown-surface 404 branch (`surface !== 'discord'` check loses its
    `&& surface !== 'tauri'` clause).
- Text delivery is untouched: the AdapterHub carries external adapters only
  (Discord); the tauri chat is the broker's native channel and was never
  gated by `attendsPolicy`.

## Control-plane changes

- `control-plane/src/hooks/useSurfacePolicy.ts`:
  - `SURFACES` drops `{ key: "tauri", label: "Tauri app" }` — the popover
    lists Discord text + Discord voice only.
  - The local `surfaceModes` mirror and `KNOWN_SURFACES` drop `tauri` the
    same way as the broker parser; presence typing loses the `tauri` key.
- `control-plane/src/molecules/SurfacePolicyPopover.tsx`:
  - The `grayed` special case (`surface.key !== "tauri" && !discord.configured`)
    simplifies to `!discord.configured`.
  - No other rail changes: full visibility comes from the broker's
    unfiltered roster frame.

## Data + docs

- `swarm/.smith/agents/ignacio.json`, `wilkin.json`: remove the dead
  `"tauri"` key from the channels map; keep
  `{ "discord": "autojoin", "discord-voice": "disabled" }`. Commit the
  settled files (they currently sit uncommitted with `"tauri": "on-request"`
  — the artifact that caused the empty rail).
- `PRD.md`: one-line note in the channels/surfaces area: the Tauri app is
  the management console — every agent always appears there; join/admission
  applies to external surfaces only.

## Behavior after the change

- The AGENTS rail always shows the full crew (freestanding agents, squads,
  freed members, groups) regardless of channel modes.
- The surface popover manages Discord only; "Join now" never targets tauri.
- A `"tauri"` key lingering in any agent file is inert (parsed away), so no
  data migration beyond the two live files is required.
- `SurfacePolicy` admissions still work unchanged for Discord surfaces.

## Testing

- `surface-modes` parser: map with `tauri: 'on-request'` → no `tauri` key in
  output; legacy array `["tauri","discord"]` → discord autojoin only;
  absent → discord autojoin + voice disabled (unchanged).
- Roster: an agent with `discord: 'on-request'` and no admission appears in
  the tauri roster frame.
- Join endpoint: `surface: "tauri"` → 404 unknown surface.
- Popover (`SurfacePolicyPopover.test.tsx`): renders exactly two surface
  rows; both gray out when Discord is unconfigured.

## Out of scope

- Auto-admission of on-request agents to Discord when delegated work.
- Any rail visual redesign (grouping, ghosts, task badges).
