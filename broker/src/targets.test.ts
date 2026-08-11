import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTarget, resolveTarget, type TargetRoster } from './targets.ts';

const ROSTER: TargetRoster = {
  squads: [{ id: 'alpha', leader: { name: 'Gabriel' } }],
  groups: [
    {
      id: 'g1',
      name: 'delta',
      leader: 'josefina',
      members: [
        { id: 'osvaldo', name: 'Osvaldo', roles: ['Backend Engineer', 'senior'] },
        { id: 'josefina', name: 'Josefina', roles: ['Product Manager'] },
      ],
    },
    {
      id: 'g2',
      name: 'epsilon', // no leader yet — election still in flight
      members: [
        { id: 'osvaldo', name: 'Osvaldo', roles: ['Backend Engineer', 'developer'] },
        { id: 'josefina', name: 'Josefina', roles: ['Product Manager'] },
      ],
    },
  ],
  agents: [
    { id: 'osvaldo', name: 'Osvaldo' },
    { id: 'josefina', name: 'Josefina' },
  ],
};

test('no target at all is a brain turn — the untouched path every other caller uses', () => {
  assert.deepEqual(resolveTarget(undefined, ROSTER), { kind: 'brain' });
});

test('host and crew are both brain turns', () => {
  assert.deepEqual(resolveTarget({ kind: 'host' }, ROSTER), { kind: 'brain' });
  assert.deepEqual(resolveTarget({ kind: 'crew' }, ROSTER), { kind: 'brain' });
});

test('a squad resolves to its leader', () => {
  assert.deepEqual(resolveTarget({ kind: 'squad', id: 'alpha' }, ROSTER), { kind: 'agent', name: 'Gabriel' });
});

test('a group resolves to its elected leader', () => {
  assert.deepEqual(resolveTarget({ kind: 'group', id: 'g1' }, ROSTER), { kind: 'agent', name: 'Josefina' });
});

test('a group mid-election resolves through the ladder — sending NEVER waits for a vote', () => {
  assert.deepEqual(resolveTarget({ kind: 'group', id: 'g2' }, ROSTER), { kind: 'agent', name: 'Josefina' });
});

test('an individual resolves to itself', () => {
  assert.deepEqual(resolveTarget({ kind: 'agent', id: 'osvaldo' }, ROSTER), { kind: 'agent', name: 'Osvaldo' });
});

test('unknown ids report an error rather than silently becoming a brain turn', () => {
  assert.ok('error' in resolveTarget({ kind: 'squad', id: 'nope' }, ROSTER));
  assert.ok('error' in resolveTarget({ kind: 'group', id: 'nope' }, ROSTER));
  assert.ok('error' in resolveTarget({ kind: 'agent', id: 'nope' }, ROSTER));
});

test('parseTarget accepts the five shapes and rejects everything else', () => {
  assert.deepEqual(parseTarget({ kind: 'host' }), { kind: 'host' });
  assert.deepEqual(parseTarget({ kind: 'agent', id: 'osvaldo' }), { kind: 'agent', id: 'osvaldo' });
  assert.equal(parseTarget(undefined), undefined);
  assert.equal(parseTarget('agent:osvaldo'), undefined); // a string is never a target on the wire
  assert.equal(parseTarget({ kind: 'agent' }), undefined); // id required
  assert.equal(parseTarget({ kind: 'nonsense' }), undefined);
});
