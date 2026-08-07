// ---------------------------------------------------------------------------
// orchestrator/types.ts — All shared types for the Fire-and-Forget Swarm
// ---------------------------------------------------------------------------

/**
 * Binary outcome: the only two states the top-level orchestrator cares about.
 * Everything else is internal to the swarm.
 */
export type TaskOutcome = 'completed' | 'failed';

/**
 * Full lifecycle status for internal tracking and logging.
 */
export type TaskStatus =
  | 'queued'        // In .smith/queue/, waiting dispatch
  | 'dispatched'    // Alpha tmux session launched
  | 'running'       // Alpha session actively executing
  | 'completed'     // Exit 0 — triggers verification pipeline
  | 'failed'        // Exit 1 — immediate quarantine, no retries
  | 'quarantined';  // Failed task shelved for human review

/**
 * Supported CLI agent types that can serve as the Alpha agent.
 */
export type AgentType = 'agy' | 'claude' | 'codex' | 'opencode' | 'copilot';

/**
 * Execution runtime for task sessions.
 *   'tmux'          — Bare-metal tmux sessions on the host (default)
 *   'docker'        — Docker containers with tmux running inside
 *   'remote'        — Dispatched to a connected worker machine via WorkerPool (any runtime)
 *   'remote-tmux'   — Dispatched to a remote worker advertising tmux support
 *   'remote-docker' — Dispatched to a remote worker advertising docker support
 */
export type RuntimeType = 'tmux' | 'docker' | 'remote' | 'remote-tmux' | 'remote-docker';

/**
 * Where the agent runs.
 *   'local'  — On this machine (tmux or docker on host)
 *   'docker' — In a Docker container on this machine (clone + isolate)
 *   'remote' — On a remote machine (SSH, cloud VM, etc.)
 */
export type LocationType = 'local' | 'docker' | 'remote';

// ---------------------------------------------------------------------------
// Pull Request Configuration — per-task override for auto-PR creation
// ---------------------------------------------------------------------------

/**
 * Pull request configuration for automated PR creation.
 */
export interface PullRequestConfig {
  /** Auto-create PR on task completion (default: false) */
  autoCreate: boolean;
  /** Target branch for PRs (default: baseBranch) */
  targetBranch?: string;
  /** PR title template. Placeholders: {taskId}, {prompt}, {agent} */
  titlePattern: string;
  /** Default labels to apply */
  labels: string[];
  /** Default reviewers (GitHub usernames) */
  reviewers: string[];
  /** Draft PR (default: true — human reviews before merge) */
  draft: boolean;
}

// ---------------------------------------------------------------------------
// Task Manifest
// ---------------------------------------------------------------------------

/**
 * The task manifest that enters the queue.
 * This is the contract between the pipeline and the orchestrator.
 */
export interface TaskManifest {
  taskId: string;
  prompt: string;
  /** Memorable agent name (e.g., bold-falcon-7a3f). Auto-generated if not provided.
   *  This name tracks the agent through: branch → session → container → worktree → logs → PR */
  agentName?: string;
  context: {
    files: string[];           // Files relevant to this task
    repository: string;        // Git remote URL
    branch: string;            // Source branch to worktree from
    workspace?: string;        // Workspace name (see workspaces.ts)
    repo?: string;             // Repo name within the workspace
    /** Absolute path of the resolved repo — set SERVER-SIDE only (never trusted from clients). */
    repoPath?: string;
  };
  agent: AgentType;            // Which CLI tool to use as Alpha
  /** Model the CLI should run, from the composed agent's engine. Resolved
   *  server-side; the driver spells the flag its tool understands. */
  model?: string;
  runtime?: RuntimeType;       // Execution runtime (default 'tmux')
  location?: LocationType;     // Where: local, docker, or remote
  createdAt: string;           // ISO 8601
  priority: 'critical' | 'high' | 'normal' | 'low';
  metadata?: Record<string, unknown>;
  /** Composed-agent profile, resolved server-side — materialized into the
   *  tool's native config in the worktree (design §5). */
  profile?: { name: string; role: string; directives: string };
  /** Override pull request settings for this task */
  pullRequest?: Partial<PullRequestConfig>;
}

/**
 * The result after a task completes or fails.
 * This is what the orchestrator produces after the Alpha session exits.
 */
export interface TaskResult {
  taskId: string;
  outcome: TaskOutcome;
  exitCode: number;
  sessionName: string;
  worktreePath: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  logs?: string;              // Path to captured stdout/stderr log file
  /** Branch name created for this task */
  branch?: string;
  /** PR URL if auto-created */
  pullRequestUrl?: string;
}

/**
 * Configuration for the orchestrator.
 */
export interface OrchestratorConfig {
  smithRoot: string;          // Path to .smith/ directory
  queueDir: string;           // .smith/queue/
  worktreeDir: string;        // .smith/worktrees/
  logsDir: string;            // .smith/logs/
  delegateBin: string;        // Path to smith-delegate script
  tmuxPrefix: string;         // Prefix for tmux session names (default: 'task')
  agentCommands: Record<AgentType, string>;  // CLI command per agent type
  teardownTimeoutMs: number;  // Max time to wait for orphan cleanup
  defaultRuntime: RuntimeType; // Default runtime when manifest doesn't specify
  docker: DockerConfig;       // Docker-specific configuration
  /** Remote workers — machines that accept task dispatch over HTTPS */
  remoteWorkers?: RemoteWorkerEntry[];
}

/**
 * Remote worker entry in orchestrator config.
 */
export interface RemoteWorkerEntry {
  /** Base URL of the worker (e.g., "https://192.168.1.50:7778") */
  url: string;
  /** Shared secret for authentication */
  secret: string;
  /** Human-readable name (e.g., "gpu-box-01") */
  name?: string;
  /** Max concurrent tasks (discovered via handshake if not set) */
  capacity?: number;
}

/**
 * Configuration for Docker runtime mode.
 */
export interface DockerConfig {
  image: string;              // Docker image to use (default: 'smith-agent:latest')
  network?: string;           // Docker network mode (e.g., 'host', 'bridge', custom)
  cpuLimit?: string;          // CPU limit (e.g., '2.0' for 2 cores)
  memoryLimit?: string;       // Memory limit (e.g., '4g' for 4GB)
  shmSize?: string;           // /dev/shm size for Playwright/Chromium (default: '2g')
  extraMounts?: string[];     // Additional volume mounts (e.g., SSH keys, git config)
  extraEnv?: Record<string, string>;  // Additional environment variables
}

/**
 * Events emitted by the Dispatcher via EventEmitter.
 */
export type DispatcherEvent =
  | { type: 'task:dispatched'; taskId: string; sessionName: string }
  | { type: 'task:completed'; taskId: string; result: TaskResult }
  | { type: 'task:failed'; taskId: string; result: TaskResult }
  | { type: 'task:quarantined'; taskId: string; reason: string }
  | { type: 'session:orphan_cleanup'; sessionPattern: string; killed: number };

/**
 * Quarantine entry for a failed task shelved for human review.
 */
export interface QuarantineEntry {
  taskId: string;
  result: TaskResult;
  reason: string;
  quarantinedAt: string;
  releasedAt?: string;
}
