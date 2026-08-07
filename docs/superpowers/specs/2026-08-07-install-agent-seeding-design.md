# Fresh install ships Anderson only; crew state never lives in git

**Date:** 2026-08-07
**Status:** Approved by Edwin (approach A: untrack crew state; UI-composed host circle).

## Problem

A fresh clone/install of the repo ships with Edwin's dev crew baked in:
`swarm/.smith/agents/ignacio.json`, `swarm/.smith/agents/wilkin.json`, and
`swarm/.smith/workspaces/jefelabs.json` are tracked in git, deliberately
re-included by `.gitignore:52-58`. First-run on a new machine therefore shows
agents that user never created.

**Decision:** on install the app has exactly one presence — Anderson, the
broker's host identity (`broker/.smith/identity.json`, which stays tracked
and *is* the shipped artifact). User-created agents are runtime state: they
live only in `swarm/.smith/`, persist across app restarts, and reappear on
re-entry because the swarm reloads them on boot (this already works; the spec
makes it an invariant).

Anderson remains deliberately NOT an agent (`broker/src/identity.ts` — no
engine, never delegatable). His rail presence is presentation only, composed
in the UI from the `identity` field that already rides every roster frame.

## Repo state changes

- `git rm --cached` (files stay on disk):
  - `swarm/.smith/agents/ignacio.json`
  - `swarm/.smith/agents/wilkin.json`
  - `swarm/.smith/workspaces/jefelabs.json`
- Root `.gitignore`: replace lines 52-58 (the `swarm/.smith/*` +
  re-include block) with a plain `swarm/.smith/` ignore. No re-includes for
  agents, workspaces, or squads.
- `broker/.smith` rules are untouched: `identity.json` stays tracked.

## Control-plane changes

- `src/data/agents.ts`: `AgentSeed.kind` gains `"host"`
  (`"agent" | "squad" | "host"`).
- `src/pages/HomePage.tsx`: when `identity` (from `useBrokerChat`) is
  non-null, prepend a host entry to the `agents` array passed to
  `AgentRoster`: `{ id: "host", name, role, ring: identity.ring ?? fallback,
  listening: identity.listening, kind: "host" }`. Identity null (broker down,
  older broker) → no host entry; rail behaves exactly as today.
- `src/organisms/AgentRoster.tsx`: the rail becomes two visual groups:
  - **Host slot** — the `kind === "host"` entry pinned at the top, outside
    the sortable context: no drag handle, never draggable, never a
    squad-combine target; no ✕ remove badge in edit mode; tapping it does
    not open agent edit; excluded from the `smith.rosterOrder` localStorage
    key; still shows live state (the `listening` pulse when Anderson is
    addressed); visually distinct as host (ring from identity, `#8a93a6`).
  - **Crew section** — a small "Crew" label under the host slot, then the
    existing sortable list of agents and squads plus the add (+) button.
    The label and add button are structural — they render even when the crew
    is empty or the host slot is absent (identity null), so a fresh install
    reads: Anderson, then an empty Crew section inviting creation.
    Drag/sort/combine/remove semantics inside Crew are unchanged.

## Persistence on re-entry

Nothing to build. Agents persist as `swarm/.smith/agents/*.json`; the swarm
loads them on boot; the broker's roster frame repopulates the rail on every
app launch. Invariant stated by this spec: **user crew state lives only in
`.smith`, never in git.**

## Error handling

- Broker unreachable / identity absent from frame → no host circle; the
  existing disconnected UX is unchanged.
- Roster order stored before this change (no `host` id) needs no migration —
  the host entry never participates in ordering.

## Testing

- Control-plane vitest:
  - host entry renders first and has no remove/drag/combine affordances;
  - the "Crew" label and add button render below the host, including when
    the crew list is empty;
  - identity null → no host circle (Crew section renders as today);
  - existing `AgentRoster` tests keep passing.
- Full suites for swarm, broker, and control-plane run green after the
  untracking (proves nothing reads the tracked copies; `ignacio`/`wilkin`
  strings in tests are inline fixtures, not file reads).
- Manual smoke: fresh clone into scratchpad → `git ls-files swarm/.smith`
  returns nothing; app boot shows exactly one circle (Anderson) plus the add
  button.
