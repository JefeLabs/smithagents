// ---------------------------------------------------------------------------
// orchestrator/worker.ts — Smith Worker (runs on remote machines)
//
// Connects TO the orchestrator via WebSocket, self-registers, and stays
// connected for bidirectional task dispatch.
//
// Start it:
//   smith-worker --orchestrator ws://192.168.1.10:7777 --secret "xxx"
//
// Flow:
//   1. Connects WS to orchestrator at /workers/connect
//   2. Sends 'register' message with capabilities
//   3. Receives 'registered' acknowledgment
//   4. Waits for 'task:dispatch' messages
//   5. Executes tasks locally (tmux/docker)
//   6. Pushes 'task:accepted', 'output:chunk', 'task:completed' back
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import WebSocket from "ws";
import type {
  OrchestratorMessage,
  OutputChunkMessage,
  OutputRequestMessage,
  TaskAcceptedMessage,
  TaskCompletedMessage,
  TaskDispatchMessage,
  TaskFailedMessage,
  TaskKillMessage,
  TaskSteerMessage,
  WorkerHeartbeatMessage,
  WorkerRegisterMessage,
} from "./remote-types.js";
import { DockerRuntime, type RuntimeAdapter, TmuxRuntime } from "./runtime.js";
import type { DockerConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkerConfig {
  /** Orchestrator WS URL (e.g., "ws://192.168.1.10:7777") */
  orchestratorUrl: string;
  /** Shared secret — legacy auth path; must match orchestrator config */
  secret?: string;
  /** Device token from pairing — preferred over secret */
  token?: string;
  /** Max concurrent tasks this worker handles */
  capacity: number;
  /** Worker name (default: hostname) */
  name: string;
  /** Stable worker ID (persists across restarts) */
  workerId: string;
  /** Default runtime for tasks (default: 'tmux') */
  defaultRuntime: "tmux" | "docker";
  /** Docker config if using docker runtime */
  docker?: DockerConfig;
  /** Reconnect delay in ms (default: 3000) */
  reconnectMs: number;
  /** Heartbeat interval in ms (default: 10000) */
  heartbeatMs: number;
  /** Output push interval in ms (default: 2000) */
  outputPushMs: number;
}

const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  orchestratorUrl: "ws://localhost:7777",
  secret: "",
  capacity: 5,
  name: hostname(),
  workerId: `worker-${randomUUID().substring(0, 8)}`,
  defaultRuntime: "tmux",
  reconnectMs: 3_000,
  heartbeatMs: 10_000,
  outputPushMs: 2_000,
};

interface TrackedSession {
  taskId: string;
  sessionName: string;
  startedAt: string;
  exitCode?: number;
  finished: boolean;
}

// ---------------------------------------------------------------------------
// Pairing + credentials
// ---------------------------------------------------------------------------

export function toHttpUrl(url: string): string {
  return url.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
}
export function toWsUrl(url: string): string {
  return url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

/** Exponential backoff with ±20% jitter so a worker fleet never thunders. */
export function nextReconnectDelay(
  attempt: number,
  baseMs = 3_000,
  capMs = 60_000,
  rand: () => number = Math.random,
): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.round(exp * (0.8 + 0.4 * rand()));
}

export interface WorkerCredentials {
  orchestratorUrl: string;
  deviceId: string;
  token: string;
  name: string;
}

export const DEFAULT_CREDENTIALS_PATH = join(homedir(), ".smith", "worker-credentials.json");

/** Redeem a pairing code and persist the device credentials (0600). */
export async function registerDevice(
  orchestratorUrl: string,
  code: string,
  name: string,
  credsPath = DEFAULT_CREDENTIALS_PATH,
): Promise<WorkerCredentials> {
  const res = await fetch(`${toHttpUrl(orchestratorUrl)}/devices/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Pairing failed (${res.status}): ${detail}`);
  }
  const { deviceId, token } = (await res.json()) as { deviceId: string; token: string };
  const creds: WorkerCredentials = { orchestratorUrl: toWsUrl(orchestratorUrl), deviceId, token, name };
  await mkdir(dirname(credsPath), { recursive: true });
  await writeFile(credsPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
  await chmod(credsPath, 0o600); // writeFile mode is umask-filtered; chmod is not
  return creds;
}

