import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enrichFromComposedAgent } from './server.js';
import type { ComposedAgent } from './agents.js';

const AGENTS = [
  {
    id: 'octavio',
    name: 'Octavio',
    role: 'Backend engineer',
    directives: 'Ship small, tested changes.',
    engine: { cli: 'claude', model: 'claude-opus' },
  },
] as unknown as ComposedAgent[];

test('a delegated task inherits the addressed agent persona AND its model', () => {
  const { profile, model } = enrichFromComposedAgent(AGENTS, 'octavio');
  // Both halves matter: profile drives materialization, model drives the launch flag.
  assert.deepEqual(profile, { name: 'Octavio', role: 'Backend engineer', directives: 'Ship small, tested changes.' });
  assert.equal(model, 'claude-opus');
});

test('an unknown or absent agent id yields no persona and no model, never a partial', () => {
  assert.deepEqual(enrichFromComposedAgent(AGENTS, 'nobody'), { profile: undefined, model: undefined });
  assert.deepEqual(enrichFromComposedAgent(AGENTS, undefined), { profile: undefined, model: undefined });
});
