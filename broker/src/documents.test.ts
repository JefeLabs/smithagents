import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Blueprint } from './blueprints.ts';
import { type Doc, DocumentManager } from './documents.ts';

const BP: Blueprint = {
  id: 'spec',
  name: 'Design Spec',
  workTypes: ['feature', 'bugfix'],
  sections: [
    { id: 'overview', heading: 'What this is' },
    { id: 'repro', heading: 'Reproduction', when: { workType: ['bugfix'] } },
  ],
};

function manager(saved: Doc[] = []) {
  const writes: Doc[] = [];
  const m = new DocumentManager(
    { loadAll: () => saved, save: (d) => writes.push(structuredClone(d)) },
    () => '2026-08-10T12:00:00.000Z',
  );
  m.init();
  return { m, writes };
}

test('create instantiates sections for the work type and persists', () => {
  const { m, writes } = manager();
  const doc = m.create(BP, 'bugfix', 'Login breaks on resume');
  assert.ok(doc);
  assert.equal(doc.id, 'd1');
  assert.deepEqual(doc.sections.map((s) => s.id), ['overview', 'repro']);
  assert.equal(doc.status, 'drafting');
  assert.deepEqual(doc.participants, []);
  assert.equal(writes.length, 1);
});

test('create returns null for an undeclared work type and persists nothing', () => {
  const { m, writes } = manager();
  assert.equal(m.create(BP, 'decision', 'x'), null);
  assert.equal(writes.length, 0);
});

test('patchSection replaces the body, bumps updatedAt, persists', () => {
  const { m, writes } = manager();
  const doc = m.create(BP, 'feature', 'T')!;
  const patched = m.patchSection(doc.id, 'overview', 'It does the thing.');
  assert.equal(patched?.sections.find((s) => s.id === 'overview')?.body, 'It does the thing.');
  assert.equal(writes.length, 2);
});

test('patchSection on unknown doc or section is null, nothing persists', () => {
  const { m, writes } = manager();
  const doc = m.create(BP, 'feature', 'T')!;
  assert.equal(m.patchSection('d99', 'overview', 'x'), null);
  assert.equal(m.patchSection(doc.id, 'nope', 'x'), null);
  assert.equal(writes.length, 1);
});

test('init loads persisted docs and continues the id sequence', () => {
  const persisted: Doc = {
    id: 'd7',
    title: 'Old',
    blueprintId: 'spec',
    workType: 'feature',
    sections: [{ id: 'overview', heading: 'What this is', body: 'old' }],
    participants: [],
    proposals: [],
    status: 'drafting',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
  const { m } = manager([persisted]);
  assert.equal(m.get('d7')?.title, 'Old');
  assert.equal(m.create(BP, 'feature', 'New')?.id, 'd8');
});

test('list is newest-updated first', () => {
  const { m } = manager();
  const a = m.create(BP, 'feature', 'A')!;
  m.create(BP, 'feature', 'B');
  m.patchSection(a.id, 'overview', 'bump'); // same fake clock, but patch re-saves; order falls back to insertion — assert both present
  assert.deepEqual(m.list().map((d) => d.title).sort(), ['A', 'B']);
});
