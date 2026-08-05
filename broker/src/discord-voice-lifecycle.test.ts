import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDiscordVoiceLifecycle,
  type DiscordEarClientLike,
  type DiscordEarVoiceStateLike,
  type DiscordVoiceLifecycleDeps,
} from './discord-voice-lifecycle.ts';
import type { createDiscordVoiceSurface } from './discord-voice.ts';
import type { VoicePresence } from './voice-presence.ts';

type Surface = ReturnType<typeof createDiscordVoiceSurface>;

/** Models createEarClient's real return shape without touching discord.js or the network. */
function fakeEarClient() {
  const loginCalls: string[] = [];
  let destroyCalls = 0;
  const voiceStateHandlers: Array<(oldState: DiscordEarVoiceStateLike, newState: DiscordEarVoiceStateLike) => void> = [];
  const client: DiscordEarClientLike = {
    login: async (token) => {
      loginCalls.push(token);
    },
    destroy: async () => {
      destroyCalls += 1;
    },
    on: (event, handler) => {
      if (event === 'voiceStateUpdate') voiceStateHandlers.push(handler);
    },
    channels: {
      fetch: async () => {
        throw new Error('channels.fetch should not be called in this test');
      },
      cache: { get: () => undefined },
    },
  };
  return {
    client,
    loginCalls,
    destroyCalls: () => destroyCalls,
    voiceStateHandlers,
  };
}

function fakeDeps(overrides: Partial<DiscordVoiceLifecycleDeps> = {}) {
  const revoked: string[] = [];
  const attachCalls: Array<{ publishPcm: unknown }> = [];
  let detachCalls = 0;
  const utterances: string[] = [];
  const surfaceChanges: Array<{ surface: Surface | null; presence: VoicePresence | null }> = [];
  const deps: DiscordVoiceLifecycleDeps = {
    directory: { list: () => [] },
    policy: { revokeAll: (surface) => void revoked.push(surface) },
    broker: {
      attachVoiceSurface: (surface) => {
        attachCalls.push(surface);
        return true;
      },
      detachVoiceSurface: () => {
        detachCalls += 1;
      },
    },
    onUtterance: (text) => void utterances.push(text),
    makeStt: () => {
      throw new Error('makeStt should not be called in this test');
    },
    onSurfaceChange: (surface, presence) => void surfaceChanges.push({ surface, presence }),
    checkFfmpeg: () => true,
    ...overrides,
  };
  return { deps, revoked, attachCalls, detachCalls: () => detachCalls, utterances, surfaceChanges };
}

test('bootDiscordVoice: ffmpeg unavailable returns null without constructing an ear client', async () => {
  const { deps, surfaceChanges } = fakeDeps({
    checkFfmpeg: () => false,
    createEarClient: () => {
      throw new Error('createEarClient should not be called when ffmpeg is unavailable');
    },
  });
  const lifecycle = createDiscordVoiceLifecycle(deps);
  const result = await lifecycle.bootDiscordVoice('tok', ['chan-1']);
  assert.equal(result, null);
  assert.deepEqual(surfaceChanges, []);
});

test('bootDiscordVoice: missing token returns null without constructing an ear client', async () => {
  const { deps, surfaceChanges } = fakeDeps({
    createEarClient: () => {
      throw new Error('createEarClient should not be called when the token is missing');
    },
  });
  const lifecycle = createDiscordVoiceLifecycle(deps);
  const result = await lifecycle.bootDiscordVoice(undefined, ['chan-1']);
  assert.equal(result, null);
  assert.deepEqual(surfaceChanges, []);
});

test('bootDiscordVoice: logs in the injected ear client and reports the new surface/presence via onSurfaceChange', async () => {
  const fakeClient = fakeEarClient();
  const { deps, surfaceChanges } = fakeDeps({ createEarClient: () => fakeClient.client });
  const lifecycle = createDiscordVoiceLifecycle(deps);
  const teardown = await lifecycle.bootDiscordVoice('ear-tok', ['chan-1']);

  assert.equal(typeof teardown, 'function');
  assert.deepEqual(fakeClient.loginCalls, ['ear-tok']);
  assert.equal(surfaceChanges.length, 1);
  assert.notEqual(surfaceChanges[0]!.surface, null);
  assert.notEqual(surfaceChanges[0]!.presence, null);
  // Registers exactly one voiceStateUpdate listener on the ear client for presence tracking.
  assert.equal(fakeClient.voiceStateHandlers.length, 1);
});

test('the returned teardown closure destroys the ear client, revokes discord-voice admissions, detaches the broker surface, and resets onSurfaceChange to (null, null)', async () => {
  const fakeClient = fakeEarClient();
  const { deps, revoked, detachCalls, surfaceChanges } = fakeDeps({ createEarClient: () => fakeClient.client });
  const lifecycle = createDiscordVoiceLifecycle(deps);
  const teardown = await lifecycle.bootDiscordVoice('ear-tok', ['chan-1']);

  await teardown!();

  assert.equal(fakeClient.destroyCalls(), 1);
  assert.deepEqual(revoked, ['discord-voice']);
  assert.equal(detachCalls(), 1);
  assert.equal(surfaceChanges.length, 2);
  assert.deepEqual(surfaceChanges[1], { surface: null, presence: null });
});

test('teardown is safe when nothing was ever joined — leaveAll no-ops rather than throwing', async () => {
  const fakeClient = fakeEarClient();
  const { deps } = fakeDeps({ createEarClient: () => fakeClient.client });
  const lifecycle = createDiscordVoiceLifecycle(deps);
  const teardown = await lifecycle.bootDiscordVoice('ear-tok', ['chan-1']);

  await assert.doesNotReject(() => teardown!());
  assert.equal(fakeClient.destroyCalls(), 1);
});

test('bootDiscordVoice can be called again after a previous teardown, logging in a fresh ear client', async () => {
  const clients = [fakeEarClient(), fakeEarClient()];
  let created = 0;
  const { deps, surfaceChanges } = fakeDeps({
    createEarClient: () => clients[created++]!.client,
  });
  const lifecycle = createDiscordVoiceLifecycle(deps);

  const firstTeardown = await lifecycle.bootDiscordVoice('tok', ['chan-1']);
  await firstTeardown!();
  const secondTeardown = await lifecycle.bootDiscordVoice('tok', ['chan-1']);

  assert.equal(created, 2);
  assert.deepEqual(clients[0]!.loginCalls, ['tok']);
  assert.equal(clients[0]!.destroyCalls(), 1);
  assert.deepEqual(clients[1]!.loginCalls, ['tok']);
  assert.equal(clients[1]!.destroyCalls(), 0);
  // (null,null) from the first teardown, then a fresh (surface,presence) from the second boot.
  assert.equal(surfaceChanges.length, 3);
  assert.deepEqual(surfaceChanges[1], { surface: null, presence: null });
  assert.notEqual(surfaceChanges[2]!.surface, null);

  await secondTeardown!();
  assert.equal(clients[1]!.destroyCalls(), 1);
});

test('two independent lifecycles do not share state', async () => {
  const a = fakeDeps({ createEarClient: () => fakeEarClient().client });
  const b = fakeDeps({ createEarClient: () => fakeEarClient().client });
  const lifecycleA = createDiscordVoiceLifecycle(a.deps);
  const lifecycleB = createDiscordVoiceLifecycle(b.deps);

  await lifecycleA.bootDiscordVoice('tok', ['chan-1']);
  assert.equal(a.surfaceChanges.length, 1);
  assert.equal(b.surfaceChanges.length, 0);
});
