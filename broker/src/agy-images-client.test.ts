import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgyImagesClient, type AgyRunner } from './agy-images-client.ts';

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d', 'hex'); // enough to be readable bytes

test('collects the produced image even when misnamed, returns ImagesClient shape', async () => {
  let seenArgv: string[] = [];
  const runner: AgyRunner = async (argv, cwd) => {
    seenArgv = argv;
    await writeFile(join(cwd, 'whatever-agy-called-it.jpeg'), PNG_BYTES); // wrong ext, wrong name — must still be found
    return { code: 0, stdout: 'done', stderr: '' };
  };
  const client = new AgyImagesClient('agy', runner);
  const res = await client.models.generateContent({ model: 'ignored', contents: 'portrait prompt' });
  const data = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
  assert.equal(data, PNG_BYTES.toString('base64'));
  assert.equal(seenArgv[0], 'agy');
  assert.equal(seenArgv[1], '-p');
  assert.ok(seenArgv[2]!.includes('portrait prompt'), 'house prompt must reach agy verbatim');
  assert.ok(seenArgv.includes('--dangerously-skip-permissions'));
});

test('no image produced -> typed error the wizard can show verbatim', async () => {
  const runner: AgyRunner = async () => ({ code: 0, stdout: '', stderr: '' });
  const client = new AgyImagesClient('agy', runner);
  await assert.rejects(
    () => client.models.generateContent({ model: 'x', contents: 'p' }),
    /agy produced no image/,
  );
});

test('nonzero exit -> error mentions exit code', async () => {
  const runner: AgyRunner = async () => ({ code: 1, stdout: '', stderr: 'boom' });
  const client = new AgyImagesClient('agy', runner);
  await assert.rejects(() => client.models.generateContent({ model: 'x', contents: 'p' }), /exit 1/);
});
