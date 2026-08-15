// ---------------------------------------------------------------------------
// orchestrator/config.ts — Configuration loader with sensible defaults
// ---------------------------------------------------------------------------

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentType, DockerConfig, OrchestratorConfig } from "./types.js";

/**
 * Default CLI commands for each supported agent type.
 * These are the raw commands that get composed with the task prompt.
 */
const DEFAULT_AGENT_COMMANDS: Record<AgentType, string> = {
  agy: "agy --dangerously-skip-permissions",
  claude: "claude --dangerously-skip-permissions",
  codex: "codex --full-auto",
  opencode: "opencode",
  copilot: "copilot --allow-all-tools",
};

/**
 * Default Docker configuration.
 * Uses the custom smith-agent image with no resource limits.
 */
const DEFAULT_DOCKER_CONFIG: DockerConfig = {
  image: "smith-agent:latest",
  shmSize: "2g",
  memoryLimit: "8g",
  // Agent auth has to cross into Linux somehow. macOS Keychain credentials —
  // what `claude` uses on the host — cannot be mounted into a container, so a
  // containerised agent reports "Not logged in · Please run /login" and the
  // task fails. `claude setup-token` mints a long-lived token for exactly this
  // case; forwarded here when the host has one, absent otherwise so nothing
  // changes for installs that do not use docker.
  extraEnv: process.env.CLAUDE_CODE_OAUTH_TOKEN
    ? { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN }
    : undefined,
};

/**
 * Load orchestrator configuration with sensible defaults.
 * Creates all required directories if they don't already exist.
 *
 * @param overrides - Partial config to merge over defaults
 * @returns Fully resolved OrchestratorConfig
 */
export function loadConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  const smithRoot = resolve(overrides?.smithRoot ?? ".smith");

  const config: OrchestratorConfig = {
    smithRoot,
    queueDir: resolve(smithRoot, "queue"),
    worktreeDir: resolve(smithRoot, "worktrees"),
    logsDir: resolve(smithRoot, "logs"),
    delegateBin: resolve("bin", "smith-delegate"),
    tmuxPrefix: "task",
    agentCommands: { ...DEFAULT_AGENT_COMMANDS },
    teardownTimeoutMs: 30_000,
    defaultRuntime: "tmux",
    docker: { ...DEFAULT_DOCKER_CONFIG, ...overrides?.docker },
    ...overrides,
    // Re-apply docker merge so partial docker overrides don't clobber defaults
    ...(overrides ? { docker: { ...DEFAULT_DOCKER_CONFIG, ...overrides.docker } } : {}),
  };

  // Ensure all required directories exist
  ensureDirectories(config);

  return config;
}

/**
 * Create all required directories if they don't exist.
 * Uses recursive mkdir so nested paths are created atomically.
 */
function ensureDirectories(config: OrchestratorConfig): void {
  const dirs = [config.smithRoot, config.queueDir, config.worktreeDir, config.logsDir];

  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
}

export interface LiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

/** Read LiveKit connection config from the environment. Throws naming the first missing var. */
export function loadLiveKitConfig(env: NodeJS.ProcessEnv = process.env): LiveKitConfig {
  const url = env.LIVEKIT_URL;
  const apiKey = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;
  if (!url) throw new Error("LIVEKIT_URL is required");
  if (!apiKey) throw new Error("LIVEKIT_API_KEY is required");
  if (!apiSecret) throw new Error("LIVEKIT_API_SECRET is required");
  return { url, apiKey, apiSecret };
}
