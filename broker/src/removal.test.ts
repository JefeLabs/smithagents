import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRemoval, transcriptMentions, createRemovalService } from './removal.ts';
import type { Session } from './sessions.ts';

const session = (texts: string[]): Session => ({
  id: 's1', title: 't', workspace: 'w', createdAt: 'c', updatedAt: 'u', brainHistory: [],
  transcript: texts.map((text) => ({ role: 'broker' as const, text, at: 'now' })),
});

test('no evidence -> delete; any evidence -> archive', () => {
  assert.equal(resolveRemoval({ transcriptHit: false, warmSessions: 0, activeTasks: 0 }), 'delete');
  assert.equal(resolveRemoval({ transcriptHit: true, warmSessions: 0, activeTasks: 0 }), 'archive');
  assert.equal(resolveRemoval({ transcriptHit: false, warmSessions: 1, activeTasks: 0 }), 'archive');
  assert.equal(resolveRemoval({ transcriptHit: false, warmSessions: 0, activeTasks: 2 }), 'archive');
});

test('transcriptMentions matches the speaker prefix, by name or id, case-insensitively', () => {
  const agent = { id: 'wilkin', name: 'Wilkin' };
  assert.equal(transcriptMentions([session(['Wilkin: claro, I will take it'])], agent), true);
  assert.equal(transcriptMentions([session(['wilkin: lowercase prefix'])], agent), true);
  assert.equal(transcriptMentions([session(['Aurelio: ask Wilkin later'])], agent), false); // mention ≠ speaking
  assert.equal(transcriptMentions([session([])], agent), false);
});

test('user lines never count as agent speech', () => {
  const s = session([]);
  s.transcript.push({ role: 'user', text: 'Wilkin: pretend I am him', at: 'now' });
  assert.equal(transcriptMentions([s], { id: 'wilkin', name: 'Wilkin' }), false);
});

test('removal service: aggregates evidence, calls the matching swarm op', async () => {
  const ops: string[] = [];
  const make = (transcript: string[], usage: { warmSessions: number; activeTasks: number }) =>
    createRemovalService({
      registry: async () => [{ id: 'wilkin', name: 'Wilkin' }],
      agentUsage: async () => usage,
      deleteAgent: async (id) => void ops.push(`delete:${id}`),
      archiveAgent: async (id) => void ops.push(`archive:${id}`),
      sessions: () => [session(transcript)],
      onChanged: async () => void ops.push('refresh'),
    });
  const clean = await make([], { warmSessions: 0, activeTasks: 0 }).execute('wilkin');
  assert.deepEqual(clean, { outcome: 'deleted' });
  const spoke = await make(['Wilkin: hola'], { warmSessions: 0, activeTasks: 0 }).execute('wilkin');
  assert.deepEqual(spoke, { outcome: 'archived' });
  assert.deepEqual(ops, ['delete:wilkin', 'refresh', 'archive:wilkin', 'refresh']);
  assert.deepEqual(await make([], { warmSessions: 0, activeTasks: 0 }).preview('nobody'), { error: 'Unknown agent: nobody' });
});
