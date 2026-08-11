import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeWorkerConfig, nextReconnectDelay, toHttpUrl, toWsUrl, registerDevice, loadCredentials } from './worker.js';

test('mergeWorkerConfig: explicit undefined overrides never clobber defaults', () => {
  // The CLI passes `capacity: opts.capacity ? Number(...) : undefined` — a
  // plain spread would override the default with undefined, and a worker
  // with capacity undefined is never picked by the pool (0 < undefined).
  const merged = mergeWorkerConfig({ orchestratorUrl: 'ws://x:1', token: 't', capacity: undefined, name: undefined, defaultRuntime: undefined });
  assert.equal(merged.capacity, 5);
  assert.equal(merged.defaultRuntime, 'tmux');
  assert.ok(merged.name.length > 0);
  assert.equal(merged.orchestratorUrl, 'ws://x:1');
  assert.equal(merged.token, 't');
});

test('nextReconnectDelay: exponential from base, capped, jittered ±20%', () => {
  const noJitter = () => 0.5; // rand=0.5 → jitter factor exactly 1.0
  assert.equal(nextReconnectDelay(0, 3_000, 60_000, noJitter), 3_000);
  assert.equal(nextReconnectDelay(1, 3_000, 60_000, noJitter), 6_000);
  assert.equal(nextReconnectDelay(10, 3_000, 60_000, noJitter), 60_000);
  assert.equal(nextReconnectDelay(2, 3_000, 60_000, () => 0), 9_600);
  assert.equal(nextReconnectDelay(2, 3_000, 60_000, () => 1), 14_400);
});

test('URL scheme conversion is symmetric and idempotent', () => {
  assert.equal(toHttpUrl('ws://host:7777'), 'http://host:7777');
  assert.equal(toHttpUrl('wss://cell.example.com'), 'https://cell.example.com');
  assert.equal(toHttpUrl('http://host:7777'), 'http://host:7777');
  assert.equal(toWsUrl('http://host:7777'), 'ws://host:7777');
  assert.equal(toWsUrl('https://cell.example.com'), 'wss://cell.example.com');
  assert.equal(toWsUrl('wss://cell.example.com'), 'wss://cell.example.com');
});

test('registerDevice redeems the code and writes 0600 credentials; loadCredentials round-trips', async () => {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      assert.equal(req.url, '/devices/redeem');
      const parsed = JSON.parse(body) as { code: string; name: string };
      assert.equal(parsed.code, 'ABCD-EFGH');
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ deviceId: 'device-12345678', token: 'smith-device-feed' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const credsPath = join(await mkdtemp(join(tmpdir(), 'creds-')), 'worker-credentials.json');

  const creds = await registerDevice(`ws://127.0.0.1:${port}`, 'ABCD-EFGH', 'test-box', credsPath);
  server.close();

  assert.equal(creds.deviceId, 'device-12345678');
  assert.equal(creds.orchestratorUrl, `ws://127.0.0.1:${port}`);
  const mode = (await stat(credsPath)).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal((await readFile(credsPath, 'utf8')).includes('smith-device-feed'), true);
  assert.deepEqual(await loadCredentials(credsPath), creds);
});

test('registerDevice surfaces a rejected code as an error', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(410, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or expired pairing code' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const credsPath = join(await mkdtemp(join(tmpdir(), 'creds-')), 'worker-credentials.json');
  await assert.rejects(
    registerDevice(`http://127.0.0.1:${port}`, 'DEAD-CODE', 'box', credsPath),
    /Invalid or expired/,
  );
  server.close();
  assert.equal(await loadCredentials(credsPath), null);
});
