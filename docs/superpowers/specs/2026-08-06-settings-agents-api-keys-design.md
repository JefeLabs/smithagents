# Settings: Agents Section + API Keys Registry — Design

**Date:** 2026-08-06
**Status:** Draft — design approved in session (Edwin), spec pending review
**Scope:** Group the Settings nav under section headings (App / Agents /
Workspace) and add an API Keys page under the new Agents section: a
machine-level registry of engine/provider API keys (Anthropic, OpenAI,
Google) — stored, redacted, and live-verified the same way CLI tools are.
Nothing consumes the keys yet; the store is the contract the future
api-runtime reads.

## Goal

The CLI tool registry records which subscription CLIs this machine has.
Its sibling is missing: agents that will run as raw API calls (the `api`
engine kind in the api-runtime direction) need provider keys, and today
those keys have no home, no verification, and no UI. This spec adds the
key half: a data-driven provider registry with an untracked, owner-only
store; save/verify/delete routes on the swarm with a broker passthrough;
and a Settings card page mirroring CLI Tools. It also introduces section
headings in the Settings nav so agent-machinery pages (CLI Tools, API
Keys) read as one group.

## Settled decisions

- **Engine/provider keys, not service keys.** This page manages keys that
  let *agents* run via provider APIs (Anthropic, OpenAI, Google). Broker
  service keys (ElevenLabs, Deepgram, LiveKit, Gemini avatars) stay in
  `.env` — different consumers, different lifecycle.
- **Store + verify only in v1.** Keys are saved, verified, and displayed.
  No catalog changes, no wizard changes, no launch-path changes. The
  api-runtime lands later and reads this store; its absence must not
  block shipping the registry.
- **Machine-scoped, one untracked file.** Keys are machine facts like CLI
  auth, so they live in `swarm/.smith/api-keys.json` (0600, dir 0700 —
  exact `saveCliToolsFile` idiom), not on the `User` record and not as
  connector instances. Connectors are per-user workspace integrations;
  engine keys are agent infrastructure.
- **Data-driven provider registry.** `PROVIDERS` in
  `swarm/src/api-keys.ts` drives storage, routes, verification, and the
  UI card grid. Adding a provider is adding an entry — no new routes,
  fields, or redaction logic (same rule as connector vendors and
  personas).
- **Redact everywhere.** No API response ever contains a raw key.
  Listings expose `hasKey`, `last4`, and verify state only. There is no
  "show key" affordance; replacing a key is typing a new one.
- **Block only confirmed negatives.** HTTP 401/403 from the provider →
  `verified: false`. Network failure, timeout, or 5xx → `'unknown'` with
  a human detail — a flaky network never marks a key bad. Same rule the
  CLI registry uses for auth probes.
- **Unknown provider is a 404.** `PUT`/`DELETE`/`verify` on a provider id
  not in the registry fails loudly — deliberately fixing the pattern the
  cli-tools review flagged (`POST /cli-tools/refresh?tool=<unknown>`
  silently 200s).
- **Grouped nav, everything grouped.** Settings nav becomes three labeled
  sections — **App** (General, Themes), **Agents** (CLI Tools, API Keys),
  **Workspace** (Integrations, Channels). Headings are non-interactive
  labels; one idiom, no orphan tabs.

## Data shapes

```ts
// swarm/src/api-keys.ts
export interface ApiProviderDef {
  id: string;           // 'anthropic' | 'openai' | 'google' | …
  label: string;        // 'Anthropic'
  description: string;  // one line under the card title
  verify(key: string, fetchImpl?: typeof fetch): Promise<{ ok: boolean | 'unknown'; detail: string }>;
}

export interface ApiKeyEntry {
  key: string;                      // raw key — file is 0600, never serialized to clients
  verified: boolean | 'unknown';    // last probe result
  detail: string;                   // human-readable, e.g. 'key accepted' / '401 unauthorized'
  lastCheckedAt: string;            // ISO timestamp of last probe
}

export interface ApiKeysFile {
  version: 1;
  providers: Record<string, ApiKeyEntry>;
}

/** Registry entry joined with redacted machine state — drives the whole UI. */
export interface ApiKeyListing {
  id: string;
  label: string;
  description: string;
  hasKey: boolean;
  last4: string | null;             // null when no key
  verified: boolean | 'unknown' | null;  // null when no key
  detail: string | null;
  lastCheckedAt: string | null;
}
```

Loader mirrors `loadCliToolsFile`: corrupt or missing file → empty file
(no throw). Saver mirrors `saveCliToolsFile`: `mkdir` 0700, open 0600.

## Verify probes

Cheapest authenticated GET per provider; the probe validates the
credential, nothing else.

