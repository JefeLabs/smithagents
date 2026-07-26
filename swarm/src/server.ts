// ---------------------------------------------------------------------------
// orchestrator/server.ts — Fastify HTTP Server + WebSocket + UDP Heartbeat
//
// The orchestrator as a long-running server:
//   - REST API for task submission, status, cancellation
//   - WebSocket for real-time event streaming
//   - UDP multicast for lightweight heartbeat/status pings
//   - Health endpoint for monitoring
//   - Queue worker that auto-dispatches queued tasks
//
// This is the production entry point. The Dispatcher, RuntimeAdapter,
// and QuarantineManager all remain unchanged — the server wraps them.
// ---------------------------------------------------------------------------

import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { createSocket, type Socket as DgramSocket } from 'node:dgram';
import { WebSocket } from 'ws';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  Dispatcher,
  QuarantineManager,
  loadConfig,
  createRuntime,
  AgentNamePool,
  type RuntimeAdapter,
  type AgentName,
  type OrchestratorConfig,
  type TaskManifest,
  type TaskResult,
  type DispatcherEvent,
} from './index.js';
import { WorkerPool } from './remote-runtime.js';
import {
  SquadPool,
  SQUAD_ROSTER,
  type SquadManifest,
  type SquadMode,
  type SquadId,
} from './squads.js';
import type {
  ConnectedWorker,
  WorkerRegisterMessage,
  WorkerMessage,
  RegisteredMessage,
} from './remote-types.js';
import { loadAgents } from './agents.js';
import { loadWorkspacesFromDir, resolveRepo, type Workspace } from './workspaces.js';
import { MeetingOrchestrator } from './meetings.js';
import { loadLiveKitConfig } from './config.js';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Active task tracked by the server */
interface ActiveTask {
  manifest: TaskManifest;
  status: 'queued' | 'dispatched' | 'running';
  startedAt: string;
  sessionName: string;
  agentName: AgentName | null;
  runtime: RuntimeAdapter | null;
  promise?: Promise<TaskResult>;
}

/** Server configuration (extends orchestrator config) */
export interface ServerConfig {
  /** HTTP port (default: 7777) */
  port: number;
  /** HTTP host (default: '127.0.0.1' — binding non-loopback requires SMITH_API_TOKEN) */
  host: string;
  /** UDP multicast address for heartbeat (default: '239.0.0.1') */
  udpMulticastAddr: string;
  /** UDP multicast port (default: 7778) */
  udpPort: number;
  /** Heartbeat interval in ms (default: 5000) */
  heartbeatIntervalMs: number;
  /** Max concurrent tasks — matches the 10-agent roster (default: 10) */
  maxConcurrent: number;
  /** Orchestrator config overrides */
  orchestrator?: Partial<OrchestratorConfig>;
}

const DEFAULT_SERVER_CONFIG: ServerConfig = {
  port: 7777,
  host: '127.0.0.1',
  udpMulticastAddr: '239.0.0.1',
  udpPort: 7778,
  heartbeatIntervalMs: 5_000,
  maxConcurrent: 10,
};

// ---------------------------------------------------------------------------
// OrchestratorServer
// ---------------------------------------------------------------------------

/**
 * Long-running orchestrator server.
 *
 * Wraps the Dispatcher in a Fastify HTTP server with:
 *   - REST API (POST/GET/DELETE tasks)
 *   - WebSocket event stream
 *   - UDP heartbeat multicast
 *   - Auto-dispatch queue worker
 */
export class OrchestratorServer {
  private readonly config: ServerConfig;
  private readonly orchConfig: OrchestratorConfig;
  private readonly dispatcher: Dispatcher;
  private readonly quarantine: QuarantineManager;
  private readonly app;

  // State
  private readonly activeTasks = new Map<string, ActiveTask>();
  private readonly completedTasks = new Map<string, TaskResult>();
  private readonly taskQueue: TaskManifest[] = [];
  private readonly wsClients = new Set<WebSocket>();
  private readonly namePool = new AgentNamePool();
  readonly workerPool = new WorkerPool();
  readonly squadPool = new SquadPool();
  private readonly activeSquads = new Map<SquadId, SquadManifest>();

  // UDP
  private udpSocket: DgramSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Auth — bearer token from SMITH_API_TOKEN; null means loopback-only dev mode
  private readonly apiToken: string | null;

  // Meetings — built lazily (agents loaded from disk) on first use
  private meetingOrchestrator: MeetingOrchestrator | null = null;

  // Workspaces — named repo groupings delegations can target (loaded at start)
  private workspaces: Workspace[] = [];

