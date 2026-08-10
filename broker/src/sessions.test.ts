import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionManager, truncateTitle, resolveLazyWorkspace, type Session, type SessionStoreLike } from './sessions.ts';

const T = '2026-01-01T00:00:00.000Z';

function memoryStore(initial: Session[] = []): SessionStoreLike & { saved: Session[] } {
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

test('init with an empty store returns null and creates nothing', () => {
  const mgr = new SessionManager(memoryStore());
  assert.equal(mgr.init(), null);
  assert.equal(mgr.hasActive(), false);
  assert.equal(mgr.activeOrNull(), null);
  assert.deepEqual(mgr.list(), []);
});

test('init resumes the most recently updated persisted session and keeps ids monotonic', () => {
  const store = memoryStore([
    { id: 's1', title: 'old', workspace: 'jefelabs', runtime: 'local-in-process', createdAt: 'a', updatedAt: '2026-01-01', transcript: [], brainHistory: [] },
    { id: 's2', title: 'fresh', workspace: 'jefelabs', runtime: 'local-in-process', createdAt: 'b', updatedAt: '2026-06-01', transcript: [], brainHistory: [] },
  ]);
  const mgr = new SessionManager(store);
  assert.equal(mgr.init()?.id, 's2');
  assert.equal(mgr.create('jefelabs').id, 's3'); // no id reuse after restart
});

test('legacy persisted sessions without runtime read as local-in-process', () => {
  const store = memoryStore();
  store.save({ id: 's1', title: 'old', workspace: 'w', createdAt: T, updatedAt: T, transcript: [], brainHistory: [] } as never);
  const mgr = new SessionManager(store);
  mgr.init();
  assert.equal(mgr.list()[0].runtime, 'local-in-process');
});

test('create carries runtime and truncated title; retitle applies exactly once', () => {
  const mgr = new SessionManager(memoryStore());
  const s = mgr.create('w', { runtime: 'remote-docker', title: truncateTitle('fix the flaky deploy pipeline that keeps timing out on arm builds'), awaitingTitle: true });
  assert.equal(s.runtime, 'remote-docker');
  assert.equal(s.title.length <= 40, true);
  assert.equal(s.title.endsWith('…'), true);
  assert.equal(mgr.retitle(s.id, 'Flaky deploy pipeline'), true);
  assert.equal(mgr.retitle(s.id, 'Second try'), false);
  assert.equal(mgr.activeOrNull()?.title, 'Flaky deploy pipeline');
});

test('truncateTitle collapses whitespace and caps at 40 chars', () => {
  assert.equal(truncateTitle('  hello   world  '), 'hello world');
  assert.equal(truncateTitle(''), 'New session');
  assert.equal(truncateTitle('x'.repeat(60)).length, 40);
});

test('resetAll leaves zero sessions', () => {
  const mgr = new SessionManager(memoryStore());
  mgr.create('w', { runtime: 'local-in-process' });
  mgr.resetAll();
  assert.equal(mgr.hasActive(), false);
  assert.deepEqual(mgr.list(), []);
});

test('resolveLazyWorkspace: discord lands in the attended workspace, everything else in the default', () => {
  assert.equal(resolveLazyWorkspace({ kind: 'discord', channelRef: 'c' }, 'acme', 'main'), 'acme');
  assert.equal(resolveLazyWorkspace({ kind: 'discord', channelRef: 'c' }, null, 'main'), 'main');
  assert.equal(resolveLazyWorkspace(undefined, 'acme', 'main'), 'main');
  assert.equal(resolveLazyWorkspace({ kind: 'stdin', channelRef: 'c' }, 'acme', 'main'), 'main');
});

test('sessions default to kind chat; document sessions carry kind and docId', () => {
  let n = 0;
  const store = memoryStore();
  const mgr = new SessionManager(store, () => new Date(Date.parse(T) + n++ * 1000).toISOString());
  mgr.create('acme', {});
  const doc = mgr.create('acme', { kind: 'document', docId: 'd1', title: 'Spec: login' });
  const [docRow, chatRow] = mgr.list();
  assert.equal(docRow.id, doc.id);
  assert.equal(docRow.kind, 'document');
  assert.equal(docRow.docId, 'd1');
  assert.equal(chatRow.kind, 'chat');
  assert.equal(chatRow.docId, undefined);
});

test('a legacy persisted session with no kind lists as chat', () => {
  const store = memoryStore();
  store.save({ id: 's1', title: 'old', workspace: 'w', runtime: 'local-in-process', createdAt: T, updatedAt: T, transcript: [], brainHistory: [] } as never);
  const mgr = new SessionManager(store);
  mgr.init();
  assert.equal(mgr.list()[0].kind, 'chat');
  assert.equal(mgr.list()[0].docId, undefined);
});

test('transcript and brain history persist through the store; switching swaps them', () => {
  const store = memoryStore();
  const mgr = new SessionManager(store);
  mgr.create('jefelabs');
  mgr.appendTranscript('user', 'hola equipo');
  mgr.saveBrainHistory([{ role: 'user', content: 'hola equipo' }]);
  const second = mgr.create('jefelabs', { title: 'Voice work' });
  assert.equal(mgr.active().id, second.id);
  assert.deepEqual(mgr.active().transcript, []); // fresh conversation
  mgr.activate('s1');
  assert.equal(mgr.active().transcript[0]?.text, 'hola equipo');
  assert.equal(mgr.active().brainHistory.length, 1);
  assert.equal(mgr.activate('nope'), null);
});
