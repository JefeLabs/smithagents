import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpeechChunker } from './chunker.ts';

function collect(): { chunks: string[]; on: (t: string) => void } {
  const chunks: string[] = [];
  return { chunks, on: (t: string) => chunks.push(t) };
}

test('flush emits the buffered remainder as one chunk', () => {
  const { chunks, on } = collect();
  const c = new SpeechChunker(on);
  c.push('Hello there.');
  c.flush();
  assert.deepEqual(chunks, ['Hello there.']);
});

test('emits at a sentence boundary once minChars is reached', () => {
  const { chunks, on } = collect() as { chunks: string[]; on: (t: string) => void };
  const c = new SpeechChunker(on, { minChars: 10, maxChars: 200 });
  c.push('Short. '); // sentence end but < minChars — held
  assert.deepEqual(chunks, []);
  c.push('This second sentence pushes us past the minimum. ');
  assert.equal(chunks.length, 1);
  assert.ok((chunks[0] as string).startsWith('Short.'));
  assert.ok((chunks[0] as string).endsWith('minimum.'));
});

test('splits a run-on at a word boundary at maxChars', () => {
  const { chunks, on } = collect();
  const c = new SpeechChunker(on, { minChars: 10, maxChars: 40 });
  c.push('one two three four five six seven eight nine ten eleven twelve');
  c.flush();
  assert.ok(chunks.length >= 2);
  for (const ch of chunks) assert.ok(ch.length <= 40, `chunk too long: "${ch}"`);
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), 'one two three four five six seven eight nine ten eleven twelve');
});

test('never emits empty chunks', () => {
  const { chunks, on } = collect();
  const c = new SpeechChunker(on);
  c.push('   ');
  c.flush();
  c.flush();
  assert.deepEqual(chunks, []);
});

test('newline is a hard boundary: speaker lines never merge', () => {
  const chunks: string[] = [];
  const c = new SpeechChunker((t) => chunks.push(t));
  c.push('Octavio: We move forward.\nGabriel: Squad Alpha is locked and loaded, hermano.');
  c.flush();
  assert.deepEqual(chunks, ['Octavio: We move forward.', 'Gabriel: Squad Alpha is locked and loaded, hermano.']);
});
