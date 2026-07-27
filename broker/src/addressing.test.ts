import assert from 'node:assert/strict';
import { test } from 'node:test';
import { whoIsAddressed } from './addressing.ts';

const CREW = ['Manuel', 'Octavio', 'Aurelio', 'Squad Alpha'];

test('"Hey <Name>" addresses that teammate', () => {
  assert.deepEqual(whoIsAddressed('Hey Manuel, can you take the auth refactor?', CREW), ['Manuel']);
});

test('a name leading the utterance is a vocative too', () => {
  assert.deepEqual(whoIsAddressed('Octavio, what do you think?', CREW), ['Octavio']);
});

test('a passing mention does NOT light anyone up', () => {
  // The whole point of the indicator is that it means something.
  assert.deepEqual(whoIsAddressed('I talked to Manuel yesterday about the ledger', CREW), []);
  assert.deepEqual(whoIsAddressed('this is the branch Aurelio wrote', CREW), []);
});

test('addressing the room lights up everyone', () => {
  assert.deepEqual(whoIsAddressed('hey team, standup in five', CREW), CREW);
  assert.deepEqual(whoIsAddressed('oye gente', CREW), CREW);
});

test('Spanish vocatives work — the crew switches languages mid-sentence', () => {
  assert.deepEqual(whoIsAddressed('oye Aurelio, tranquilo con eso', CREW), ['Aurelio']);
  assert.deepEqual(whoIsAddressed('hola Manuel', CREW), ['Manuel']);
});

test('multi-word names (squads) are matched as a phrase', () => {
  assert.deepEqual(whoIsAddressed('hey Squad Alpha, status?', CREW), ['Squad Alpha']);
});

test('accents and punctuation do not defeat a match', () => {
  assert.deepEqual(whoIsAddressed('¡Hey Aurelio!', CREW), ['Aurelio']);
});

test('two people addressed at once both light up', () => {
  assert.deepEqual(whoIsAddressed('Manuel, and hey Octavio too', CREW), ['Manuel', 'Octavio']);
});

test('an empty or nameless utterance addresses nobody', () => {
  assert.deepEqual(whoIsAddressed('', CREW), []);
  assert.deepEqual(whoIsAddressed('what is the status of the build?', CREW), []);
});
