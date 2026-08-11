import assert from "node:assert/strict";
import { test } from "node:test";
import type { VoiceKeys } from "./swarm-client.ts";
import { VOICE_KEYS_TTL_MS, VoiceKeyResolver } from "./voice-keys.ts";

const KEYS: VoiceKeys = { stt: { vendorId: "deepgram", apiKey: "dg" }, tts: { vendorId: "elevenlabs", apiKey: "el" } };

function makeSwarm(responses: Array<VoiceKeys | null>) {
  let calls = 0;
  return {
    calls: () => calls,
    client: {
      getVoiceKeys: async () => {
        calls++;
        return responses[Math.min(calls - 1, responses.length - 1)];
      },
    },
  };
}

test("resolves keys and caches within the TTL", async () => {
  let now = 0;
  const swarm = makeSwarm([KEYS]);
  const r = new VoiceKeyResolver(swarm.client, () => now);
  assert.equal(await r.sttKey(), "dg");
  assert.equal(await r.ttsKey(), "el");
  assert.equal(swarm.calls(), 1); // second read inside TTL hits cache
  now = VOICE_KEYS_TTL_MS + 1;
  assert.equal(await r.sttKey(), "dg");
  assert.equal(swarm.calls(), 2); // TTL expiry refetches
});

test("unset keys resolve null and status false", async () => {
  const r = new VoiceKeyResolver(makeSwarm([{ stt: null, tts: null }]).client, () => 0);
  assert.equal(await r.sttKey(), null);
  assert.deepEqual(await r.status(), { stt: false, tts: false });
});

test("swarm unreachable (null) keeps the last good keys", async () => {
  let now = 0;
  const r = new VoiceKeyResolver(makeSwarm([KEYS, null]).client, () => now);
  assert.equal(await r.sttKey(), "dg");
  now = VOICE_KEYS_TTL_MS + 1;
  assert.equal(await r.sttKey(), "dg"); // refresh returned null → cached keys survive
});

test("a key change is picked up after the TTL", async () => {
  let now = 0;
  const rotated: VoiceKeys = { stt: { vendorId: "deepgram", apiKey: "dg2" }, tts: null };
  const r = new VoiceKeyResolver(makeSwarm([KEYS, rotated]).client, () => now);
  assert.equal(await r.sttKey(), "dg");
  now = VOICE_KEYS_TTL_MS + 1;
  assert.equal(await r.sttKey(), "dg2");
  assert.equal(await r.ttsKey(), null);
});

test("statusSync returns the cached snapshot without awaiting", async () => {
  const r = new VoiceKeyResolver(makeSwarm([KEYS]).client, () => 0);
  assert.deepEqual(r.statusSync(), { stt: false, tts: false }); // nothing fetched yet
  await r.status(); // warm
  assert.deepEqual(r.statusSync(), { stt: true, tts: true });
});

test("concurrent calls while stale deduplicate (single refresh)", async () => {
  let now = 0;
  const swarm = makeSwarm([KEYS]);
  const r = new VoiceKeyResolver(swarm.client, () => now);

  // Warm the cache
  await r.sttKey();
  assert.equal(swarm.calls(), 1);

  // Advance past TTL
  now = VOICE_KEYS_TTL_MS + 1;

  // Multiple overlapping calls while stale: should deduplicate to one refresh
  const [stt1, tts1, stt2] = await Promise.all([r.sttKey(), r.ttsKey(), r.sttKey()]);
  assert.equal(stt1, "dg");
  assert.equal(tts1, "el");
  assert.equal(stt2, "dg");
  assert.equal(swarm.calls(), 2); // exactly one refresh despite three awaits
});

test("swarm rejection keeps last-good cache and allows retry", async () => {
  let now = 0;
  let callCount = 0;
  const r = new VoiceKeyResolver(
    {
      getVoiceKeys: async () => {
        callCount++;
        if (callCount === 1) return KEYS; // warm the cache
        if (callCount === 2) throw new Error("swarm crashed"); // rejection
        return KEYS; // recovery
      },
    },
    () => now,
  );

  // Warm with good keys
  assert.equal(await r.sttKey(), "dg");
  assert.equal(callCount, 1);

  // Advance past TTL
  now = VOICE_KEYS_TTL_MS + 1;

  // Refresh hits rejection: should keep last-good, not throw
  assert.equal(await r.sttKey(), "dg");
  assert.equal(callCount, 2);

  // Advance past TTL again
  now = VOICE_KEYS_TTL_MS * 2 + 1;

  // Next TTL window retries and succeeds
  assert.equal(await r.sttKey(), "dg");
  assert.equal(callCount, 3);
});