export async function loadCredentials(credsPath = DEFAULT_CREDENTIALS_PATH): Promise<WorkerCredentials | null> {
  try {
    return JSON.parse(await readFile(credsPath, "utf8")) as WorkerCredentials;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SmithWorker
// ---------------------------------------------------------------------------

/**
 * Merge a partial config over the defaults, dropping explicit undefineds —
 * the CLI builds `{ capacity: x ? N : undefined, ... }`, and a plain spread
 * would let those undefineds clobber the defaults (a capacity-undefined
 * worker is never picked by the pool).
 */
export function mergeWorkerConfig(config?: Partial<WorkerConfig>): WorkerConfig {
  const defined = Object.fromEntries(
    Object.entries(config ?? {}).filter(([, v]) => v !== undefined),
  ) as Partial<WorkerConfig>;
  return { ...DEFAULT_WORKER_CONFIG, ...defined };
}

export class SmithWorker {
  private readonly config: WorkerConfig;
  private readonly runtime: RuntimeAdapter;
  private readonly sessions = new Map<string, TrackedSession>();
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private outputTimer: ReturnType<typeof setInterval> | null = null;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private stopped = false;

  constructor(config?: Partial<WorkerConfig>) {
    this.config = mergeWorkerConfig(config);

    if (this.config.defaultRuntime === "docker" && this.config.docker) {
      this.runtime = new DockerRuntime(this.config.docker);
    } else {
      this.runtime = new TmuxRuntime();
    }
  }

  // -------------------------------------------------------------------------
  // Connect to orchestrator
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    console.log(`\n  🔧 Smith Worker "${this.config.name}" (${this.config.workerId})`);
    console.log(`     Orchestrator: ${this.config.orchestratorUrl}`);
    console.log(`     Capacity:     ${this.config.capacity} slots`);
    console.log(`     Runtime:      ${this.config.defaultRuntime}\n`);

    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;

    const url = `${this.config.orchestratorUrl}/workers/connect`;
    console.log(`  → Connecting to ${url}...`);

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      console.log(`  ✓ Connected to orchestrator`);
      this.register();
      this.startHeartbeat();
      this.startOutputPush();
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as OrchestratorMessage;
        this.handleMessage(msg);
      } catch (err) {
        console.error(`  ✗ Invalid message from orchestrator:`, err);
      }
    });

    this.ws.on("close", () => {
      console.log(`  ⚠ Disconnected from orchestrator`);
      this.stopTimers();
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      console.error(`  ✗ WebSocket error: ${err.message}`);
      // 'close' will fire after this
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;
    const delay = nextReconnectDelay(this.reconnectAttempts++, this.config.reconnectMs);
    console.log(`  ↻ Reconnecting in ${Math.round(delay / 100) / 10}s...`);
    setTimeout(() => {
      this.reconnecting = false;
      this.connect();
    }, delay);
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  private register(): void {
    const msg: WorkerRegisterMessage = {
      type: "register",
      workerId: this.config.workerId,
      name: this.config.name,
      secret: this.config.secret ?? "",
      token: this.config.token,
      capacity: this.config.capacity,
      agents: ["claude", "agy", "codex"],
      runtimes: [this.config.defaultRuntime],
      version: "0.1.0",
    };
    this.send(msg);
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  private handleMessage(msg: OrchestratorMessage): void {
    switch (msg.type) {
      case "registered":
        if (msg.accepted) {
          this.reconnectAttempts = 0;
          console.log(`  ✓ Registered with orchestrator (${msg.message ?? "ok"})`);
        } else {
          console.error(`  ✗ Registration rejected: ${msg.message}`);
          this.stop();
        }
        break;

      case "task:dispatch":
        this.handleDispatch(msg);
        break;

      case "task:steer":
        this.handleSteer(msg);
        break;

      case "task:kill":
        this.handleKill(msg);
        break;

      case "output:request":
        this.handleOutputRequest(msg);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Task handlers
  // -------------------------------------------------------------------------

  private async handleDispatch(msg: TaskDispatchMessage): Promise<void> {
    if (this.sessions.size >= this.config.capacity) {
      // Send failure — at capacity
      const fail: TaskFailedMessage = {
        type: "task:failed",
        taskId: msg.taskId,
        sessionName: msg.sessionName,
        exitCode: -1,
        error: `Worker at capacity (${this.config.capacity} slots full)`,
      };
      this.send(fail);
      return;
    }

    try {
      await this.runtime.launch(msg.sessionName, msg.command, msg.cwd);

      const session: TrackedSession = {
        taskId: msg.taskId,
        sessionName: msg.sessionName,
        startedAt: new Date().toISOString(),
        finished: false,
      };
      this.sessions.set(msg.sessionName, session);

      // Confirm acceptance
      const accepted: TaskAcceptedMessage = {
        type: "task:accepted",
        taskId: msg.taskId,
        sessionName: msg.sessionName,
        workerId: this.config.workerId,
      };
      this.send(accepted);

      console.log(`  ▶ Launched ${msg.sessionName} (${msg.taskId.substring(0, 8)})`);

      // Wait for completion in background
      this.runtime
        .waitFor(msg.sessionName)
        .then((exitCode) => {
          session.exitCode = exitCode;
          session.finished = true;

          const completed: TaskCompletedMessage = {
            type: "task:completed",
            taskId: msg.taskId,
            sessionName: msg.sessionName,
            exitCode,
          };
          this.send(completed);

          console.log(`  ${exitCode === 0 ? "✓" : "✗"} ${msg.sessionName} exited (code ${exitCode})`);
        })
        .catch((err) => {
          session.exitCode = -1;
          session.finished = true;

          const failed: TaskFailedMessage = {
            type: "task:failed",
            taskId: msg.taskId,
            sessionName: msg.sessionName,
            exitCode: -1,
            error: String(err),
          };
          this.send(failed);
        });
    } catch (err) {
      const failed: TaskFailedMessage = {
        type: "task:failed",
        taskId: msg.taskId,
        sessionName: msg.sessionName,
        exitCode: -1,
        error: `Launch failed: ${err}`,
      };
      this.send(failed);
    }
  }

  private async handleSteer(msg: TaskSteerMessage): Promise<void> {
    const session = this.sessions.get(msg.sessionName);
    if (!session || session.finished) return;

    try {
      await this.runtime.sendKeys(msg.sessionName, msg.keys, msg.target);
      console.log(`  ↪ Steered ${msg.sessionName}: ${msg.keys.substring(0, 60)}`);
    } catch (err) {
      console.error(`  ✗ Steer failed for ${msg.sessionName}: ${err}`);
    }
  }

  private async handleKill(msg: TaskKillMessage): Promise<void> {
    const session = this.sessions.get(msg.sessionName);
    if (!session) return;

    try {
      await this.runtime.kill(msg.sessionName);
      session.finished = true;
      session.exitCode = -9;

      const completed: TaskCompletedMessage = {
        type: "task:completed",
        taskId: msg.taskId,
        sessionName: msg.sessionName,
        exitCode: -9,
      };
      this.send(completed);
      console.log(`  ☠ Killed ${msg.sessionName}`);
    } catch (err) {
      console.error(`  ✗ Kill failed for ${msg.sessionName}: ${err}`);
    }
  }

  private async handleOutputRequest(msg: OutputRequestMessage): Promise<void> {
    const session = this.sessions.get(msg.sessionName);
    if (!session) return;

    try {
      const output = await this.runtime.captureOutput(msg.sessionName);
      const chunk: OutputChunkMessage = {
        type: "output:chunk",
        taskId: msg.taskId,
        sessionName: msg.sessionName,
        output,
        lines: output.split("\n").length,
      };
      this.send(chunk);
    } catch {
      // Session may have ended
    }
  }

  // -------------------------------------------------------------------------
  // Heartbeat + output streaming
  // -------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const hb: WorkerHeartbeatMessage = {
        type: "heartbeat",
        workerId: this.config.workerId,
        activeCount: this.activeCount,
        capacity: this.config.capacity,
      };
      this.send(hb);
    }, this.config.heartbeatMs);
  }

  /** Push output for all active sessions periodically */
  private startOutputPush(): void {
    this.outputTimer = setInterval(async () => {
      for (const [, session] of this.sessions) {
        if (session.finished) continue;
        try {
          const output = await this.runtime.captureOutput(session.sessionName);
          const chunk: OutputChunkMessage = {
            type: "output:chunk",
            taskId: session.taskId,
            sessionName: session.sessionName,
            output,
            lines: output.split("\n").length,
          };
          this.send(chunk);
        } catch {
          // Session might have just ended
        }
      }
    }, this.config.outputPushMs);
  }

  private stopTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.outputTimer) {
      clearInterval(this.outputTimer);
      this.outputTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private get activeCount(): number {
    let count = 0;
    for (const [, s] of this.sessions) {
      if (!s.finished) count++;
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // Stop
  // -------------------------------------------------------------------------

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopTimers();

    // Kill all active sessions
    for (const [, session] of this.sessions) {
      if (!session.finished) {
        await this.runtime.kill(session.sessionName).catch(() => {});
      }
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    console.log(`  Worker "${this.config.name}" stopped.`);
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function startWorker(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0] && !args[0].startsWith("--") ? args.shift() : null;
  const opts: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith("--")) continue;
    const key = args[i].replace(/^--/, "");
    opts[key] = args[i + 1];
  }

  if (subcommand === "register") {
    if (!opts.orchestrator || !opts.code) {
      console.error("Usage: smith-worker register --orchestrator <url> --code XXXX-XXXX [--name <name>]");
      process.exit(1);
    }
    const name = opts.name ?? hostname();
    const creds = await registerDevice(opts.orchestrator, opts.code, name);
    console.log(`  ✓ Paired as "${name}" (${creds.deviceId})`);
    console.log(`  Credentials saved to ${DEFAULT_CREDENTIALS_PATH}`);
    console.log(`  Start the worker with: smith-worker`);
    return;
  }

  const creds = opts.token ? null : await loadCredentials();
  const orchestratorUrl = opts.orchestrator ?? creds?.orchestratorUrl;
  const token = opts.token ?? creds?.token;

  if (!orchestratorUrl || (!token && !opts.secret)) {
    console.error("Usage: smith-worker [--orchestrator ws://HOST:7777] [--token <device-token>]");
    console.error("       smith-worker register --orchestrator <url> --code XXXX-XXXX [--name <name>]");
    console.error("\nWith no flags, credentials from `smith-worker register` are used.");
    console.error("\nOptional:");
    console.error("  --capacity       Max concurrent tasks (default: 5)");
    console.error("  --name           Worker name (default: hostname)");
    console.error("  --runtime        Default runtime: tmux or docker (default: tmux)");
    console.error("  --id             Stable worker ID (default: paired deviceId, else random)");
    console.error("  --secret         Legacy shared-secret auth instead of a device token");
    process.exit(1);
  }

  const worker = new SmithWorker({
    orchestratorUrl,
    token,
    secret: opts.secret,
    capacity: opts.capacity ? Number(opts.capacity) : undefined,
    name: opts.name ?? creds?.name,
    workerId: opts.id ?? creds?.deviceId,
    defaultRuntime: opts.runtime as "tmux" | "docker" | undefined,
  });

  process.on("SIGINT", async () => {
    console.log("\nShutting down worker...");
    await worker.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await worker.stop();
    process.exit(0);
  });

  await worker.start();
}