| Provider  | Probe                                                            | Auth |
|-----------|------------------------------------------------------------------|------|
| anthropic | `GET https://api.anthropic.com/v1/models`                        | `x-api-key` + `anthropic-version` headers |
| openai    | `GET https://api.openai.com/v1/models`                           | `Authorization: Bearer` |
| google    | `GET https://generativelanguage.googleapis.com/v1beta/models`    | `?key=` query param |

Mapping: 2xx → `ok: true`; 401/403 → `ok: false` with status detail;
anything else (network error, timeout, 429, 5xx) → `ok: 'unknown'` with
detail. Probes take an injectable `fetchImpl` for tests (same pattern as
connector `verify`). Timeout: 10s via `AbortSignal.timeout`, mirroring
the CLI auth-probe budget.

## Swarm routes (`server.ts`)

- `GET /api-keys` → `{ providers: ApiKeyListing[] }` — registry-driven,
  so providers without keys still appear as cards.
- `PUT /api-keys/:provider` body `{ key: string }` → saves, probes
  immediately, returns the updated listing. Empty/blank key → 400.
- `POST /api-keys/:provider/verify` → re-probes the stored key, returns
  the updated listing. No stored key → 409 with detail.
- `DELETE /api-keys/:provider` → removes the entry, returns `{ ok: true }`.
- Any `:provider` not in `PROVIDERS` → 404 `{ error: 'unknown provider' }`.

## Broker passthrough (7790)

Exact `cliTools` idiom: an `apiKeys` handler object in `broker/src/main.ts`
delegating to new `swarm-client.ts` methods, routed in `text-channel.ts`
(`GET /api-keys`, `PUT /api-keys/:id`, `POST /api-keys/:id/verify`,
`DELETE /api-keys/:id`), origin-restricted the same way as the existing
credentialed routes.

## Control-plane

**Nav sections.** `GROUPS` in `SettingsPanel.tsx` becomes
`SECTIONS: Array<{ heading: string; items: Group[] }>` — App / Agents /
Workspace as settled above. Headings render as small non-interactive
labels (`settings-screen__heading`); the active-tab logic is unchanged.
API Keys uses the `KeyRound` lucide icon.

**`ApiKeysGroup.tsx`** (new, `organisms/settings/`): card grid, one card
per registry provider, same CSS classes as CLI Tools / Integrations — no
new styles beyond the nav heading. Card states by pill:

- `no key` (`--unconnected`) — password input + save.
- `needs valid key` (`--unconnected`) — key stored but probe returned a
  confirmed 401/403; masked `•••• last4` + detail, input to replace,
  verify + remove buttons.
- `unverified` (`--unconnected`) — probe couldn't confirm either way
  (`'unknown'`); same affordances as above.
- `valid` (`--connected`) — masked `•••• last4`, `last checked …` line,
  verify + remove buttons, input to replace.

**`useBrokerChat.ts`**: `listApiKeys`, `saveApiKey(id, key)`,
`verifyApiKey(id)`, `deleteApiKey(id)` — passed through `HomePage.tsx`
into `SettingsPanel` like the CLI tools trio; group renders the
"not wired up yet" hint when absent.

## Error handling

- Store load never throws; corrupt file regenerates empty.
- Probe failures are recorded (`'unknown'` + detail), never thrown.
- Route errors are structured JSON (`{ error }`) with correct status
  codes; UI surfaces them inline (`wizard__error`) like CliToolsGroup.
- Removing a key is immediate and idempotent; deleting an absent entry
  still returns `{ ok: true }`.

## Testing

TDD throughout, mirroring the CLI registry's test layout:

- `swarm/src/api-keys.test.ts` — store round-trip + 0600 mode, corrupt
  file → empty, redaction (listing never contains `key`), last4
  derivation, probe result mapping (2xx / 401 / network error / 5xx via
  stubbed fetch), per-provider probe request shape.
- `swarm/src/server.test.ts` additions — the four routes, 404 unknown
  provider, 400 blank key, 409 verify-without-key, listing includes
  keyless providers.
- `broker/src/text-channel.test.ts` additions — passthrough routes +
  origin restriction (covering the Origin-403 gap the cli-tools review
  left open).
- `control-plane` — `ApiKeysGroup.test.tsx` (pill states, save/verify/
  remove flows, error surface) and `SettingsPanel.test.tsx` additions
  (section headings render, API Keys tab mounts the group, tab order).

## Out of scope (v1)

- No consumer of the keys: engine catalog, agent wizard, and launch path
  are untouched. The api-runtime (one swarm, two engine kinds) reads
  `api-keys.json` when it lands; this file's shape is that contract.
- No broker service keys (ElevenLabs/Deepgram/LiveKit/Gemini stay in
  `.env`).
- No per-key usage metering, no multiple keys per provider, no
  environment-variable fallback reads.
- Hosted-switchboard note: like `cli-tools.json`, this file is a natural
  per-device payload later — nothing here should assume it stays local
  forever, but nothing ships for that now.
