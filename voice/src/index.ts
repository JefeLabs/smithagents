export { CachingVoiceProvider } from "./providers/caching-voice-provider.ts";
export {
  type ElevenLabsOptions,
  ElevenLabsVoiceProvider,
} from "./providers/elevenlabs-voice-provider.ts";
export { type LocalVoiceOptions, LocalVoiceProvider } from "./providers/local-voice-provider.ts";
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
export { VoiceRouter } from "./voice-router.ts";
