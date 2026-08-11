import assert from "node:assert/strict";
import { test } from "node:test";
import { int16ToBytes, pcmBytesToFrames } from "./pcm.ts";

function bytesOf(...samples: number[]): Uint8Array {
  const i16 = new Int16Array(samples);
  return new Uint8Array(i16.buffer.slice(0));
}

test("splits bytes into frameMs-sized mono frames", () => {
  // 10ms frames at 1000Hz = 10 samples per frame; 25 samples -> 2 frames + 5-sample remainder
  const bytes = bytesOf(...Array.from({ length: 25 }, (_, i) => i));
  const { frames, remainder } = pcmBytesToFrames(bytes, 1000, 10);
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.samplesPerChannel, 10);
  assert.equal(frames[0]!.sampleRate, 1000);
  assert.deepEqual([...frames[0]!.data], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual([...frames[1]!.data], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  assert.equal(remainder.length, 10); // 5 samples * 2 bytes
});

test("odd trailing byte is carried in the remainder, never dropped", () => {
  const bytes = new Uint8Array([...bytesOf(1, 2, 3), 0x7f]); // 3 samples + 1 stray byte
  const { frames, remainder } = pcmBytesToFrames(bytes, 3000, 1); // 3 samples/frame
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0]!.data], [1, 2, 3]);
  assert.deepEqual([...remainder], [0x7f]);
});

test("int16ToBytes round-trips with pcmBytesToFrames", () => {
  const original = new Int16Array([100, -200, 32767, -32768]);
  const { frames } = pcmBytesToFrames(int16ToBytes(original), 4000, 1); // 4 samples/frame
  assert.deepEqual([...frames[0]!.data], [...original]);
});
