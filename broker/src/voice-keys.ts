// Runtime voice-key resolution (spec §4): a short-TTL cache over swarm's
// GET /me/voice/keys so pasting a key in Settings takes effect without a
// broker restart. Swarm-unreachable (client returns null) keeps the last
// good keys — voice shouldn't flap off because swarm restarted.
import type { VoiceKeys } from "./swarm-client.ts";

export const VOICE_KEYS_TTL_MS = 20_000;

export const VOICE_STT_HINT = "Add a Deepgram key in Settings → Integrations, then select it under Settings → Voice.";
export const VOICE_TTS_HINT =
  "No text-to-speech key — add an ElevenLabs key in Settings → Integrations, then select it under Settings → Voice.";

export class VoiceKeyResolver {
  private cached: VoiceKeys = { stt: null, tts: null };
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly swarm: { getVoiceKeys(): Promise<VoiceKeys | null> },
    private readonly now: () => number = Date.now,
  ) {}

  private refresh(): Promise<void> {
    this.inflight ??= this.swarm
      .getVoiceKeys()
      .then((keys) => {
        if (keys) this.cached = keys; // null = unreachable → keep last good
      })
      .catch(() => {
        // rejection (network/swarm crash) → keep last-good cache, same as null
      })
      .finally(() => {
        this.fetchedAt = this.now();
        this.inflight = null;
      });
    return this.inflight;
  }

  private async current(): Promise<VoiceKeys> {
    if (this.now() - this.fetchedAt >= VOICE_KEYS_TTL_MS) await this.refresh();
    return this.cached;
  }

  async sttKey(): Promise<string | null> {
    return (await this.current()).stt?.apiKey ?? null;
  }

  async ttsKey(): Promise<string | null> {
    return (await this.current()).tts?.apiKey ?? null;
  }

  async status(): Promise<{ stt: boolean; tts: boolean }> {
    const c = await this.current();
    return { stt: Boolean(c.stt), tts: Boolean(c.tts) };
  }

  /** Cached snapshot for sync call sites (/agents payload); kicks a background refresh when stale. */
  statusSync(): { stt: boolean; tts: boolean } {
    if (this.now() - this.fetchedAt >= VOICE_KEYS_TTL_MS) void this.refresh();
    return { stt: Boolean(this.cached.stt), tts: Boolean(this.cached.tts) };
  }
}
