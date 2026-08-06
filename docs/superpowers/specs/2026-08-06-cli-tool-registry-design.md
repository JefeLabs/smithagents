# CLI Tool Registry (Active Subscriptions) — Design

**Date:** 2026-08-06
**Status:** Approved (Edwin, 2026-08-06)
**Scope:** Register the agent CLI tools (claude, codex, opencode, copilot,
agy) that actually have an active subscription on this machine — the way
channels and integrations are registered today — so only working tools can
be assigned to agents, and agents whose tool goes dark are visibly flagged
and cleanly blocked instead of failing with a raw launch error.

## Goal

Today the `ENGINES` catalog (`swarm/src/personas.ts`) says which CLI tools
*can exist*, but nothing records which ones *you actually have*: installed,
logged in, subscription active. The wizard happily offers all five engines;
the only failure signal is a runtime `ToolLaunchError` when the binary is
missing or crashed. This spec adds the missing "instances" half: a
machine-level registry that detects and verifies each CLI tool, persists
its status, gates the engine picker and agent create/edit, blocks
launch/dispatch for inactive tools with a typed error, and surfaces status
in Settings plus a per-agent badge.

## Settled decisions

- **Auto-detect + verify, not manual declaration.** Swarm probes the
  machine: binary on PATH (generic detection), then a per-tool auth check
  (driver-specific). Detected tools appear pre-listed; a per-tool `enabled`
  toggle lets the user opt a tool *out*. No manual "add a tool" flow.
- **Machine-scoped, not per-user.** CLI auth lives in machine state
  (`~/.claude`, `~/.codex`, …), so the registry is one status file under
  `.smith/`, not `cliSubscriptions[]` on the `User` record. Modeling it as
  per-user connector instances would duplicate a machine fact per user.
- **Gate the existing `engine.cli` field — no new pointer on the agent.**
  The registry constrains what the wizard offers and what agent
  create/edit accepts. `ComposedAgent.engine` stays exactly as it is; no
  `cliSubscriptionId`. One subscription per tool per machine.
- **Block + badge at runtime.** Warm-session launch and task dispatch
  refuse agents whose engine tool is inactive, with a clear typed error;
  the control-plane shows a warning badge on affected agents.
- **Freshness: startup + manual + on-failure. No periodic polling.**
  Probe all tools asynchronously at swarm startup, offer manual refresh in
  Settings, and re-probe a tool automatically when its launch fails — the
  status self-corrects on first failure. Never probe on every launch.
- **Annotate, don't filter.** The catalog keeps returning all engines,
  each annotated with `{active, statusDetail}`. The wizard grays out
  inactive engines with the reason instead of hiding them.
- **Block only confirmed negatives.** `active = detected && enabled &&
  authOk !== false`. A driver that cannot reliably check auth returns
  `'unknown'`, which counts as active — we block on a missing binary or a
  confirmed logged-out state, never on ignorance.
- **`enabled` defaults to `true` on first detection.** Migration-critical:
  existing agents (ignacio on claude, wilkin on codex) keep working the
  moment this ships. The toggle is opt-out, not opt-in.

## 1. Data model

**Status store** (`swarm/src/cli-tools.ts`, new) — one JSON file at
`<swarm cwd>/.smith/cli-tools.json`, untracked, dir 0700 / file 0600,
following `channels.ts`'s storage discipline:

```ts
export interface CliToolStatus {
  detected: boolean;              // binary resolvable on PATH
  authOk: boolean | 'unknown';    // driver auth probe result
  enabled: boolean;               // user toggle; defaults true on first detection
  detail: string;                 // human-readable, e.g. "logged in", "binary not found"
  version?: string;               // tool-reported version when cheaply available
  lastCheckedAt: string;          // ISO timestamp of last probe
}

export interface CliToolsFile {
  version: 1;
  tools: Record<string, CliToolStatus>;   // keyed by ENGINES cli id
}

export function isActive(s: CliToolStatus | undefined): boolean;
// undefined -> false; else s.detected && s.enabled && s.authOk !== false
```

The catalog remains `ENGINES` in `personas.ts` — this module is only the
"what do I actually have" overlay. Adding a tool later (e.g. gemini) is a
new `EngineOption` + a new driver; the registry needs no changes.

`cli-tools.ts` owns: load/save of the status file (corrupt or missing file
regenerates empty and triggers a sweep), the probe orchestrator (generic
PATH detection + driver auth probe per tool, with a hard per-probe timeout
of 10s), the `enabled` toggle, and `isActive`. A probe never throws — any
probe failure lands as `authOk: false` (or `detected: false`) with the
error in `detail`.

## 2. Driver auth probe

`ToolDriver` (`swarm/src/drivers/types.ts`) gains one method:

```ts
/** Check whether this tool is authenticated / subscription-active.
 *  Return 'unknown' when the tool has no reliable status command.
 *  Must resolve within the caller's timeout; never throw. */
verifyAuth(baseCommand: string): Promise<{ ok: boolean | 'unknown'; detail: string }>;
```

- Detection (is the binary on PATH) is **not** the driver's job — the
  orchestrator resolves the first word of the configured
  `agentCommands[cli]` via `command -v` before calling `verifyAuth`.
