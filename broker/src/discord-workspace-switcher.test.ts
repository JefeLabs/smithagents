import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordWorkspaceSwitcher, type DiscordWorkspaceSwitcherDeps } from './discord-workspace-switcher.ts';

type Config = { botToken: string; textChannels: string[]; voiceChannels: string[] } | null;

function fakeDeps(configsByWorkspace: Record<string, Config>, overrides: Partial<DiscordWorkspaceSwitcherDeps> = {}) {
  const calls: string[] = [];
  const deps: DiscordWorkspaceSwitcherDeps = {
    swarm: {
      getWorkspaceDiscordConfig: async (name) => {
        calls.push(`getConfig:${name}`);
        return configsByWorkspace[name] ?? null;
      },
    },
    discordTextLifecycle: {
      teardownDiscordText: async () => {
        calls.push('teardownText');
      },
      bootDiscordText: async (token, textChannels) => {
        calls.push(`bootText:${token}:${textChannels.join(',')}`);
        return { stop: async () => {} };
      },
    },
    discordVoiceLifecycle: {
      teardownDiscordVoice: async () => {
        calls.push('teardownVoice');
      },
      bootDiscordVoice: async (token, allowlist) => {
        calls.push(`bootVoice:${token}:${allowlist.join(',')}`);
        return async () => {};
      },
    },
    ...overrides,
  };
  return { deps, calls };
}

test('switchDiscordForWorkspace: tears down both surfaces before booting the new config, in text-then-voice order', async () => {
  const { deps, calls } = fakeDeps({
    acme: { botToken: 'tok-acme', textChannels: ['general'], voiceChannels: ['lobby'] },
  });
  const switcher = createDiscordWorkspaceSwitcher(deps);
  await switcher.switchDiscordForWorkspace('acme');
  assert.deepEqual(calls, [
    'teardownText',
    'teardownVoice',
    'getConfig:acme',
    'bootText:tok-acme:general',
    'bootVoice:tok-acme:lobby',
  ]);
});

test('switchDiscordForWorkspace: a workspace with no Discord config tears down without booting anything new', async () => {
  const { deps, calls } = fakeDeps({});
  const switcher = createDiscordWorkspaceSwitcher(deps);
  await switcher.switchDiscordForWorkspace('no-discord');
  assert.deepEqual(calls, ['teardownText', 'teardownVoice', 'getConfig:no-discord']);
});

test('switchDiscordForWorkspace: empty voiceChannels boots text but skips the voice boot entirely', async () => {
  const { deps, calls } = fakeDeps({
    acme: { botToken: 'tok-acme', textChannels: ['general'], voiceChannels: [] },
  });
  const switcher = createDiscordWorkspaceSwitcher(deps);
  await switcher.switchDiscordForWorkspace('acme');
  assert.deepEqual(calls, ['teardownText', 'teardownVoice', 'getConfig:acme', 'bootText:tok-acme:general']);
});

test('switchDiscordForWorkspace: different workspaces resolve and boot their own distinct config', async () => {
  const { deps, calls } = fakeDeps({
    acme: { botToken: 'tok-acme', textChannels: ['acme-general'], voiceChannels: [] },
    globex: { botToken: 'tok-globex', textChannels: ['globex-general'], voiceChannels: ['globex-lobby'] },
  });
  const switcher = createDiscordWorkspaceSwitcher(deps);
  await switcher.switchDiscordForWorkspace('acme');
  await switcher.switchDiscordForWorkspace('globex');
  assert.deepEqual(calls, [
    'teardownText',
    'teardownVoice',
    'getConfig:acme',
    'bootText:tok-acme:acme-general',
    'teardownText',
    'teardownVoice',
    'getConfig:globex',
    'bootText:tok-globex:globex-general',
    'bootVoice:tok-globex:globex-lobby',
  ]);
});

test("switchDiscordForWorkspace: a text-boot failure doesn't block attempting the voice boot, and doesn't reject", async () => {
  const { deps, calls } = fakeDeps(
    { acme: { botToken: 'tok-acme', textChannels: ['general'], voiceChannels: ['lobby'] } },
    {
      discordTextLifecycle: {
        teardownDiscordText: async () => void calls.push('teardownText'),
        bootDiscordText: async () => {
          throw new Error('text boot exploded');
        },
      },
    },
  );
  const switcher = createDiscordWorkspaceSwitcher(deps);
  await assert.doesNotReject(() => switcher.switchDiscordForWorkspace('acme'));
  assert.deepEqual(calls, ['teardownText', 'teardownVoice', 'getConfig:acme', 'bootVoice:tok-acme:lobby']);
});

test("switchDiscordForWorkspace: a voice-boot failure doesn't reject the overall switch", async () => {
  const { deps, calls } = fakeDeps(
    { acme: { botToken: 'tok-acme', textChannels: ['general'], voiceChannels: ['lobby'] } },
    {
      discordVoiceLifecycle: {
        teardownDiscordVoice: async () => void calls.push('teardownVoice'),
        bootDiscordVoice: async () => {
          throw new Error('voice boot exploded');
        },
      },
    },
  );
  const switcher = createDiscordWorkspaceSwitcher(deps);
  await assert.doesNotReject(() => switcher.switchDiscordForWorkspace('acme'));
  assert.deepEqual(calls, ['teardownText', 'teardownVoice', 'getConfig:acme', 'bootText:tok-acme:general']);
});
