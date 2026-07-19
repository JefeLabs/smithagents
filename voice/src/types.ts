/**
 * VoiceProvider abstraction (PRD §3, §5 voice layer).
 *
 * One interface, many backends — local (Piper/MLX), ElevenLabs (BYO key), and a
 * caching decorator — selected by policy per persona. Mirrors the model-provider
 * and channel abstractions: swappable implementations behind a stable contract,
 * with declared `capabilities` so policy can choose by *properties* (metered?
 * offline? latency?) rather than by hardcoding a provider name.
 */

/** Provider identifier. Open string so custom providers slot in. */
export type VoiceProviderId = "local" | "elevenlabs" | (string & {});

/** Raw audio encodings a provider may emit. */
export type AudioFormat = "pcm_s16le" | "wav" | "mp3" | "opus";

/** How fast a provider responds — the axis that decides live-voice fitness. */
export type LatencyClass = "instant" | "low" | "network";

/** A chunk of synthesized audio (streaming). */
export interface AudioChunk {
  data: Uint8Array;
  format: AudioFormat;
  sampleRate: number;
}

/** A completed synthesis (non-streaming). */
export interface SynthesisResult extends AudioChunk {
  durationMs?: number;
  /** True when served from the pre-cache rather than freshly synthesized. */
  fromCache?: boolean;
  /** Characters billed by a metered provider (0 for local / cache hits). */
  charactersBilled?: number;
}

/**
 * A persona's voice config — lives in the persona `.md` front-matter, e.g.
 * `voice: { provider: elevenlabs, voiceId: "...", model: eleven_flash_v2_5 }`.
 */
export interface PersonaVoiceConfig {
  provider: VoiceProviderId;
  /** Provider voice id — ElevenLabs voiceId, Piper model name, etc. */
  voiceId?: string;
  /** Provider model — e.g. `eleven_flash_v2_5`, `piper-en_US-...`. */
  model?: string;
  /** Provider-specific knobs (stability, similarity, speed, ...). */
  settings?: Record<string, unknown>;
  /**
   * Cache the *fixed* lines this persona repeats (greetings, stock reactions like
   * Aurelio's sigh). Fixed lines pay a metered provider once, then replay from
   * disk forever. Dynamic content bypasses the cache.
   */
  cacheFixedLines?: boolean;
}

/** A single synthesis request. */
export interface SynthesisRequest {
  text: string;
  voice: PersonaVoiceConfig;
  personaId: string;
  /** Desired output encoding; providers pick a sane default when omitted. */
  format?: AudioFormat;
  sampleRate?: number;
  signal?: AbortSignal;
}

/** What a provider can do — lets policy choose by property, not by name. */
export interface VoiceCapabilities {
  streaming: boolean;
  /** Zero-shot / instant voice cloning (distinct natural persona voices). */
  cloning: boolean;
  /** Runs fully on-device — no network, works offline. */
  offline: boolean;
  /** Bills per character / per use (cost you must account for). */
  metered: boolean;
  latency: LatencyClass;
}

/** The uniform contract every voice backend implements. */
export interface VoiceProvider {
  readonly id: VoiceProviderId;
  readonly capabilities: VoiceCapabilities;

  /** Synthesize the whole utterance and return it. */
  synthesize(req: SynthesisRequest): Promise<SynthesisResult>;

  /** Stream audio as it is produced — the path for live meetings. */
  stream(req: SynthesisRequest): AsyncIterable<AudioChunk>;
}
