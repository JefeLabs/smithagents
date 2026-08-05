import { test } from 'node:test';
import assert from 'node:assert/strict';
import type WebSocket from 'ws';
import { WorkerPool } from './remote-runtime.js';
import type { ConnectedWorker, TaskDispatchMessage } from './remote-types.js';

test('WorkerPool.launch: env is never forwarded onto the outgoing TaskDispatchMessage', async () => {
  const pool = new WorkerPool();
  const sent: unknown[] = [];
  const fakeWs = {
    readyState: 1,
    send: (data: string) => sent.push(JSON.parse(data)),
  } as unknown as WebSocket;

  const info: ConnectedWorker = {
    workerId: 'w1',
    name: 'worker-1',
    capacity: 1,
    activeCount: 0,
    agents: ['claude'],
    runtimes: ['tmux'],
    version: '1.0.0',
    connectedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    tasks: new Set(),
  };
  pool.addWorker('w1', info, fakeWs);

  await pool.launch('session-1', 'echo hi', '/tmp', { SOME_TOKEN: 'x' });

  assert.equal(sent.length, 1);
  const msg = sent[0] as TaskDispatchMessage;
  assert.equal(msg.type, 'task:dispatch');
  assert.equal(msg.sessionName, 'session-1');
  assert.equal('env' in msg, false, 'env should not be present on the wire message');
});
