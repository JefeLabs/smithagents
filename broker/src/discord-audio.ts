/**
 * Real Discord audio transcode. The broker's TTS output is 44.1kHz mono
 * s16le PCM (see broker.ts's `TTS_SAMPLE_RATE`); Discord's voice pipeline
 * wants Opus packets encoded from 48kHz stereo s16le. Two prism-media
 * stages do the work: an FFmpeg process resamples/upmixes to 48kHz stereo
 * (the format Discord voice bots universally target), then an
 * `@discordjs/opus`-backed `opus.Encoder` frames and compresses that into
 * Opus packets ready for `@discordjs/voice`'s `createAudioResource` (with
 * `inputType: StreamType.Opus`). `sodium-native` is @discordjs/voice's own
 * dependency for encrypting the resulting RTP packets — nothing in this
 * file touches it directly.
 *
 * This module is exercised only by the live checklist
 * (docs/MANUAL-TESTING.md): `discord-voice.ts`'s fake-gateway unit tests
 * never import it, so a missing system `ffmpeg` or an unbuilt native addon
 * cannot fail the test suite — only real voice playback.
 */
import { Readable } from 'node:stream';
import prism from 'prism-media';

const DISCORD_SAMPLE_RATE = 48000;
const DISCORD_CHANNELS = 2;
const OPUS_FRAME_SIZE = 960; // 20ms at 48kHz, the frame size @discordjs/voice expects

/** Adapts the broker's async-iterable byte stream into a Readable ffmpeg can consume on stdin. */
function toReadable(pcm44kMono: AsyncIterable<Uint8Array>): Readable {
  return Readable.from(
    (async function* toBuffers() {
      for await (const chunk of pcm44kMono) {
        yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      }
    })(),
  );
}

/**
 * 44.1kHz mono s16le -> 48kHz stereo s16le (ffmpeg) -> Opus packets
 * (@discordjs/opus via prism-media), ready for
 * `createAudioResource(stream, { inputType: StreamType.Opus })`.
 */
export function pcm44kMonoToOpus(pcm44kMono: AsyncIterable<Uint8Array>): Readable {
  const ffmpeg = new prism.FFmpeg({
    args: [
      '-f', 's16le', '-ar', '44100', '-ac', '1', '-i', '-',
      '-f', 's16le', '-ar', String(DISCORD_SAMPLE_RATE), '-ac', String(DISCORD_CHANNELS),
    ],
  });
  const opusEncoder = new prism.opus.Encoder({
    rate: DISCORD_SAMPLE_RATE,
    channels: DISCORD_CHANNELS,
    frameSize: OPUS_FRAME_SIZE,
  });

  const input = toReadable(pcm44kMono);
  input.on('error', (err) => ffmpeg.destroy(err));
  input.pipe(ffmpeg);
  ffmpeg.on('error', (err) => opusEncoder.destroy(err));
  return ffmpeg.pipe(opusEncoder);
}
