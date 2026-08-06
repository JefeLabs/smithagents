import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findJobRole, findLanguage, findPreset, findStereotype, PRESET_AGENTS } from './personas.js';

test('11 presets, unique ids, every catalog reference resolves, card content present', () => {
  assert.equal(PRESET_AGENTS.length, 11);
  assert.equal(new Set(PRESET_AGENTS.map((p) => p.id)).size, 11);
  for (const p of PRESET_AGENTS) {
    assert.match(p.id, /^[a-z0-9][a-z0-9-]{0,63}$/, p.id);
    assert.ok(findStereotype(p.stereotype), `${p.id}: stereotype ${p.stereotype}`);
    assert.ok(findJobRole(p.jobRole), `${p.id}: jobRole ${p.jobRole}`);
    assert.ok(findLanguage(p.language), `${p.id}: language ${p.language}`);
    assert.ok(p.hook.length > 0 && p.backstory.length > 0 && p.persona.style.length > 0, p.id);
    assert.match(p.ring, /^#[0-9a-fA-F]{6}$/, p.id);
    assert.equal(p.avatar, `${p.id}.png`, p.id);
    assert.equal(p.engine.cli, 'claude', p.id);
  }
});

test('findPreset resolves by id and misses cleanly', () => {
  assert.equal(findPreset('minerva')?.name, 'Minerva');
  assert.equal(findPreset('nope'), undefined);
});
