import { useRef, useState } from "react";

const TARGET_RATE = 48000; // what the broker's Deepgram session expects (s16le mono)

/** Naive linear resample — good enough for speech into an STT engine. */
function resampleTo48k(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === TARGET_RATE) return input;
  const outLength = Math.round((input.length * TARGET_RATE) / fromRate);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = (i * (input.length - 1)) / (outLength - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, input.length - 1);
    out[i] = (input[lo] ?? 0) + ((input[hi] ?? 0) - (input[lo] ?? 0)) * (pos - lo);
  }
  return out;
}

function toS16le(samples: Float32Array): ArrayBuffer {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out.buffer;
}

/**
 * Push-to-talk: captures the mic and streams s16le 48kHz mono PCM chunks to
 * the broker over the text channel. Toggle on -> mic-start + audio frames;
 * toggle off -> tracks stopped + mic-stop (Deepgram flushes the utterance).
 */
export function usePushToTalk(controls: { begin: () => void; audio: (pcm: ArrayBuffer) => void; end: () => void }) {
  const [micLive, setMicLive] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  const controlsRef = useRef(controls);
  controlsRef.current = controls;

  const stop = () => {
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
    void ctx.current?.close();
    ctx.current = null;
    controlsRef.current.end();
    setMicLive(false);
  };

  const toggleMic = async () => {
    if (micLive) {
      stop();
      return;
    }
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      const audioCtx = new AudioContext({ sampleRate: TARGET_RATE });
      const source = audioCtx.createMediaStreamSource(media);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        const mono = e.inputBuffer.getChannelData(0);
        controlsRef.current.audio(toS16le(resampleTo48k(mono, audioCtx.sampleRate)));
      };
      source.connect(processor);
      processor.connect(audioCtx.destination); // required for onaudioprocess to fire in WebKit
      stream.current = media;
      ctx.current = audioCtx;
      controlsRef.current.begin();
      setMicError(null);
      setMicLive(true);
    } catch (err) {
      setMicError(err instanceof Error ? err.message : String(err));
      setMicLive(false);
    }
  };

  return { micLive, micError, toggleMic };
}
