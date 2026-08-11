import assert from "node:assert/strict";
import { test } from "node:test";
import type WebSocket from "ws";
import { WorkerPool } from "./remote-runtime.js";
import type { ConnectedWorker, TaskDispatchMessage } from "./remote-types.js";

// Helper to create a ConnectedWorker with specified runtimes
function workerInfo(workerId: string, runtimes: Array<"tmux" | "docker">): ConnectedWorker {
  return {
    workerId,
    name: workerId,
    capacity: 10,
    activeCount: 0,
    agents: ["claude"],
    runtimes,
    version: "1.0.0",
    connectedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    tasks: new Set(),
  };
}

test("WorkerPool.launch: env is never forwarded onto the outgoing TaskDispatchMessage", async () => {
  const pool = new WorkerPool();
  const sent: unknown[] = [];
  const fakeWs = {
    readyState: 1,
    send: (data: string) => sent.push(JSON.parse(data)),
  } as unknown as WebSocket;

  const info: ConnectedWorker = {
    workerId: "w1",
    name: "worker-1",
    capacity: 1,
    activeCount: 0,
    agents: ["claude"],
    runtimes: ["tmux"],
    version: "1.0.0",
    connectedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    tasks: new Set(),
  };
  pool.addWorker("w1", info, fakeWs);

  await pool.launch("session-1", "echo hi", "/tmp", { SOME_TOKEN: "x" });

  assert.equal(sent.length, 1);
  const msg = sent[0] as TaskDispatchMessage;
  assert.equal(msg.type, "task:dispatch");
  assert.equal(msg.sessionName, "session-1");
  assert.equal("env" in msg, false, "env should not be present on the wire message");
});

test("launch with kind routes to a worker advertising that runtime", async () => {
  const pool = new WorkerPool();
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

  pool.addWorker("w-tmux", workerInfo("w-tmux", ["tmux"]), tmuxWsTyped);
  pool.addWorker("w-docker", workerInfo("w-docker", ["docker"]), dockerWsTyped);
  await pool.launch("s1", "echo hi", "/tmp", undefined, "docker");
  assert.equal(sentDocker.length, 1);
  assert.equal(sentTmux.length, 0);
});

test("launch with kind and no advertising worker throws a named error", async () => {
  const pool = new WorkerPool();
  pool.addWorker("w-tmux", workerInfo("w-tmux", ["tmux"]), { send: () => {}, readyState: 1 } as unknown as WebSocket);
  await assert.rejects(
    pool.launch("s1", "echo hi", "/tmp", undefined, "docker"),
    /No remote workers advertising "docker"/,
  );
});

test("launch without kind keeps legacy any-worker behavior", async () => {
  const pool = new WorkerPool();
  const sent: unknown[] = [];
  const ws = { send: (data: string) => sent.push(JSON.parse(data)), readyState: 1 } as unknown as WebSocket;
  pool.addWorker("w-tmux", workerInfo("w-tmux", ["tmux"]), ws);
  await pool.launch("s1", "echo hi", "/tmp");
  assert.equal(sent.length, 1);
});

// ---------------------------------------------------------------------------
// Disconnect / reap resilience
// ---------------------------------------------------------------------------

function fakeSocket(): { sent: unknown[]; ws: WebSocket; closed: () => boolean } {
  const sent: unknown[] = [];
  let closed = false;
  const ws = {
    readyState: 1,
    send: (data: string) => sent.push(JSON.parse(data)),
    close: () => {
      closed = true;
    },
    terminate: () => {
      closed = true;
    },
  } as unknown as WebSocket;
  return { sent, ws, closed: () => closed };
}

test("removeWorker settles pendingWaits with -1 instead of hanging forever", async () => {
  const pool = new WorkerPool();
  pool.addWorker("w1", workerInfo("w1", ["tmux"]), fakeSocket().ws);
  await pool.launch("sess-gone", "echo hi", "/tmp");
  pool.handleWorkerMessage("w1", {
    type: "task:accepted",
    taskId: "sess-gone",
    sessionName: "sess-gone",
    workerId: "w1",
  });
  const wait = pool.waitFor("sess-gone");
  pool.removeWorker("w1");
  assert.equal(await wait, -1);
});

test("removeWorker clears the output cache for its sessions", async () => {
  const pool = new WorkerPool();
  pool.addWorker("w1", workerInfo("w1", ["tmux"]), fakeSocket().ws);
  await pool.launch("sess-cache", "echo hi", "/tmp");
  pool.handleWorkerMessage("w1", {
    type: "task:accepted",
    taskId: "sess-cache",
    sessionName: "sess-cache",
    workerId: "w1",
  });
  pool.handleWorkerMessage("w1", {
    type: "output:chunk",
    taskId: "sess-cache",
    sessionName: "sess-cache",
    output: "stale",
    lines: 1,
  });
  pool.removeWorker("w1");
  // With the cache cleared and no worker owning the session, captureOutput
  // must reject (request times out) rather than serve dead output.
  await assert.rejects(pool.captureOutput("sess-cache"));
});

test("reapStale terminates only workers with stale heartbeats", () => {
  const pool = new WorkerPool();
  const now = Date.now();
  const fresh = workerInfo("fresh", ["tmux"]);
  const stale = workerInfo("stale", ["tmux"]);
  stale.lastHeartbeat = new Date(now - 60_000).toISOString();
  const staleSocket = fakeSocket();
  pool.addWorker("fresh", fresh, fakeSocket().ws);
  pool.addWorker("stale", stale, staleSocket.ws);
  const reaped = pool.reapStale(45_000, now);
  assert.deepEqual(reaped, ["stale"]);
  assert.equal(pool.workerCount, 1);
  assert.equal(staleSocket.closed(), true);
});

test("disconnectWorker closes the socket and removes the worker", () => {
  const pool = new WorkerPool();
  const socket = fakeSocket();
  pool.addWorker("w1", workerInfo("w1", ["tmux"]), socket.ws);
  assert.equal(pool.disconnectWorker("w1"), true);
  assert.equal(socket.closed(), true);
  assert.equal(pool.workerCount, 0);
  assert.equal(pool.disconnectWorker("w1"), false);
});
