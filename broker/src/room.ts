/**
 * LiveKitRoomBridge — the broker's seat in the meeting room. Joins with a
 * minted token, exposes remote (human mic) audio as raw s16le bytes for STT,
 * and publishes TTS PCM back as the broker's voice. THIN by design: all
 * decisions live elsewhere; this file is the only one importing the native
 * @livekit/rtc-node module (exercised via the live smoke, not unit tests).
 */
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { pcmBytesToFrames } from './pcm.ts';

export class LiveKitRoomBridge {
  private room: Room | null = null;
  private source: AudioSource | null = null;
  private remoteAudioCb: ((pcmBytes: Uint8Array) => void) | null = null;
  private publishRemainder: Uint8Array = new Uint8Array(0);

  async connect(opts: { url: string; token: string }): Promise<void> {
    const room = new Room();
    this.room = room;

    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      void (async () => {
        try {
          const stream = new AudioStream(track, { sampleRate: 48000 });
          for await (const frame of stream) {
            const bytes = new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
            this.remoteAudioCb?.(bytes.slice(0));
          }
        } catch (err) {
          console.error('[room] remote audio stream ended abnormally:', err);
          return;
        }
      })();
    });

    await room.connect(opts.url, opts.token, { autoSubscribe: true, dynacast: false });
  }

  onRemoteAudio(cb: (pcmBytes: Uint8Array) => void): void {
    this.remoteAudioCb = cb;
  }

  async publishPcm(bytes: Uint8Array, sampleRate: number): Promise<void> {
    if (!this.room) return;
    if (!this.source) {
      this.source = new AudioSource(sampleRate, 1);
      const track = LocalAudioTrack.createAudioTrack('broker-voice', this.source);
      await this.room.localParticipant?.publishTrack(
        track,
        new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
      );
    }
    const joined = new Uint8Array(this.publishRemainder.length + bytes.length);
    joined.set(this.publishRemainder, 0);
    joined.set(bytes, this.publishRemainder.length);
    const { frames, remainder } = pcmBytesToFrames(joined, sampleRate);
    this.publishRemainder = remainder;
    for (const f of frames) {
      await this.source.captureFrame(new AudioFrame(f.data, f.sampleRate, 1, f.samplesPerChannel));
    }
  }

  async disconnect(): Promise<void> {
    await this.room?.disconnect();
    this.room = null;
    this.source = null;
    this.publishRemainder = new Uint8Array(0);
  }
}