  constructor(config?: Partial<ServerConfig>) {
    this.config = { ...DEFAULT_SERVER_CONFIG, ...config };
    this.apiToken = process.env.SMITH_API_TOKEN?.trim() || null;
    this.orchConfig = loadConfig(this.config.orchestrator);
    this.dispatcher = new Dispatcher(this.orchConfig);
    this.quarantine = new QuarantineManager(this.orchConfig.logsDir);

    // Create Fastify instance
    this.app = Fastify({
      logger: {
        level: 'info',
        transport: {
          target: 'pino-pretty',
          options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      },
    });

    // Wire up dispatcher events to broadcast
    this.dispatcher.on('task:dispatched', (e: DispatcherEvent) => this.broadcast(e));
    this.dispatcher.on('task:completed', (e: DispatcherEvent) => this.broadcast(e));
    this.dispatcher.on('task:failed', (e: DispatcherEvent) => this.broadcast(e));
    this.dispatcher.on('task:quarantined', (e: DispatcherEvent) => this.broadcast(e));
    this.dispatcher.on('session:orphan_cleanup', (e: DispatcherEvent) => this.broadcast(e));
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Start the server: HTTP + WebSocket + UDP heartbeat + queue worker */
  async start(): Promise<void> {
    // The steer/kill endpoints inject keystrokes into live sessions — never
    // expose them beyond loopback without authentication.
    const loopback = ['127.0.0.1', '::1', 'localhost'].includes(this.config.host);
    if (!this.apiToken && !loopback) {
      throw new Error(
        `Refusing to bind ${this.config.host} without SMITH_API_TOKEN set. ` +
        'Export SMITH_API_TOKEN to expose the API beyond loopback, or use --host 127.0.0.1.',
      );
    }

    this.workspaces = await loadWorkspacesFromDir(resolve(process.cwd(), '.smith/workspaces'));
    if (this.workspaces.length > 0) {
      this.app.log.info(`Workspaces: ${this.workspaces.map((w) => `${w.name}(${w.repos.map((r) => r.name).join(',')})`).join(' ')}`);
    }

    await this.registerPlugins();
    this.registerAuthHook();
    this.registerRoutes();
    this.startUdpHeartbeat();
    this.startQueueWorker();

    await this.app.listen({ port: this.config.port, host: this.config.host });

    this.app.log.info(
      `Orchestrator server running on http://${this.config.host}:${this.config.port}`,
    );
    this.app.log.info(
      `UDP heartbeat on ${this.config.udpMulticastAddr}:${this.config.udpPort}`,
    );
    this.app.log.info(
      `Max concurrent tasks: ${this.config.maxConcurrent}`,
    );
  }

  /** Graceful shutdown */
  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.udpSocket) this.udpSocket.close();
    for (const ws of this.wsClients) ws.close();
    await this.app.close();
  }

  // -------------------------------------------------------------------------
  // Plugins
  // -------------------------------------------------------------------------

  private async registerPlugins(): Promise<void> {
    await this.app.register(websocket);
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  /** Constant-time comparison of two secrets (hashing normalizes lengths). */
  private static secretsEqual(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) return false;
    return timingSafeEqual(
      createHash('sha256').update(a).digest(),
      createHash('sha256').update(b).digest(),
    );
  }

  /**
   * Require `Authorization: Bearer <SMITH_API_TOKEN>` on every route except
   * /health. Runs on WebSocket upgrade requests too (/ws, /workers/connect);
   * those clients may instead pass `?token=<SMITH_API_TOKEN>` since browsers
   * cannot set headers on WebSocket connections.
   */
  private registerAuthHook(): void {
    const token = this.apiToken;
    if (!token) {
      // start() has already pinned the listener to loopback in this mode.
      this.app.log.warn('SMITH_API_TOKEN not set — API is unauthenticated, loopback-only');
      return;
    }
    this.app.addHook('onRequest', async (req, reply) => {
      const path = req.url.split('?')[0];
      if (path === '/health') return;
      const header = req.headers.authorization;
      const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
      const queryToken = (req.query as Record<string, unknown> | null)?.token;
      const presented = bearer ?? (typeof queryToken === 'string' ? queryToken : undefined);
      if (!OrchestratorServer.secretsEqual(presented, token)) {
        return reply.status(401).send({ error: 'unauthorized' });
      }
    });
  }

