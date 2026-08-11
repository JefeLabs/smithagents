/**
 * Real Discord audio transcode, both directions.
 *
 * OUT (the mouths): the broker's TTS output is 44.1kHz mono s16le PCM (see
 * broker.ts's `TTS_SAMPLE_RATE`); Discord's voice pipeline wants Opus
 * packets encoded from 48kHz stereo s16le. Two prism-media stages do the
 * work: an FFmpeg process resamples/upmixes to 48kHz stereo (the format
 * Discord voice bots universally target), then an `@discordjs/opus`-backed
 * `opus.Encoder` frames and compresses that into Opus packets ready for
 * `@discordjs/voice`'s `createAudioResource` (with `inputType:
 * StreamType.Opus`).
 *
 * IN (the ear): the reverse leg. Discord always delivers each subscribed
 * speaker's audio as 48kHz stereo Opus; `@discordjs/opus`'s `opus.Decoder`
 * turns that back into 48kHz stereo s16le, and `stereoToMono` mixes the two
 * channels down (average of L/R) to the mono stream `discord-voice.ts`'s
 * `VoiceReceiverLike` contract hands to a Deepgram session. `realReceiver`
 * wires a real `@discordjs/voice` `VoiceReceiver` to that contract —
 * subscribing per speaking-start (`EndBehaviorType.AfterSilence`, so each
 * subscription is one bounded utterance-shaped stream, not the whole
 * session) and resolving `displayName`/`isBot` from the guild member.
 *
 * `sodium-native` is @discordjs/voice's own dependency for encrypting (and,
 * on receive, decrypting) RTP packets — nothing in this file touches it
 * directly.
 *
 * This module is exercised only by the live checklist
 * (docs/MANUAL-TESTING.md): `discord-voice.ts`'s fake-gateway/fake-receiver
 * unit tests never import it, so a missing system `ffmpeg` or an unbuilt
 * native addon cannot fail the test suite — only real voice I/O.
 * `realReceiver` in particular is typecheck-only scaffolding this task: no
 * call site threads a live ear connection into it yet (see
 * `discord-voice.ts`'s module header, "The ear" section) — that's for
 * whoever wires main.ts's real ear connection through.
 */
import { Readable, Transform } from "node:stream";
import { EndBehaviorType, type VoiceReceiver } from "@discordjs/voice";
import type { Guild } from "discord.js";
import prism from "prism-media";
import type { VoiceReceiverLike } from "./discord-voice.ts";

const DISCORD_SAMPLE_RATE = 48000;
// Rate of the incoming TTS PCM — mirrors broker.ts's TTS_SAMPLE_RATE (same env,
// same default); read directly here to keep this leaf module import-free.
const TTS_INPUT_RATE = Number(process.env.TTS_SAMPLE_RATE ?? 24000);
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
      // Input rate MUST match the broker's TTS output (broker.ts TTS_SAMPLE_RATE,
      // same env + default) or the voice plays back pitch-shifted.
      "-f",
      "s16le",
      "-ar",
      String(TTS_INPUT_RATE),
      "-ac",
      "1",
      "-i",
      "-",
      "-f",
      "s16le",
      "-ar",
      String(DISCORD_SAMPLE_RATE),
      "-ac",
      String(DISCORD_CHANNELS),
    ],
  });
  const opusEncoder = new prism.opus.Encoder({
    rate: DISCORD_SAMPLE_RATE,
    channels: DISCORD_CHANNELS,
    frameSize: OPUS_FRAME_SIZE,
  });

  const input = toReadable(pcm44kMono);
  input.on("error", (err) => ffmpeg.destroy(err));
  input.pipe(ffmpeg);
  ffmpeg.on("error", (err) => opusEncoder.destroy(err));
  return ffmpeg.pipe(opusEncoder);
}

/** A subscription per speaking-start ends after this much silence — one bounded, utterance-shaped stream, not the whole VC session. */
const RECEIVE_END_SILENCE_MS = 1000;

/**
 * 48kHz interleaved stereo s16le -> 48kHz mono s16le, averaging each frame's
 * L/R sample. Assumes chunk boundaries land on whole 4-byte stereo frames,
 * true for prism's `opus.Decoder` output (it never emits a mid-sample
 * split) but worth a live-checklist glance if that ever changes upstream.
 */
function stereoToMono(): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const frames = Math.floor(chunk.length / 4);
      const mono = Buffer.alloc(frames * 2);
      for (let i = 0; i < frames; i++) {
        const left = chunk.readInt16LE(i * 4);
        const right = chunk.readInt16LE(i * 4 + 2);
        mono.writeInt16LE((left + right) >> 1, i * 2);
      }
      callback(null, mono);
    },
  });
}

/** One speaker's Opus packet stream -> 48kHz mono s16le PCM, ready for a Deepgram session at 48000. */
function opusToPcm48kMono(opusPackets: Readable): Readable {
  const decoder = new prism.opus.Decoder({
    rate: DISCORD_SAMPLE_RATE,
    channels: DISCORD_CHANNELS,
    frameSize: OPUS_FRAME_SIZE,
  });
  opusPackets.on("error", (err) => decoder.destroy(err));
  opusPackets.pipe(decoder);
  return decoder.pipe(stereoToMono());
}

/**
 * Adapts a real, already-connected `@discordjs/voice` `VoiceReceiver` into
 * the ear's `VoiceReceiverLike` contract (`discord-voice.ts`). Subscribes
 * fresh per speaking-start rather than once per session, since Discord's
 * own speaking-start/end events are exactly the utterance boundaries the
 * per-user STT sessions want to reuse across (see `discord-voice.ts`'s
 * module header, "The ear" section, for why the session itself outlives any
 * one subscription). Unreached by anything in this task — see the module
 * header's top note.
 */
export function realReceiver(voiceReceiver: VoiceReceiver, guild: Guild): VoiceReceiverLike {
  return {
    onSpeakingStart(cb) {
      voiceReceiver.speaking.on("start", (userId) => {
        void (async () => {
          // Left before we could resolve who they are — nothing to attribute to.
          const member = await guild.members.fetch(userId).catch((err: unknown) => {
            console.error(
              `[discord-voice] couldn't resolve guild member ${userId} for a voice speaking-start — dropping their audio: ${String(err)}`,
            );
            return null;
          });
          if (!member) return;
          const opusStream = voiceReceiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: RECEIVE_END_SILENCE_MS },
          });
          cb(userId, member.displayName, member.user.bot, opusToPcm48kMono(opusStream));
        })();
      });
    },
  };
}
