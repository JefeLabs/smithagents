import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXEC_TO_RUNTIME, isExecutionMode } from './execution-modes.js';

test('mapping matches the spec seam exactly', () => {
  assert.deepEqual(EXEC_TO_RUNTIME, {
    'local-in-process': 'tmux',
    'local-docker': 'docker',
    'remote-in-process': 'remote-tmux',
    'remote-docker': 'remote-docker',
  });
});

test('isExecutionMode guards strings', () => {
  assert.equal(isExecutionMode('remote-docker'), true);
  assert.equal(isExecutionMode('tmux'), false);
  assert.equal(isExecutionMode(42), false);
});
