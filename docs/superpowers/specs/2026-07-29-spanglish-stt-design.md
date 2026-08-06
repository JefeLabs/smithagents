# Spanglish STT (nova-3 multi) — Design

> **Status:** Approved design, pending implementation plan.
> **Date:** 2026-07-29

## Problem

STT is effectively English-only: `makeDeepgramLive` (`broker/src/main.ts`)
opens the Deepgram session with `model: 'nova-3'` and no `language` option, so
it defaults to English. Spanish speech — VC ear or in-app PTT mic — is
mistranscribed. The agents' `language: "en-do"` field is persona/TTS-side (how
generated lines *sound*), not hearing-side.

Requirement: strong Spanish support, where humans code-switch between Spanish
and English, sometimes within one sentence.

## Design

One change site: `makeDeepgramLive` adds a `language` option to the Deepgram
`connect()` call, read from the `DEEPGRAM_LANGUAGE` env var with **`'multi'` as
the default** — nova-3's code-switching mode transcribes Spanish and English in
one stream, making strong Spanish the out-of-the-box behavior. The env var lets
a session pin `'en'` or `'es-419'` when needed (same pattern as the env-tunable
TTS rate).

Both hearing paths — the in-app PTT mic and the Discord VC ear — flow through
this one factory, so a single change covers both. Nothing downstream changes:
the Haiku brain reads Spanish fine and transcripts stay speaker-prefixed.

## Testing

- Unit test on the factory options: env respected, `'multi'` default.
- One live VC smoke test: `multi` has different endpointing/latency behavior
  than plain English mode, and `endpointing: 300` is load-bearing for meeting
  etiquette.

## Out of scope (YAGNI)

- Per-agent STT languages.
- Keyword boosting.
- A control-plane language toggle.

All addable later if `multi` falls short.
