// ---------------------------------------------------------------------------
// orchestrator/remote-runtime.ts — RuntimeAdapter backed by a remote worker
//
// Instead of running tmux/docker locally, this adapter dispatches commands
// to a remote worker through the orchestrator's worker pool. The pool
// manages the WebSocket connections; this adapter just sends messages.
// ---------------------------------------------------------------------------

import type { RuntimeAdapter } from './runtime.js';
import type {
  ConnectedWorker,
  TaskDispatchMessage,
  TaskSteerMessage,
  TaskKillMessage,
  OutputRequestMessage,
  OutputChunkMessage,
  WorkerMessage,
} from './remote-types.js';

// ---------------------------------------------------------------------------
// Worker Pool — manages connected remote workers
// ---------------------------------------------------------------------------

import type WebSocket from 'ws';

interface PendingOutput {
  resolve: (output: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingWait {
  resolve: (exitCode: number) => void;
}

/**
 * Pool of connected remote workers.
 *
 * Workers connect TO us via WebSocket. The pool tracks them,
 * routes tasks to the least-loaded worker, and relays messages.
 */
export class WorkerPool {
  /** Connected workers keyed by workerId */
  private readonly workers = new Map<string, { info: ConnectedWorker; ws: WebSocket }>();
  /** Session → workerId mapping for routing steer/kill/output */
  private readonly sessionWorker = new Map<string, string>();
  /** Pending output requests awaiting response */
  private readonly pendingOutputs = new Map<string, PendingOutput>();
  /** Pending waitFor calls */
  private readonly pendingWaits = new Map<string, PendingWait>();
  /** Latest output cache from periodic pushes */
  private readonly outputCache = new Map<string, string>();

  /**
   * Register a new worker (called when WS connects and 'register' message arrives).
   */
  addWorker(workerId: string, info: ConnectedWorker, ws: WebSocket): void {
    this.workers.set(workerId, { info, ws });
  }

  /**
   * Remove a worker (disconnect or reap). Every session it owned settles its
   * pending waitFor with -1 — a vanished worker is a failed task, never a
   * task that hangs the dispatcher forever — and drops its cached output so
   * captureOutput can't serve a dead session's last frame as live.
   */
  removeWorker(workerId: string): void {
    this.workers.delete(workerId);
    for (const [session, wid] of this.sessionWorker) {
      if (wid !== workerId) continue;
      this.sessionWorker.delete(session);
      this.outputCache.delete(session);
      const pending = this.pendingWaits.get(session);
      if (pending) {
        pending.resolve(-1);
        this.pendingWaits.delete(session);
      }
    }
  }

  /** Force-disconnect a worker (e.g., its device was revoked). */
  disconnectWorker(workerId: string): boolean {
    const entry = this.workers.get(workerId);
    if (!entry) return false;
    try { entry.ws.close(); } catch { /* already dead */ }
    this.removeWorker(workerId);
    return true;
  }

  /**
   * Reap workers whose last heartbeat is older than maxAgeMs. The socket is
   * terminated (not close — a half-dead TCP peer never completes a close
   * handshake) and the worker removed. Returns the reaped workerIds.
   */
  reapStale(maxAgeMs: number, now = Date.now()): string[] {
    const reaped: string[] = [];
    for (const [workerId, entry] of this.workers) {
      if (now - Date.parse(entry.info.lastHeartbeat) <= maxAgeMs) continue;
      try { (entry.ws as { terminate?: () => void }).terminate?.(); } catch { /* already dead */ }
      reaped.push(workerId);
    }
    for (const id of reaped) this.removeWorker(id);
    return reaped;
  }

  /**
   * Handle an incoming message from a worker.
   */
  handleWorkerMessage(workerId: string, msg: WorkerMessage): void {
    const entry = this.workers.get(workerId);
    if (!entry) return;

    switch (msg.type) {
      case 'task:accepted':
        this.sessionWorker.set(msg.sessionName, workerId);
        entry.info.activeCount++;
        entry.info.tasks.add(msg.taskId);
        break;

      case 'task:completed':
      case 'task:failed': {
        entry.info.activeCount = Math.max(0, entry.info.activeCount - 1);
        entry.info.tasks.delete(msg.taskId);
        // Resolve pending waitFor
        const pending = this.pendingWaits.get(msg.sessionName);
        if (pending) {
          pending.resolve(msg.exitCode);
          this.pendingWaits.delete(msg.sessionName);
        }
        break;
      }

      case 'output:chunk':
        // Cache latest output
        this.outputCache.set(msg.sessionName, msg.output);
        // Resolve pending output request if any
        const pendingOutput = this.pendingOutputs.get(msg.sessionName);
        if (pendingOutput) {
          clearTimeout(pendingOutput.timer);
          pendingOutput.resolve(msg.output);
          this.pendingOutputs.delete(msg.sessionName);
        }
        break;

      case 'heartbeat':
        entry.info.activeCount = msg.activeCount;
        entry.info.lastHeartbeat = new Date().toISOString();
        break;
    }
  }

  /**
   * Pick the best worker for a new task (least loaded with capacity).
   * If kind is specified, filters to workers advertising that runtime.
   */
  private pickWorker(kind?: 'tmux' | 'docker'): { info: ConnectedWorker; ws: WebSocket } | null {
    let best: { info: ConnectedWorker; ws: WebSocket } | null = null;
    let bestLoad = Infinity;

    for (const [, entry] of this.workers) {
      if (kind && !entry.info.runtimes.includes(kind)) continue;
      if (entry.info.activeCount < entry.info.capacity) {
        const load = entry.info.activeCount / entry.info.capacity;
        if (load < bestLoad) {
          bestLoad = load;
          best = entry;
        }
      }
    }
    return best;
  }

  /**
   * Send a message to the worker that owns a session.
   */
  private sendToSession(sessionName: string, msg: unknown): boolean {
    const workerId = this.sessionWorker.get(sessionName);
    if (!workerId) return false;
    const entry = this.workers.get(workerId);
    if (!entry || entry.ws.readyState !== 1) return false;
    entry.ws.send(JSON.stringify(msg));
    return true;
  }

  // -------------------------------------------------------------------------
  // RuntimeAdapter-compatible methods
  // -------------------------------------------------------------------------

  /**
   * Dispatch a task to the least-loaded worker.
   * If kind is specified, routes to a worker advertising that runtime.
   */
  async launch(sessionName: string, command: string, cwd: string, env?: Record<string, string>, kind?: 'tmux' | 'docker'): Promise<void> {
    const worker = this.pickWorker(kind);
    if (!worker) {
      throw new Error(kind ? `No remote workers advertising "${kind}" with capacity` : 'No remote workers available with capacity');
    }

    // env carries secrets (Atlassian/GitHub tokens) — smith-worker doesn't consume
    // this field yet, so don't transmit it until it does. Re-add once the worker
    // protocol actually reads and injects it.
    const msg: TaskDispatchMessage = {
      type: 'task:dispatch',
      taskId: sessionName, // session name is the task identity
      sessionName,
      command,
      cwd,
    };

    worker.ws.send(JSON.stringify(msg));
    // Session mapping will be set when 'task:accepted' comes back
  }

  /**
   * Wait for a remote session to exit.
   */
  async waitFor(sessionName: string): Promise<number> {
    return new Promise<number>((resolve) => {
      this.pendingWaits.set(sessionName, { resolve });
    });
  }

  /**
   * Check if a remote session exists.
   */
  async exists(sessionName: string): Promise<boolean> {
    return this.sessionWorker.has(sessionName);
  }

  /**
   * Kill a remote session.
   */
  async kill(sessionName: string): Promise<void> {
    const msg: TaskKillMessage = {
      type: 'task:kill',
      taskId: sessionName,
      sessionName,
    };
    this.sendToSession(sessionName, msg);
  }

  /**
   * Kill sessions matching a pattern on all workers.
   */
  async killPattern(pattern: string): Promise<number> {
    let killed = 0;
    for (const [session] of this.sessionWorker) {
      if (session.startsWith(pattern)) {
        await this.kill(session);
        killed++;
      }
    }
    return killed;
  }

  /**
   * List remote sessions by prefix.
   */
  async listByPrefix(prefix: string): Promise<string[]> {
    return Array.from(this.sessionWorker.keys()).filter((s) => s.startsWith(prefix));
  }

  /**
   * Capture output from a remote session.
   * Returns cached output or requests fresh output from the worker.
   */
  async captureOutput(sessionName: string): Promise<string> {
    // Return cached output if available (from periodic pushes)
    const cached = this.outputCache.get(sessionName);
    if (cached !== undefined) return cached;

    // Request fresh output
    const msg: OutputRequestMessage = {
      type: 'output:request',
      taskId: sessionName,
      sessionName,
    };
    this.sendToSession(sessionName, msg);

    // Wait for response with timeout
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOutputs.delete(sessionName);
        reject(new Error(`Output request timeout for ${sessionName}`));
      }, 5_000);

      this.pendingOutputs.set(sessionName, { resolve, reject, timer });
    });
  }

  /**
   * Send keystrokes to a remote session.
   */
  async sendKeys(sessionName: string, keys: string, target?: string): Promise<void> {
    const msg: TaskSteerMessage = {
      type: 'task:steer',
      taskId: sessionName,
      sessionName,
      keys,
      target,
    };
    if (!this.sendToSession(sessionName, msg)) {
      throw new Error(`Session ${sessionName} not found on any worker`);
    }
  }

  async sendText(sessionName: string, text: string, target?: string): Promise<void> {
    // The remote worker protocol has no paste op yet (h3: remote-worker
    // hardening) — relay as a steer message; the worker's tmux applies its
    // usual send-keys semantics. Persistent sessions are local-first today.
    await this.sendKeys(sessionName, text, target);
  }

  // -------------------------------------------------------------------------
  // State queries
  // -------------------------------------------------------------------------

  /**
   * Get all connected workers.
   */
  listWorkers(): ConnectedWorker[] {
    return Array.from(this.workers.values()).map((e) => e.info);
  }

  /**
   * Total capacity across all workers.
   */
  get totalCapacity(): number {
    let total = 0;
    for (const [, e] of this.workers) total += e.info.capacity;
    return total;
  }

  /**
   * Total active tasks across all workers.
   */
  get totalActive(): number {
    let total = 0;
    for (const [, e] of this.workers) total += e.info.activeCount;
    return total;
  }

  /**
   * Number of connected workers.
   */
  get workerCount(): number {
    return this.workers.size;
  }
}

