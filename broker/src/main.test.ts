import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentDirectory } from './directory.ts';
import { SurfacePolicy } from './surface-modes.ts';
import type { RegistryAgent } from './swarm-client.ts';

// Fake discord lifecycle for testing
function fakeDiscordTextLifecycle(activeState?: unknown) {
  return {
    activeDiscordText: activeState ?? null,
    bootDiscordText: async () => ({}),
    teardownDiscordText: async () => {},
  };
}

// Test helper: creates a fake RegistryAgent
function fakeAgent(id: string, channels?: Record<string, string>): RegistryAgent {
  return {
    id,
    name: `Agent ${id}`,
    role: 'developer',
    directives: 'work on code',
    engine: { cli: 'claude', model: 'claude-3-sonnet' },
    channels,
  };
}

// Test helper: creates a surfaces object matching main.ts's structure
function createSurfacesUnderTest(overrides?: { voiceSurface?: unknown; discordTextLifecycle?: unknown }) {
  const directory = new AgentDirectory();
  const policy = new SurfacePolicy(() => directory.list());
  let voiceSurface: unknown = overrides?.voiceSurface ?? null;
  const discordTextLifecycle = overrides?.discordTextLifecycle ?? fakeDiscordTextLifecycle();

  const surfaces = {
    presence: () => {
      const out: Record<string, Record<string, boolean>> = {};
      const voiceIds = new Set((voiceSurface as any)?.connectedAgentIds?.() ?? []);
      for (const a of directory.list()) {
        out[a.id] = {
          tauri: policy.attends(a.id, 'tauri'),
          discord: (discordTextLifecycle as any).activeDiscordText !== null && policy.attends(a.id, 'discord'),
          'discord-voice': voiceIds.has(a.id),
        };
      }
      return out;
    },
    info: () => ({
      configured: (discordTextLifecycle as any).activeDiscordText !== null,
      voiceReady: voiceSurface !== null,
    }),
  };

  return { directory, policy, surfaces };
}

test('surfaces.info() reflects activeDiscordText state, not env var', () => {
  // When activeDiscordText is null: configured should be false
  const { surfaces } = createSurfacesUnderTest({ discordTextLifecycle: fakeDiscordTextLifecycle(null) });
  const infoNoDiscord = surfaces.info();
  assert.equal(infoNoDiscord.configured, false, 'configured should be false when activeDiscordText is null');

  // When activeDiscordText is set (non-null): configured should be true
  const { surfaces: surfaces2 } = createSurfacesUnderTest({
    discordTextLifecycle: fakeDiscordTextLifecycle({ some: 'adapter' }),
  });
  const infoWithDiscord = surfaces2.info();
  assert.equal(infoWithDiscord.configured, true, 'configured should be true when activeDiscordText is set');
});

test('surfaces.info() reflects voiceSurface state separately', () => {
  // When voiceSurface is null: voiceReady should be false
  const { surfaces } = createSurfacesUnderTest({ voiceSurface: null });
  const infoNoVoice = surfaces.info();
  assert.equal(infoNoVoice.voiceReady, false, 'voiceReady should be false when voiceSurface is null');

  // When voiceSurface is set: voiceReady should be true
  const fakeVoiceSurface = { connectedAgentIds: () => [] };
  const { surfaces: surfaces2 } = createSurfacesUnderTest({ voiceSurface: fakeVoiceSurface });
  const infoWithVoice = surfaces2.info();
  assert.equal(infoWithVoice.voiceReady, true, 'voiceReady should be true when voiceSurface is set');
});

test('surfaces.presence() includes discord only when activeDiscordText !== null', () => {
  const { directory, surfaces: surfacesNoDiscord } = createSurfacesUnderTest({ discordTextLifecycle: fakeDiscordTextLifecycle(null) });

  // Seed a test agent
  directory.seed([fakeAgent('test-agent', { discord: 'autojoin', tauri: 'autojoin' })]);

  // No Discord: presence shows discord: false
  let presence = surfacesNoDiscord.presence();
  assert.equal(presence['test-agent'].discord, false, 'discord should be false when activeDiscordText is null');

  // With Discord booted: presence shows discord: true (with policy allowing autojoin)
  const { directory: dir2, surfaces: surfacesWithDiscord } = createSurfacesUnderTest({
    discordTextLifecycle: fakeDiscordTextLifecycle({ some: 'adapter' }),
  });
  dir2.seed([fakeAgent('test-agent', { discord: 'autojoin', tauri: 'autojoin' })]);
  presence = surfacesWithDiscord.presence();
  assert.equal(presence['test-agent'].discord, true, 'discord should be true when activeDiscordText is set and agent is autojoin');
});

test('surfaces.presence() respects policy.attends for discord', () => {
  const { directory, policy, surfaces } = createSurfacesUnderTest({
    discordTextLifecycle: fakeDiscordTextLifecycle({ some: 'adapter' }),
  });

  // Seed an agent with discord: on-request (not autojoin)
  directory.seed([fakeAgent('on-request-agent', { discord: 'on-request', tauri: 'autojoin' })]);

  let presence = surfaces.presence();
  // Even though Discord is configured, on-request agents don't attend unless admitted
  assert.equal(presence['on-request-agent'].discord, false, 'discord should be false for on-request agent not yet admitted');

  // Admit the agent
  policy.admit('on-request-agent', 'discord');
  presence = surfaces.presence();
  assert.equal(presence['on-request-agent'].discord, true, 'discord should be true for on-request agent after admission');
});

test('surfaces.presence() ignores disabled agents on discord', () => {
  const { directory, surfaces } = createSurfacesUnderTest({
    discordTextLifecycle: fakeDiscordTextLifecycle({ some: 'adapter' }),
  });

  // Seed an agent with discord: disabled
  directory.seed([fakeAgent('disabled-agent', { discord: 'disabled', tauri: 'autojoin' })]);

  const presence = surfaces.presence();
  assert.equal(presence['disabled-agent'].discord, false, 'discord should be false for disabled agent');
});
