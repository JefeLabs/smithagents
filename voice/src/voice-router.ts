import type {
  AudioChunk,
  PersonaVoiceConfig,
  SynthesisRequest,
  SynthesisResult,
  VoiceProvider,
  VoiceProviderId,
} from "./types.ts";

/**
 * Resolves a persona's {@link PersonaVoiceConfig} to a registered
 * {@link VoiceProvider} and drives synthesis. The voice-layer counterpart to
 * PersonaRouter: config-driven, never naming a provider inline.
 *
 * <p>Register providers by id (wrap metered ones in `CachingVoiceProvider` before
 * registering so fixed lines are paid once). A missing provider falls back to
 * `fallbackId` (default `"local"`) — degrade to free/offline rather than fail.
 */
export class VoiceRouter {
  private readonly providers = new Map<VoiceProviderId, VoiceProvider>();

  constructor(private readonly fallbackId: VoiceProviderId = "local") {}

  register(provider: VoiceProvider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  /**
   * Pick the provider for a persona's voice config.
   *
   * Default policy: honor the persona's declared provider; if it isn't
   * registered, fall back to the free/offline provider. This is the seam where a
   * richer policy could live — e.g. force `local` for high-frequency reactions,
   * or downgrade metered providers when the user is over a spend cap. Choose by
   * `provider.capabilities` (metered / offline / latency), not by name.
   */
  resolve(voice: PersonaVoiceConfig): VoiceProvider {
    const chosen = this.providers.get(voice.provider) ?? this.providers.get(this.fallbackId);
    if (!chosen) {
      throw new Error(`No voice provider for '${voice.provider}' and no '${this.fallbackId}' fallback registered.`);
    }
    return chosen;
  }

  synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
    return this.resolve(req.voice).synthesize(req);
  }

  stream(req: SynthesisRequest): AsyncIterable<AudioChunk> {
    return this.resolve(req.voice).stream(req);
  }
}
