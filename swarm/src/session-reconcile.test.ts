import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifySession } from './session-reconcile.js';

const HASH = 'abc123';

test('a plain restart adopts the sessions that are still running', () => {
  const v = classifySession({ processAlive: true, recordedProfileHash: HASH, currentProfileHash: HASH });
  assert.equal(v.action, 'adopt');
});

test('a record whose tmux session died is forgotten, not adopted', () => {
  // Adopting would hand out a handle whose every send fails.
  const v = classifySession({ processAlive: false, recordedProfileHash: HASH, currentProfileHash: HASH });
  assert.equal(v.action, 'forget');
});

test('a dead process is forgotten even if the agent was also deleted', () => {
  const v = classifySession({ processAlive: false, recordedProfileHash: HASH, currentProfileHash: null });
  assert.equal(v.action, 'forget');
});

test('every verdict carries a reason, so a boot decision is explainable', () => {
  for (const facts of [
    { processAlive: true, recordedProfileHash: HASH, currentProfileHash: HASH },
    { processAlive: false, recordedProfileHash: HASH, currentProfileHash: HASH },
    { processAlive: true, recordedProfileHash: HASH, currentProfileHash: 'changed' },
    { processAlive: true, recordedProfileHash: HASH, currentProfileHash: null },
  ]) {
    assert.ok(classifySession(facts).reason.length > 0);
  }
});
