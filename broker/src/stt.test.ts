import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { DeepgramSttStream, deepgramLiveOptions, type LiveLike } from "./stt.ts";

function fakeLive(): { live: LiveLike & EventEmitter; sent: Uint8Array[]; closed: boolean[] } {
  const sent: Uint8Array[] = [];
  const closed: boolean[] = [];
  const em = new EventEmitter() as EventEmitter & LiveLike;
  em.send = (d: Uint8Array) => sent.push(d);
  em.requestClose = () => closed.push(true);
  return { live: em, sent, closed };
}

function results(transcript: string, opts: { is_final: boolean; speech_final: boolean }) {
  return { ...opts, channel: { alternatives: [{ transcript }] } };
}

test("accumulates is_final segments and emits one utterance on speech_final", () => {
  const { live } = fakeLive();
  const utterances: string[] = [];
  const stt = new DeepgramSttStream(() => live);
  stt.start((u) => utterances.push(u));

  live.emit("Results", results("hey manuel", { is_final: false, speech_final: false })); // interim — ignored
  live.emit("Results", results("hey manuel", { is_final: true, speech_final: false }));
  live.emit("Results", results("how are the tests", { is_final: true, speech_final: true }));

  assert.deepEqual(utterances, ["hey manuel how are the tests"]);
});

test("empty transcripts never emit; buffer resets between utterances", () => {
  const { live } = fakeLive();
  const utterances: string[] = [];
  const stt = new DeepgramSttStream(() => live);
  stt.start((u) => utterances.push(u));

  live.emit("Results", results("", { is_final: true, speech_final: true }));
  assert.deepEqual(utterances, []);

  live.emit("Results", results("first", { is_final: true, speech_final: true }));
  live.emit("Results", results("second", { is_final: true, speech_final: true }));
  assert.deepEqual(utterances, ["first", "second"]);
});

test("sendAudio forwards to live; stop closes it", () => {
  const { live, sent, closed } = fakeLive();
  const stt = new DeepgramSttStream(() => live);
  stt.start(() => {});
  const pcm = new Uint8Array([1, 2, 3]);
  stt.sendAudio(pcm);
  assert.deepEqual(sent, [pcm]);
  stt.stop();
  assert.deepEqual(closed, [true]);
});

test("sendAudio before start is a safe no-op", () => {
  const { live } = fakeLive();
  const stt = new DeepgramSttStream(() => live);
  stt.sendAudio(new Uint8Array([9])); // must not throw
});

test("deepgramLiveOptions defaults to multi and preserves the load-bearing options", () => {
  const opts = deepgramLiveOptions(48000, {});
  assert.equal(opts.language, "multi");
  assert.equal(opts.model, "nova-3");
  assert.equal(opts.encoding, "linear16");
  assert.equal(opts.sample_rate, 48000);
  assert.equal(opts.channels, 1);
  assert.equal(opts.interim_results, "true");
  assert.equal(opts.smart_format, "true");
  assert.equal(opts.endpointing, 300);
});

test("DEEPGRAM_LANGUAGE env overrides the language", () => {
  assert.equal(deepgramLiveOptions(24000, { DEEPGRAM_LANGUAGE: "es-419" }).language, "es-419");
  assert.equal(deepgramLiveOptions(24000, { DEEPGRAM_LANGUAGE: "es-419" }).sample_rate, 24000);
});

test("blank DEEPGRAM_LANGUAGE falls back to multi", () => {
  assert.equal(deepgramLiveOptions(48000, { DEEPGRAM_LANGUAGE: "" }).language, "multi");
});
