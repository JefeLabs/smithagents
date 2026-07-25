/**
 * Pure PCM plumbing (no native imports — unit-testable). Audio in this
 * system is s16le mono: LiveKit frames carry Int16Array, Deepgram wants raw
 * s16le bytes, ElevenLabs pcm output is s16le bytes. These helpers convert
 * between byte streams and fixed-duration frames, carrying partial frames
 * (and odd bytes) as a remainder so nothing is dropped across chunks.
 */
export interface PcmFrame {
  data: Int16Array;
  sampleRate: number;
  samplesPerChannel: number;
}

export function pcmBytesToFrames(
  bytes: Uint8Array,
  sampleRate: number,
  frameMs = 100,
): { frames: PcmFrame[]; remainder: Uint8Array } {
  const samplesPerFrame = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const bytesPerFrame = samplesPerFrame * 2;
  const frames: PcmFrame[] = [];
  let offset = 0;
  while (bytes.length - offset >= bytesPerFrame) {
    const slice = bytes.slice(offset, offset + bytesPerFrame);
    frames.push({
      data: new Int16Array(slice.buffer, slice.byteOffset, samplesPerFrame),
      sampleRate,
      samplesPerChannel: samplesPerFrame,
    });
    offset += bytesPerFrame;
  }
  return { frames, remainder: bytes.slice(offset) };
}

export function int16ToBytes(frame: Int16Array): Uint8Array {
  return new Uint8Array(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength));
}
