// Runtime voice-key resolution (spec §4): a short-TTL cache over swarm's
// GET /me/voice/keys so pasting a key in Settings takes effect without a
// broker restart. Swarm-unreachable (client returns null) keeps the last
// good keys — voice shouldn't flap off because swarm restarted.
import type { VoiceKeys } from "./swarm-client.ts";

export const VOICE_KEYS_TTL_MS = 20_000;

export const VOICE_STT_HINT = "Add a Deepgram key in Settings → Integrations, then select it under Settings → Voice.";
export const VOICE_TTS_HINT =
  "No text-to-speech key — add an ElevenLabs key in Settings → Integrations, then select it under Settings → Voice.";
/**
 * The refusal for a caller that NAMED an instance to speak with (the welcome
 * wizard's ▶ Say something) and whose choice could not be used — deleted since,
 * a vendor that cannot do text-to-speech, or a key the master key can no longer
 * decrypt. VOICE_TTS_HINT is wrong for that caller twice over: it says there is
 * no key when the user just picked one, and it sends a first-run user to a
 * Settings screen they have not reached yet.
 */
export const VOICE_TTS_CHOICE_HINT = "I couldn't use that key to speak — pick another one and I'll try again.";

export class VoiceKeyResolver {
  private cached: VoiceKeys = { stt: null, tts: null };
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly swarm: { getVoiceKeys(opts?: { ttsInstanceId?: string }): Promise<VoiceKeys | null> },
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

  /**
   * The key behind ONE named connector instance — the welcome wizard's
   * in-progress pick, which is not the saved slot and must not become it.
   *
   * Deliberately outside the cache in both directions: reading it would answer
   * a preview with the saved key while the screen showed another, and writing
   * it would leave the live mic and every later speak() using a choice the user
   * never committed. A preview is one call; paying for one round trip is the
   * cheap half of that trade.
   *
   * Swarm validates the instance (it must exist and its vendor must declare
   * `tts`), so null here covers refused, absent and unreachable alike — the
   * caller has no key either way, and never a fallback to the saved one.
   */
  async ttsKeyFor(instanceId: string): Promise<string | null> {
    const keys = await this.swarm.getVoiceKeys({ ttsInstanceId: instanceId }).catch(() => null);
    return keys?.tts?.apiKey ?? null;
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
