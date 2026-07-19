import { spawn } from "node:child_process";
import type {
  AudioChunk,
  SynthesisRequest,
  SynthesisResult,
  VoiceCapabilities,
  VoiceProvider,
} from "../types.ts";

export interface LocalVoiceOptions {
  /** Path to the local TTS binary (Piper, or an MLX-audio CLI wrapper). */
  binaryPath: string;
  /** Directory holding the voice model files. */
  modelsDir?: string;
  /** Raw output sample rate the binary produces (Piper default is 22050). */
  sampleRate?: number;
}

/**
 * On-device TTS via a local binary (Piper / MLX-audio). Free, private, offline,
 * and lowest-latency — the default for high-frequency reactions and the snappy
 * conversational path. Text is written to the child's stdin; raw PCM is read from
 * stdout and yielded as it arrives.
 *
 * <p>The exact argv depends on the binary; {@link LocalVoiceOptions.binaryPath}
 * is expected to point at a wrapper that reads text on stdin, selects the voice
 * from {@link PersonaVoiceConfig.voiceId}/`model`, and writes raw PCM to stdout.
 */
export class LocalVoiceProvider implements VoiceProvider {
  readonly id = "local";
  readonly capabilities: VoiceCapabilities = {
    streaming: true,
    cloning: false,
    offline: true,
    metered: false,
    latency: "instant",
  };

  constructor(private readonly opts: LocalVoiceOptions) {}

  async *stream(req: SynthesisRequest): AsyncIterable<AudioChunk> {
    const sampleRate = req.sampleRate ?? this.opts.sampleRate ?? 22050;
    const args: string[] = [];
    if (this.opts.modelsDir) args.push("--models-dir", this.opts.modelsDir);
    if (req.voice.model) args.push("--model", req.voice.model);
    else if (req.voice.voiceId) args.push("--voice", req.voice.voiceId);

    const child = spawn(this.opts.binaryPath, args, { signal: req.signal });
    child.stdin.write(req.text);
    child.stdin.end();

    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    try {
      for await (const chunk of child.stdout) {
        yield { data: chunk as Uint8Array, format: "pcm_s16le", sampleRate };
      }
    } catch (err) {
      throw new Error(`Local TTS failed (${this.opts.binaryPath}): ${String(err)}\n${stderr}`);
    }
  }

  async synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
    const sampleRate = req.sampleRate ?? this.opts.sampleRate ?? 22050;
    const parts: Uint8Array[] = [];
    for await (const chunk of this.stream(req)) parts.push(chunk.data);
    return {
      data: concat(parts),
      format: "pcm_s16le",
      sampleRate,
      charactersBilled: 0,
    };
  }
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
