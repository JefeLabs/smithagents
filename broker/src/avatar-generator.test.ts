import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { AvatarGenerator, buildAvatarPrompt, type ImagesClient } from './avatar-generator.ts';

const tinyPng = () =>
  sharp({ create: { width: 4, height: 4, channels: 3, background: '#aa5533' } }).png().toBuffer();

const clientReturning = (parts: Array<{ inlineData?: { data?: string; mimeType?: string } }>): ImagesClient => ({
  models: { generateContent: async () => ({ candidates: [{ content: { parts } }] }) },
});

test('buildAvatarPrompt: house style always present, persona clauses appended', () => {
  const p = buildAvatarPrompt({ name: 'Minerva', gender: 'female', role: 'Security Engineer', backstory: 'Found her first injection hole at nineteen.' });
  assert.match(p, /Flat vector bust portrait/);
  assert.match(p, /no text/);
  assert.match(p, /A woman called Minerva, a Security Engineer\./);
  assert.match(p, /injection hole/);
  assert.match(buildAvatarPrompt({}), /A person\./);
});

test('generate: normalizes whatever Gemini returns to a 512x512 png (base64)', async () => {
  const src = (await tinyPng()).toString('base64');
  const gen = new AvatarGenerator(clientReturning([{ inlineData: { data: src, mimeType: 'image/png' } }]), 'gemini-2.5-flash-image');
  const out = Buffer.from(await gen.generate({ name: 'Nena' }), 'base64');
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, 512);
  assert.equal(meta.height, 512);
  assert.equal(meta.format, 'png');
});

test('generate: empty candidates -> a user-facing error', async () => {
  const gen = new AvatarGenerator(clientReturning([{}]), 'gemini-2.5-flash-image');
  await assert.rejects(gen.generate({}), /no image/i);
});
