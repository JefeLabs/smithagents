import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveAvatarEngine } from './avatar-engine.ts';
import type { ImagesClient } from './avatar-generator.ts';

const fakeClient = (tag: string): ImagesClient =>
  ({ models: { generateContent: async () => ({ candidates: [], tag }) } }) as unknown as ImagesClient;

test('verified google key wins -> api engine with that key', async () => {
  let seenKey = '';
  const engine = await resolveAvatarEngine({
    getGoogleKey: async () => 'sk-g-123',
    isAgyActive: async () => true, // even with agy available, key accelerates
    makeApiClient: (key) => {
      seenKey = key;
      return fakeClient('api');
    },
    makeAgyClient: () => fakeClient('agy'),
  });
  assert.equal(engine?.kind, 'api');
  assert.equal(seenKey, 'sk-g-123');
});

test('no key, agy active -> agy engine', async () => {
  const engine = await resolveAvatarEngine({
    getGoogleKey: async () => null,
    isAgyActive: async () => true,
    makeAgyClient: () => fakeClient('agy'),
  });
  assert.equal(engine?.kind, 'agy');
});

test('neither -> null', async () => {
  assert.equal(
    await resolveAvatarEngine({ getGoogleKey: async () => null, isAgyActive: async () => false }),
    null,
  );
});
