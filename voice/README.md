# @smithagents/voice

The **VoiceProvider abstraction** — one interface, swappable TTS backends, chosen
by policy per persona. The voice-layer sibling of the model-provider and channel
abstractions.

> **First TypeScript module of the TS rebuild.** The stack decision (2026-07-19)
> is local = TypeScript, cloud = Rust; this is self-contained (Node built-ins +
> global `fetch`, no runtime deps) so it relocates cleanly to wherever the TS
> project lands. Not yet compiled here — no TS toolchain is installed in this repo.

## Providers

| Provider | Latency | Offline | Metered | Cloning | Use |
|----------|---------|---------|---------|---------|-----|
| `LocalVoiceProvider` (Piper / MLX) | instant | ✅ | ✖ | ✖ | **Default** — reactions, snappy path, free & private |
| `ElevenLabsVoiceProvider` (BYO key) | network | ✖ | ✅ | ✅ | **Premium tier** — natural signature persona voices |
| `CachingVoiceProvider` (decorator) | instant on hit | ✅ | ✖ on hit | — | Wrap a metered provider → pay once for fixed lines |

## Shape

```ts
const router = new VoiceRouter("local")
  .register(new LocalVoiceProvider({ binaryPath: "/opt/piper/piper" }))
  // ElevenLabs wrapped in the cache: fixed lines paid once, then served from disk.
  .register(new CachingVoiceProvider(
    new ElevenLabsVoiceProvider({ apiKey: userKey }),
    "audio-cache",
  ));

// Persona voice config comes from the persona `.md` front-matter:
//   voice: { provider: elevenlabs, voiceId: "...", model: eleven_flash_v2_5, cacheFixedLines: true }
for await (const chunk of router.stream({ text, voice, personaId })) {
  publishToLiveKit(chunk); // agent speaks in the room
}
```

## Design notes

- **Choose by capability, not name.** Providers declare `capabilities`
  (`metered` / `offline` / `latency`), so policy can prefer `local` for
  high-frequency reactions and reserve `elevenlabs` for signature lines.
- **BYO key.** The ElevenLabs key is the *user's* — per-character cost is theirs,
  keeping platform COGS ≈ 0. Store it encrypted, like model keys.
- **Pre-cache is composition.** `CachingVoiceProvider` wraps a delegate and keeps
  its `id`, so caching is transparent to resolution.
- **Downstream.** Chunks feed LiveKit (agents speak as room participants); local
  STT (Whisper) is the inbound counterpart, specced separately.

## Open decision — the routing policy

`VoiceRouter.resolve()` ships a sensible default (honor the persona's provider,
else fall back to local). The richer policy — force `local` for reactions,
downgrade metered providers past a spend cap, pick by latency for live vs. async —
is the seam worth shaping to your product tiers.
