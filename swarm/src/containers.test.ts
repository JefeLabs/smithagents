import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyContainersFile, loadContainersFile, saveContainersFile, probeDocker } from './containers.js';

test('missing or corrupt file loads as disabled-docker default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'containers-'));
  assert.deepEqual(await loadContainersFile(join(dir, 'nope.json')), emptyContainersFile());
});

test('save/load round-trip preserves enabled flag', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'containers-'));
  const path = join(dir, 'containers.json');
  await saveContainersFile(path, { version: 1, docker: { enabled: true } });
  assert.equal((await loadContainersFile(path)).docker.enabled, true);
});

test('probeDocker reports ok with server version, and failure as unreachable', async () => {
  const ok = await probeDocker(async (argv) => {
    if (argv.includes('docker')) {
      return { code: 0, stdout: '27.0.1\n', stderr: '' };
    }
    throw new Error('Unexpected command');
  });
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /27\.0\.1/);
  const bad = await probeDocker(async () => {
    throw new Error('Cannot connect to the Docker daemon');
  });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /daemon/i);
});
