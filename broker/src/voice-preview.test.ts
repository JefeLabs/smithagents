import assert from "node:assert/strict";
import { test } from "node:test";
import { type PreviewDeps, previewVoice, VOICE_PREVIEW_LINE, voiceOptionsFrom } from "./voice-preview.ts";

// A FAKE cast map, never the real PREMADE_STANDINS — proves voiceOptionsFrom
// actually reads its argument instead of returning a catalog baked into the
// module. A wrong implementation that returns a hardcoded list matching
// today's real PREMADE_STANDINS values would fail this test immediately.
test("voiceOptionsFrom derives {id, label} pairs from the given cast map", () => {
  const options = voiceOptionsFrom({ Zeta: "id-z", Alpha: "id-a" });
  assert.deepEqual(options, [
    { id: "id-z", label: "Zeta" },
    { id: "id-a", label: "Alpha" },
  ]);
});

// Catches an implementation that swaps id/label (returns key as id, value as label).
test("voiceOptionsFrom: id is the voice id, label is the cast name — not swapped", () => {
  const options = voiceOptionsFrom({ Manuel: "ErXwobaYiN019PkySvjV" });
  assert.deepEqual(options, [{ id: "ErXwobaYiN019PkySvjV", label: "Manuel" }]);
});

test("voiceOptionsFrom: an empty cast yields no options, not a fallback list", () => {
  assert.deepEqual(voiceOptionsFrom({}), []);
});

test("VOICE_PREVIEW_LINE is one non-empty constant", () => {
  assert.equal(typeof VOICE_PREVIEW_LINE, "string");
  assert.ok(VOICE_PREVIEW_LINE.trim().length > 0);
});

function deps(overrides: Partial<PreviewDeps> = {}): PreviewDeps {
  return {
    currentTts: async () => ({ synthesize: async () => ({ data: new Uint8Array([1, 2, 3]) }) }),
    noTtsHint: "no tts configured hint",
    standInVoiceId: "stand-in-id",
    timeoutMs: 30_000,
    isTimeout: () => false,
    ...overrides,
  };
}

// A wrong implementation that skips base64-encoding, or hardcodes the wrong
// mime string (e.g. "audio/mp3"), fails this exact-shape comparison.
test("previewVoice: success resolves {mime: audio/mpeg, dataB64} with the synthesized bytes", async () => {
  const result = await previewVoice("voice-1", "hello", deps());
  assert.deepEqual(result, { mime: "audio/mpeg", dataB64: Buffer.from([1, 2, 3]).toString("base64") });
});

// A wrong implementation that throws instead of resolving would make this
// `await` reject and the test fail on an uncaught rejection rather than on
// the assertion below — proving the refusal is a RESOLVED value.
test("previewVoice: no TTS configured resolves the exact human hint, never throws", async () => {
  const result = await previewVoice("voice-1", "hello", deps({ currentTts: async () => null }));
  assert.deepEqual(result, { error: "no tts configured hint" });
});

// A wrong implementation that swallows the underlying message (returns a
// generic "failed" with no detail) fails the regex match below.
test("previewVoice: a provider throw resolves {error} with the real reason, never rejects or hangs", async () => {
  const result = await previewVoice(
    "voice-1",
    "hello",
    deps({
      currentTts: async () => ({
        synthesize: async () => {
          throw new Error("network exploded");
        },
      }),
    }),
  );
  assert.ok("error" in result);
  assert.match((result as { error: string }).error, /network exploded/);
});

// A wrong implementation that treats every failure the same (no 402
// discrimination, no retry) resolves {error} here instead of the stand-in's
// audio — this deepEqual against the SUCCESS shape catches that.
test("previewVoice: a 402 on the requested voice retries once with the stand-in and returns its audio", async () => {
  const calls: string[] = [];
  const result = await previewVoice(
    "gated-voice",
    "hello",
    deps({
      standInVoiceId: "stand-in-id",
      currentTts: async () => ({
        synthesize: async ({ voiceId }) => {
          calls.push(voiceId);
          if (voiceId === "gated-voice") throw new Error("402 payment_required");
          return { data: new Uint8Array([9, 9]) };
        },
      }),
    }),
  );
  assert.deepEqual(result, { mime: "audio/mpeg", dataB64: Buffer.from([9, 9]).toString("base64") });
  assert.deepEqual(calls, ["gated-voice", "stand-in-id"]);
});

// A wrong implementation with no same-id guard would call synthesize a
// second, pointlessly identical time; asserting calls.length === 1 catches
// the missing guard even though the final {error} shape looks the same.
test("previewVoice: a 402 on the stand-in itself does not retry again", async () => {
  const calls: string[] = [];
  const result = await previewVoice(
    "stand-in-id",
    "hello",
    deps({
      standInVoiceId: "stand-in-id",
      currentTts: async () => ({
        synthesize: async ({ voiceId }) => {
          calls.push(voiceId);
          throw new Error("402 payment_required");
        },
      }),
    }),
  );
  assert.ok("error" in result);
  assert.deepEqual(calls, ["stand-in-id"]);
});

// A wrong implementation that ignores the injected isTimeout (e.g. checks
// err.name === "AbortError" internally instead of delegating) would not
// recognize this custom TimeoutError and would fall through to the 402
// path, making a second call — the calls-length assertion catches that.
test("previewVoice: a timeout resolves {error} via the injected isTimeout, with no 402 retry", async () => {
  const calls: string[] = [];
  const result = await previewVoice(
    "voice-1",
    "hello",
    deps({
      isTimeout: (err) => (err as Error)?.name === "TotallyMadeUpTimeoutError",
      currentTts: async () => ({
        synthesize: async ({ voiceId }) => {
          calls.push(voiceId);
          const err = new Error("timed out");
          err.name = "TotallyMadeUpTimeoutError";
          throw err;
        },
      }),
    }),
  );
  assert.ok("error" in result);
  assert.deepEqual(calls, ["voice-1"]);
});
