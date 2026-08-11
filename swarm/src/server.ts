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
  type RuntimeType,
  type LocationType,
} from './index.js';
import { WorkerPool } from './remote-runtime.js';
import {
  SquadPool,
  SQUAD_ROSTER,
  loadSquadsFromDir,
  setSquadRoster,
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
import { DeviceRegistry } from './device-registry.js';
import type { RemoteWorkerEntry } from './types.js';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { loadAgents, findAgent, saveAgent, activeAgents, type ComposedAgent } from './agents.js';
import { readAvatar, stageAvatar } from './avatars.js';
import { QUICK_QUESTIONS, STEREOTYPES, JOB_ROLES, ENGINES, LANGUAGES, DEFAULT_LANGUAGE, findStereotype, findJobRole, findEngine, findLanguage, REACTION_LEVELS, PRESET_AGENTS } from './personas.js';
import { AgentSessionManager } from './agent-sessions.js';
import { SessionStore } from './session-store.js';
import { agentUsage, isBusy } from './lifecycle.js';
import { isValidModelId } from './drivers/model-flag.js';
import {
  loadWorkspacesFromDir,
  resolveRepo,
  saveWorkspace,
  removeWorkspaceFile,
  isGitRepo,
  defaultViolation,
  activeWorkspaces,
  normalizeRepoBranch,
  initGitRepo,
  type Workspace,
  type WorkspaceRepo,
} from './workspaces.js';
import { loadUsersFromDir, saveUser, resolveCurrentUser, sweepEncryptUsers, type User, type ConnectorInstance, type VoiceSettings } from './users.js';
import { isEncrypted } from './secretbox.js';
import { verifyGithubRepo } from './verify-github.js';
import { verifyAtlassian } from './verify-atlassian.js';
import { VENDORS, findVendor, verifyBeforeSave } from './connectors.js';
import { loadChannelsFor, saveChannels, type WorkspaceChannels } from './channels.js';
import { verifyDiscordToken } from './verify-discord.js';
import { lookupTicket, searchDocs } from './atlassian-client.js';
import { MeetingOrchestrator } from './meetings.js';
import { loadLiveKitConfig } from './config.js';
import { dirname, resolve, isAbsolute } from 'node:path';
import {
  buildCliToolListings,
  gateReason,
  inactiveDetail,
  isActive,
  loadCliToolsFile,
  refreshCliTool,
  saveCliToolsFile,
  sweepCliTools,
  type SweepDeps,
} from './cli-tools.js';
import {
  buildExecutionModes,
  loadContainersFile,
  probeDocker,
  saveContainersFile,
} from './containers.js';
import {
  addCard, BOARD_TEMPLATES, BOARD_TYPE_LABELS, boardIdFor, type BoardType, createBoard, deleteBoardFile,
  findCardByRef, findRouteDestination, loadBoards, patchCard, removeCard, resolveExit, routeCard, saveBoard,
  type WorkBoard,
} from './work-items.js';
import { importIssues, searchIssues, transitionIssue } from './jira-sync.js';
import {
  applyStoryToggles,
  createCapability,
  deleteCapabilityFile,
  ensurePersonalBoard,
  ensureWorkspaceBoards,
  loadCapabilities,
  patchCapability,
  renderSpecSkeleton,
  repointSliceCardRef,
  resyncLinkedCards,
  saveCapability,
  sendSliceToBoard,
  sliceStories,
  slugify,
  unlinkCapabilityCards,
  unlinkSliceCard,
  type Capability,
} from './capabilities.js';
import {
  buildApiKeyListings,
  deleteKey,
  getCredential,
  loadApiKeysFile,
  saveAndVerifyKey,
  verifyStoredKey,
  type ApiKeyOpResult,
} from './api-keys.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Board card a task's manifest names in `metadata.workCardRef`, if any. */
type WorkCardRef = { boardId: string; cardId: string };

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
  /** Device pairing registry — the writer behind /workers/connect auth. */
  readonly deviceRegistry = new DeviceRegistry(resolve(process.cwd(), '.smith/devices.json'));
  private reapTimer: ReturnType<typeof setInterval> | null = null;
  readonly squadPool = new SquadPool();
  /** Warm conversational sessions (design §3) — lazy so tests don't need tmux. */
  private agentSessions: AgentSessionManager | null = null;
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
    this.dispatcher = new Dispatcher(this.orchConfig, this.workerPool);
    this.quarantine = new QuarantineManager(this.orchConfig.logsDir);

    // Create Fastify instance
    this.app = Fastify({
      // Fastify's 1 MiB default rejects a base64-encoded 2 MB avatar (needs ~2.8 MB with
      // JSON overhead) before decodeAvatarData's friendly 400 can fire. 4 MB gives headroom.
      bodyLimit: 4 * 1024 * 1024,
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
    this.dispatcher.on('task:completed', (e: DispatcherEvent) => this.forwardTaskOutcome(e));
    this.dispatcher.on('task:failed', (e: DispatcherEvent) => this.forwardTaskOutcome(e));
    this.dispatcher.on('task:quarantined', (e: DispatcherEvent) => this.broadcast(e));
    this.dispatcher.on('session:orphan_cleanup', (e: DispatcherEvent) => this.broadcast(e));
  }

  /**
   * Forward a task:completed/task:failed dispatcher event to WS clients. If
   * the task was dispatched from a board card (manifest.metadata.workCardRef,
   * still resolvable here — dispatchTask's `.then`/`.catch` only deletes the
   * activeTasks entry after `dispatch()` resolves, and this event fires from
   * inside `dispatch()` beforehand), the broadcast carries `workCardRef` and
   * the card's delegation state is best-effort patched to match.
   */
  private forwardTaskOutcome(e: DispatcherEvent): void {
    if (e.type !== 'task:completed' && e.type !== 'task:failed') return;
    const manifest = this.activeTasks.get(e.taskId)?.manifest;
    const workCardRef = manifest?.metadata?.workCardRef as WorkCardRef | undefined;
    if (workCardRef) {
      void this.patchWorkCard(workCardRef, e.type === 'task:completed' ? 'completed' : 'failed', e.result.pullRequestUrl).catch(() => {});
    }
    this.broadcast((workCardRef ? { ...e, workCardRef } : e) as unknown as DispatcherEvent);
  }

  /** Reread `.smith/workspaces/*.json` — called at boot and after every mutation below. */
  private async reloadWorkspaces(): Promise<void> {
    this.workspaces = await loadWorkspacesFromDir(resolve(process.cwd(), '.smith/workspaces'));
  }

  /**
   * Adopt warm sessions that outlived the last run. Never fatal: a swarm that
   * cannot reconcile must still boot and serve, or one bad record takes the
   * whole orchestrator down.
   */
  private async reconcileSessions(): Promise<void> {
    try {
      const agents = await loadAgents(resolve(process.cwd(), '.smith/agents'));
      const hashes = new Map(
        agents.map((a) => [a.id, createHash('sha256').update(JSON.stringify(a)).digest('hex').slice(0, 16)]),
      );
      const manager = new AgentSessionManager(createRuntime('tmux', this.orchConfig.docker), {
        agentCommands: this.orchConfig.agentCommands,
        worktreeDir: this.orchConfig.worktreeDir,
        store: new SessionStore(resolve(process.cwd(), '.smith/sessions')),
        toolGate: async (cli) => gateReason(await loadCliToolsFile(resolve(process.cwd(), '.smith/cli-tools.json')), cli),
      });
      const summary = await manager.reconcile(hashes);
      this.agentSessions = manager;
      if (summary.adopted || summary.forgotten || summary.killed || summary.orphans.length) {
        this.app.log.info(
          `Session reconciliation: adopted ${summary.adopted}, forgot ${summary.forgotten}, killed ${summary.killed}` +
            (summary.orphans.length ? `, ${summary.orphans.length} orphan(s) left running: ${summary.orphans.join(', ')}` : ''),
        );
      }
    } catch (err) {
      this.app.log.warn(`Session reconciliation skipped: ${(err as Error).message}`);
    }
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

    // Squads are data, like agents: seeded on first boot, then owned by
    // .smith/squads/*.json — an empty dir legitimately means "no squads".
    setSquadRoster(await loadSquadsFromDir(resolve(process.cwd(), '.smith/squads')));

    await this.reconcileSessions();

    await this.reloadWorkspaces();
    if (this.workspaces.length > 0) {
      this.app.log.info(`Workspaces: ${this.workspaces.map((w) => `${w.name}(${w.repos.map((r) => r.name).join(',')})`).join(' ')}`);
    }

    try {
      const legacy = await Promise.all([
        stat(resolve(process.cwd(), '.smith/project.json')).then(() => '.smith/project.json', () => null),
        stat(resolve(process.cwd(), '.smith/projects')).then(() => '.smith/projects/', () => null),
      ]);
      for (const found of legacy.filter(Boolean)) {
        this.app.log.warn(`${found} is a legacy project config — projects were removed; use .smith/workspaces/ (see PRD §2)`);
      }
    } catch { /* fs races are not boot problems */ }

    await this.deviceRegistry.load();

    await this.registerPlugins();
    this.registerAuthHook();
    this.registerRoutes();
    this.startUdpHeartbeat();
    this.startQueueWorker();

    // Reap workers whose heartbeats stopped without a socket close (sleep,
    // NAT timeout, kill -9). 45s = 4 missed 10s heartbeats + slack.
    this.reapTimer = setInterval(() => {
      for (const id of this.workerPool.reapStale(45_000)) {
        this.app.log.warn(`Reaped stale remote worker: ${id}`);
        this.broadcast({ type: 'worker:disconnected', workerId: id } as unknown as DispatcherEvent);
      }
    }, 15_000);

    // Belt-and-braces on top of sweepEncryptUsers' own per-file skip-and-
    // continue: also guards the failure mode that isn't per-file, e.g.
    // resolveMasterKey unable to create ~/.smith (read-only/absent HOME). An
    // un-swept file still works fine — saveUser encrypts on the next write.
    try {
      await sweepEncryptUsers(resolve(process.cwd(), '.smith/users'));
    } catch (err) {
      this.app.log.warn(`User encrypt-sweep failed, continuing unswept: ${(err as Error).message}`);
    }

    await this.app.listen({ port: this.config.port, host: this.config.host });

    // CLI tool registry: probe machine reality in the background — the cached
    // file serves until fresh results land (spec: startup + manual +
    // on-failure; never a boot gate, never periodic).
    void sweepCliTools(resolve(process.cwd(), '.smith/cli-tools.json'), {
      agentCommands: this.orchConfig.agentCommands,
      clis: ENGINES.map((e) => e.cli),
    }).then(
      (f) =>
        this.app.log.info(
          `CLI tools: ${ENGINES.map((e) => `${e.cli}=${isActive(f.tools[e.cli]) ? 'active' : 'inactive'}`).join(' ')}`,
        ),
      (err) => this.app.log.warn(`CLI tool sweep failed: ${(err as Error).message}`),
    );

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
    if (this.reapTimer) clearInterval(this.reapTimer);
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

  /** Constant-time comparison of two secrets — delegates to the exported helper. */
  private static secretsEqual(a: string | undefined, b: string | undefined): boolean {
    return secretsEqual(a, b);
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
    // /devices/redeem authenticates via single-use pairing code; /workers/connect
    // via the device token in its register frame (fail-closed, 10s deadline).
    // Neither client holds SMITH_API_TOKEN — that is the point of pairing.
    const exempt = new Set(['/health', '/devices/redeem', '/workers/connect']);
    this.app.addHook('onRequest', async (req, reply) => {
      const path = req.url.split('?')[0];
      if (exempt.has(path)) return;
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
  // Work boards — the user's kanban store
  // -------------------------------------------------------------------------

  private workDir(): string {
    return resolve(process.cwd(), '.smith/work');
  }

  /**
   * A finishing task that was dispatched from a board card writes its
   * outcome back onto the card — state only, never the column; columns
   * belong to the human. Best-effort: a store hiccup must not disturb
   * task bookkeeping.
   *
   * findCardByRef, not a boardId lookup: the manifest's ref is stamped at
   * dispatch, and deliver/in-progress — where delegated cards live — has a
   * "Back to plan" route out of it. Silence is right for a DELETED card; a
   * MOVED one still exists, and missing it strands the card on a spinning
   * "working" badge forever with no PR link.
   */
  private async patchWorkCard(
    ref: WorkCardRef,
    state: 'completed' | 'failed',
    prUrl?: string,
  ): Promise<void> {
    const { boards } = await loadBoards(this.workDir());
    const found = findCardByRef(boards, ref);
    const delegation = found?.card.delegation;
    if (!found || !delegation) return;
    patchCard(found.board, found.card.id, { delegation: { ...delegation, state, prUrl: prUrl ?? delegation.prUrl } });
    await saveBoard(this.workDir(), found.board);
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

      // Resolve the composed-agent profile (broker sends composedAgentId) so
      // the dispatcher can materialize it into the worktree (design §5).
      const composedId = (body.metadata as Record<string, unknown> | undefined)?.composedAgentId;
      let agents: ComposedAgent[] = [];
      if (typeof composedId === 'string') {
        agents = await loadAgents(resolve(process.cwd(), '.smith/agents'));
        const composedAgent = agents.find((a) => a.id === composedId);
        if (composedAgent?.archived) return reply.status(404).send({ error: `${composedAgent.name} is archived` });
      }
      const { profile, model } = enrichFromComposedAgent(agents, composedId);

      const taskId = randomUUID();
      const agentName = server.namePool.claim(taskId);
      const resolvedRuntime = resolveTaskRuntime(body.runtime, server.orchConfig.defaultRuntime);
      const manifest: TaskManifest = {
        taskId,
        prompt: body.prompt,
        agentName: agentName ?? undefined,
        agent: body.agent,
        runtime: resolvedRuntime.runtime,
        location: body.location ?? resolvedRuntime.location,
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
        profile,
        model,
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
        pullRequestUrl: r.pullRequestUrl,
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
        const workCardRef = active.manifest.metadata?.workCardRef as WorkCardRef | undefined;
        if (workCardRef) void server.patchWorkCard(workCardRef, 'failed').catch(() => {});
        server.broadcast({
          type: 'task:failed',
          taskId,
          result: { taskId, outcome: 'failed', exitCode: -9, sessionName: active.sessionName, worktreePath: '', startedAt: active.startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - new Date(active.startedAt).getTime() },
          ...(workCardRef ? { workCardRef } : {}),
        } as unknown as DispatcherEvent);
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
      // Auth-exempt endpoint: a socket that hasn't produced a valid register
      // frame within the deadline is dropped, so strangers can't hold sockets.
      const authDeadline = setTimeout(() => { if (!workerId) socket.close(); }, 10_000);

      socket.on('message', (data: Buffer) => {
        void (async () => {
          const msg = JSON.parse(data.toString()) as WorkerMessage;

          if (msg.type === 'register') {
            const reg = msg as WorkerRegisterMessage;

            // Fail closed: a device token must verify against the pairing
            // registry, or (legacy) the secret must match a configured
            // worker. Token-authed workers adopt their deviceId as identity.
            const verdict = await evaluateWorkerRegistration(
              reg, server.deviceRegistry, server.orchConfig.remoteWorkers ?? []);

            if (!verdict.accepted) {
              const reject: RegisteredMessage = {
                type: 'registered',
                accepted: false,
                orchestratorId: 'orchestrator',
                message: verdict.reason,
              };
              socket.send(JSON.stringify(reject));
              socket.close();
              return;
            }

            workerId = verdict.poolWorkerId;
            clearTimeout(authDeadline);
            if (verdict.deviceId) void server.deviceRegistry.touch(verdict.deviceId);

            const workerInfo: ConnectedWorker = {
              workerId: verdict.poolWorkerId,
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

            server.workerPool.addWorker(verdict.poolWorkerId, workerInfo, socket as unknown as import('ws').WebSocket);

            const ack: RegisteredMessage = {
              type: 'registered',
              accepted: true,
              orchestratorId: 'orchestrator',
              message: `Welcome ${reg.name} (${reg.capacity} slots)`,
            };
            socket.send(JSON.stringify(ack));

            server.app.log.info(
              `Remote worker registered: ${reg.name} (${verdict.poolWorkerId}) — ${reg.capacity} slots`,
            );

            server.broadcast({
              type: 'worker:connected',
              workerId: verdict.poolWorkerId,
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
        })().catch((err) => {
          server.app.log.error(`Invalid message from worker: ${err}`);
        });
      });

      socket.on('close', () => {
        clearTimeout(authDeadline);
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

    // ── Device pairing ───────────────────────────────────────────────
    this.app.post('/devices/pair-codes', async (_req, reply) => {
      const { code, expiresAt } = server.deviceRegistry.mintPairingCode();
      return reply.status(201).send({ code, expiresAt: new Date(expiresAt).toISOString() });
    });

    this.app.post('/devices/redeem', async (req, reply) => {
      const body = (req.body ?? {}) as { code?: string; name?: string };
      if (!body.code || !body.name) {
        return reply.status(400).send({ error: 'Missing required fields: code, name' });
      }
      const result = await server.deviceRegistry.redeem(body.code, body.name);
      if (!result) return reply.status(410).send({ error: 'Invalid or expired pairing code' });
      server.app.log.info(`Device paired: ${body.name} (${result.deviceId})`);
      return reply.status(201).send(result);
    });

    this.app.get('/devices', async () => {
      const connected = new Set(server.workerPool.listWorkers().map((w) => w.workerId));
      return {
        devices: server.deviceRegistry.list().map((d) => ({
          deviceId: d.deviceId, name: d.name, createdAt: d.createdAt,
          lastSeenAt: d.lastSeenAt, revoked: Boolean(d.revoked),
          connected: connected.has(d.deviceId),
        })),
      };
    });

    this.app.delete<{ Params: { deviceId: string } }>('/devices/:deviceId', async (req, reply) => {
      const ok = await server.deviceRegistry.revoke(req.params.deviceId);
      if (!ok) return reply.status(404).send({ error: 'Unknown device' });
      server.workerPool.disconnectWorker(req.params.deviceId);
      return { revoked: true };
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

    // ── Agent creation catalog + registry writes ───────────────────────
    this.app.get('/agents/catalog', async () => {
      // Annotate, don't filter (spec): the wizard grays out inactive engines
      // with the reason instead of hiding them.
      const cliFile = await loadCliToolsFile(resolve(process.cwd(), '.smith/cli-tools.json'));
      return {
        stereotypes: STEREOTYPES,
        jobRoles: JOB_ROLES,
        engines: ENGINES.map((e) => ({
          ...e,
          active: isActive(cliFile.tools[e.cli]),
          statusDetail: inactiveDetail(cliFile.tools[e.cli]) || undefined,
        })),
        languages: LANGUAGES,
        quickQuestions: QUICK_QUESTIONS,
        reactionLevels: REACTION_LEVELS,
        presets: PRESET_AGENTS,
      };
    });

    // Portrait bytes. Live agents' art first, committed preset art second —
    // one URL shape for roster avatars and chooser cards alike. The filename
    // regex inside readAvatar doubles as the traversal guard.
    this.app.get<{ Params: { file: string } }>('/avatars/:file', async (req, reply) => {
      const buf = await readAvatar(
        req.params.file,
        resolve(process.cwd(), '.smith/avatars'),
        resolve(process.cwd(), 'assets/avatars'),
      );
      if (!buf) return reply.status(404).send({ error: `Unknown avatar: ${req.params.file}` });
      return reply.type('image/png').send(buf);
    });

    this.app.post('/agents', async (req, reply) => {
      const b = req.body as Partial<ComposedAgent> & { stereotype?: string };
      if (!b.name?.trim()) return reply.status(400).send({ error: 'Missing required field: name' });
      const id = (b.id ?? b.name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const seed = b.stereotype ? findStereotype(b.stereotype) : undefined;
      if (b.stereotype && !seed) return reply.status(400).send({ error: `Unknown stereotype: ${b.stereotype}` });
      const jobRoleId = (b as { jobRole?: string }).jobRole;
      const job = jobRoleId ? findJobRole(jobRoleId) : undefined;
      if (jobRoleId && !job) return reply.status(400).send({ error: `Unknown job role: ${jobRoleId}` });

      if (b.engine?.cli && !findEngine(b.engine.cli)) {
        return reply.status(400).send({ error: `Unknown CLI: ${b.engine.cli}` });
      }
      const requestedCli = b.engine?.cli ?? 'claude'; // must gate the default too
      const cliGate = gateReason(await loadCliToolsFile(resolve(process.cwd(), '.smith/cli-tools.json')), requestedCli);
      if (cliGate) return reply.status(400).send({ error: `${requestedCli} is not available: ${cliGate}` });
      if (b.language && !findLanguage(b.language)) {
        return reply.status(400).send({ error: `Unknown language: ${b.language}` });
      }
      // The model reaches a shell command string at launch. Reject a bad id
      // here so the wizard shows a clear error, rather than at launch time —
      // and so a malformed one is never persisted to an agent file.
      const requestedModel = b.engine?.model?.trim();
      if (requestedModel && requestedModel !== 'default' && !isValidModelId(requestedModel)) {
        return reply.status(400).send({
          error: `Invalid model id: ${requestedModel}. Use letters, digits, and . _ : / - only (e.g. "claude-opus" or "anthropic/claude-sonnet").`,
        });
      }

      const agentsDir = resolve(process.cwd(), '.smith/agents');
      const existing = await loadAgents(agentsDir);
      const collider = existing.find((a) => a.id === id);
      if (collider) {
        return reply.status(409).send({
          error: collider.archived
            ? `The name "${id}" belongs to an archived agent — pick another`
            : `Agent "${id}" already exists`,
        });
      }

      const withAvatar = b as typeof b & { avatarData?: string; avatarPreset?: string };
      let avatar: string | undefined;
      try {
        avatar = await stageAvatar({
          agentId: id,
          liveDir: resolve(process.cwd(), '.smith/avatars'),
          presetDir: resolve(process.cwd(), 'assets/avatars'),
          avatarData: withAvatar.avatarData,
          avatarPreset: withAvatar.avatarPreset,
        });
      } catch (err) {
        return reply.status(400).send({ error: `avatar: ${String((err as Error).message)}` });
      }

      // The stereotype seeds; every field the wizard sent wins over it.
      const agent: ComposedAgent = {
        id,
        name: b.name.trim(),
        role: b.role?.trim() || job?.label || seed?.label || 'Specialist',
        // Job role says WHAT they own; the stereotype colors HOW they say it.
        directives: b.directives?.trim() || job?.directives || seed?.directives || 'You are a specialist on this team.',
        engine: {
          cli: b.engine?.cli ?? 'claude',
          model: b.engine?.model ?? findEngine(b.engine?.cli ?? 'claude')?.models[0] ?? 'claude-sonnet',
        },
        persona: { style: b.persona?.style?.trim() || seed?.style || '' },
        stereotype: b.stereotype,
        // Kept so the edit wizard can restore the dropdown; `role` alone is a
        // free-text title and cannot be mapped back to a catalog entry.
        jobRole: job?.id,
        gender: b.gender,
        backstory: b.backstory?.trim() || undefined,
        language: b.language ?? DEFAULT_LANGUAGE,
        reactions: b.reactions ?? seed?.reactions,
        quickAnswers: b.quickAnswers,
        voice: b.voice?.voiceId ? { provider: 'elevenlabs', voiceId: b.voice.voiceId } : undefined,
        avatarRing: b.avatarRing,
        avatar,
        channels: ['tauri'],
      };
      try {
        await saveAgent(agentsDir, agent);
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
      server.app.log.info(`Agent created: ${agent.id} (${agent.name})`);
      return reply.status(201).send(agent);
    });

    // Reusable across the edit route and the usage/archive/delete routes
    // below — reuses the same session-manager closure the warm-session
    // routes rely on. Task refs carry both the stable composed-agent id
    // (from metadata.composedAgentId, when the caller sent one) and the
    // display name, so isBusy/agentUsage can match by id first and fall
    // back to name only for tasks whose manifest predates the id.
    const agentFacts = async (agent: ComposedAgent) => {
      const records = await new SessionStore(resolve(process.cwd(), '.smith/sessions')).load();
      const live = server.agentSessions ? (await server.agentSessions.list()).map((s) => s.agentId) : [];
      const taskRefs = [...server.activeTasks.values()]
        .map((t) => ({
          composedAgentId: typeof t.manifest.metadata?.composedAgentId === 'string' ? t.manifest.metadata.composedAgentId : undefined,
          profileName: t.manifest.profile?.name,
        }))
        .filter((ref) => ref.composedAgentId !== undefined || ref.profileName !== undefined);
      return { records, live, taskRefs };
    };

    // Editing an existing agent. Merge, don't replace: the wizard submits
    // every field it knows, but a caller that sends three fields must not
    // silently blank the rest of the persona.
    this.app.put<{ Params: { id: string } }>('/agents/:id', async (req, reply) => {
      const b = req.body as Partial<ComposedAgent> & { stereotype?: string; jobRole?: string };
      const agentsDir = resolve(process.cwd(), '.smith/agents');
      const agents = await loadAgents(agentsDir);
      const existing = agents.find((a) => a.id === req.params.id);
      if (!existing) return reply.status(404).send({ error: `Unknown agent: ${req.params.id}` });

      // Renaming (or any edit) mid-task would dissolve the busy-lock and
      // task attribution out from under a running task — block all edits
      // while busy, matching the UI, which already locks busy agents from
      // the edit wizard.
      const { live, taskRefs } = await agentFacts(existing);
      if (isBusy(live, taskRefs, existing)) {
        return reply.status(409).send({ error: `${existing.name} is working — cancel their task or session first` });
      }

      if (b.stereotype && !findStereotype(b.stereotype)) {
        return reply.status(400).send({ error: `Unknown stereotype: ${b.stereotype}` });
      }
      if (b.engine?.cli && !findEngine(b.engine.cli)) {
        return reply.status(400).send({ error: `Unknown CLI: ${b.engine.cli}` });
      }
      if (b.engine?.cli && b.engine.cli !== existing.engine.cli) {
        const cliGate = gateReason(await loadCliToolsFile(resolve(process.cwd(), '.smith/cli-tools.json')), b.engine.cli);
        if (cliGate) return reply.status(400).send({ error: `${b.engine.cli} is not available: ${cliGate}` });
      }
      if (b.language && !findLanguage(b.language)) {
        return reply.status(400).send({ error: `Unknown language: ${b.language}` });
      }
      if (b.jobRole && !findJobRole(b.jobRole)) {
        return reply.status(400).send({ error: `Unknown job role: ${b.jobRole}` });
      }
      const nextModel = b.engine?.model?.trim();
      if (nextModel && nextModel !== 'default' && !isValidModelId(nextModel)) {
        return reply.status(400).send({
          error: `Invalid model id: ${nextModel}. Use letters, digits, and . _ : / - only (e.g. "claude-opus").`,
        });
      }

      const updated = buildAgentUpdate(existing, b);
      const withAvatar = b as typeof b & { avatarData?: string };
      if (withAvatar.avatarData) {
        try {
          updated.avatar = await stageAvatar({
            agentId: existing.id,
            liveDir: resolve(process.cwd(), '.smith/avatars'),
            presetDir: resolve(process.cwd(), 'assets/avatars'),
            avatarData: withAvatar.avatarData,
          });
        } catch (err) {
          return reply.status(400).send({ error: `avatar: ${String((err as Error).message)}` });
        }
      }
      try {
        await saveAgent(agentsDir, updated);
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
      server.app.log.info(`Agent updated: ${updated.id} (${updated.name})`);
      return reply.status(200).send(updated);
    });

    this.app.get<{ Params: { id: string } }>('/agents/:id/usage', async (req, reply) => {
      const agents = await loadAgents(resolve(process.cwd(), '.smith/agents'));
      const agent = agents.find((a) => a.id === req.params.id);
      if (!agent) return reply.status(404).send({ error: `Unknown agent: ${req.params.id}` });
      const { records, live, taskRefs } = await agentFacts(agent);
      return agentUsage(agent, records, live, taskRefs);
    });

    this.app.post<{ Params: { id: string } }>('/agents/:id/archive', async (req, reply) => {
      const agentsDir = resolve(process.cwd(), '.smith/agents');
      const agents = await loadAgents(agentsDir);
      const agent = agents.find((a) => a.id === req.params.id);
      if (!agent) return reply.status(404).send({ error: `Unknown agent: ${req.params.id}` });
      const { live, taskRefs } = await agentFacts(agent);
      if (isBusy(live, taskRefs, agent)) {
        return reply.status(409).send({ error: `${agent.name} is working — cancel their task or session first` });
      }
      await saveAgent(agentsDir, { ...agent, archived: true });
      return { ok: true, archived: agent.id };
    });

    this.app.delete<{ Params: { id: string } }>('/agents/:id', async (req, reply) => {
      const agentsDir = resolve(process.cwd(), '.smith/agents');
      const agents = await loadAgents(agentsDir);
      const agent = agents.find((a) => a.id === req.params.id);
      if (!agent) return reply.status(404).send({ error: `Unknown agent: ${req.params.id}` });
      // Defense in depth: the broker decides archive-vs-delete, but swarm
      // re-checks its own facts so a buggy caller cannot erase history.
      const { records, live, taskRefs } = await agentFacts(agent);
      const usage = agentUsage(agent, records, live, taskRefs);
      if (usage.warmSessions > 0 || usage.activeTasks > 0) {
        return reply.status(409).send({ error: `${agent.name} has history on this machine — archive instead` });
      }
      await rm(resolve(agentsDir, `${agent.id}.json`));
      return { ok: true, deleted: agent.id };
    });

    // ── Persistent agent sessions (warm conversational workers) ────────
    const sessionManager = (): AgentSessionManager => {
      server.agentSessions ??= new AgentSessionManager(createRuntime('tmux', server.orchConfig.docker), {
        agentCommands: server.orchConfig.agentCommands,
        worktreeDir: server.orchConfig.worktreeDir,
        store: new SessionStore(resolve(process.cwd(), '.smith/sessions')),
        toolGate: async (cli) => gateReason(await loadCliToolsFile(resolve(process.cwd(), '.smith/cli-tools.json')), cli),
      });
      return server.agentSessions;
    };
    const sessionErrorStatus = (err: unknown): number => {
      const code = (err as { code?: string }).code;
      if (code === 'session_not_found') return 404;
      if (code === 'session_dead') return 410;
      if (code === 'turn_timeout') return 408;
      return 500;
    };

    this.app.post('/agent-sessions', async (req, reply) => {
      const body = req.body as { agent?: string; workspace?: string; repo?: string };
      if (!body.agent) return reply.status(400).send({ error: 'Missing required field: agent' });
      const agents = await loadAgents(resolve(process.cwd(), '.smith/agents'));
      const agent = findAgent(agents, body.agent);
      if (!agent) return reply.status(404).send({ error: `Unknown agent: ${body.agent}` });
      if (agent?.archived) return reply.status(404).send({ error: `${agent.name} is archived` });
      const resolved = resolveRepo(server.workspaces, body.workspace, body.repo);
      if ((body.workspace || body.repo) && !resolved) {
        return reply.status(400).send({ error: `Unknown workspace/repo: ${body.workspace ?? '(default)'}/${body.repo ?? '(default)'}` });
      }
      const repoRoot = resolved?.repo.path ?? process.cwd();
      const baseBranch = resolved?.repo.branch ?? 'main';
      try {
        // Pin the profile content at start (design §5): a changed agent file
        // never mutates a live session — it means a new session.
        const raw = JSON.stringify(agent);
        const info = await sessionManager().create(agent, raw, repoRoot, baseBranch);
        return reply.status(201).send(info);
      } catch (err) {
        if ((err as { code?: string }).code === 'tool_launch_failed') {
          // Self-correction (spec: on-failure re-probe): a launch failure is
          // the freshest signal — refresh just this tool, fire-and-forget.
          void refreshCliTool(
            resolve(process.cwd(), '.smith/cli-tools.json'),
            server.orchConfig.agentCommands,
            agent.engine.cli,
          ).catch(() => {});
        }
        return reply.status(sessionErrorStatus(err)).send({ error: String((err as Error).message) });
      }
    });

    this.app.get('/agent-sessions', async () => {
      return { sessions: server.agentSessions ? await server.agentSessions.list() : [] };
    });

    this.app.post<{ Params: { id: string } }>('/agent-sessions/:id/send', async (req, reply) => {
      const body = req.body as { text?: string; timeoutMs?: number };
      if (!body.text?.trim()) return reply.status(400).send({ error: 'Missing required field: text' });
      try {
        const messages = await sessionManager().send(req.params.id, body.text, body.timeoutMs);
        return { messages };
      } catch (err) {
        return reply.status(sessionErrorStatus(err)).send({ error: String((err as Error).message) });
      }
    });

    this.app.get<{ Params: { id: string } }>('/agent-sessions/:id/messages', async (req, reply) => {
      try {
        return { messages: await sessionManager().messages(req.params.id) };
      } catch (err) {
        return reply.status(sessionErrorStatus(err)).send({ error: String((err as Error).message) });
      }
    });

    this.app.delete<{ Params: { id: string } }>('/agent-sessions/:id', async (req, reply) => {
      try {
        await sessionManager().destroy(req.params.id);
        return { ok: true };
      } catch (err) {
        return reply.status(sessionErrorStatus(err)).send({ error: String((err as Error).message) });
      }
    });

    // ── Reset ──────────────────────────────────────────────────────────
    // Tiered, explicit, and never silent: the caller names the scope and gets
    // back exactly what was destroyed and what was preserved. Remote workers
    // are NEVER killed — they are other machines' processes.
    this.app.post('/reset', async (req) => {
      const body = (req.body ?? {}) as { runtime?: boolean; worktrees?: boolean; agents?: boolean };
      const scope = { runtime: body.runtime !== false, worktrees: Boolean(body.worktrees), agents: Boolean(body.agents) };
      const killed = { warmSessions: 0, taskSessions: 0, queued: 0, active: 0, worktrees: 0, agents: 0, squads: 0 };
      const preserved: string[] = [];

      if (scope.runtime) {
        // Warm conversational sessions first (they own worktrees + branches).
        if (server.agentSessions) {
          for (const info of await server.agentSessions.list()) {
            await server.agentSessions.destroy(info.id).catch(() => {});
            killed.warmSessions += 1;
          }
        }
        killed.queued = server.taskQueue.length;
        server.taskQueue.length = 0;
        for (const [taskId, task] of server.activeTasks) {
          await task.runtime?.kill(task.sessionName).catch(() => {});
          server.namePool.releaseByTaskId(taskId);
          killed.active += 1;
        }
        server.activeTasks.clear();
        // Sweep any orphaned local sessions this swarm launched.
        const local = createRuntime('tmux', server.orchConfig.docker);
        killed.taskSessions = await local.killPattern(`${server.orchConfig.tmuxPrefix}-`).catch(() => 0);
        killed.taskSessions += await local.killPattern('smith-warm-').catch(() => 0);
        server.completedTasks.clear();
      }

      const remoteWorkers = server.workerPool.listWorkers().length;
      if (remoteWorkers > 0) preserved.push(`${remoteWorkers} remote worker(s) — remote instances are never killed`);

      if (scope.worktrees) {
        // Prune only orphaned worktree registrations; task BRANCHES (and their
        // PRs) survive — committed work is never destroyed by a reset.
        for (const workspace of server.workspaces) {
          for (const repo of workspace.repos) {
            await new Promise<void>((res) => {
              execFile('git', ['worktree', 'prune'], { cwd: repo.path }, () => res());
            });
            killed.worktrees += 1;
          }
        }
        preserved.push('task branches and their pull requests (committed work is never destroyed)');
      } else {
        preserved.push('worktrees, task branches, and pull requests');
      }

      if (scope.agents) {
        // Roster wipe: personas and squads are user data, so they are
        // archived, never deleted — restore by moving the files back.
        const stamp = Date.now();
        const agentsDir = resolve(process.cwd(), '.smith/agents');
        const existing = await loadAgents(agentsDir);
        if (existing.length > 0) {
          await rename(agentsDir, resolve(process.cwd(), `.smith/agents-archived-${stamp}`)).catch(() => {});
          await mkdir(agentsDir, { recursive: true }).catch(() => {});
          killed.agents = existing.length;
        }
        // Portraits ride with the roster: archived beside it, never deleted.
        await rename(
          resolve(process.cwd(), '.smith/avatars'),
          resolve(process.cwd(), `.smith/avatars-archived-${stamp}`),
        ).catch(() => {});
        // Work boards are user data too: archived beside the roster, never deleted.
        await rename(
          resolve(process.cwd(), '.smith/work'),
          resolve(process.cwd(), `.smith/work-archived-${stamp}`),
        ).catch(() => {});
        const squadsDir = resolve(process.cwd(), '.smith/squads');
        killed.squads = SQUAD_ROSTER.length;
        await rename(squadsDir, resolve(process.cwd(), `.smith/squads-archived-${stamp}`)).catch(() => {});
        await mkdir(squadsDir, { recursive: true }).catch(() => {});
        setSquadRoster([]);
        if (killed.agents > 0 || killed.squads > 0) {
          preserved.push(`agents and squads archived to .smith/*-archived-${stamp} (restore by moving them back)`);
        }
      } else {
        preserved.push('agent personas and squads');
      }

      server.app.log.warn(`Reset (${JSON.stringify(scope)}): ${JSON.stringify(killed)}`);
      server.broadcast({ type: 'session:orphan_cleanup', sessionPattern: `${server.orchConfig.tmuxPrefix}-*`, killed: killed.taskSessions });
      return { ok: true, scope, killed, preserved };
    });

    this.app.post('/workspaces', async (req, reply) => {
      const b = req.body as Partial<Workspace> & { repos?: Array<WorkspaceRepo & { initGit?: boolean }> };
      const initProblem = await gitInitRequestedRepos(b.repos);
      if (initProblem) return reply.status(400).send({ error: initProblem });
      const problem = await workspaceProblems(b);
      if (problem) return reply.status(400).send({ error: problem });
      const dir = resolve(process.cwd(), '.smith/workspaces');
      const name = b.name!.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const all = await loadWorkspacesFromDir(dir);
      const collider = all.find((w) => w.name === name);
      if (collider) {
        return reply.status(409).send({
          error: collider.archived
            ? `The name "${name}" belongs to an archived workspace — pick another`
            : `Workspace "${name}" already exists`,
        });
      }
      const ws: Workspace = {
        name,
        description: b.description?.trim() || undefined,
        repos: b.repos!.map((r) => ({
          name: r.name.trim(),
          path: r.path,
          repository: r.repository,
          branch: r.branch || 'main',
          github: r.github,
        })),
        default: Boolean(b.default) || activeWorkspaces(all).length === 0,
        atlassian: b.atlassian,
        links: sanitizeLinks(b.links),
        color: b.color?.trim() || undefined,
      };
      try {
        if (ws.default) for (const other of all.filter((w) => w.default)) await saveWorkspace(dir, { ...other, default: undefined });
        await saveWorkspace(dir, ws);
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
      // A new workspace gets Ideation + Plan + Deliver; the other three via
      // "+ add". Without this the Board stage shows only the Personal tab
      // until the user creates a capability or hand-adds every board.
      // Best-effort: a name too long to fit a board id (createBoard throws)
      // or a disk hiccup must not fail a workspace that already saved.
      await ensureWorkspaceBoards(server.workDir(), ws.name).catch((err) => {
        server.app.log.warn(`Could not provision boards for workspace "${ws.name}": ${String((err as Error).message)}`);
      });
      await server.reloadWorkspaces();
      return reply.status(201).send(ws);
    });

    this.app.put<{ Params: { name: string } }>('/workspaces/:name', async (req, reply) => {
      const b = req.body as Partial<Workspace>;
      const dir = resolve(process.cwd(), '.smith/workspaces');
      const all = await loadWorkspacesFromDir(dir);
      const existing = all.find((w) => w.name === req.params.name);
      if (!existing) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
      const merged: Workspace = {
        ...existing,
        // The name is the file key and what sessions point at — immutable.
        name: existing.name,
        description: b.description !== undefined ? b.description.trim() || undefined : existing.description,
        repos: b.repos ? normalizeRepoBranch(b.repos) : existing.repos,
        default: b.default ?? existing.default,
        archived: b.archived === false ? undefined : existing.archived,
        atlassian: b.atlassian !== undefined ? b.atlassian : existing.atlassian,
        links: b.links !== undefined ? sanitizeLinks(b.links) : existing.links,
        color: b.color !== undefined ? b.color.trim() || undefined : existing.color,
      };
      if (merged.default && merged.archived) {
        return reply.status(409).send({ error: `"${existing.name}" is archived — un-archive it before making it the default` });
      }
      const problem = await workspaceProblems(merged);
      if (problem) return reply.status(400).send({ error: problem });
      if (merged.default && !existing.default) {
        for (const other of all.filter((w) => w.default && w.name !== merged.name)) {
          await saveWorkspace(dir, { ...other, default: undefined });
        }
      }
      if (existing.default && b.default === false && activeWorkspaces(all).length > 1) {
        return reply.status(409).send({ error: `"${existing.name}" is the default workspace — set another default first` });
      }
      await saveWorkspace(dir, merged);
      await server.reloadWorkspaces();
      return merged;
    });

    this.app.post<{ Params: { name: string } }>('/workspaces/:name/archive', async (req, reply) => {
      const dir = resolve(process.cwd(), '.smith/workspaces');
      const all = await loadWorkspacesFromDir(dir);
      const ws = all.find((w) => w.name === req.params.name);
      if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
      const violation = defaultViolation(all, ws.name);
      if (violation) return reply.status(409).send({ error: violation });
      await saveWorkspace(dir, { ...ws, archived: true, default: undefined });
      await server.reloadWorkspaces();
      return { ok: true, archived: ws.name };
    });

    this.app.delete<{ Params: { name: string } }>('/workspaces/:name', async (req, reply) => {
      const dir = resolve(process.cwd(), '.smith/workspaces');
      const all = await loadWorkspacesFromDir(dir);
      const ws = all.find((w) => w.name === req.params.name);
      if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
      const violation = defaultViolation(all, ws.name);
      if (violation) return reply.status(409).send({ error: violation });
      const repoPaths = new Set(ws.repos.map((r) => r.path));
      const activeTasks = [...server.activeTasks.values()].filter((t) => {
        const repoPath = t.manifest.context.repoPath;
        return repoPath !== undefined && repoPaths.has(repoPath);
      }).length;
      if (activeTasks > 0) {
        return reply.status(409).send({ error: `Workspace "${ws.name}" has ${activeTasks} running task(s) — archive instead` });
      }
      await removeWorkspaceFile(dir, ws.name);
      await server.reloadWorkspaces();
      return { ok: true, deleted: ws.name };
    });

    this.app.get<{ Params: { name: string } }>('/workspaces/:name/usage', async (req, reply) => {
      const all = await loadWorkspacesFromDir(resolve(process.cwd(), '.smith/workspaces'));
      const ws = all.find((w) => w.name === req.params.name);
      if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
      const repoPaths = new Set(ws.repos.map((r) => r.path));
      const activeTasks = [...server.activeTasks.values()].filter((t) => {
        const repoPath = t.manifest.context.repoPath;
        return repoPath !== undefined && repoPaths.has(repoPath);
      }).length;
      return { activeTasks };
    });

    this.app.get('/workspaces', async () => {
      const active = activeWorkspaces(server.workspaces);
      return {
        workspaces: server.workspaces.map((w) => ({
          name: w.name,
          description: w.description,
          default: Boolean(w.default) || (!active.some((x) => x.default) && active[0] === w),
          archived: Boolean(w.archived),
          repos: w.repos.map((r) => ({ name: r.name, path: r.path, repository: r.repository, branch: r.branch ?? 'main', github: r.github })),
          atlassian: w.atlassian,
          links: w.links,
          color: w.color,
        })),
      };
    });

    const redactUser = (u: User | null) => ({
      id: u?.id ?? 'me',
      name: u?.name ?? 'You',
      connectors: (u?.connectors ?? []).map(redactConnector),
    });

    this.app.get('/me', async () => {
      const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
      return redactUser(resolveCurrentUser(users));
    });

    this.app.put('/me', async (req, reply) => {
      const b = req.body as { name?: string };
      const dir = resolve(process.cwd(), '.smith/users');
      const users = await loadUsersFromDir(dir);
      const existing = resolveCurrentUser(users);
      const merged = buildUserUpdate(existing, b);
      try {
        await saveUser(dir, merged);
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
      return redactUser(merged);
    });

    this.app.get('/connectors/vendors', async () => {
      return VENDORS.map((v) => ({
        id: v.id,
        label: v.label,
        description: v.description,
        fields: v.fields,
        verifyExtraFields: v.verifyExtraFields ?? [],
        capabilities: v.capabilities ?? [],
      }));
    });

    this.app.get('/me/connectors', async () => {
      const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
      const user = resolveCurrentUser(users);
      return (user?.connectors ?? []).map(redactConnector);
    });

    this.app.post('/me/connectors', async (req, reply) => {
      const b = req.body as { vendorId?: string; label?: string; fields?: Record<string, string> };
      if (!b.vendorId || !findVendor(b.vendorId)) return reply.status(400).send({ error: `Unknown vendor: ${b.vendorId}` });
      if (!b.label?.trim()) return reply.status(400).send({ error: 'A label is required' });
      const dir = resolve(process.cwd(), '.smith/users');
      const users = await loadUsersFromDir(dir);
      const existing = resolveCurrentUser(users) ?? { id: 'me', name: 'You', default: true, connectors: [] };
      const instance: ConnectorInstance = {
        id: randomUUID(),
        vendorId: b.vendorId,
        label: b.label.trim(),
        fields: buildConnectorFields(b.vendorId, b.fields),
      };
      const blocked = await verifyBeforeSave(instance.vendorId, instance.fields);
      if (blocked) return reply.status(400).send({ error: blocked });
      const merged: User = { ...existing, connectors: [...(existing.connectors ?? []), instance] };
      try {
        await saveUser(dir, merged);
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
      return reply.status(201).send(redactConnector(instance));
    });

    this.app.put<{ Params: { id: string } }>('/me/connectors/:id', async (req, reply) => {
      const b = req.body as { label?: string; fields?: Record<string, string> };
      const dir = resolve(process.cwd(), '.smith/users');
      const users = await loadUsersFromDir(dir);
      const existing = resolveCurrentUser(users);
      const current = existing?.connectors?.find((c) => c.id === req.params.id);
      if (!current) return reply.status(404).send({ error: `Unknown connector: ${req.params.id}` });
      const updated = buildConnectorUpdate(current, b);
      const blocked = await verifyBeforeSave(updated.vendorId, updated.fields);
      if (blocked) return reply.status(400).send({ error: blocked });
      const merged: User = {
        ...existing!,
        connectors: existing!.connectors!.map((c) => (c.id === current.id ? updated : c)),
      };
      try {
        await saveUser(dir, merged);
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
      return redactConnector(updated);
    });

    this.app.delete<{ Params: { id: string } }>('/me/connectors/:id', async (req, reply) => {
      const dir = resolve(process.cwd(), '.smith/users');
      const users = await loadUsersFromDir(dir);
      const existing = resolveCurrentUser(users);
      if (!existing?.connectors?.some((c) => c.id === req.params.id)) {
        return reply.status(404).send({ error: `Unknown connector: ${req.params.id}` });
      }
      const merged: User = {
        ...existing,
        connectors: existing.connectors.filter((c) => c.id !== req.params.id),
        voice: clearVoiceReferences(existing.voice, req.params.id),
      };
      try {
        await saveUser(dir, merged);
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
      return { ok: true };
    });

    this.app.post<{ Params: { id: string } }>('/me/connectors/:id/verify', async (req, reply) => {
      const b = (req.body as { extra?: Record<string, string> } | undefined) ?? {};
      const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
      const user = resolveCurrentUser(users);
      const instance = user?.connectors?.find((c) => c.id === req.params.id);
      if (!instance) return reply.status(404).send({ error: `Unknown connector: ${req.params.id}` });
      const vendor = findVendor(instance.vendorId);
      if (!vendor) return reply.status(400).send({ error: `Unknown vendor: ${instance.vendorId}` });
      return vendor.verify(instance.fields, b.extra ?? {});
    });

    const redactVoice = (u: User | null) => ({
      stt: u?.voice?.stt ?? null,
      tts: u?.voice?.tts ?? null,
      hideInactive: Boolean(u?.voice?.hideInactive),
    });

    this.app.get('/me/voice', async () => {
      const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
      return redactVoice(resolveCurrentUser(users));
    });

    this.app.put('/me/voice', async (req, reply) => {
      const dir = resolve(process.cwd(), '.smith/users');
      const users = await loadUsersFromDir(dir);
      const existing = resolveCurrentUser(users) ?? { id: 'me', name: 'You', default: true, connectors: [] };
      const r = buildVoiceUpdate(existing, req.body);
      if ('error' in r) return reply.status(400).send({ error: r.error });
      const merged: User = { ...existing, voice: r.voice };
      try {
        await saveUser(dir, merged);
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
      return redactVoice(merged);
    });

    // Internal-only — returns RAW voice keys, like /workspaces/:name/channels/discord-token
    // above: never proxied through broker's browser-facing text-channel.ts surface.
    // broker's SwarmClient calls it server-to-server on the same loopback-bound,
    // no-separate-auth trust boundary. In cloud mode this route is the seam where
    // platform-provisioned keys would be resolved instead (spec §7).
    this.app.get('/me/voice/keys', async () => {
      const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
      return resolveVoiceKeys(resolveCurrentUser(users));
    });

    // ── CLI tool registry (machine-level; spec 2026-08-06) ─────────────
    const cliToolsPath = () => resolve(process.cwd(), '.smith/cli-tools.json');
    const cliSweepDeps = (): SweepDeps => ({
      agentCommands: server.orchConfig.agentCommands,
      clis: ENGINES.map((e) => e.cli),
    });

    this.app.get('/cli-tools', async () => {
      let file = await loadCliToolsFile(cliToolsPath());
      // Lazy first sweep: a fresh install that opens Settings before the
      // startup sweep lands still gets real statuses, not blanks.
      if (Object.keys(file.tools).length === 0) {
        file = await sweepCliTools(cliToolsPath(), cliSweepDeps());
      }
      return { tools: buildCliToolListings(ENGINES, file) };
    });

    this.app.post('/cli-tools/refresh', async (req) => {
      const tool = (req.query as { tool?: string }).tool;
      const file = await sweepCliTools(cliToolsPath(), cliSweepDeps(), tool);
      return { tools: buildCliToolListings(ENGINES, file) };
    });

    this.app.put<{ Params: { id: string } }>('/cli-tools/:id', async (req, reply) => {
      const b = req.body as { enabled?: boolean };
      if (typeof b?.enabled !== 'boolean') return reply.status(400).send({ error: 'body must be { enabled: boolean }' });
      if (!findEngine(req.params.id)) return reply.status(404).send({ error: `Unknown CLI tool: ${req.params.id}` });
      const file = await loadCliToolsFile(cliToolsPath());
      const current = file.tools[req.params.id];
      if (!current) return reply.status(409).send({ error: 'Tool not probed yet — refresh first' });
      file.tools[req.params.id] = { ...current, enabled: b.enabled };
      await saveCliToolsFile(cliToolsPath(), file);
      return { tools: buildCliToolListings(ENGINES, file) };
    });

    // ── Containers (Settings → Workspace → Containers; spec 2026-08-07) ────
    const containersPath = () => resolve(process.cwd(), '.smith/containers.json');

    this.app.get('/containers', async () => await loadContainersFile(containersPath()));

    this.app.put('/containers', async (req, reply) => {
      const b = req.body as { docker?: { enabled?: boolean } };
      if (typeof b?.docker?.enabled !== 'boolean') {
        return reply.status(400).send({ error: 'body must be { docker: { enabled: boolean } }' });
      }
      const file = await loadContainersFile(containersPath());
      file.docker.enabled = b.docker.enabled;
      await saveContainersFile(containersPath(), file);
      return file;
    });

    this.app.post('/containers/verify', async () => await probeDocker());

    this.app.get('/execution-modes', async () => {
      const file = await loadContainersFile(containersPath());
      return { modes: buildExecutionModes(file.docker.enabled, server.workerPool.listWorkers().map((w) => w.runtimes)) };
    });

    // ── API key registry (Settings → API Keys; spec 2026-08-06) ────────────
    const apiKeysPath = () => resolve(process.cwd(), '.smith/api-keys.json');
    const sendKeyOp = (reply: { status(code: number): { send(body: unknown): unknown } }, r: ApiKeyOpResult) =>
      'error' in r ? reply.status(r.status).send({ error: r.error }) : { providers: r.listings };

    this.app.get('/api-keys', async () => ({ providers: buildApiKeyListings(await loadApiKeysFile(apiKeysPath())) }));

    this.app.put<{ Params: { provider: string } }>('/api-keys/:provider', async (req, reply) =>
      sendKeyOp(reply, await saveAndVerifyKey(apiKeysPath(), req.params.provider, ((req.body ?? {}) as { key?: string }).key ?? '')),
    );

    this.app.post<{ Params: { provider: string } }>('/api-keys/:provider/verify', async (req, reply) =>
      sendKeyOp(reply, await verifyStoredKey(apiKeysPath(), req.params.provider)),
    );

    this.app.delete<{ Params: { provider: string } }>('/api-keys/:provider', async (req, reply) =>
      sendKeyOp(reply, await deleteKey(apiKeysPath(), req.params.provider)),
    );

    // Raw-key hop for the broker's avatar generator ONLY. Guard: the swarm
    // binds 127.0.0.1, and this route is deliberately absent from the broker's
    // text-channel passthrough — 7790 can never serve it (spec invariant).
    this.app.get<{ Params: { provider: string } }>('/api-keys/:provider/credential', async (req, reply) => {
      const r = await getCredential(apiKeysPath(), req.params.provider);
      return 'error' in r ? reply.status(r.status).send({ error: r.error }) : r;
    });

    this.app.post<{ Params: { name: string } }>('/workspaces/:name/verify-atlassian', async (req, reply) => {
      const ws = server.workspaces.find((w) => w.name === req.params.name);
      if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
      if (!ws.atlassian) return reply.status(400).send({ error: `Workspace "${ws.name}" has no Jira/Confluence site configured` });
      const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
      const user = resolveCurrentUser(users);
      const resolved = resolveConnector(ws.atlassian.connectorId, 'atlassian', 'an Atlassian', 'workspace', user);
      if ('error' in resolved) return reply.status(400).send({ error: resolved.error });
      const { instance } = resolved;
      return verifyAtlassian(ws.atlassian.siteUrl, instance.fields.email ?? '', instance.fields.apiToken ?? '', {
        confluenceSpaceKey: ws.atlassian.confluenceSpaceKeys?.[0],
      });
    });

    const redactChannels = (c: WorkspaceChannels | null) => ({
      hasDiscordToken: Boolean(c?.discord?.botToken),
      textChannels: c?.discord?.textChannels ?? [],
      voiceChannels: c?.discord?.voiceChannels ?? [],
    });

    this.app.get<{ Params: { name: string } }>('/workspaces/:name/channels', async (req, reply) => {
      const ws = server.workspaces.find((w) => w.name === req.params.name);
      if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
      const channels = await loadChannelsFor(resolve(process.cwd(), '.smith/channels'), req.params.name);
      return redactChannels(channels);
    });

    this.app.put<{ Params: { name: string } }>('/workspaces/:name/channels', async (req, reply) => {
      const ws = server.workspaces.find((w) => w.name === req.params.name);
      if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
      const dir = resolve(process.cwd(), '.smith/channels');
      const existing = await loadChannelsFor(dir, req.params.name);
      const b = req.body as Partial<WorkspaceChannels>;
      const merged = buildChannelsUpdate(existing, b);
      try {
        await saveChannels(dir, req.params.name, merged);
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
      return redactChannels(merged);
    });

    this.app.post<{ Params: { name: string } }>('/workspaces/:name/channels/verify-discord', async (req, reply) => {
      const ws = server.workspaces.find((w) => w.name === req.params.name);
      if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
      const channels = await loadChannelsFor(resolve(process.cwd(), '.smith/channels'), req.params.name);
      if (!channels?.discord?.botToken) {
        return reply.status(400).send({ error: `Workspace "${ws.name}" has no Discord bot token saved yet` });
      }
      return verifyDiscordToken(channels.discord.botToken);
    });

    // Internal-only — returns the RAW bot token, unlike every other route in this
    // block. Never proxied through broker's browser-facing text-channel.ts
    // surface (see this task's header note for why this route has to exist at
    // all). broker's SwarmClient calls it directly, server-to-server, on the
    // same loopback-bound, no-separate-auth trust boundary broker and swarm
    // already share for every other request between them in all-local mode.
    this.app.get<{ Params: { name: string } }>('/workspaces/:name/channels/discord-token', async (req, reply) => {
      const ws = server.workspaces.find((w) => w.name === req.params.name);
      if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
      const channels = await loadChannelsFor(resolve(process.cwd(), '.smith/channels'), req.params.name);
      if (!channels?.discord) return reply.status(404).send({ error: `Workspace "${ws.name}" has no Discord config` });
      return channels.discord;
    });

    this.app.post<{ Params: { name: string; repoName: string } }>(
      '/workspaces/:name/repos/:repoName/verify-github',
      async (req, reply) => {
        const ws = server.workspaces.find((w) => w.name === req.params.name);
        if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
        const repo = ws.repos.find((r) => r.name === req.params.repoName);
        if (!repo) return reply.status(404).send({ error: `Unknown repo: ${req.params.repoName}` });
        if (!repo.github) return reply.status(400).send({ error: `Repo "${repo.name}" has no GitHub owner/repo configured` });
        const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
        const user = resolveCurrentUser(users);
        const resolved = resolveConnector(repo.github.connectorId, 'github', 'a GitHub', 'repo', user);
        if ('error' in resolved) return reply.status(400).send({ error: resolved.error });
        return verifyGithubRepo(repo.github.owner, repo.github.repo, resolved.instance.fields.token ?? '');
      },
    );

    this.app.post<{ Params: { name: string }; Body: { ticketKey?: string } }>(
      '/workspaces/:name/atlassian/lookup-ticket',
      async (req, reply) => {
        const ws = server.workspaces.find((w) => w.name === req.params.name);
        if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
        if (!ws.atlassian) return reply.status(400).send({ error: `Workspace "${ws.name}" has no Jira/Confluence site configured` });
        const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
        const user = resolveCurrentUser(users);
        const ticketKey = req.body?.ticketKey;
        const resolved = resolveAtlassianConnector(ws.atlassian.connectorId, user, { name: 'ticketKey', value: ticketKey });
        if ('error' in resolved) return reply.status(400).send({ error: resolved.error });
        return lookupTicket(ws.atlassian.siteUrl, resolved.instance.fields.email ?? '', resolved.instance.fields.apiToken ?? '', ticketKey!);
      },
    );

    this.app.post<{ Params: { name: string }; Body: { query?: string } }>(
      '/workspaces/:name/atlassian/search-docs',
      async (req, reply) => {
        const ws = server.workspaces.find((w) => w.name === req.params.name);
        if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
        if (!ws.atlassian) return reply.status(400).send({ error: `Workspace "${ws.name}" has no Jira/Confluence site configured` });
        const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
        const user = resolveCurrentUser(users);
        const query = req.body?.query;
        const resolved = resolveAtlassianConnector(ws.atlassian.connectorId, user, { name: 'query', value: query });
        if ('error' in resolved) return reply.status(400).send({ error: resolved.error });
        return searchDocs(ws.atlassian.siteUrl, resolved.instance.fields.email ?? '', resolved.instance.fields.apiToken ?? '', query!, {
          spaceKeys: ws.atlassian.confluenceSpaceKeys,
        });
      },
    );

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
      // Full registry, archived included — the broker filters for the roster and needs the rest for history.
      const agents = await loadAgents(resolve(process.cwd(), '.smith/agents'));
      return { agents };
    });

    // ── Work boards — the user's kanban store ──────────────────────────
    const boardOr404 = async (id: string, reply: { status: (n: number) => { send: (b: unknown) => unknown } }): Promise<WorkBoard | null> => {
      const { boards } = await loadBoards(server.workDir());
      const board = boards.find((b) => b.id === id) ?? null;
      if (!board) reply.status(404).send({ error: `Unknown board: ${id}` });
      return board;
    };

    // Ensuring on read is the only board created as a side effect of a GET:
    // the Personal tab must always have something behind it, and `+ add`
    // deliberately does not offer `personal`.
    this.app.get('/work/boards', async () => {
      await ensurePersonalBoard(server.workDir());
      return loadBoards(server.workDir());
    });

    this.app.post('/work/boards', async (req, reply) => {
      const b = req.body as { type?: string; workspaceId?: string };
      const type = b?.type as BoardType;
      if (!type || !BOARD_TEMPLATES[type]) return reply.status(400).send({ error: `Unknown board type: ${String(b?.type)}` });
      if (type === 'personal' && b.workspaceId) return reply.status(400).send({ error: 'The personal board belongs to no workspace' });
      if (type !== 'personal' && !b.workspaceId?.trim()) return reply.status(400).send({ error: `Board type "${type}" requires a workspaceId` });
      try {
        const board = createBoard(type, b.workspaceId?.trim());
        const { boards } = await loadBoards(server.workDir());
        if (boards.some((x) => x.id === board.id)) {
          return reply.status(409).send({
            error: type === 'personal'
              ? 'The personal board already exists'
              : `Workspace "${b.workspaceId}" already has a ${BOARD_TYPE_LABELS[type]} board`,
          });
        }
        await saveBoard(server.workDir(), board);
        return reply.status(201).send(board);
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
    });

    this.app.patch<{ Params: { id: string } }>('/work/boards/:id', async (req, reply) => {
      const board = await boardOr404(req.params.id, reply);
      if (!board) return;
      const b = req.body as Partial<Pick<WorkBoard, 'name' | 'columns' | 'jira'>>;
      if (b.name?.trim()) board.name = b.name.trim();
      if (b.columns) {
        if (!Array.isArray(b.columns) || b.columns.some((c) => !c?.id || !c?.name)) {
          return reply.status(400).send({ error: 'columns must be [{id, name, jiraStatus?}]' });
        }
        const ids = new Set(b.columns.map((c) => c.id));
        if (board.cards.some((c) => !ids.has(c.columnId))) {
          return reply.status(400).send({ error: 'columns update would orphan cards — move them first' });
        }
        board.columns = b.columns;
      }
      if (b.jira !== undefined) board.jira = b.jira ?? undefined;
      await saveBoard(server.workDir(), board);
      return board;
    });

    this.app.delete<{ Params: { id: string } }>('/work/boards/:id', async (req, reply) => {
      const board = await boardOr404(req.params.id, reply);
      if (!board) return;
      await deleteBoardFile(server.workDir(), board.id);
      return { ok: true };
    });

    this.app.post<{ Params: { id: string } }>('/work/boards/:id/cards', async (req, reply) => {
      const board = await boardOr404(req.params.id, reply);
      if (!board) return;
      try {
        const card = addCard(board, req.body as { title: string; notes?: string; columnId?: string });
        await saveBoard(server.workDir(), board);
        return reply.status(201).send(card);
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
    });

    this.app.patch<{ Params: { id: string; cardId: string } }>('/work/boards/:id/cards/:cardId', async (req, reply) => {
      const board = await boardOr404(req.params.id, reply);
      if (!board) return;

      // Linked-card checklists are toggle-only views of the capability's
      // stories — validate and compute the canonical copies up front (400 on
      // violation), but hold every write until patchCard has actually
      // succeeded: nothing here may persist on a PATCH that ultimately
      // rejects for an unrelated reason (e.g. an invalid columnId).
      const bodyPatch = req.body as { stories?: Array<{ id: string; text: string; done: boolean; verifiedBy?: string }> };
      const targetCard = board.cards.find((c) => c.id === req.params.cardId);
      let capToPersist: Capability | undefined;
      let crossBoardSibling: WorkBoard | undefined;
      if (bodyPatch.stories && targetCard?.capabilityRef) {
        const { capabilities } = await loadCapabilities(capsDir());
        const cap = capabilities.find((c) => c.id === targetCard.capabilityRef?.capabilityId);
        if (cap) {
          let canonical: ReturnType<typeof applyStoryToggles>;
          try {
            canonical = applyStoryToggles(cap, targetCard.capabilityRef.sliceId, bodyPatch.stories);
          } catch (err) {
            return reply.status(400).send({ error: String((err as Error).message) });
          }
          capToPersist = cap;
          const copy = () => canonical.map((s) => ({ id: s.id, text: s.text, done: s.done, verifiedBy: s.verifiedBy }));
          bodyPatch.stories = copy();
          const slice = cap.slices.find((s) => s.id === targetCard.capabilityRef?.sliceId);
          const sibling = [slice?.capCardRef, slice?.deliveryCardRef].find((r) => r && r.cardId !== targetCard.id);
          if (sibling && sibling.boardId !== board.id) {
            const { boards: all } = await loadBoards(server.workDir());
            const other = all.find((b) => b.id === sibling.boardId);
            const otherCard = other?.cards.find((c) => c.id === sibling.cardId);
            if (other && otherCard) {
              otherCard.stories = copy();
              crossBoardSibling = other;
            }
          } else if (sibling) {
            const siblingCard = board.cards.find((c) => c.id === sibling.cardId);
            if (siblingCard) siblingCard.stories = copy();
          }
        }
      }

      try {
        const card = patchCard(board, req.params.cardId, req.body as Parameters<typeof patchCard>[2]);

        // Push-on-move: a Jira-linked card landing on a mapped column tries
        // the matching transition. Best-effort — the human's move always
        // sticks; only the amber badge reports a failed push. The whole
        // section (credential load included — loadUsersFromDir throws on a
        // malformed user file) is one try/catch so nothing here can escape
        // to the route's outer catch and drop the already-applied move.
        const movedTo = (req.body as { columnId?: string }).columnId;
        const target = movedTo ? board.columns.find((c) => c.id === movedTo) : undefined;
        if (card.jira && target?.jiraStatus && board.jira) {
          try {
            const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
            const resolved = resolveAtlassianConnector(board.jira.connectorId, resolveCurrentUser(users), { name: 'key', value: card.jira.key });
            if ('error' in resolved) {
              card.jira.lastPushError = resolved.error;
            } else {
              await transitionIssue(
                board.jira.siteUrl,
                resolved.instance.fields.email ?? '',
                resolved.instance.fields.apiToken ?? '',
                card.jira.key,
                target.jiraStatus,
              );
              card.jira = { key: card.jira.key, url: card.jira.url };
            }
          } catch (err) {
            card.jira.lastPushError = String((err as Error).message);
          }
        }

        // Only now — patchCard applied cleanly — do the capability/sibling
        // writes computed above actually hit disk, alongside the board's own
        // save, so a failed patch (e.g. bad columnId) leaves nothing behind.
        if (capToPersist) await saveCapability(capsDir(), capToPersist);
        if (crossBoardSibling) await saveBoard(server.workDir(), crossBoardSibling);
        await saveBoard(server.workDir(), board);
        return card;
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
    });

    this.app.delete<{ Params: { id: string; cardId: string } }>('/work/boards/:id/cards/:cardId', async (req, reply) => {
      const board = await boardOr404(req.params.id, reply);
      if (!board) return;
      const capRef = board.cards.find((c) => c.id === req.params.cardId)?.capabilityRef;
      try {
        removeCard(board, req.params.cardId);
        await saveBoard(server.workDir(), board);
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
      if (capRef) {
        // Strand-proofing (I1): without this, a re-send 409s forever because
        // the slice still thinks this (now-deleted) card holds its ref.
        // Best-effort — a missing/renamed capability must not fail a delete
        // that has already succeeded.
        try {
          const { capabilities } = await loadCapabilities(capsDir());
          const cap = capabilities.find((c) => c.id === capRef.capabilityId);
          if (cap && unlinkSliceCard(cap, capRef.sliceId, req.params.cardId)) {
            await saveCapability(capsDir(), cap);
          }
        } catch {
          // ignore — the delete already succeeded
        }
      }
      return { ok: true };
    });

    this.app.post<{ Params: { id: string; cardId: string } }>(
      '/work/boards/:id/cards/:cardId/route',
      async (req, reply) => {
        const source = await boardOr404(req.params.id, reply);
        if (!source) return;
        const card = source.cards.find((c) => c.id === req.params.cardId);
        if (!card) return reply.status(404).send({ error: `Unknown card: ${req.params.cardId}` });
        const toType = (req.body as { toType?: string })?.toType as BoardType;
        const exit = toType ? resolveExit(source, card.columnId, toType) : undefined;
        if (!exit) {
          return reply.status(400).send({
            error: `No route from ${source.name}/${card.columnId} to "${String(toType)}"`,
          });
        }
        const { boards } = await loadBoards(server.workDir());
        const dest = findRouteDestination(boards, source, exit);
        if (!dest) {
          return reply.status(404).send({
            error: `Workspace "${source.workspaceId}" has no ${BOARD_TYPE_LABELS[exit.toType]} board — add it first`,
          });
        }
        const plan = routeCard(source, dest, card.id, exit, new Date().toISOString());
        // Destination first: a crash between these two writes duplicates the
        // card (recoverable) rather than losing it (not).
        await saveBoard(server.workDir(), plan.writeFirst);
        await saveBoard(server.workDir(), plan.writeSecond);
        if (plan.card.capabilityRef) {
          // The card just changed board file; its slice's ref still names the
          // one it left. Repoint so the ref stays accurate rather than merely
          // recoverable by findCardByRef's scan. Best-effort, mirroring the
          // card-DELETE unlink: a missing capability must not fail a move
          // that has already been persisted.
          try {
            const { capabilities } = await loadCapabilities(capsDir());
            const cap = capabilities.find((c) => c.id === plan.card.capabilityRef?.capabilityId);
            if (cap && repointSliceCardRef(cap, plan.card.id, dest.id)) {
              await saveCapability(capsDir(), cap);
            }
          } catch {
            // ignore — the route already succeeded
          }
        }
        return reply.status(200).send({ card: plan.card, boardId: dest.id });
      },
    );

    this.app.post<{ Params: { id: string } }>('/work/boards/:id/jira/import', async (req, reply) => {
      const board = await boardOr404(req.params.id, reply);
      if (!board) return;
      if (!board.jira) return reply.status(400).send({ error: `Board "${board.id}" has no Jira link configured` });
      const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
      const user = resolveCurrentUser(users);
      const resolved = resolveAtlassianConnector(board.jira.connectorId, user, { name: 'jql', value: board.jira.jql ?? 'x' });
      if ('error' in resolved) return reply.status(400).send({ error: resolved.error });
      const jql = board.jira.jql?.trim() || `project = ${board.jira.projectKey} ORDER BY updated DESC`;
      try {
        const issues = await searchIssues(
          board.jira.siteUrl,
          resolved.instance.fields.email ?? '',
          resolved.instance.fields.apiToken ?? '',
          jql,
        );
        const summary = importIssues(board, issues);
        await saveBoard(server.workDir(), board);
        return summary;
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
    });

    // ── Capability story maps — the authoring layer above the boards ──
    const capsDir = () => resolve(process.cwd(), '.smith/work/capabilities');
    const capOr404 = async (id: string, reply: { status: (n: number) => { send: (b: unknown) => unknown } }): Promise<Capability | null> => {
      const { capabilities } = await loadCapabilities(capsDir());
      const cap = capabilities.find((c) => c.id === id) ?? null;
      if (!cap) reply.status(404).send({ error: `Unknown capability: ${id}` });
      return cap;
    };

    this.app.get('/work/capabilities', async (req) => {
      const { capabilities, errors } = await loadCapabilities(capsDir());
      const ws = (req.query as { workspaceId?: string }).workspaceId;
      return { capabilities: ws ? capabilities.filter((c) => c.workspaceId === ws) : capabilities, errors };
    });

    this.app.post('/work/capabilities', async (req, reply) => {
      const b = req.body as { name?: string; workspaceId?: string };
      if (!b?.name?.trim() || !b.workspaceId?.trim()) return reply.status(400).send({ error: 'Missing required fields: name, workspaceId' });
      try {
        const { capabilities } = await loadCapabilities(capsDir());
        // LAST in its own workspace, not last overall: the row only ever shows one
        // workspace, so ordering against capabilities the user cannot see would leave
        // gaps in the sequence they can.
        const mine = capabilities.filter((c) => c.workspaceId === b.workspaceId?.trim());
        const nextOrder = mine.reduce((max, c) => Math.max(max, (c.order ?? -1) + 1), 0);
        const cap = createCapability(b.name, b.workspaceId.trim(), nextOrder);
        if (capabilities.some((c) => c.id === cap.id)) return reply.status(409).send({ error: `Capability "${cap.id}" already exists` });
        await saveCapability(capsDir(), cap);
        await ensureWorkspaceBoards(server.workDir(), cap.workspaceId);
        return reply.status(201).send(cap);
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
    });

    this.app.patch<{ Params: { id: string } }>('/work/capabilities/:id', async (req, reply) => {
      const cap = await capOr404(req.params.id, reply);
      if (!cap) return;
      try {
        patchCapability(cap, req.body as Parameters<typeof patchCapability>[1]);
        await saveCapability(capsDir(), cap);
        // Runs only after the capability patch itself has succeeded and
        // persisted (write-ordering discipline from T3): keeps every linked
        // card's checklist a synced view rather than a send-time snapshot
        // (C1). resyncLinkedCards already skips any ref whose board/card no
        // longer resolves; a raw disk failure here still 400s the request,
        // matching how the sibling write-through PATCH treats its own writes.
        await resyncLinkedCards(server.workDir(), cap);
        return cap;
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
    });

    this.app.delete<{ Params: { id: string } }>('/work/capabilities/:id', async (req, reply) => {
      const cap = await capOr404(req.params.id, reply);
      if (!cap) return;
      // Unlink, never orphan: linked cards keep their story copies as local checklists.
      const { boards } = await loadBoards(server.workDir());
      for (const board of unlinkCapabilityCards(boards, cap)) await saveBoard(server.workDir(), board);
      await deleteCapabilityFile(capsDir(), cap.id);
      return { ok: true };
    });

    this.app.post<{ Params: { id: string; sliceId: string } }>('/work/capabilities/:id/slices/:sliceId/spec', async (req, reply) => {
      const cap = await capOr404(req.params.id, reply);
      if (!cap) return;
      const slice = cap.slices.find((s) => s.id === req.params.sliceId);
      if (!slice) return reply.status(404).send({ error: `Unknown slice: ${req.params.sliceId}` });
      if (slice.specPath) return reply.status(409).send({ error: `Slice already has a spec: ${slice.specPath}` });
      const workspaces = await loadWorkspacesFromDir(resolve(process.cwd(), '.smith/workspaces'));
      const resolved = resolveRepo(workspaces, cap.workspaceId);
      if (!resolved) return reply.status(400).send({ error: `No active workspace/repo for: ${cap.workspaceId}` });
      try {
        const date = new Date().toISOString().slice(0, 10);
        const relPath = `docs/superpowers/specs/${date}-${slugify(slice.name)}-design.md`;
        const absPath = resolve(resolved.repo.path, relPath);
        const exists = await readFile(absPath, 'utf8').then(() => true, () => false);
        if (exists) return reply.status(409).send({ error: `File already exists: ${relPath}` });
        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(absPath, renderSpecSkeleton(slice.name, sliceStories(cap, slice.id), date));
        slice.specPath = relPath;
        cap.updatedAt = new Date().toISOString();
        await saveCapability(capsDir(), cap);
        return { specPath: relPath };
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
    });

    this.app.post<{ Params: { id: string; sliceId: string } }>('/work/capabilities/:id/slices/:sliceId/send', async (req, reply) => {
      const cap = await capOr404(req.params.id, reply);
      if (!cap) return;
      const slice = cap.slices.find((s) => s.id === req.params.sliceId);
      if (!slice) return reply.status(404).send({ error: `Unknown slice: ${req.params.sliceId}` });
      const target = (req.body as { target?: 'capabilities' | 'delivery' })?.target;
      if (target !== 'capabilities' && target !== 'delivery') return reply.status(400).send({ error: 'target must be "capabilities" or "delivery"' });
      const refKey = target === 'capabilities' ? 'capCardRef' : 'deliveryCardRef';
      if (slice[refKey]) return reply.status(409).send({ error: `Slice already sent to ${target}` });
      if (target === 'delivery' && !slice.specPath) return reply.status(409).send({ error: 'Generate the spec before sending to delivery' });
      await ensureWorkspaceBoards(server.workDir(), cap.workspaceId);
      const { boards } = await loadBoards(server.workDir());
      // The wire values and the capCardRef/deliveryCardRef keys are persisted
      // on every capability file; only the board types behind them moved.
      const board = boards.find((b) => b.id === boardIdFor(cap.workspaceId, target === 'capabilities' ? 'plan' : 'deliver'));
      if (!board) return reply.status(400).send({ error: `Workspace board missing: ${cap.workspaceId} ${target}` });
      try {
        const card = sendSliceToBoard(cap, slice, board);
        await saveBoard(server.workDir(), board);
        slice[refKey] = { boardId: board.id, cardId: card.id };
        cap.updatedAt = new Date().toISOString();
        await saveCapability(capsDir(), cap);
        return reply.status(201).send(card);
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
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
    // manifest.runtime is always baked by POST /tasks (resolveTaskRuntime); a future
    // enqueuer that omits it would make this tracking adapter diverge from
    // dispatcher.dispatch's workspace-aware resolution.
    const runtimeType = manifest.runtime ?? this.orchConfig.defaultRuntime;
    const agentName = (manifest.agentName as AgentName | undefined) ?? this.namePool.getNameForTask(manifest.taskId) ?? null;
    const sessionName = agentName?.toLowerCase() ?? `task-${manifest.taskId}`;
    const runtime = createRuntime(runtimeType, this.orchConfig.docker, this.workerPool);

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

/**
 * A delegated task inherits its identity from the composed agent that was
 * addressed: the persona the driver materializes into the worktree, and the
 * model its CLI is launched with. Both must land on the manifest — dropping
 * either silently downgrades the task to a generic, default-model run.
 */
export function enrichFromComposedAgent(
  agents: ComposedAgent[],
  composedId: unknown,
): { profile: TaskManifest['profile']; model: string | undefined } {
  if (typeof composedId !== 'string') return { profile: undefined, model: undefined };
  const composed = agents.find((a) => a.id === composedId);
  if (!composed) return { profile: undefined, model: undefined };
  return {
    profile: { name: composed.name, role: composed.role, directives: composed.directives },
    model: composed.engine?.model,
  };
}

/**
 * PUT /agents/:id merge: the wizard submits every field it knows, but a
 * caller that sends three fields must not silently blank the rest of the
 * persona — every field either takes the body's value or falls back to the
 * existing one. Pulled out of the route handler so it's unit-testable
 * without booting the server (model-id validation stays in the route; this
 * only merges).
 */
export function buildAgentUpdate(
  existing: ComposedAgent,
  b: Partial<ComposedAgent> & { stereotype?: string; jobRole?: string },
): ComposedAgent {
  const nextModel = b.engine?.model?.trim();
  return {
    ...existing,
    // The id is the file key and the handle other records point at, so a
    // rename changes the display name only.
    id: existing.id,
    name: b.name?.trim() || existing.name,
    role: b.role?.trim() || existing.role,
    directives: b.directives?.trim() || existing.directives,
    engine: {
      cli: b.engine?.cli ?? existing.engine.cli,
      model: nextModel || existing.engine.model,
    },
    persona: b.persona?.style !== undefined ? { style: b.persona.style.trim() } : existing.persona,
    stereotype: b.stereotype ?? existing.stereotype,
    jobRole: b.jobRole ?? existing.jobRole,
    gender: b.gender ?? existing.gender,
    backstory: b.backstory !== undefined ? b.backstory.trim() || undefined : existing.backstory,
    language: b.language ?? existing.language,
    reactions: b.reactions ?? existing.reactions,
    quickAnswers: b.quickAnswers ?? existing.quickAnswers,
    voice: b.voice?.voiceId ? { provider: 'elevenlabs', voiceId: b.voice.voiceId } : existing.voice,
    avatarRing: b.avatarRing ?? existing.avatarRing,
    channels: b.channels ?? existing.channels,
    archived: b.archived === false ? undefined : existing.archived,
  };
}

/**
 * POST /workspaces' one creation side effect: repos submitted with the
 * transient `initGit` flag become git repos before workspaceProblems'
 * isGitRepo validation runs. The flag is never persisted — the route's
 * explicit repo-field mapping drops it.
 */
export async function gitInitRequestedRepos(
  repos: Array<Partial<WorkspaceRepo> & { initGit?: boolean }> | undefined,
): Promise<string | null> {
  for (const r of repos ?? []) {
    if (!r?.initGit || !r.path || !isAbsolute(r.path)) continue;
    if (await isGitRepo(r.path)) continue;
    try {
      await initGitRepo(r.path);
    } catch (err) {
      return `Repo "${r.name ?? r.path}": git init failed — ${String((err as Error).message)}`;
    }
  }
  return null;
}

/**
 * Creation-time runtime resolution (design §3): per-task override wins, else
 * the server default — workspace-level runtime was removed by spec
 * 2026-08-07. Resolved here — not only at dispatch — because this route
 * bakes the result into manifest.runtime, which dispatchTask and the
 * dashboard both read.
 */
export function resolveTaskRuntime(
  requested: RuntimeType | undefined,
  defaultRuntime: RuntimeType,
): { runtime: RuntimeType; location: LocationType } {
  const runtime = requested ?? defaultRuntime;
  const location: LocationType =
    runtime === 'docker' ? 'docker' : runtime.startsWith('remote') ? 'remote' : 'local';
  return { runtime, location };
}

/**
 * Shared by POST and PUT /workspaces — every repo must be an absolute path
 * to a real git checkout (the dispatcher worktrees task branches from it),
 * and a half-filled atlassian/github block must be rejected rather than
 * silently treated as "configured" by every downstream consumer that only
 * checks the object's truthiness. Pulled out of the route handler so it's
 * unit-testable without booting the server.
 */
export async function workspaceProblems(b: Partial<Workspace>): Promise<string | null> {
  if (!b.name?.trim()) return 'Missing required field: name';
  if (!Array.isArray(b.repos) || b.repos.length === 0) return 'A workspace needs at least one repo';
  for (const r of b.repos) {
    if (!r?.name?.trim()) return 'Every repo needs a name';
    if (!r.path || !isAbsolute(r.path)) return `Repo "${r.name}": path must be absolute`;
    if (!(await isGitRepo(r.path))) return `Repo "${r.name}": ${r.path} is not a git repository`;
  }
  if (b.links !== undefined && (!Array.isArray(b.links) || b.links.some((l) => typeof l !== 'string'))) {
    return 'links must be an array of strings';
  }
  if (b.atlassian && !b.atlassian.siteUrl?.trim()) {
    return 'Atlassian: site URL is required';
  }
  for (const r of b.repos ?? []) {
    if (r.github && (!r.github.owner?.trim() || !r.github.repo?.trim())) {
      return `Repo "${r.name}": GitHub owner and repo are both required when configuring GitHub`;
    }
  }
  return null;
}

/** Trim, drop empties/non-strings; undefined when nothing survives. */
function sanitizeLinks(links: unknown): string[] | undefined {
  if (!Array.isArray(links)) return undefined;
  const clean = links.filter((l): l is string => typeof l === 'string').map((l) => l.trim()).filter(Boolean);
  return clean.length ? clean : undefined;
}

/**
 * Redaction for one saved connector: secret fields become `has<Field>`
 * booleans (never the raw value), non-secret fields pass through as-is.
 * Pulled out to module level (rather than nested in registerRoutes, where
 * the routes above still call it via `redactUser`) so it's unit-testable
 * without booting the server, matching workspaceProblems/buildConnectorUpdate's
 * convention — also the shape Task 7's broker swarm-client.ts mirrors.
 */
export function redactConnector(instance: ConnectorInstance): Record<string, unknown> {
  const vendor = findVendor(instance.vendorId);
  const fields: Record<string, string | boolean> = {};
  for (const f of vendor?.fields ?? []) {
    const v = instance.fields[f.key];
    if (f.secret) fields[`has${f.key[0]!.toUpperCase()}${f.key.slice(1)}`] = Boolean(v);
    else fields[f.key] = v ?? '';
  }
  return { id: instance.id, vendorId: instance.vendorId, label: instance.label, fields };
}

/**
 * Resolves a workspace/repo's connectorId to the actual saved
 * ConnectorInstance, scoped to the expected vendor. Centralizes the guard
 * logic that used to be duplicated inline across verify-atlassian,
 * verify-github, lookup-ticket, and search-docs (each reimplementing "no
 * connectorId set" / "connectorId set but no matching same-vendor instance"
 * with identical shape) — pulled out here so those guard paths are
 * unit-testable without booting the server, matching this file's other
 * extracted-helper convention. `vendorLabel`/`scope` exist only to keep each
 * call site's existing user-facing error text unchanged (e.g. "an Atlassian
 * connector for this workspace" vs "a GitHub connector for this repo").
 */
export function resolveConnector(
  connectorId: string | undefined,
  vendorId: string,
  vendorLabel: string,
  scope: string,
  user: User | null,
): { instance: ConnectorInstance } | { error: string } {
  if (!connectorId) return { error: `Pick ${vendorLabel} connector for this ${scope} first` };
  const instance = user?.connectors?.find((c) => c.id === connectorId && c.vendorId === vendorId);
  if (!instance) return { error: `The connector picked for this ${scope} no longer exists — pick another` };
  return { instance };
}

/**
 * Shared precondition order for lookup-ticket/search-docs: the connector
 * guard (resolveConnector) must be checked BEFORE the route's own required
 * body field, so a request invalid on both axes reports "pick a connector"
 * first, not "missing field" — this is precedence-sensitive, not just an
 * internal-shape choice. Pulled out to module level, distinct from
 * resolveConnector itself, specifically so that ordering is unit-testable:
 * fix round 2 caught that the resolveConnector extraction had accidentally
 * swapped this order in both routes (the connector-guard call moved to
 * after the ticketKey/query check), found only by manual review, not a
 * test — this closes that gap for good rather than trusting call-site
 * ordering discipline again.
 */
export function resolveAtlassianConnector(
  connectorId: string | undefined,
  user: User | null,
  requiredField: { name: string; value: string | undefined },
): { instance: ConnectorInstance } | { error: string } {
  const resolved = resolveConnector(connectorId, 'atlassian', 'an Atlassian', 'workspace', user);
  if ('error' in resolved) return resolved;
  if (!requiredField.value) return { error: `Missing required field: ${requiredField.name}` };
  return resolved;
}

/**
 * PUT /me merge: rebuilds field-by-field (id/default are never
 * user-submitted) rather than `{...existing, ...}` — but every field the
 * three connector-writing siblings below carry forward (connectors, voice)
 * must be explicitly threaded here too, or renaming the operator silently
 * wipes it. Final-review caught `voice` missing from this list: an operator
 * rename turned off both voice capabilities and reset hideInactive with no
 * error — currently latent (no shipped UI calls this route) but a landmine.
 */
export function buildUserUpdate(existing: User | null, body: { name?: string }): User {
  return {
    id: existing?.id ?? 'me',
    name: body.name?.trim() || existing?.name || 'You',
    default: true,
    connectors: existing?.connectors,
    voice: existing?.voice,
  };
}

/** PUT /me/voice body → validated full-replace VoiceSettings (spec §2). */
export function buildVoiceUpdate(user: User | null, body: unknown): { voice: VoiceSettings } | { error: string } {
  const b = (body ?? {}) as { stt?: { instanceId?: string } | null; tts?: { instanceId?: string } | null; hideInactive?: boolean };
  const voice: VoiceSettings = { hideInactive: Boolean(b.hideInactive) };
  for (const slot of ['stt', 'tts'] as const) {
    const sel = b[slot];
    if (!sel) continue; // null/undefined → slot off
    const instanceId = sel.instanceId ?? '';
    const instance = user?.connectors?.find((c) => c.id === instanceId);
    if (!instance) return { error: `Unknown connector instance: ${instanceId}` };
    const vendor = findVendor(instance.vendorId);
    if (!vendor?.capabilities?.includes(slot)) {
      return { error: `${vendor?.label ?? instance.vendorId} cannot power ${slot === 'stt' ? 'speech-to-text' : 'text-to-speech'}` };
    }
    voice[slot] = { instanceId };
  }
  return { voice };
}

/** DELETE /me/connectors/:id side effect (spec §2): a deleted instance vacates any voice slot pointing at it. */
export function clearVoiceReferences(voice: VoiceSettings | undefined, instanceId: string): VoiceSettings | undefined {
  if (!voice) return undefined;
  const next: VoiceSettings = { ...voice };
  if (next.stt?.instanceId === instanceId) delete next.stt;
  if (next.tts?.instanceId === instanceId) delete next.tts;
  return next;
}

/** GET /me/voice/keys resolution (spec §4). Fields are already decrypted in memory by loadUsersFromDir. */
export function resolveVoiceKeys(user: User | null): {
  stt: { vendorId: string; apiKey: string } | null;
  tts: { vendorId: string; apiKey: string } | null;
} {
  const resolveSlot = (slot: 'stt' | 'tts') => {
    const instanceId = user?.voice?.[slot]?.instanceId;
    const instance = user?.connectors?.find((c) => c.id === instanceId);
    const apiKey = instance?.fields.apiKey;
    // A still-`enc:v1:…` value means decryptUser couldn't decrypt it (lost/
    // rotated master key, passed through by design — see users.ts
    // decryptUser). Reporting that slot as populated would flip statusSync()
    // true and open the mic gate, only for Deepgram/ElevenLabs to silently
    // reject the ciphertext — treat it as absent so the user gets the normal
    // "add a key in Settings" pointer instead of a silent no-op.
    if (!instance || !apiKey || isEncrypted(apiKey)) return null;
    return { vendorId: instance.vendorId, apiKey };
  };
  return { stt: resolveSlot('stt'), tts: resolveSlot('tts') };
}

/**
 * POST /me/connectors field filter: keeps only the keys the matched vendor
 * actually declares, mirroring buildConnectorUpdate's PUT-side filtering
 * below — unlike PUT, there's no `existing` to fall back to on create, so
 * this just drops any key the registry doesn't know about rather than
 * merging. Without it, a create request could persist arbitrary/garbage
 * keys that redaction (which only ever emits registry-declared keys) can
 * never surface again, or persist zero fields silently.
 */
export function buildConnectorFields(vendorId: string, fields: Record<string, string> | undefined): Record<string, string> {
  const vendor = findVendor(vendorId);
  const result: Record<string, string> = {};
  for (const f of vendor?.fields ?? []) {
    if (fields?.[f.key] !== undefined) result[f.key] = fields[f.key]!;
  }
  return result;
}

/**
 * PUT /me/connectors/:id merge: every field (secret or not) trims a
 * submitted value and falls back to the existing stored value on blank —
 * applied uniformly, unlike the old buildUserUpdate, which only did this for
 * Atlassian's two fields and used a plain `??` (no trim, no fallback-on-
 * blank-string) for GitHub's single field. `vendorId` is immutable — never
 * read from `b`, even if a caller sends one.
 */
export function buildConnectorUpdate(
  existing: ConnectorInstance,
  b: { label?: string; fields?: Record<string, string> },
): ConnectorInstance {
  const vendor = findVendor(existing.vendorId);
  const fields = { ...existing.fields };
  if (b.fields) {
    for (const f of vendor?.fields ?? []) {
      const submitted = (b.fields[f.key] ?? '').trim();
      fields[f.key] = submitted || existing.fields[f.key] || '';
    }
  }
  return { id: existing.id, vendorId: existing.vendorId, label: b.label?.trim() || existing.label, fields };
}

/**
 * PUT /workspaces/:name/channels merge: a submitted `discord` block replaces
 * textChannels/voiceChannels wholesale, but botToken falls back to the
 * existing saved value when the submission's own botToken is blank — the
 * settings-group UI convention (ChannelsGroup) never re-sends a saved
 * secret, so "edit only the channel lists" submits {botToken: "", ...}
 * on every ordinary save; without this fallback that would silently wipe the
 * token. Same fix shape as buildConnectorUpdate's blank-submission fallback —
 * see that function's doc comment for the original incident this pattern
 * traces back to (PUT /me's now-deleted email-wipe bug).
 */
export function buildChannelsUpdate(existing: WorkspaceChannels | null, b: Partial<WorkspaceChannels>): WorkspaceChannels {
  if (!b.discord) return existing?.discord ? { discord: existing.discord } : {};
  const botToken = b.discord.botToken?.trim() || existing?.discord?.botToken || '';
  // Defended the same way buildConnectorUpdate defends its own optional
  // fields above: a submission that omits one or both lists entirely (e.g.
  // {"discord":{"botToken":"x"}}) must fall back rather than persist
  // `undefined` — broker does an unguarded `config.textChannels.length` /
  // `config.voiceChannels.length` downstream (discord-text-lifecycle.ts,
  // discord-workspace-switcher.ts), and an undefined list there throws inside
  // a `.catch`-swallowed call, so Discord would silently never boot for this
  // workspace with no visible error.
  const textChannels = b.discord.textChannels ?? existing?.discord?.textChannels ?? [];
  const voiceChannels = b.discord.voiceChannels ?? existing?.discord?.voiceChannels ?? [];
  return { discord: { botToken, textChannels, voiceChannels } };
}

/** Constant-time comparison of two secrets (hashing normalizes lengths). */
export function secretsEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}

/**
 * Decide a worker registration. Token-authed workers adopt their deviceId as
 * pool identity — the self-asserted workerId is only trusted on the legacy
 * shared-secret path. A presented token that fails MUST NOT fall through to
 * the secret path.
 */
export async function evaluateWorkerRegistration(
  reg: WorkerRegisterMessage,
  registry: DeviceRegistry,
  configured: RemoteWorkerEntry[],
): Promise<{ accepted: true; poolWorkerId: string; deviceId?: string } | { accepted: false; reason: string }> {
  if (reg.token) {
    const device = await registry.verifyToken(reg.token);
    if (!device) return { accepted: false, reason: 'Invalid device token' };
    return { accepted: true, poolWorkerId: device.deviceId, deviceId: device.deviceId };
  }
  if (configured.length === 0) return { accepted: false, reason: 'No remote workers configured' };
  if (!configured.some((w) => secretsEqual(w.secret, reg.secret))) {
    return { accepted: false, reason: 'Invalid secret' };
  }
  return { accepted: true, poolWorkerId: reg.workerId };
}