  /** Lazily build the meeting orchestrator (agents loaded from disk on first use). */
  private async meetings(): Promise<MeetingOrchestrator> {
    if (!this.meetingOrchestrator) {
      const agents = await loadAgents(resolve(process.cwd(), '.smith/agents'));
      this.meetingOrchestrator = new MeetingOrchestrator(loadLiveKitConfig(), agents);
    }
    return this.meetingOrchestrator;
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  private registerRoutes(): void {
    const server = this;

    // ── Health ─────────────────────────────────────────────────────────
    this.app.get('/health', async () => {
      return {
        status: 'ok',
        uptime: process.uptime(),
        activeTasks: server.activeTasks.size,
        queuedTasks: server.taskQueue.length,
        completedTasks: server.completedTasks.size,
        maxConcurrent: server.config.maxConcurrent,
        memory: {
          rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
          heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        },
      };
    });

    // ── Submit Task ────────────────────────────────────────────────────
    this.app.post('/tasks', async (req, reply) => {
      const body = req.body as Partial<TaskManifest>;

      // Validate required fields
      if (!body.prompt || !body.agent || !body.context) {
        return reply.status(400).send({
          error: 'Missing required fields: prompt, agent, context',
        });
      }

      // Build full manifest with defaults.
      // taskId is always generated server-side — a client-supplied value would
      // flow into session names, git branch names, and worktree paths, opening
      // command- and path-injection. Callers correlate via the returned taskId.
      // Resolve the target repo server-side. Client-sent repoPath is ignored —
      // only the workspace registry may name filesystem paths.
      const resolved = resolveRepo(server.workspaces, body.context.workspace, body.context.repo);
      if ((body.context.workspace || body.context.repo) && !resolved) {
        return reply.status(400).send({
          error: `Unknown workspace/repo: ${body.context.workspace ?? '(default)'}/${body.context.repo ?? '(default)'}`,
        });
      }

      const taskId = randomUUID();
      const agentName = server.namePool.claim(taskId);
      const manifest: TaskManifest = {
        taskId,
        prompt: body.prompt,
        agentName: agentName ?? undefined,
        agent: body.agent,
        runtime: body.runtime ?? server.orchConfig.defaultRuntime,
        location: body.location ?? (body.runtime === 'docker' ? 'docker' : 'local'),
        context: {
          ...body.context,
          workspace: resolved?.workspace.name,
          repo: resolved?.repo.name,
          repoPath: resolved?.repo.path,
          branch: body.context.branch || resolved?.repo.branch || 'main',
        },
        createdAt: new Date().toISOString(),
        priority: body.priority ?? 'normal',
        metadata: body.metadata,
      };

      // Queue it
      server.taskQueue.push(manifest);
      server.broadcast({
        type: 'task:dispatched',
        taskId: manifest.taskId,
        sessionName: `queued-${manifest.taskId}`,
      });

      server.app.log.info(`Task ${manifest.taskId} queued as ${agentName ?? 'unnamed'} (agent: ${manifest.agent})`);

      return reply.status(202).send({
        taskId: manifest.taskId,
        agentName: agentName ?? null,
        status: 'queued',
        position: server.taskQueue.length,
      });
    });

    // ── Get Task Status ───────────────────────────────────────────────
    this.app.get<{ Params: { taskId: string } }>('/tasks/:taskId', async (req, reply) => {
      const { taskId } = req.params;

      // Check active
      const active = server.activeTasks.get(taskId);
      if (active) {
        return { taskId, status: active.status, startedAt: active.startedAt };
      }

      // Check completed
      const completed = server.completedTasks.get(taskId);
      if (completed) {
        return { taskId, status: completed.outcome, result: completed };
      }

      // Check queued
      const queueIdx = server.taskQueue.findIndex((m) => m.taskId === taskId);
      if (queueIdx >= 0) {
        return { taskId, status: 'queued', position: queueIdx + 1 };
      }

      // Check quarantine
      const quarantined = await server.quarantine.get(taskId);
      if (quarantined) {
        return { taskId, status: 'quarantined', quarantine: quarantined };
      }

      return reply.status(404).send({ error: `Task ${taskId} not found` });
    });

    // ── List All Tasks ────────────────────────────────────────────────
    this.app.get('/tasks', async () => {
      const active = Array.from(server.activeTasks.entries()).map(([id, t]) => ({
        taskId: id,
        agentName: t.agentName,
        status: t.status,
        agent: t.manifest.agent,
        runtime: t.manifest.runtime,
        location: t.manifest.location ?? 'local',
        startedAt: t.startedAt,
      }));

      const queued = server.taskQueue.map((m, i) => ({
        taskId: m.taskId,
        status: 'queued' as const,
        agent: m.agent,
        runtime: m.runtime,
        position: i + 1,
      }));

      const completed = Array.from(server.completedTasks.values()).map((r) => ({
        taskId: r.taskId,
        status: r.outcome,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
      }));

      return { active, queued, completed };
    });

    // ── Resolve helper — accepts name or taskId ─────────────────────
    const resolveTaskId = (nameOrId: string): string | undefined => {
      // Direct taskId match
      if (server.activeTasks.has(nameOrId)) return nameOrId;
      // Name lookup via pool
      const byName = server.namePool.resolve(nameOrId);
      if (byName) return byName;
      // Prefix match on taskId
      for (const id of server.activeTasks.keys()) {
        if (id.startsWith(nameOrId)) return id;
      }
      return undefined;
    };

    // ── Cancel / Kill Task ─────────────────────────────────────────────
    this.app.delete<{ Params: { taskId: string } }>('/tasks/:taskId', async (req, reply) => {
      const taskId = resolveTaskId(req.params.taskId) ?? req.params.taskId;

      // Remove from queue if queued
      const queueIdx = server.taskQueue.findIndex((m) => m.taskId === taskId);
      if (queueIdx >= 0) {
        server.taskQueue.splice(queueIdx, 1);
        server.namePool.releaseByTaskId(taskId);
        server.app.log.info(`Task ${taskId} removed from queue`);
        return { taskId, status: 'cancelled', was: 'queued' };
      }

      // If active, kill the session
      const active = server.activeTasks.get(taskId);
      if (active && active.runtime) {
        await active.runtime.kill(active.sessionName);
        server.activeTasks.delete(taskId);
        server.namePool.releaseByTaskId(taskId);
        server.app.log.info(`Task ${taskId} (${active.agentName}) force-killed`);
        server.broadcast({ type: 'task:failed', taskId, result: { taskId, outcome: 'failed', exitCode: -9, sessionName: active.sessionName, worktreePath: '', startedAt: active.startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - new Date(active.startedAt).getTime() } } as unknown as DispatcherEvent);
        return { taskId, agentName: active.agentName, status: 'killed', was: 'running' };
      }

      return reply.status(404).send({ error: `Task ${req.params.taskId} not found` });
    });

    // ── Live Output — capture tmux pane content ───────────────────────
    this.app.get<{ Params: { taskId: string } }>('/tasks/:taskId/output', async (req, reply) => {
      const taskId = resolveTaskId(req.params.taskId);
      const active = taskId ? server.activeTasks.get(taskId) : undefined;
      if (!active || !active.runtime) {
        return reply.status(404).send({ error: `'${req.params.taskId}' not running or not found` });
      }
      try {
        const output = await active.runtime.captureOutput(active.sessionName);
        return {
          taskId,
          agentName: active.agentName,
          sessionName: active.sessionName,
          agent: active.manifest.agent,
          runtime: active.manifest.runtime,
          uptime: Date.now() - new Date(active.startedAt).getTime(),
          output,
        };
      } catch {
        return reply.status(500).send({ error: 'Failed to capture output' });
      }
    });

    // ── Steer — send keystrokes to running agent ─────────────────────
    this.app.post<{ Params: { taskId: string } }>('/tasks/:taskId/steer', async (req, reply) => {
      const taskId = resolveTaskId(req.params.taskId);
      const active = taskId ? server.activeTasks.get(taskId) : undefined;
      if (!active || !active.runtime) {
        return reply.status(404).send({ error: `'${req.params.taskId}' not running or not found` });
      }
      const body = req.body as { keys?: string; message?: string };
      const keys = body.keys ?? body.message;
      if (!keys) {
        return reply.status(400).send({ error: 'Provide "keys" or "message" in body' });
      }
      try {
        await active.runtime.sendKeys(active.sessionName, keys);
        server.app.log.info(`Steered ${active.agentName ?? taskId}: ${keys.substring(0, 80)}`);
        return {
          taskId,
          agentName: active.agentName,
          status: 'sent',
          keys: keys.substring(0, 200),
        };
      } catch {
        return reply.status(500).send({ error: 'Failed to send keys' });
      }
    });

    // ── Force Kill — explicit kill endpoint ──────────────────────────
    this.app.post<{ Params: { taskId: string } }>('/tasks/:taskId/kill', async (req, reply) => {
      const taskId = resolveTaskId(req.params.taskId);
      const active = taskId ? server.activeTasks.get(taskId) : undefined;
      if (!active || !active.runtime) {
        return reply.status(404).send({ error: `'${req.params.taskId}' not running or not found` });
      }
      await active.runtime.kill(active.sessionName);
      server.activeTasks.delete(taskId!);
      server.namePool.releaseByTaskId(taskId!);
      server.app.log.info(`${active.agentName ?? taskId} force-killed via /kill`);
      return { taskId, agentName: active.agentName, status: 'killed' };
    });

    // ── Agents Roster — who's working ────────────────────────────────
    this.app.get('/agents', async () => {
      const assigned = server.namePool.list().map(({ name, taskId }) => {
        const task = server.activeTasks.get(taskId);
        return {
          name,
          taskId,
          agent: task?.manifest.agent ?? null,
          location: task?.manifest.location ?? 'local',
          status: task?.status ?? 'queued',
          prompt: task?.manifest.prompt.substring(0, 100) ?? null,
          startedAt: task?.startedAt ?? null,
        };
      });
      const available = server.namePool.available();
      return { assigned, available, total: 10 };
    });

    // ── Quarantine List ───────────────────────────────────────────────
    this.app.get('/quarantine', async () => {
      return server.quarantine.list();
    });

    // ── Quarantine Release ────────────────────────────────────────────
    this.app.post<{ Params: { taskId: string } }>('/quarantine/:taskId/release', async (req, reply) => {
      try {
        await server.quarantine.release(req.params.taskId);
        return { taskId: req.params.taskId, status: 'released' };
      } catch (err) {
        return reply.status(404).send({
          error: err instanceof Error ? err.message : 'Release failed',
        });
      }
    });

    // ── WebSocket Event Stream ────────────────────────────────────────
    this.app.get('/ws', { websocket: true }, (socket) => {
      server.wsClients.add(socket);
      server.app.log.info(`WebSocket client connected (total: ${server.wsClients.size})`);

      socket.on('close', () => {
        server.wsClients.delete(socket);
        server.app.log.info(`WebSocket client disconnected (total: ${server.wsClients.size})`);
      });

      // Send current state on connect
      socket.send(JSON.stringify({
        type: 'state:snapshot',
        activeTasks: server.activeTasks.size,
        queuedTasks: server.taskQueue.length,
        maxConcurrent: server.config.maxConcurrent,
      }));
    });

    // ── Remote Worker WebSocket ───────────────────────────────────────
    this.app.get('/workers/connect', { websocket: true }, (socket) => {
      let workerId: string | null = null;

      socket.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as WorkerMessage;

          if (msg.type === 'register') {
            const reg = msg as WorkerRegisterMessage;

            // Fail closed: workers must be explicitly configured, and the
            // presented secret must match a configured worker's secret.
            // A worker configured without a secret is never accepted.
            const configured = server.orchConfig.remoteWorkers ?? [];
            const accepted = configured.length > 0
              && configured.some((w) => OrchestratorServer.secretsEqual(w.secret, reg.secret));

            if (!accepted) {
              const reject: RegisteredMessage = {
                type: 'registered',
                accepted: false,
                orchestratorId: 'orchestrator',
                message: configured.length > 0 ? 'Invalid secret' : 'No remote workers configured',
              };
              socket.send(JSON.stringify(reject));
              socket.close();
              return;
            }

            workerId = reg.workerId;

            const workerInfo: ConnectedWorker = {
              workerId: reg.workerId,
              name: reg.name,
              capacity: reg.capacity,
              activeCount: 0,
              agents: reg.agents,
              runtimes: reg.runtimes,
              version: reg.version,
              connectedAt: new Date().toISOString(),
              lastHeartbeat: new Date().toISOString(),
              tasks: new Set(),
            };

            server.workerPool.addWorker(reg.workerId, workerInfo, socket as unknown as import('ws').WebSocket);

            const ack: RegisteredMessage = {
              type: 'registered',
              accepted: true,
              orchestratorId: 'orchestrator',
              message: `Welcome ${reg.name} (${reg.capacity} slots)`,
            };
            socket.send(JSON.stringify(ack));

            server.app.log.info(
              `Remote worker registered: ${reg.name} (${reg.workerId}) — ${reg.capacity} slots`,
            );

            server.broadcast({
              type: 'worker:connected',
              workerId: reg.workerId,
              name: reg.name,
              capacity: reg.capacity,
            } as unknown as DispatcherEvent);

            return;
          }

          // Route all other messages through the pool
          if (workerId) {
            server.workerPool.handleWorkerMessage(workerId, msg);

            // Forward task completion events to the orchestrator's event stream
            if (msg.type === 'task:completed' || msg.type === 'task:failed') {
              server.broadcast({
                type: msg.type === 'task:completed' ? 'task:completed' : 'task:failed',
                taskId: msg.taskId,
                result: {
                  taskId: msg.taskId,
                  outcome: msg.type === 'task:completed' && msg.exitCode === 0 ? 'completed' : 'failed',
                  exitCode: msg.exitCode,
                  sessionName: msg.sessionName,
                },
              } as unknown as DispatcherEvent);
            }
          }
        } catch (err) {
          server.app.log.error(`Invalid message from worker: ${err}`);
        }
      });

      socket.on('close', () => {
        if (workerId) {
          server.workerPool.removeWorker(workerId);
          server.app.log.info(`Remote worker disconnected: ${workerId}`);
          server.broadcast({
            type: 'worker:disconnected',
            workerId,
          } as unknown as DispatcherEvent);
        }
      });
    });

    // ── List Remote Workers ──────────────────────────────────────────
    this.app.get('/workers', async () => {
      const workers = server.workerPool.listWorkers().map((w) => ({
        workerId: w.workerId,
        name: w.name,
        capacity: w.capacity,
        activeCount: w.activeCount,
        agents: w.agents,
        runtimes: w.runtimes,
        connectedAt: w.connectedAt,
        lastHeartbeat: w.lastHeartbeat,
        tasks: Array.from(w.tasks),
      }));
      return {
        workers,
        totalCapacity: server.workerPool.totalCapacity,
        totalActive: server.workerPool.totalActive,
        count: server.workerPool.workerCount,
      };
    });

    // ── Squads ────────────────────────────────────────────────────────

    this.app.post('/squads', async (req, reply) => {
      const body = req.body as { prompt: string; squadId?: SquadId; mode?: SquadMode; agents?: number };
      
      if (!body.prompt) {
        return reply.status(400).send({ error: 'Missing required field: prompt' });
      }

      const mode = body.mode ?? 'squad';
      const numAgents = body.agents ?? (mode === 'solo' ? 1 : mode === 'squad' ? 4 : 4);
      
      if (mode === 'squad' && numAgents < 2) {
        return reply.status(400).send({ error: 'Squad mode requires >= 2 agents' });
      }

      const taskId = randomUUID();
      let squadId = body.squadId;
      
      if (!squadId) {
        squadId = server.squadPool.claim(taskId) ?? undefined;
        if (!squadId) {
          return reply.status(503).send({ error: 'No squads available' });
        }
      } else {
        if (server.squadPool.isActive(squadId)) {
          return reply.status(409).send({ error: `Squad ${squadId} is already active` });
        }
        // Force claim the specific squad (bypassing private constraint since claim() lacks squadId param)
        (server.squadPool as any).activeAssignments.set(squadId, taskId);
      }

      const squadDef = server.squadPool.getSquad(squadId);
      const activeAgents = squadDef.members.slice(0, numAgents);
      if (!activeAgents.find(m => m.role === 'leader')) {
        activeAgents[0] = squadDef.leader;
      }

      const manifest: SquadManifest = {
        squadId,
        mode,
        taskId,
        prompt: body.prompt,
        agents: activeAgents,
        sessionName: `squad-${squadId}-${taskId}`,
        createdAt: new Date().toISOString(),
        status: 'queued'
      };

      server.activeSquads.set(squadId, manifest);

      return {
        squadId,
        taskId,
        leader: squadDef.leader.name,
        members: activeAgents.map(m => m.name),
        status: 'queued'
      };
    });

    this.app.get('/workspaces', async () => {
      return {
        workspaces: server.workspaces.map((w) => ({
          name: w.name,
          description: w.description,
          default: Boolean(w.default) || (!server.workspaces.some((x) => x.default) && server.workspaces[0] === w),
          repos: w.repos.map((r) => ({ name: r.name, repository: r.repository, branch: r.branch ?? 'main' })),
        })),
      };
    });

    this.app.get('/squads', async () => {
      const all = SQUAD_ROSTER.map(s => {
        const isActive = server.squadPool.isActive(s.id) || server.activeSquads.has(s.id);
        return {
          id: s.id,
          status: isActive ? 'active' : 'idle',
          taskId: server.activeSquads.get(s.id)?.taskId ?? null,
          leader: { name: s.leader.name, role: s.leader.role },
          members: s.members.map(m => ({ name: m.name, role: m.role })),
        };
      });
      return { squads: all, active: server.activeSquads.size, total: SQUAD_ROSTER.length };
    });

    this.app.get<{ Params: { id: string } }>('/squads/:id', async (req, reply) => {
      const squadId = server.squadPool.resolve(req.params.id);
      if (!squadId) {
        return reply.status(404).send({ error: `Squad or member ${req.params.id} not found` });
      }
      const manifest = server.activeSquads.get(squadId);
      if (!manifest) {
        return { squadId, status: 'idle' };
      }
      return {
        squadId,
        taskId: manifest.taskId,
        members: manifest.agents.map(m => m.name),
        status: manifest.status,
        mode: manifest.mode,
        prompt: manifest.prompt
      };
    });

    this.app.delete<{ Params: { id: string } }>('/squads/:id', async (req, reply) => {
      const squadId = server.squadPool.resolve(req.params.id);
      if (!squadId) {
        return reply.status(404).send({ error: `Squad or member ${req.params.id} not found` });
      }
      
      const manifest = server.activeSquads.get(squadId);
      if (!manifest) {
        return reply.status(404).send({ error: `Squad ${squadId} is not active` });
      }
      
      server.activeSquads.delete(squadId);
      server.squadPool.release(squadId);
      
      return { squadId, status: 'killed' };
    });

    this.app.get<{ Params: { id: string } }>('/squads/:id/output', async (req, reply) => {
      const squadId = server.squadPool.resolve(req.params.id);
      if (!squadId) {
        return reply.status(404).send({ error: `Squad or member ${req.params.id} not found` });
      }
      const manifest = server.activeSquads.get(squadId);
      if (!manifest) {
        return reply.status(404).send({ error: `Squad ${squadId} is not active` });
      }
      
      try {
        const runtime = createRuntime(server.orchConfig.defaultRuntime, server.orchConfig.docker);
        const output = await runtime.captureOutput(manifest.sessionName);
        return { squadId, sessionName: manifest.sessionName, output };
      } catch (err) {
        return reply.status(500).send({ error: 'Failed to capture output', details: String(err) });
      }
    });

    this.app.post<{ Params: { id: string } }>('/squads/:id/steer', async (req, reply) => {
      const squadId = server.squadPool.resolve(req.params.id);
      if (!squadId) {
        return reply.status(404).send({ error: `Squad or member ${req.params.id} not found` });
      }
      const manifest = server.activeSquads.get(squadId);
      if (!manifest) {
        return reply.status(404).send({ error: `Squad ${squadId} is not active` });
      }
      
      const body = req.body as { keys: string; pane?: number; target?: string };
      if (!body.keys) {
        return reply.status(400).send({ error: 'Missing keys' });
      }
      
      try {
        const runtime = createRuntime(server.orchConfig.defaultRuntime, server.orchConfig.docker);
        const targetSession = body.target ?? (body.pane !== undefined ? `${manifest.sessionName}.${body.pane}` : manifest.sessionName);
        await runtime.sendKeys(targetSession, body.keys);
        return { squadId, status: 'sent', keys: body.keys, target: targetSession };
      } catch (err) {
        return reply.status(500).send({ error: 'Failed to send keys', details: String(err) });
      }
    });

    this.app.post<{ Params: { id: string } }>('/squads/:id/council/join', async (req, reply) => {
      const squadId = server.squadPool.resolve(req.params.id);
      if (!squadId) {
        return reply.status(404).send({ error: `Squad or member ${req.params.id} not found` });
      }
      const manifest = server.activeSquads.get(squadId);
      if (!manifest) {
        return reply.status(404).send({ error: `Squad ${squadId} is not active` });
      }
      manifest.mode = 'council';
      return { squadId, mode: 'council', status: 'joined' };
    });

    this.app.post<{ Params: { id: string } }>('/squads/:id/council/overrule', async (req, reply) => {
      const squadId = server.squadPool.resolve(req.params.id);
      if (!squadId) {
        return reply.status(404).send({ error: `Squad or member ${req.params.id} not found` });
      }
      const manifest = server.activeSquads.get(squadId);
      if (!manifest) {
        return reply.status(404).send({ error: `Squad ${squadId} is not active` });
      }
      const body = req.body as { directive: string };
      if (!body.directive) {
        return reply.status(400).send({ error: 'Missing directive' });
      }
      
      try {
        const runtime = createRuntime(server.orchConfig.defaultRuntime, server.orchConfig.docker);
        await runtime.sendKeys(`${manifest.sessionName}.0`, body.directive + '\n');
        return { squadId, status: 'overruled', directive: body.directive };
      } catch (err) {
        return reply.status(500).send({ error: 'Failed to send directive', details: String(err) });
      }
    });

    // ── Agents registry ───────────────────────────────────────────────
    this.app.get('/agents/registry', async () => {
      const agents = await loadAgents(resolve(process.cwd(), '.smith/agents'));
      return { agents };
    });

    // ── Meetings ──────────────────────────────────────────────────────
    this.app.post('/meetings', async (req, reply) => {
      const body = (req.body ?? {}) as { agent?: string; all?: boolean };
      if (!body.agent && !body.all) {
        return reply.status(400).send({ error: 'provide "agent" (name/id) or "all": true' });
      }
      try {
        const join = await (await server.meetings()).open(body);
        return reply.status(201).send(join);
      } catch (e) {
        return reply.status(400).send({ error: (e as Error).message });
      }
    });

    this.app.get('/meetings', async () => ({ meetings: (await server.meetings()).list() }));

    this.app.delete<{ Params: { id: string } }>('/meetings/:id', async (req) => {
      await (await server.meetings()).close(req.params.id);
      return { id: req.params.id, status: 'closed' };
    });
  }

  // -------------------------------------------------------------------------
  // Queue Worker
  // -------------------------------------------------------------------------

  /**
   * Background loop that dequeues tasks and dispatches them,
   * respecting the maxConcurrent limit.
   */
  private startQueueWorker(): void {
    const tick = async (): Promise<void> => {
      while (
        this.taskQueue.length > 0 &&
        this.activeTasks.size < this.config.maxConcurrent
      ) {
        const manifest = this.taskQueue.shift()!;
        this.dispatchTask(manifest);
      }
    };

    // Poll every second
    setInterval(() => tick().catch((e) => this.app.log.error(e)), 1_000);
  }

  /**
   * Dispatch a single task and track it.
   * Runs in the background — does not block the queue worker.
   */
  private dispatchTask(manifest: TaskManifest): void {
    const runtimeType = manifest.runtime ?? this.orchConfig.defaultRuntime;
    const agentName = (manifest.agentName as AgentName | undefined) ?? this.namePool.getNameForTask(manifest.taskId) ?? null;
    const sessionName = agentName?.toLowerCase() ?? `task-${manifest.taskId}`;
    const runtime = createRuntime(runtimeType, this.orchConfig.docker);

    const task: ActiveTask = {
      manifest,
      status: 'dispatched',
      startedAt: new Date().toISOString(),
      sessionName,
      agentName,
      runtime,
    };

    this.activeTasks.set(manifest.taskId, task);
    task.status = 'running';

    this.app.log.info(
      `Dispatching ${agentName ?? manifest.taskId} (agent: ${manifest.agent}, runtime: ${manifest.runtime ?? this.orchConfig.defaultRuntime})`,
    );

    // Fire-and-forget: dispatch returns when the task completes
    task.promise = this.dispatcher.dispatch(manifest)
      .then((result: TaskResult) => {
        this.activeTasks.delete(manifest.taskId);
        this.namePool.releaseByTaskId(manifest.taskId);
        this.completedTasks.set(manifest.taskId, result);
        this.app.log.info(
          `Task ${manifest.taskId} ${result.outcome} (exit ${result.exitCode}, ${result.durationMs}ms)`,
        );
        return result;
      })
      .catch((error: unknown) => {
        this.activeTasks.delete(manifest.taskId);
        this.namePool.releaseByTaskId(manifest.taskId);
        const failResult: TaskResult = {
          taskId: manifest.taskId,
          outcome: 'failed',
          exitCode: -1,
          sessionName: `error-${manifest.taskId}`,
          worktreePath: '',
          startedAt: task.startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - new Date(task.startedAt).getTime(),
        };
        this.completedTasks.set(manifest.taskId, failResult);
        this.app.log.error(`Task ${manifest.taskId} error: ${error}`);
        return failResult;
      });
  }

  // -------------------------------------------------------------------------
  // Broadcasting (WebSocket + UDP)
  // -------------------------------------------------------------------------

  /** Broadcast an event to all WebSocket clients and UDP */
  private broadcast(event: DispatcherEvent): void {
    const payload = JSON.stringify(event);

    // WebSocket
    for (const ws of this.wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }

    // UDP multicast
    this.udpBroadcast(payload);
  }

  // -------------------------------------------------------------------------
  // UDP Heartbeat
  // -------------------------------------------------------------------------

  private startUdpHeartbeat(): void {
    try {
      this.udpSocket = createSocket({ type: 'udp4', reuseAddr: true });
      this.udpSocket.bind(this.config.udpPort, () => {
        this.udpSocket!.setBroadcast(true);
        try {
          this.udpSocket!.addMembership(this.config.udpMulticastAddr);
        } catch {
          // Multicast may not be available — fallback to broadcast
        }
      });

      this.heartbeatTimer = setInterval(() => {
        const heartbeat = {
          type: 'heartbeat',
          timestamp: new Date().toISOString(),
          activeTasks: this.activeTasks.size,
          queuedTasks: this.taskQueue.length,
          maxConcurrent: this.config.maxConcurrent,
          memory: Math.round(process.memoryUsage().rss / 1024 / 1024),
        };
        this.udpBroadcast(JSON.stringify(heartbeat));
      }, this.config.heartbeatIntervalMs);

      this.app.log.info('UDP heartbeat started');
    } catch (err) {
      this.app.log.warn(`UDP heartbeat failed to start: ${err}`);
    }
  }

  private udpBroadcast(message: string): void {
    if (!this.udpSocket) return;
    const buf = Buffer.from(message);
    this.udpSocket.send(
      buf, 0, buf.length,
      this.config.udpPort,
      this.config.udpMulticastAddr,
      () => {/* fire and forget */},
    );
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * Start the orchestrator server from the command line.
 *
 * Usage:
 *   npx tsx orchestrator/server.ts
 *   npx tsx orchestrator/server.ts --port 8080 --max-concurrent 8
 *
 * Binds loopback by default. To expose beyond localhost:
 *   SMITH_API_TOKEN=<secret> npx tsx orchestrator/server.ts --host 0.0.0.0
 * All routes except /health then require `Authorization: Bearer <secret>`
 * (WebSocket clients may pass ?token=<secret>).
 */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const config: Partial<ServerConfig> = {};

  for (let i = 0; i < args.length; i += 2) {
    switch (args[i]) {
      case '--port': config.port = parseInt(args[i + 1], 10); break;
      case '--host': config.host = args[i + 1]; break;
      case '--max-concurrent': config.maxConcurrent = parseInt(args[i + 1], 10); break;
      case '--udp-port': config.udpPort = parseInt(args[i + 1], 10); break;
    }
  }

  const server = new OrchestratorServer(config);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[server] Shutting down...');
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.start();
}

// Run if executed directly
const isMain = process.argv[1]?.endsWith('server.ts') ||
               process.argv[1]?.endsWith('server.js');
if (isMain) {
  main().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
