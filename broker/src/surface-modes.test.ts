import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyModeChange, decideJoin, SurfacePolicy, surfaceModes } from './surface-modes.ts';

test('legacy array: listed surfaces autojoin, unlisted disabled, tauri retired', () => {
  assert.deepEqual(surfaceModes({ channels: ['tauri', 'discord'] }), {
    discord: 'autojoin',
    'discord-voice': 'disabled',
  });
});

test('absent channels field: discord autojoin, voice disabled, no tauri key', () => {
  assert.deepEqual(surfaceModes({}), {
    discord: 'autojoin',
    'discord-voice': 'disabled',
  });
});

test('map form: tauri key dropped, absent key disabled, unknown surfaces preserved, bad values fail closed', () => {
  const modes = surfaceModes({
    channels: { tauri: 'on-request', 'discord-voice': 'on-request', matrix: 'autojoin', discord: 'sometimes' },
  });
  assert.equal('tauri' in modes, false); // retired: parsed away even when present
  assert.equal(modes['discord-voice'], 'on-request');
  assert.equal(modes.matrix, 'autojoin'); // unknown surface passes through
  assert.equal(modes.discord, 'disabled'); // unrecognized value fails closed
});

test('non-object, non-array channels: all disabled, no tauri key', () => {
  assert.deepEqual(surfaceModes({ channels: 'discord' }), {
    discord: 'disabled',
    'discord-voice': 'disabled',
  });
});

test('policy: attends = autojoin, or on-request + admitted; tauri never attends; revoked on demand', () => {
  const agents = [{ id: 'ignacio', channels: { discord: 'on-request', tauri: 'autojoin' } }];
  const policy = new SurfacePolicy(() => agents);
  assert.equal(policy.attends('ignacio', 'tauri'), false); // retired surface: no mode, no attendance
  assert.equal(policy.attends('ignacio', 'discord'), false);
  policy.admit('ignacio', 'discord');
  assert.equal(policy.attends('ignacio', 'discord'), true);
  policy.revoke('ignacio', 'discord');
  assert.equal(policy.attends('ignacio', 'discord'), false);
  policy.admit('ignacio', 'discord');
  policy.revokeAll('discord');
  assert.equal(policy.attends('ignacio', 'discord'), false);
  assert.equal(policy.attends('ghost', 'discord'), false); // unknown agent: disabled
});

test('applyModeChange: voice disable ejects; autojoin flip joins only with a room', async () => {
  const calls: string[] = [];
  const deps = {
    leaveAgent: (id: string) => calls.push(`leave:${id}`),
    joinAgent: async (id: string) => {
      calls.push(`join:${id}`);
    },
    roomActive: () => true,
    revoke: (id: string, s: string) => calls.push(`revoke:${id}:${s}`),
    log: () => {},
  };
  await applyModeChange(deps, 'ignacio', { 'discord-voice': 'autojoin' }, { 'discord-voice': 'disabled' });
  assert.deepEqual(calls, ['leave:ignacio', 'revoke:ignacio:discord-voice']);

  calls.length = 0;
  await applyModeChange(deps, 'ignacio', { 'discord-voice': 'disabled' }, { 'discord-voice': 'autojoin' });
  assert.deepEqual(calls, ['join:ignacio', 'revoke:ignacio:discord-voice']);

  calls.length = 0;
  deps.roomActive = () => false;
  await applyModeChange(deps, 'ignacio', { 'discord-voice': 'disabled' }, { 'discord-voice': 'autojoin' });
  assert.deepEqual(calls, ['revoke:ignacio:discord-voice']); // no room — no join

  calls.length = 0;
  await applyModeChange(deps, 'ignacio', { discord: 'on-request' }, { discord: 'disabled' });
  assert.deepEqual(calls, ['revoke:ignacio:discord']); // non-voice surfaces: revoke only
});

test('decideJoin: disabled rejects outright; on-request needs an admission; autojoin proceeds without one', () => {
  assert.deepEqual(decideJoin('ignacio', 'discord-voice', 'disabled'), {
    type: 'reject',
    status: 409,
    error: 'ignacio is disabled on discord-voice',
  });
  assert.deepEqual(decideJoin('ignacio', 'discord-voice', 'on-request'), { type: 'admit' });
  assert.deepEqual(decideJoin('ignacio', 'discord-voice', 'autojoin'), { type: 'allow' });
  // Surface-agnostic: the same three outcomes apply to every surface, not just voice.
  assert.deepEqual(decideJoin('ignacio', 'discord', 'disabled'), {
    type: 'reject',
    status: 409,
    error: 'ignacio is disabled on discord',
  });
});
