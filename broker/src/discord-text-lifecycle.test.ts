import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordTextLifecycle, type DiscordTextHub } from './discord-text-lifecycle.ts';
import type { ChannelAdapter, ChannelUtterance } from './channels.ts';
import type { DiscordAdapterOptions } from './discord-adapter.ts';

function fakeHub() {
  const registered: ChannelAdapter[] = [];
  const unregistered: string[] = [];
  const utterances: Array<{ kind: string; u: ChannelUtterance }> = [];
  const hub: DiscordTextHub = {
    register: (adapter) => void registered.push(adapter),
    unregister: (kind) => void unregistered.push(kind),
    onUtterance: (kind, u) => void utterances.push({ kind, u }),
  };
  return { hub, registered, unregistered, utterances };
}

// Models createDiscordAdapter's real return shape without touching discord.js.
function fakeCreateDiscordAdapter() {
  const stopCalls: number[] = [];
  let calls = 0;
  const adapter: ChannelAdapter = { kind: 'discord', deliver: async () => {} };
  const createDiscordAdapter = async () => {
    calls += 1;
    return {
      adapter,
      stop: async () => {
        stopCalls.push(calls);
      },
    };
  };
  return { createDiscordAdapter, stopCalls, calls: () => calls };
}

test('bootDiscordText: empty textChannels returns null without starting a client', async () => {
  const { hub } = fakeHub();
  const { createDiscordAdapter, calls } = fakeCreateDiscordAdapter();
  const lifecycle = createDiscordTextLifecycle({ hub, createDiscordAdapter });
  const result = await lifecycle.bootDiscordText('tok', []);
  assert.equal(result, null);
  assert.equal(calls(), 0);
  assert.equal(lifecycle.activeDiscordText, null);
});

test('bootDiscordText registers the adapter with the hub and tracks it as active', async () => {
  const { hub, registered } = fakeHub();
  const { createDiscordAdapter } = fakeCreateDiscordAdapter();
  const lifecycle = createDiscordTextLifecycle({ hub, createDiscordAdapter });
  const result = await lifecycle.bootDiscordText('tok', ['chan-1']);
  assert.notEqual(result, null);
  assert.equal(registered.length, 1);
  assert.equal(registered[0]!.kind, 'discord');
  assert.equal(lifecycle.activeDiscordText, result);
});

test("bootDiscordText's onUtterance callback forwards to hub.onUtterance tagged 'discord'", async () => {
  const { hub, utterances } = fakeHub();
  let capturedOnUtterance: ((u: ChannelUtterance) => void) | undefined;
  const createDiscordAdapter = async (opts: DiscordAdapterOptions) => {
    capturedOnUtterance = opts.onUtterance;
    return { adapter: { kind: 'discord', deliver: async () => {} }, stop: async () => {} };
  };
  const lifecycle = createDiscordTextLifecycle({ hub, createDiscordAdapter });
  await lifecycle.bootDiscordText('tok', ['chan-1']);
  capturedOnUtterance!({ text: 'hola', author: 'Edwin', channelRef: 'chan-1' });
  assert.deepEqual(utterances, [{ kind: 'discord', u: { text: 'hola', author: 'Edwin', channelRef: 'chan-1' } }]);
});

test('bootDiscordText then teardownDiscordText: stop() is called exactly once, activeDiscordText resets to null', async () => {
  const { hub, unregistered } = fakeHub();
  const { createDiscordAdapter, stopCalls } = fakeCreateDiscordAdapter();
  const lifecycle = createDiscordTextLifecycle({ hub, createDiscordAdapter });
  await lifecycle.bootDiscordText('tok', ['chan-1']);
  await lifecycle.teardownDiscordText();
  assert.equal(stopCalls.length, 1);
  assert.deepEqual(unregistered, ['discord']);
  assert.equal(lifecycle.activeDiscordText, null);

  // Idempotent: a second teardown with nothing active is a no-op, not a second stop().
  await lifecycle.teardownDiscordText();
  assert.equal(stopCalls.length, 1);
});

test('teardownDiscordText with nothing active is a no-op', async () => {
  const { hub, unregistered } = fakeHub();
  const { createDiscordAdapter } = fakeCreateDiscordAdapter();
  const lifecycle = createDiscordTextLifecycle({ hub, createDiscordAdapter });
  await lifecycle.teardownDiscordText();
  assert.equal(unregistered.length, 0);
  assert.equal(lifecycle.activeDiscordText, null);
});

test('teardownDiscordText logs and still clears state when stop() rejects', async () => {
  const { hub, unregistered } = fakeHub();
  const createDiscordAdapter = async () => ({
    adapter: { kind: 'discord', deliver: async () => {} } as ChannelAdapter,
    stop: async () => {
      throw new Error('destroy failed');
    },
  });
  const lifecycle = createDiscordTextLifecycle({ hub, createDiscordAdapter });
  await lifecycle.bootDiscordText('tok', ['chan-1']);
  await assert.doesNotReject(() => lifecycle.teardownDiscordText());
  assert.deepEqual(unregistered, ['discord']);
  assert.equal(lifecycle.activeDiscordText, null);
});

test('two independent lifecycles do not share state', async () => {
  const a = fakeHub();
  const b = fakeHub();
  const lifecycleA = createDiscordTextLifecycle({ hub: a.hub, createDiscordAdapter: fakeCreateDiscordAdapter().createDiscordAdapter });
  const lifecycleB = createDiscordTextLifecycle({ hub: b.hub, createDiscordAdapter: fakeCreateDiscordAdapter().createDiscordAdapter });
  await lifecycleA.bootDiscordText('tok', ['chan-1']);
  assert.notEqual(lifecycleA.activeDiscordText, null);
  assert.equal(lifecycleB.activeDiscordText, null);
});
