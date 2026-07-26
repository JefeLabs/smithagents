import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionManager, type Session, type SessionStoreLike } from './sessions.ts';

function memStore(initial: Session[] = []): SessionStoreLike & { saved: Session[] } {
  const byId = new Map(initial.map((s) => [s.id, s]));
  const store = {
    saved: [] as Session[],
    loadAll: () => [...byId.values()],
    save: (s: Session) => {
      byId.set(s.id, JSON.parse(JSON.stringify(s)) as Session);
      store.saved.push(s);
    },
  };
  return store;
}

test('init creates a first session in the default workspace when none exist', () => {
  const m = new SessionManager(memStore());
  const s = m.init('jefelabs');
  assert.equal(s.workspace, 'jefelabs');
  assert.equal(m.active().id, s.id);
  assert.deepEqual(m.list()[0], { id: s.id, title: 'Session 1', workspace: 'jefelabs', updatedAt: s.updatedAt, active: true });
});

test('init resumes the most recently updated persisted session and keeps ids monotonic', () => {
  const store = memStore([
    { id: 's1', title: 'old', workspace: 'jefelabs', createdAt: 'a', updatedAt: '2026-01-01', transcript: [], brainHistory: [] },
    { id: 's2', title: 'fresh', workspace: 'jefelabs', createdAt: 'b', updatedAt: '2026-06-01', transcript: [], brainHistory: [] },
  ]);
  const m = new SessionManager(store);
  assert.equal(m.init('jefelabs').id, 's2');
  assert.equal(m.create('jefelabs').id, 's3'); // no id reuse after restart
});

test('transcript and brain history persist through the store; switching swaps them', () => {
  const store = memStore();
  const m = new SessionManager(store);
  m.init('jefelabs');
  m.appendTranscript('user', 'hola equipo');
  m.saveBrainHistory([{ role: 'user', content: 'hola equipo' }]);
  const second = m.create('jefelabs', 'Voice work');
  assert.equal(m.active().id, second.id);
  assert.deepEqual(m.active().transcript, []); // fresh conversation
  m.activate('s1');
  assert.equal(m.active().transcript[0]?.text, 'hola equipo');
  assert.equal(m.active().brainHistory.length, 1);
  assert.equal(m.activate('nope'), null);
});
