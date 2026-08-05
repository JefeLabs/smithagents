import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TmuxRuntime } from './runtime.js';

test('TmuxRuntime.launch: env vars are exported inside the wrapped command, not interpolated into it', async () => {
  const runtime = new TmuxRuntime();
  const sessionName = `test-env-${Date.now()}`;
  const dir = await mkdtemp(join(tmpdir(), 'launch-env-'));
  const outFile = join(dir, 'out.txt');
  try {
    await runtime.launch(sessionName, `echo "$SMITH_TEST_TOKEN" > ${outFile}`, dir, { SMITH_TEST_TOKEN: 'super-secret' });
    await runtime.waitFor(sessionName);
    const content = await readFile(outFile, 'utf8');
    assert.equal(content.trim(), 'super-secret');
  } finally {
    await runtime.kill(sessionName).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
