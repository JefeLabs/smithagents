// ---------------------------------------------------------------------------
// orchestrator/remote-types.ts — WebSocket protocol for orchestrator ↔ worker
//
// The worker connects TO the orchestrator via WebSocket.
// All communication flows over a single persistent WS connection.
//
// Flow:
//   1. Worker opens WS to ws://orchestrator:7777/workers/connect
//   2. Worker sends 'register' with capabilities
//   3. Orchestrator responds with 'registered'
//   4. Orchestrator pushes 'task:dispatch' when work is available
//   5. Worker pushes 'task:accepted', 'output:chunk', 'task:completed'
//   6. Orchestrator can push 'task:steer', 'task:kill' at any time
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Worker → Orchestrator messages
// ---------------------------------------------------------------------------

export interface WorkerRegisterMessage {
  type: 'register';
  /** Unique worker ID (stable across reconnects) */
  workerId: string;
  /** Human-readable name (e.g., "gpu-box-01") */
  name: string;
  /** Shared secret for auth */
  secret: string;
  /** Max concurrent tasks this worker can handle */
  capacity: number;
  /** Which agent CLIs are installed */
  agents: string[];
  /** Available runtimes on this worker */
  runtimes: Array<'tmux' | 'docker'>;
  /** Worker version */
  version: string;
}

export interface TaskAcceptedMessage {
  type: 'task:accepted';
  taskId: string;
  sessionName: string;
  workerId: string;
}

export interface TaskCompletedMessage {
  type: 'task:completed';
  taskId: string;
  sessionName: string;
  exitCode: number;
}

export interface TaskFailedMessage {
  type: 'task:failed';
  taskId: string;
  sessionName: string;
  exitCode: number;
  error?: string;
}

export interface OutputChunkMessage {
  type: 'output:chunk';
  taskId: string;
  sessionName: string;
  output: string;
  lines: number;
}

export interface WorkerHeartbeatMessage {
  type: 'heartbeat';
  workerId: string;
  activeCount: number;
  capacity: number;
}

export type WorkerMessage =
  | WorkerRegisterMessage
  | TaskAcceptedMessage
  | TaskCompletedMessage
  | TaskFailedMessage
  | OutputChunkMessage
  | WorkerHeartbeatMessage;

// ---------------------------------------------------------------------------
// Orchestrator → Worker messages
// ---------------------------------------------------------------------------

export interface RegisteredMessage {
  type: 'registered';
  accepted: boolean;
  orchestratorId: string;
  message?: string;
}

export interface TaskDispatchMessage {
  type: 'task:dispatch';
  taskId: string;
  sessionName: string;
  command: string;
  cwd: string;
  env?: Record<string, string>;
}

export interface TaskSteerMessage {
  type: 'task:steer';
  taskId: string;
  sessionName: string;
  keys: string;
  target?: string;
}

export interface TaskKillMessage {
  type: 'task:kill';
  taskId: string;
  sessionName: string;
}

export interface OutputRequestMessage {
  type: 'output:request';
  taskId: string;
  sessionName: string;
}

export type OrchestratorMessage =
  | RegisteredMessage
  | TaskDispatchMessage
  | TaskSteerMessage
  | TaskKillMessage
  | OutputRequestMessage;

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * Remote worker config — stored by the orchestrator.
 * No longer needs a URL — the worker connects to us.
 */
export interface RemoteWorkerConfig {
  /** Shared secret the worker must present to register */
  secret: string;
  /** Human-readable name (discovered via registration) */
  name?: string;
  /** Max concurrent tasks (discovered via registration) */
  capacity?: number;
}

/**
 * Connected worker state — tracked by the orchestrator.
 */
export interface ConnectedWorker {
  workerId: string;
  name: string;
  capacity: number;
  activeCount: number;
  agents: string[];
  runtimes: Array<'tmux' | 'docker'>;
  version: string;
  connectedAt: string;
  lastHeartbeat: string;
  /** Active task IDs on this worker */
  tasks: Set<string>;
}
