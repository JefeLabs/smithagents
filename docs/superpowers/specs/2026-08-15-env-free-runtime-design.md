# Env-Free Runtime — Design

**Status:** design, awaiting review
**Date:** 2026-08-15
**Blocks:** any packaged install, and therefore the welcome wizard
**Related:** [welcome wizard](2026-08-15-welcome-wizard-design.md), [brain engine selection](2026-08-15-brain-engine-selection-design.md)

## Ruling

**The app depends on nothing but what the user enters in the startup wizard or
Settings.** `.env` is a developer convenience, never a product dependency.

## Why this is a hard stop today

A packaged Tauri app bundles no sidecars (`externalBin: NONE`) and spawns no
processes, so it is a window pointing at `:7777` and `:7790`. Even granting that
those services are running, the **broker refuses to boot without four
environment variables**:

| `broker/src/config.ts` | Variable |
|---|---|
| line 51 | `ANTHROPIC_API_KEY` |
| lines 53–55 | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` |

`requiredVar` throws on absence, so a user with no `.env` gets a crash before the
wizard renders a single pixel. The swarm has **no** required env vars and already
boots clean; this is entirely a broker problem, which makes it small.

## Where each setting moves

Both destinations already exist, which is why this is re-wiring rather than
building.

| Setting | Destination | State |
|---|---|---|
| `ANTHROPIC_API_KEY` | the **api-keys registry** (`anthropic` · `google` · `openai`) with `saveAndVerifyKey`, `verifyStoredKey`, `getCredential` | ships |
| LiveKit url + key + secret | a **`livekit` connector vendor** in `connectors.ts` | **must be added** — the only new data |

The `livekit` vendor is a three-field connector alongside the six that exist, and
inherits the registry's AES-GCM encryption at rest for its secret.

## Precedence, unchanged

`.env` continues to win where a value is present — that keeps every developer's
current workflow working, and matches the existing rule that a `.env` Gemini key
outranks the store. **Only the requirement is removed, not the precedence.**

```
value = env[NAME] ?? registry.get(name) ?? undefined
```

A developer with a full `.env` sees no change whatsoever. A packaged user has no
`.env`, so every value resolves from the registry the wizard wrote.

## Degrade, never wall

With the requirement gone, absence must be a *state*, not a crash. Each missing
piece disables exactly one capability and nothing else:

| Missing | What stops | What still works |
|---|---|---|
| LiveKit connector | **meetings and Discord voice only** — `publishPcm`. Single-user voice is unaffected: TTS reaches the browser as an `audio` frame over the WebSocket | text chat, boards, documents, diagrams, agents, dispatch, **and local voice** |
| brain engine | Anderson replies | everything not requiring the brain |
| deepgram / elevenlabs | STT / TTS | text chat — the existing both-slots invariant already covers this |
| api key + no CLI + no local server | agent work | reading and organising what exists |

Two rules make this honest rather than mysterious:

- **Every disabled capability names its own cause and its fix**, surfaced to the
  UI rather than only logged. "Anderson can't reply: no brain engine configured →
  Settings" beats silence, which is what a dead key produces today.
- **Boot always succeeds.** The broker starting is not conditional on any
  configuration. This is the load-bearing requirement: everything else is
  recoverable from inside the app, and a failed boot is not.

## Error handling

- A malformed registry value is treated as absent, with a warning naming the
  connector — never a boot failure.
- A capability that becomes available mid-session (the user pastes a key) must
  activate **without a restart**, matching the per-turn brain resolution in the
  brain-engine spec. A setting that needs a restart is not settable from a
  packaged app.
- Removing a value degrades the capability rather than crashing the service.

## Testing

Unit: config load with an **empty environment** returns a usable config with
absent optionals; precedence (`.env` over registry over undefined); a malformed
registry value degrading to absent.

**The load-bearing test:** boot the broker with a completely empty environment
and assert it listens. That is the whole point of this change, and it is exactly
the case no existing test covers — the current suite runs with a populated
`.env`, which is why a four-variable boot dependency survived this long.

**Live smoke:** with `.env` moved aside entirely, start both services, complete
the wizard, and hold a text conversation. Green tests do not prove reachability.

## Out of scope

Packaging and process supervision — how a `.app` starts and stops the swarm and
broker at all — remains unspecified and is the sibling gap to this one. Removing
the `.env` dependency is necessary for a packaged install and not sufficient for
one.
