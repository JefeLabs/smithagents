import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TextChannel } from './text-channel.ts';

const execFileAsync = promisify(execFile);
const BIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin');

/** promisify(execFile) rejects with this shape; typed once so the strict-mode
 * `assert.rejects` validators below can read code/stderr without casts inline. */
type ExecFailure = { code?: number; stdout?: string; stderr?: string };

test('smith-broker-send posts the tagged utterance and prints the task-dispatched handle', async () => {
  const channel = new TextChannel((text) => {
    // Stand in for the brain: any utterance immediately "dispatches" a task.
    channel.broadcast({ type: 'task-dispatched', taskId: 't-1', agent: 'Manuel', task: text });
  });
  const port = await channel.start(0);
  try {
    const { stdout } = await execFileAsync('node', [join(BIN_DIR, 'smith-broker-send.mjs'), 'docs/prd.md', 'ship it'], {
      env: { ...process.env, SMITH_BROKER_URL: `http://127.0.0.1:${port}`, SMITH_BRIDGE_SOURCE: 'claude-code' },
    });
    const handle = JSON.parse(stdout);
    assert.equal(handle.taskId, 't-1');
    assert.equal(handle.agent, 'Manuel');
    assert.match(handle.task, /docs\/prd\.md/);
    assert.match(handle.task, /ship it/);
    assert.match(handle.task, /via claude-code/);
  } finally {
    await channel.stop();
  }
});

test('smith-broker-send times out with the brain\'s reply and exits non-zero when nothing was dispatched', async () => {
  const channel = new TextChannel(() => {
    channel.broadcast({ type: 'utterance', text: 'Manuel: which repo is this for?' });
  });
  const port = await channel.start(0);
  try {
    await assert.rejects(
      execFileAsync('node', [join(BIN_DIR, 'smith-broker-send.mjs'), 'docs/prd.md'], {
        env: { ...process.env, SMITH_BROKER_URL: `http://127.0.0.1:${port}`, SMITH_BROKER_SEND_TIMEOUT_MS: '300' },
      }),
      (err: unknown) => {
        const e = err as ExecFailure;
        assert.equal(e.code, 1);
        assert.match(e.stderr ?? '', /which repo is this for/);
        return true;
      },
    );
  } finally {
    await channel.stop();
  }
});

test('smith-broker-send exits 2 with no prd-path argument', async () => {
  await assert.rejects(execFileAsync('node', [join(BIN_DIR, 'smith-broker-send.mjs')]), (err: unknown) => {
    assert.equal((err as ExecFailure).code, 2);
    return true;
  });
});
