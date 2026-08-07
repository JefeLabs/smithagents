import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceKeyResolver, VOICE_KEYS_TTL_MS } from './voice-keys.ts';
import type { VoiceKeys } from './swarm-client.ts';

const KEYS: VoiceKeys = { stt: { vendorId: 'deepgram', apiKey: 'dg' }, tts: { vendorId: 'elevenlabs', apiKey: 'el' } };

function makeSwarm(responses: Array<VoiceKeys | null>) {
  let calls = 0;
  return {
    calls: () => calls,
    client: { getVoiceKeys: async () => { calls++; return responses[Math.min(calls - 1, responses.length - 1)]; } },
  };
}

test('resolves keys and caches within the TTL', async () => {
  let now = 0;
  const swarm = makeSwarm([KEYS]);
  const r = new VoiceKeyResolver(swarm.client, () => now);
  assert.equal(await r.sttKey(), 'dg');
  assert.equal(await r.ttsKey(), 'el');
  assert.equal(swarm.calls(), 1); // second read inside TTL hits cache
  now = VOICE_KEYS_TTL_MS + 1;
  assert.equal(await r.sttKey(), 'dg');
  assert.equal(swarm.calls(), 2); // TTL expiry refetches
});

test('unset keys resolve null and status false', async () => {
  const r = new VoiceKeyResolver(makeSwarm([{ stt: null, tts: null }]).client, () => 0);
  assert.equal(await r.sttKey(), null);
  assert.deepEqual(await r.status(), { stt: false, tts: false });
});

test('swarm unreachable (null) keeps the last good keys', async () => {
  let now = 0;
  const r = new VoiceKeyResolver(makeSwarm([KEYS, null]).client, () => now);
  assert.equal(await r.sttKey(), 'dg');
  now = VOICE_KEYS_TTL_MS + 1;
  assert.equal(await r.sttKey(), 'dg'); // refresh returned null → cached keys survive
});

test('a key change is picked up after the TTL', async () => {
  let now = 0;
  const rotated: VoiceKeys = { stt: { vendorId: 'deepgram', apiKey: 'dg2' }, tts: null };
  const r = new VoiceKeyResolver(makeSwarm([KEYS, rotated]).client, () => now);
  assert.equal(await r.sttKey(), 'dg');
  now = VOICE_KEYS_TTL_MS + 1;
  assert.equal(await r.sttKey(), 'dg2');
  assert.equal(await r.ttsKey(), null);
});

test('statusSync returns the cached snapshot without awaiting', async () => {
  const r = new VoiceKeyResolver(makeSwarm([KEYS]).client, () => 0);
  assert.deepEqual(r.statusSync(), { stt: false, tts: false }); // nothing fetched yet
  await r.status(); // warm
  assert.deepEqual(r.statusSync(), { stt: true, tts: true });
});
