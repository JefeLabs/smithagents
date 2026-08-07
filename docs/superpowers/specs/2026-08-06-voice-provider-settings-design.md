# Voice Provider Settings (BYOK Keys for TTS/STT) — Design

**Date:** 2026-08-06
**Status:** Approved (Edwin, 2026-08-06)
**Scope:** Move the voice API keys (`ELEVENLABS_API_KEY`, `DEEPGRAM_API_KEY`)
out of `.env` and into Settings — ElevenLabs and Deepgram become connector-
registry vendors, a new Settings → Voice group maps each voice capability
(STT, TTS) to a connected key, and voice features degrade gracefully (with a
"set your keys in Settings" pointer on attempted use) instead of the broker
refusing to boot. Local mode / BYOK only.

## Goal

Today the broker reads `DEEPGRAM_API_KEY` (required — boot crash without it,
`broker/src/config.ts`) and `ELEVENLABS_API_KEY` (optional — TTS silently
degrades) from the repo-root `.env`. There is no UI to enter or test these
keys, no way to see why voice is dead, and no seam for choosing a different
provider per capability later. This spec gives voice keys the same treatment
vendor credentials already get in the connector registry — card, secret
redaction, live "Test connection" — plus a Voice settings group that says
*which* connected key powers speech-to-text and which powers text-to-speech,
with both capabilities cleanly off (not crashed) when unset.

## Settled decisions

- **Keys live in the connector registry, not a parallel store.** ElevenLabs
  and Deepgram become ordinary `ConnectorVendorDef` entries in
  `swarm/src/connectors.ts` — storage on `User.connectors`, `hasApiKey`
  redaction, card UI, and verify all come free. The Voice group is a thin
  capability→instance mapping, not a second credentials screen.
- **Structure-only provider choice in v1.** The Voice group has an STT
  picker and a TTS picker, but v1 ships one engine each: STT → Deepgram,
  TTS → ElevenLabs. A `capabilities` tag on the vendor def is what the
  pickers filter by, so future providers (Deepgram Aura TTS, ElevenLabs
  Scribe STT, others) are a registry entry + capability tag + engine — the
  settings surface, routes, and resolver never change shape.
