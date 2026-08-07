import { test } from 'node:test';
import assert from 'node:assert/strict';
import type WebSocket from 'ws';
import { WorkerPool } from './remote-runtime.js';
import type { ConnectedWorker, TaskDispatchMessage } from './remote-types.js';

// Helper to create a ConnectedWorker with specified runtimes
function workerInfo(workerId: string, runtimes: Array<'tmux' | 'docker'>): ConnectedWorker {
  return {
    workerId,
    name: workerId,
    capacity: 10,
    activeCount: 0,
    agents: ['claude'],
    runtimes,
    version: '1.0.0',
    connectedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    tasks: new Set(),
  };
}

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

test('launch with kind routes to a worker advertising that runtime', async () => {
  const pool = new WorkerPool();
  const tmuxWs = { send: (() => { let count = 0; return () => count++; })(), readyState: 1 };
  const dockerWs = { send: (() => { let count = 0; return () => count++; })(), readyState: 1 };
  const sentDocker: unknown[] = [];
  const sentTmux: unknown[] = [];

  const dockerWsTyped = {
    send: (data: string) => sentDocker.push(JSON.parse(data)),
    readyState: 1,
  } as unknown as WebSocket;

  const tmuxWsTyped = {
    send: (data: string) => sentTmux.push(JSON.parse(data)),
    readyState: 1,
  } as unknown as WebSocket;

  pool.addWorker('w-tmux', workerInfo('w-tmux', ['tmux']), tmuxWsTyped);
  pool.addWorker('w-docker', workerInfo('w-docker', ['docker']), dockerWsTyped);
  await pool.launch('s1', 'echo hi', '/tmp', undefined, 'docker');
  assert.equal(sentDocker.length, 1);
  assert.equal(sentTmux.length, 0);
});

test('launch with kind and no advertising worker throws a named error', async () => {
  const pool = new WorkerPool();
  pool.addWorker('w-tmux', workerInfo('w-tmux', ['tmux']), { send: () => {}, readyState: 1 } as unknown as WebSocket);
  await assert.rejects(pool.launch('s1', 'echo hi', '/tmp', undefined, 'docker'), /No remote workers advertising "docker"/);
});

test('launch without kind keeps legacy any-worker behavior', async () => {
  const pool = new WorkerPool();
  const sent: unknown[] = [];
  const ws = { send: (data: string) => sent.push(JSON.parse(data)), readyState: 1 } as unknown as WebSocket;
  pool.addWorker('w-tmux', workerInfo('w-tmux', ['tmux']), ws);
  await pool.launch('s1', 'echo hi', '/tmp');
  assert.equal(sent.length, 1);
});
