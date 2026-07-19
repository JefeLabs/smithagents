export type {
  AudioChunk,
  AudioFormat,
  LatencyClass,
  PersonaVoiceConfig,
  SynthesisRequest,
  SynthesisResult,
  VoiceCapabilities,
  VoiceProvider,
  VoiceProviderId,
} from "./types.ts";

export { LocalVoiceProvider, type LocalVoiceOptions } from "./providers/local-voice-provider.ts";
export {
  ElevenLabsVoiceProvider,
  type ElevenLabsOptions,
} from "./providers/elevenlabs-voice-provider.ts";
export { CachingVoiceProvider } from "./providers/caching-voice-provider.ts";
export { VoiceRouter } from "./voice-router.ts";
