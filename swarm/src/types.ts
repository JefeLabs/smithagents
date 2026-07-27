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
 *   'tmux'   — Bare-metal tmux sessions on the host (default)
 *   'docker' — Docker containers with tmux running inside
 */
export type RuntimeType = 'tmux' | 'docker';

/**
 * Where the agent runs.
 *   'local'  — On this machine (tmux or docker on host)
 *   'docker' — In a Docker container on this machine (clone + isolate)
 *   'remote' — On a remote machine (SSH, cloud VM, etc.)
 */
export type LocationType = 'local' | 'docker' | 'remote';

// ---------------------------------------------------------------------------
// Project Configuration — defaults that every task inherits
// ---------------------------------------------------------------------------

/**
 * Git branching strategy for worktree and PR creation.
 */
export interface BranchingStrategy {
  /** Base branch to create worktrees from (default: 'main') */
  baseBranch: string;
  /** Branch name template. Placeholders: {taskId}, {agent}, {timestamp} */
  branchPattern: string;
  /** Remote name for push/PR operations (default: 'origin') */
  remote: string;
}

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

/**
 * Project-level defaults loaded from .smith/project.json.
 *
 * Every task inherits these unless overridden at submit time.
 * This is the contract between your repo and the orchestrator.
 *
 * @example .smith/project.json
 * ```json
 * {
 *   "name": "skoolscout-com",
 *   "repository": "git@github.com:org/skoolscout-com.git",
 *   "localPath": "/Users/dev/repos/skoolscout-com",
 *   "branching": {
 *     "baseBranch": "develop",
 *     "branchPattern": "smith/{agent}/{taskId}",
 *     "remote": "origin"
 *   },
 *   "pullRequest": {
 *     "autoCreate": true,
 *     "targetBranch": "develop",
 *     "titlePattern": "[Smith] {prompt}",
 *     "labels": ["automated", "agent-pr"],
 *     "reviewers": ["edwincruz"],
 *     "draft": true
 *   },
 *   "defaults": {
 *     "agent": "claude",
 *     "runtime": "docker",
 *     "priority": "normal"
 *   },
 *   "context": {
 *     "include": ["src/**", "tests/**"],
 *     "exclude": ["node_modules/**", "dist/**", ".next/**"],
 *     "maxFileSize": "1MB"
 *   },
 *   "hooks": {
 *     "preTask": "pnpm install",
 *     "postTask": "pnpm test",
 *     "onSuccess": "pnpm build",
 *     "onFailure": null
 *   }
 * }
 * ```
 */
export interface ProjectConfig {
  /** Human-readable project name */
  name: string;
  /** Git remote URL (SSH or HTTPS) */
  repository: string;
  /** Absolute path to local clone on the host */
  localPath: string;
  /** Branching strategy */
  branching: BranchingStrategy;
  /** Pull request settings */
  pullRequest: PullRequestConfig;
  /** Default values for task fields */
  defaults: {
    agent: AgentType;
    runtime: RuntimeType;
    location: LocationType;
    priority: TaskManifest['priority'];
  };
  /** File context settings for agents */
  context: {
    /** Glob patterns of files to include in agent context */
    include: string[];
    /** Glob patterns to exclude from agent context */
    exclude: string[];
    /** Max file size to pass as context (e.g., '1MB', '500KB') */
    maxFileSize?: string;
  };
  /** Lifecycle hooks — shell commands run at each stage */
  hooks?: {
    /** Run before task dispatch (e.g., 'pnpm install') */
    preTask?: string;
    /** Run after task completes regardless of outcome */
    postTask?: string;
    /** Run only on success (exit 0) */
    onSuccess?: string;
    /** Run only on failure (exit 1) */
    onFailure?: string;
  };
  /** Additional environment variables injected into every task */
  env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Task Manifest
// ---------------------------------------------------------------------------

/**
 * The task manifest that enters the queue.
 * This is the contract between the pipeline and the orchestrator.
 *
 * Fields from ProjectConfig are used as defaults. Per-request overrides
 * take precedence over project defaults.
 */
export interface TaskManifest {
  taskId: string;
  prompt: string;
  /** Memorable agent name (e.g., bold-falcon-7a3f). Auto-generated if not provided.
   *  This name tracks the agent through: branch → session → container → worktree → logs → PR */
  agentName?: string;
  context: {
    files: string[];           // Files relevant to this task
    repository: string;        // Git remote URL (overrides project default)
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
  runtime?: RuntimeType;       // Execution runtime (default from project or 'tmux')
  location?: LocationType;     // Where: local, docker, or remote
  createdAt: string;           // ISO 8601
  priority: 'critical' | 'high' | 'normal' | 'low';
  metadata?: Record<string, unknown>;
  /** Project name — resolved to ProjectConfig at dispatch time */
  project?: string;
  /** Composed-agent profile, resolved server-side — materialized into the
   *  tool's native config in the worktree (design §5). */
  profile?: { name: string; role: string; directives: string };
  /** Override pull request settings for this task */
  pullRequest?: Partial<PullRequestConfig>;
  /** Override branching for this task */
  branching?: Partial<BranchingStrategy>;
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
  /** Default project config — used when manifest has no project override */
  defaultProject?: ProjectConfig;
  /** Named projects — keyed by project name */
  projects?: Record<string, ProjectConfig>;
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
