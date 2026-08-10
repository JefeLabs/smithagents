import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceRegistry } from './device-registry.js';

async function freshRegistry(): Promise<{ registry: DeviceRegistry; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'devices-'));
  const file = join(dir, 'devices.json');
  const registry = new DeviceRegistry(file);
  await registry.load();
  return { registry, file };
}

test('mint + redeem yields a device whose token verifies', async () => {
  const { registry } = await freshRegistry();
  const { code } = registry.mintPairingCode();
  const result = await registry.redeem(code, 'edwins-macbook');
  assert.ok(result, 'redeem should succeed');
  const device = await registry.verifyToken(result!.token);
  assert.ok(device);
  assert.equal(device!.deviceId, result!.deviceId);
  assert.equal(device!.name, 'edwins-macbook');
});

test('pairing code is single-use', async () => {
  const { registry } = await freshRegistry();
  const { code } = registry.mintPairingCode();
  assert.ok(await registry.redeem(code, 'first'));
  assert.equal(await registry.redeem(code, 'second'), null);
});

test('expired pairing code is rejected', async () => {
  const { registry } = await freshRegistry();
  const { code } = registry.mintPairingCode(1_000, 0 /* minted at t=0 */);
  assert.equal(await registry.redeem(code, 'late', 5_000 /* now=t+5s */), null);
});

test('redeem normalizes case and dashes', async () => {
  const { registry } = await freshRegistry();
  const { code } = registry.mintPairingCode();
  const sloppy = code.toLowerCase().replace('-', '');
  assert.ok(await registry.redeem(sloppy, 'sloppy-typist'));
});

test('verifyToken rejects unknown and revoked tokens', async () => {
  const { registry } = await freshRegistry();
  const { code } = registry.mintPairingCode();
  const result = (await registry.redeem(code, 'to-revoke'))!;
  assert.equal(await registry.verifyToken('smith-device-not-a-real-token'), null);
  assert.equal(await registry.revoke(result.deviceId), true);
  assert.equal(await registry.verifyToken(result.token), null);
  assert.equal(await registry.revoke('nonexistent'), false);
});

test('devices persist across a reload; raw token is never on disk', async () => {
  const { registry, file } = await freshRegistry();
  const { code } = registry.mintPairingCode();
  const result = (await registry.redeem(code, 'persistent'))!;

  const reloaded = new DeviceRegistry(file);
  await reloaded.load();
  assert.equal(reloaded.list().length, 1);
  assert.ok(await reloaded.verifyToken(result.token));

  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(file, 'utf8');
  assert.equal(raw.includes(result.token), false, 'token stored hashed, never raw');
});

test('touch updates lastSeenAt', async () => {
  const { registry } = await freshRegistry();
  const { code } = registry.mintPairingCode();
  const result = (await registry.redeem(code, 'seen'))!;
  await registry.touch(result.deviceId);
  assert.ok(registry.list()[0]!.lastSeenAt);
});