- Each driver implements the probe with its tool's own status command
  (exact commands are chosen at implementation time per tool; e.g. codex
  has a login-status subcommand). A driver with no reliable check returns
  `{ ok: 'unknown', detail: 'no auth probe for this tool' }` — which is
  treated as active.
- Where the status command cheaply reports a version, the driver includes
  it so the orchestrator can persist `version`.

## 3. Swarm API

Three routes in `swarm/src/server.ts`, next to the connector routes:

- `GET /cli-tools` → `{ tools: [{ cli, label, models, warmSessions, note,
  status: CliToolStatus, active: boolean }] }` — `ENGINES` joined with the
  status file. One payload drives the entire Settings card grid.
- `POST /cli-tools/refresh` (optional `?tool=<cli>`) → runs probes (all
  tools, or one), persists, returns the same shape as `GET /cli-tools`.
- `PUT /cli-tools/:id` body `{ enabled: boolean }` → toggle only. Probe
  fields are never client-writable; unknown `:id` → 404.

No redaction layer: statuses contain no secrets.

`GET /agents/catalog` additionally annotates each engine entry with
`{ active, statusDetail }` (see §5).

## 4. Broker passthrough

Mirror of the connectors passthrough: one new injected dep block in
`TextChannel`'s constructor (`broker/src/text-channel.ts`), origin-
restricted like the credential routes, exposing `GET /cli-tools`,
`POST /cli-tools/refresh`, and `PUT /cli-tools/:id` on 7790; matching
proxy methods in `broker/src/swarm-client.ts`. The broker adds no
semantics — it forwards.

## 5. Gating & enforcement

- **Wizard gating:** `GET /agents/catalog` annotates engines; the
  Add/Edit Agent modal disables inactive engine options and shows
  `statusDetail` as the reason. Nothing is hidden.
- **Create/edit validation:** `POST /agents` rejects (400, with detail)
  when `engine.cli` is inactive. `PUT /agents/:id` rejects only when the
  request *changes* `engine.cli` to an inactive tool — editing other
  fields of an agent whose tool went dark always works.
- **Launch/dispatch blocking:** `agent-sessions.ts` (warm-session launch)
  and `dispatcher.ts` (task spawn) check `isActive` for the agent's
  engine before spawning. Refusal throws
  `ToolLaunchError(cli, 'subscription-inactive: <detail>')` — reusing the
  existing error type so every consumer that already handles launch
  failure handles this for free.
- **Self-correction:** any `ToolLaunchError` (including binary-missing at
  spawn) fires an async targeted re-probe of that tool, so a stale
  "active" flips to inactive after the first real failure without user
  action.

## 6. Control-plane UI

- **Settings group:** new `SettingsGroupId` `"cli-tools"` and `GROUPS`
  entry in `SettingsPanel.tsx`, rendering `CliToolsGroup.tsx`
  (new organism) modeled on `IntegrationsGroup.tsx`: one card per engine
  from `GET /cli-tools` — tool label, status pill (precedence when several
  apply: Not installed → Needs login → Disabled → Active; reality before
  preference), version + last-checked line, `enabled` toggle, per-card
  Refresh, and a Refresh-all button. A `useCliTools`
  hook wraps the three broker routes.
- **Agent badge:** the control-plane fetches `/cli-tools` once (and on
  settings changes) and joins client-side with each roster agent's
  `engine.cli` — the broker roster payload is untouched. `AgentAvatar`
  shows a warning badge when the agent's engine tool is inactive, with
  the status detail on hover.

## 7. Error handling

- Probe subprocess errors, timeouts, and non-zero exits → recorded in
  `detail`, never thrown; the sweep always completes for all tools.
- Corrupt/missing `.smith/cli-tools.json` → regenerate empty + sweep.
- Startup sweep is async: the server binds immediately and serves the
  cached file until fresh results land.
- Blocked launches surface through existing `ToolLaunchError` paths
  (session errors, task failure states) with the
  `subscription-inactive` detail string.

## 8. Testing

Co-located `*.test.ts` (node:test via tsx, matching `connectors.test.ts`
conventions):

- `cli-tools.test.ts` — orchestration with fake drivers (detected/auth
  matrix), persistence round-trip + corrupt-file regeneration,
  `isActive` truth table, `enabled` defaulting on first detection,
  probe timeout handling.
- `server.test.ts` additions — the three routes; POST/PUT agent gating
  (reject inactive on create and on engine change; allow non-engine
  edits); catalog annotation.
- Per-driver `verifyAuth` tests with stubbed exec (ok / logged-out /
  timeout / garbage output).
- `agent-sessions.test.ts` / `dispatcher.test.ts` additions — launch and
  dispatch refuse inactive tools with `subscription-inactive`; re-probe
  fires on launch failure.

## Out of scope

- **Adding gemini (or any new tool).** Needs a full `ToolDriver`; the
  registry is deliberately shaped so that's a separate, additive change.
- **Per-user subscription instances / agent pinning.** Explicitly decided
  against; revisit only if multiple accounts per tool on one machine
  becomes real.
- **Plan/tier detection.** `detail` may echo whatever the tool reports,
  but no structured plan field and no tier-based logic.
- **Periodic background polling.**
- **Hosted-switchboard integration.** Device registration (ECS BYOK
  direction) will eventually want per-device tool status; this file's
  shape is the natural payload for that, but nothing here depends on it.
