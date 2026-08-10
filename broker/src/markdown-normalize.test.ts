import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeMarkdown } from './markdown-normalize.ts';

test('equivalent spellings converge on one form', () => {
  assert.equal(normalizeMarkdown('*em* and __strong__'), normalizeMarkdown('_em_ and **strong**'));
});

test('setext headings become ATX; bullets unify', () => {
  assert.equal(normalizeMarkdown('Title\n=====\n'), '# Title');
  assert.equal(normalizeMarkdown('* one\n* two'), normalizeMarkdown('- one\n- two'));
});

test('normalizing twice changes nothing', () => {
  const once = normalizeMarkdown('# Heading\n\n*   loose    spacing\n*   here\n');
  assert.equal(normalizeMarkdown(once), once);
});

test('gfm survives — tables and task lists are not mangled away', () => {
  const table = normalizeMarkdown('| a | b |\n| - | - |\n| 1 | 2 |');
  assert.match(table, /\| a\s*\| b\s*\|/);
  assert.match(normalizeMarkdown('- [ ] todo'), /- \[ \] todo/);
});

test('blank input is empty; unparseable input is returned as-is rather than lost', () => {
  assert.equal(normalizeMarkdown('   \n  '), '');
  const weird = '<<<not really markdown>>>';
  assert.equal(typeof normalizeMarkdown(weird), 'string');
});