/**
 * RemoteRuntime — RuntimeAdapter that delegates to the WorkerPool.
 *
 * This wraps the WorkerPool so it satisfies the RuntimeAdapter interface,
 * making remote execution a drop-in replacement for local tmux/docker.
 */
export class RemoteRuntime implements RuntimeAdapter {
  constructor(
    private readonly pool: WorkerPool,
    private readonly kind?: 'tmux' | 'docker',
  ) {}

  launch(sessionName: string, command: string, cwd: string, env?: Record<string, string>): Promise<void> {
    return this.pool.launch(sessionName, command, cwd, env, this.kind);
  }
  waitFor(sessionName: string): Promise<number> {
    return this.pool.waitFor(sessionName);
  }
  exists(sessionName: string): Promise<boolean> {
    return this.pool.exists(sessionName);
  }
  kill(sessionName: string): Promise<void> {
    return this.pool.kill(sessionName);
  }
  killPattern(pattern: string): Promise<number> {
    return this.pool.killPattern(pattern);
  }
  listByPrefix(prefix: string): Promise<string[]> {
    return this.pool.listByPrefix(prefix);
  }
  captureOutput(sessionName: string): Promise<string> {
    return this.pool.captureOutput(sessionName);
  }
  sendKeys(sessionName: string, keys: string, target?: string): Promise<void> {
    return this.pool.sendKeys(sessionName, keys, target);
  }

  sendText(sessionName: string, text: string, target?: string): Promise<void> {
    return this.pool.sendText(sessionName, text, target);
  }
}
