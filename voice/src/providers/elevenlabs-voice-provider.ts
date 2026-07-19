import type {
  AudioChunk,
  AudioFormat,
  SynthesisRequest,
  SynthesisResult,
  VoiceCapabilities,
  VoiceProvider,
} from "../types.ts";

export interface ElevenLabsOptions {
  /** BYO API key — the *user's* key, so per-character cost is theirs, not yours. */
  apiKey: string;
  baseUrl?: string;
  /** Default model; Flash is the low-latency choice for live conversation. */
  defaultModel?: string;
}

/**
 * ElevenLabs streaming TTS — premium, natural, voice-cloned persona voices. A
 * network round-trip (never local-fast) and metered per character, so it is an
 * opt-in *quality tier*, not the default. BYO key keeps your COGS ≈ 0. Best
 * paired with the caching decorator so a persona's fixed lines are paid once.
 *
 * @see https://elevenlabs.io/docs — verify the current endpoint/model ids.
 */
export class ElevenLabsVoiceProvider implements VoiceProvider {
  readonly id = "elevenlabs";
  readonly capabilities: VoiceCapabilities = {
    streaming: true,
    cloning: true,
    offline: false,
    metered: true,
    latency: "network",
  };

  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(private readonly opts: ElevenLabsOptions) {
    this.baseUrl = opts.baseUrl ?? "https://api.elevenlabs.io";
    this.defaultModel = opts.defaultModel ?? "eleven_flash_v2_5";
  }

  async *stream(req: SynthesisRequest): AsyncIterable<AudioChunk> {
    const voiceId = req.voice.voiceId;
    if (!voiceId) throw new Error("ElevenLabs requires persona voice.voiceId");

    const format = req.format ?? "mp3";
    const outputFormat = toElevenLabsFormat(format, req.sampleRate);
    const url = `${this.baseUrl}/v1/text-to-speech/${voiceId}/stream?output_format=${outputFormat}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": this.opts.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        text: req.text,
        model_id: req.voice.model ?? this.defaultModel,
        voice_settings: req.voice.settings,
      }),
      signal: req.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`ElevenLabs TTS failed: ${res.status} ${await res.text().catch(() => "")}`);
    }

    const sampleRate = req.sampleRate ?? 44100;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      yield { data: chunk, format, sampleRate };
    }
  }

  async synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
    const parts: Uint8Array[] = [];
    let format: AudioFormat = req.format ?? "mp3";
    let sampleRate = req.sampleRate ?? 44100;
    for await (const chunk of this.stream(req)) {
      parts.push(chunk.data);
      format = chunk.format;
      sampleRate = chunk.sampleRate;
    }
    return {
      data: concat(parts),
      format,
      sampleRate,
      charactersBilled: req.text.length,
    };
  }
}

function toElevenLabsFormat(format: AudioFormat, sampleRate?: number): string {
  if (format === "mp3") return `mp3_44100_128`;
  if (format === "pcm_s16le") return `pcm_${sampleRate ?? 16000}`;
  if (format === "opus") return `opus_48000`;
  return `mp3_44100_128`;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