- **Capabilities degrade independently and visibly; attempted use answers
  with a pointer.** No STT → agents can still speak; no TTS → text still
  flows. Voice controls stay visible by default, and *using* one without a
  key produces an explicit "add your key in Settings" message — never a
  silent no-op or a dead control. A Voice setting ("Hide inactive voice
  features") lets the user hide them instead.
- **Hard cut from `.env`.** Once this ships, the broker no longer reads
  `ELEVENLABS_API_KEY`/`DEEPGRAM_API_KEY` at all — no fallback layer, no
  seed-once migration. Settings are the single source of truth from day
  one. Edwin's live rig goes silent on upgrade until the keys are pasted
  into Settings (deliberate; see §6).
- **No broker restart to apply.** The broker resolves voice keys from swarm
  at point of use through a short-TTL resolver — the same no-restart
  property the Discord bot token already has
  (`broker/src/discord-workspace-switcher.ts`).
- **Secrets are encrypted at rest, OS-agnostically — registry-wide.** Once
  a user sets keys they are never written as plaintext. All `secret: true`
  connector fields (voice keys *and* the existing Atlassian/GitHub/DataDog/
  Snyk secrets) are AES-256-GCM encrypted inside `.smith/users/*.json`,
  under a master key resolved without any OS-specific dependency (§3).
  Existing plaintext user files migrate transparently.
- **Keys are masked at entry and never shown again after save.** Password
  inputs while typing; after save+verify, every API response redacts to
  `hasApiKey` and the edit form is blank replace-only (§1).
- **Local mode / BYOK only.** In cloud mode voice would be bundled into the
  subscription — that is out of scope here; §7 names the seam so this
  design doesn't fight it later.

## 1. Two new connector-registry vendors

`ConnectorVendorDef` gains one optional field:

```ts
/** Voice capabilities this vendor's credential can power. Absent = not a voice vendor. */
capabilities?: ('stt' | 'tts')[];
```

New entries in `swarm/src/connectors.ts`:

- **`elevenlabs`** — label "ElevenLabs", description "Text-to-speech — the
  voices agents speak with.", fields:
  `[{ key: 'apiKey', label: 'API key', secret: true }]`,
  `capabilities: ['tts']`.
- **`deepgram`** — label "Deepgram", description "Speech-to-text — how
  agents hear you.", fields:
  `[{ key: 'apiKey', label: 'API key', secret: true }]`,
  `capabilities: ['stt']`.

Both get real verify functions (registry rule: no vendor ships without a
working "Test connection"), mirroring `verify-github.ts`:

- **`verify-elevenlabs.ts`** — `GET https://api.elevenlabs.io/v1/user` with
  header `xi-api-key: <key>`. 200 → `{ ok: true }` with the subscription
  tier in `detail` when present; 401 → invalid key; other statuses and
  network errors → `ok: false` with the reason.
- **`verify-deepgram.ts`** — `GET https://api.deepgram.com/v1/projects`
  with header `Authorization: Token <key>`. 200 → `{ ok: true }` with the
  project count in `detail`; 401 → invalid key; same error handling.

No new UI work for key entry: the Integrations card grid and
`ConnectorFormModal` are registry-driven and pick both vendors up
automatically.

**Masking (inherited, and guaranteed):** the API key field is a password
input — masked as typed — and once saved and verified the key is never
displayed again anywhere: API responses carry only `hasApiKey`, the card
shows connection status, and re-opening the form presents a blank
replace-only field (`ConnectorFormModal` seeds only non-secret fields).
Voice vendors must not weaken this: `/me/voice` and the Voice group deal
strictly in instance ids and labels, never key material.

## 2. Settings → Voice group

New `VoiceGroup` in `control-plane/src/organisms/settings/`, in the left
nav between Integrations and Channels. Contents:

- **Speech-to-text picker** and **Text-to-speech picker.** Each lists the
  user's connected connector instances whose vendor declares that
  capability — rendered "Vendor — instance label" ("Deepgram — personal") —
  plus **Off** (the default). An empty list renders guidance naming the
  capability's vendor: "Connect a Deepgram key in Integrations first"
  (ElevenLabs for the TTS picker).
- **"Hide inactive voice features" toggle** (default off). See §5.

Persistence, on the user record (`swarm/src/users.ts`):

```ts
voice?: {
  stt?: { instanceId: string };
  tts?: { instanceId: string };
  hideInactive?: boolean;
};
```

Routes on swarm (`server.ts`), proxied through the broker's text channel
like every `/me/connectors*` route (`broker/src/text-channel.ts`):

- `GET /me/voice` → `{ stt: { instanceId } | null, tts: { instanceId } | null, hideInactive: boolean }`.
  No secrets in this shape; the UI joins instance ids against
  `GET /me/connectors` for labels.
- `PUT /me/voice` — validates each supplied `instanceId` exists in
  `user.connectors` **and** its vendor declares the capability being
  assigned (STT slot requires a `'stt'` vendor, TTS slot `'tts'`); 400
  otherwise.

**Deletion rule:** `DELETE /me/connectors/:id` clears any `user.voice`
slot referencing that instance — the capability goes inactive. The
control-plane delete confirm says so when the instance is selected
("Deleting this key also turns off text-to-speech.").

## 3. Secure storage — secrets encrypted at rest (registry-wide)

Today `.smith/users/*.json` holds raw secret values, relying on being
untracked + `0600` (`users.ts`: "Raw values, including secrets"). That
posture upgrades for the whole registry, not just the two new vendors — a
voice-only secret store would fork the registry's one-shape design.

- **Cipher:** AES-256-GCM via Node's built-in `crypto` — no native
  dependencies, identical behavior on macOS, Linux, and Windows. Each
  `secret: true` field value is stored as a self-describing string
  (`enc:v1:<iv>:<ciphertext>:<authTag>`, base64 segments); non-secret
  fields stay plaintext, so files remain inspectable.
- **Master key resolution (OS-agnostic by construction):**
  1. `SMITH_MASTER_KEY` env var, if set — the cloud/headless seam (KMS- or
     orchestrator-injected later);
  2. else `~/.smith/master.key`, auto-generated (32 random bytes, `0600`)
     on first swarm boot. Living in the home directory — outside every
     repo checkout and worktree — means a copied, backed-up, or shared
     workspace directory never carries the key alongside the ciphertext.
- **Transparent migration:** on user-file load, any plaintext secret field
  is encrypted and the file rewritten — same pattern as the legacy
  `atlassian`/`github` → `connectors` upgrade already in `users.ts`.
  Decryption happens only at the two places secrets leave storage: verify
  calls and materialization/resolution (env injection, `/me/voice/keys`).
- **Redaction unchanged:** API responses still expose only `has<Key>`
  booleans; encryption is invisible to the control-plane.
- **Threat model, stated honestly:** this protects secrets at rest against
  file-level exposure of `.smith/users/` (backups, copies, accidental
  commits or shares). A local attacker running as the same OS user can
  read `~/.smith/master.key` too — defending that requires per-OS keyring
  integration (macOS Keychain / Windows Credential Manager / libsecret),
  which is a named future hardening behind the same master-key resolution
  step, not part of this spec.
- **Key loss:** if `master.key` is deleted, encrypted fields are
  unrecoverable; affected connectors show as connected-but-failing verify,
  and re-entering the key in Settings heals them. The spec accepts this —
  no key-escrow machinery in local mode.

## 4. Broker resolution — no restart to apply

`BrokerConfig` drops `deepgramApiKey` and `elevenlabsApiKey` entirely; the
broker boots with neither var present. (Other env keys — Anthropic, LiveKit,
Gemini — are unchanged; see §7.)

- **New secret-bearing route:** `GET /me/voice/keys` on swarm,
  loopback-guarded exactly like `/workspaces/:name/channels/discord-token`.
  Returns the *resolved* credentials:
  `{ stt: { vendorId, apiKey } | null, tts: { vendorId, apiKey } | null }`
  — null when the slot is unset, the instance is missing, or the field is
  empty.
- **`VoiceKeyResolver` in the broker** wraps that route with a short TTL
  cache (~20 s). All voice consumers go through it: the Deepgram client is
  constructed per listening session (today it is built once at boot,
  `broker/src/main.ts`), and the `ElevenLabsVoiceProvider` + `VoiceCatalog`
  are constructed lazily against the currently-resolved key and rebuilt
  only when the key changes. Pasting a key in Settings takes effect within
  the TTL — no broker restart.
- **Status surface:** the broker's existing status payload to the
  control-plane gains `voice: { stt: boolean, tts: boolean }` so surfaces
  can render inactive states without probing.

## 5. Inactive behavior — attempted use answers with a pointer

Capabilities degrade independently. Default (toggle off): voice features
stay visible, and *using* one without its key answers with a pointer to
Settings, never a silent failure:

- **Hold-to-talk press with no STT** → inline message: "Add a Deepgram key
  in Settings → Integrations, then select it under Settings → Voice."
- **Agent reply with no TTS** → text flows normally, speech is skipped, and
  the chat shows the equivalent TTS hint **once per session**, not per
  message.
- **Discord voice join** → blocked with that pointer (as a text reply —
  Discord's UI can't be hidden or disabled by us) only when *both*
  capabilities are unset; with one capability present the join proceeds
  and the missing half is hinted (e.g. Anderson speaks but explains he
  can't hear, or hears but replies in text).
- **Voice casting UI** (agent voice pickers backed by `VoiceCatalog`) →
  inactive with the TTS hint when no TTS key is set.

With **"Hide inactive voice features"** on, control-plane voice controls
for inactive capabilities don't render at all; Settings → Voice remains the
one place to turn them back on. The toggle only affects control-plane
surfaces — Discord behavior is unchanged by it.

## 6. Hard cut + docs

- `.env.example`, `README.md`, and `docs/MANUAL-TESTING.md` drop the two
  vars and point at Settings → Integrations + Voice.
- **Live-rig callout:** the running broker (tmux `smith-broker`) loses
  voice on upgrade until both keys are pasted into Integrations and
  selected under Voice. This is the chosen behavior — no env fallback — so
  the upgrade note in MANUAL-TESTING must say it explicitly.

## 7. Non-goals

- **Cloud mode / subscription-bundled voice.** Out of scope. The seam is
  `GET /me/voice/keys`: in cloud mode, swarm-side resolution would return
  platform-provisioned keys instead of user connectors — the broker never
  learns the difference.
- **Cross-provider engines.** No Deepgram Aura TTS, no ElevenLabs Scribe
  STT in v1. Shipping one later = add the capability tag to the registry
  entry + write the engine; settings/routes/resolver are already shaped
  for it.
- **Other broker env keys.** `ANTHROPIC_API_KEY`, `LIVEKIT_*`, and
  `GEMINI_API_KEY` stay env-configured. LiveKit is local infra, not a
  per-user credential; the rest are out of scope here.
- **Per-workspace voice overrides.** Voice is machine-global via the
  default user. Workspaces do not pin voice instances the way they pin
  agent-tool connectors.

## Testing

- **Verify functions:** mocked-fetch tests for both vendors — 200/401/5xx/
  network error, matching the existing `verify-github.test.ts` pattern.
- **`/me/voice` routes:** happy path; instance-not-found and
  wrong-capability instance rejected with 400; `DELETE /me/connectors/:id`
  clears a referencing voice slot.
- **`/me/voice/keys`:** loopback guard; resolves secrets; returns null per
  slot when unset/dangling.
- **Secure storage (§3):** encrypt/decrypt roundtrip; plaintext user file
  migrates to encrypted on load and stays decryptable; master-key
  resolution prefers `SMITH_MASTER_KEY` over `~/.smith/master.key`;
  wrong/missing master key surfaces as failing verify, not a crash.
- **`VoiceKeyResolver`:** TTL behavior; key change swaps the constructed
  provider; null → capability reported inactive.
- **Broker boot:** starts cleanly with neither key anywhere (the old
  required-var crash is gone).
- **VoiceGroup UI:** ChannelsGroup-style tests — pickers filter by
  capability, empty-state guidance, hide toggle persists.
- **Inactive-attempt paths:** hold-to-talk without STT yields the pointer
  message; TTS hint appears once per session; Discord join blocked only
  when both capabilities are unset.
