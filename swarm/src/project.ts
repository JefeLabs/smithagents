// ---------------------------------------------------------------------------
// orchestrator/project.ts — Project Configuration Loader
//
// Loads project definitions from .smith/project.json (single project)
// or .smith/projects/*.json (multiple projects).
//
// The server resolves project defaults at dispatch time:
//   1. Load the project config (by name or default)
//   2. Merge project defaults with per-request overrides
//   3. Request fields always win over project defaults
// ---------------------------------------------------------------------------

import { readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { generateAgentName } from './names.js';

import type {
  ProjectConfig,
  BranchingStrategy,
  PullRequestConfig,
  TaskManifest,
  AgentType,
  RuntimeType,
  LocationType,
} from './types.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_BRANCHING: BranchingStrategy = {
  baseBranch: 'main',
  branchPattern: 'smith/{agent}/{taskId}',
  remote: 'origin',
};

const DEFAULT_PULL_REQUEST: PullRequestConfig = {
  autoCreate: false,
  titlePattern: '[Smith] {prompt}',
  labels: [],
  reviewers: [],
  draft: true,
};

const DEFAULT_PROJECT: Omit<ProjectConfig, 'name' | 'repository' | 'localPath'> = {
  branching: DEFAULT_BRANCHING,
  pullRequest: DEFAULT_PULL_REQUEST,
  defaults: {
    agent: 'claude',
    runtime: 'docker',
    location: 'local',
    priority: 'normal',
  },
  context: {
    include: ['**/*'],
    exclude: ['node_modules/**', 'dist/**', '.git/**'],
  },
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load a single project config from a JSON file.
 * Missing fields are filled with sensible defaults.
 */
export async function loadProjectConfig(path: string): Promise<ProjectConfig> {
  const raw = await readFile(path, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<ProjectConfig>;

  if (!parsed.name || !parsed.repository || !parsed.localPath) {
    throw new Error(
      `Project config at ${path} must have name, repository, and localPath`,
    );
  }

  return {
    ...DEFAULT_PROJECT,
    ...parsed,
    name: parsed.name,
    repository: parsed.repository,
    localPath: parsed.localPath,
    branching: { ...DEFAULT_BRANCHING, ...parsed.branching },
    pullRequest: { ...DEFAULT_PULL_REQUEST, ...parsed.pullRequest },
    defaults: { ...DEFAULT_PROJECT.defaults, ...parsed.defaults },
    context: { ...DEFAULT_PROJECT.context, ...parsed.context },
  };
}

/**
 * Load all project configs from a directory of JSON files.
 *
 * @param dir Path to directory (e.g., .smith/projects/)
 * @returns Map of project name → ProjectConfig
 */
export async function loadProjectsFromDir(
  dir: string,
): Promise<Record<string, ProjectConfig>> {
  const projects: Record<string, ProjectConfig> = {};

  try {
    const files = await readdir(dir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const config = await loadProjectConfig(join(dir, file));
        projects[config.name] = config;
      } catch {
        // Skip invalid project files
      }
    }
  } catch {
    // Directory doesn't exist — no projects
  }

  return projects;
}

// ---------------------------------------------------------------------------
// Auto-Detection — use current repo when no project config exists
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    timeout: 5000,
    encoding: 'utf-8',
  });
  return stdout.trim();
}

/**
 * Auto-detect project config from the current git repository.
 *
 * Runs git commands to discover:
 *   - Repository root (git rev-parse --show-toplevel)
 *   - Remote URL (git remote get-url origin)
 *   - Current branch (git branch --show-current)
 *   - Repo name (basename of remote URL)
 *
 * Falls back gracefully if git is unavailable or not in a repo.
 *
 * In Docker mode, the container will clone from the remote URL
 * instead of mounting the host worktree — full isolation.
 */
export async function detectCurrentProject(
  cwd?: string,
): Promise<ProjectConfig> {
  const opts = cwd ? { cwd } : undefined;

  let localPath: string;
  let repository: string;
  let currentBranch: string;
  let repoName: string;

  try {
    const execInDir = (cmd: string, args: string[]) =>
      promisify(execFile)(cmd, args, {
        timeout: 5000,
        encoding: 'utf-8',
        ...opts,
      }).then((r) => r.stdout.trim());

    localPath = await execInDir('git', ['rev-parse', '--show-toplevel']);
    repository = await execInDir('git', ['remote', 'get-url', 'origin']).catch(() => localPath);
    currentBranch = await execInDir('git', ['branch', '--show-current']).catch(() => 'main');

    // Extract repo name from remote URL or path
    // git@github.com:org/repo.git → repo
    // https://github.com/org/repo.git → repo
    const urlParts = repository.split('/').pop() ?? 'unknown';
    repoName = urlParts.replace(/\.git$/, '');
  } catch {
    // Not in a git repo — use cwd
    localPath = cwd ?? process.cwd();
    repository = localPath;
    currentBranch = 'main';
    repoName = basename(localPath);
  }

  return {
    ...DEFAULT_PROJECT,
    name: repoName,
    repository,
    localPath,
    branching: {
      ...DEFAULT_BRANCHING,
      baseBranch: currentBranch,
    },
    pullRequest: DEFAULT_PULL_REQUEST,
    defaults: { ...DEFAULT_PROJECT.defaults },
    context: { ...DEFAULT_PROJECT.context },
  };
}

// ---------------------------------------------------------------------------
// Manifest Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a TaskManifest against a ProjectConfig.
 *
 * Project defaults fill in missing fields. Per-request values always win.
 *
 * @param manifest - The incoming task manifest (possibly sparse)
 * @param project  - The project config providing defaults
 * @returns A fully resolved TaskManifest
 */
export function resolveManifest(
  manifest: Partial<TaskManifest> & { prompt: string },
  project: ProjectConfig,
): TaskManifest {
  const branch = manifest.branching?.baseBranch
    ?? manifest.context?.branch
    ?? project.branching.baseBranch;

  const repository = manifest.context?.repository ?? project.repository;

  const taskId = manifest.taskId ?? crypto.randomUUID();
  const agentName = manifest.agentName ?? generateAgentName(taskId);

  return {
    taskId,
    prompt: manifest.prompt,
    agentName,
    agent: (manifest.agent ?? project.defaults.agent) as AgentType,
    runtime: (manifest.runtime ?? project.defaults.runtime) as RuntimeType,
    location: (manifest.location ?? project.defaults.location ?? deriveLocation(manifest.runtime ?? project.defaults.runtime)) as LocationType,
    priority: manifest.priority ?? project.defaults.priority,
    createdAt: manifest.createdAt ?? new Date().toISOString(),
    context: {
      files: manifest.context?.files ?? [],
      repository,
      branch,
    },
    project: manifest.project ?? project.name,
    branching: {
      ...project.branching,
      ...manifest.branching,
    },
    pullRequest: {
      ...project.pullRequest,
      ...manifest.pullRequest,
    },
    metadata: manifest.metadata,
  };
}

/**
 * Interpolate template placeholders in branch/PR patterns.
 *
 * Supported placeholders: {taskId}, {agent}, {timestamp}, {prompt}
 */
export function interpolatePattern(
  pattern: string,
  manifest: TaskManifest,
): string {
  return pattern
    .replace('{taskId}', manifest.taskId.substring(0, 8))
    .replace('{name}', manifest.agentName ?? manifest.taskId.substring(0, 8))
    .replace('{agent}', manifest.agent)
    .replace('{timestamp}', Date.now().toString(36))
    .replace('{prompt}', slugify(manifest.prompt));
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
}

/**
 * Auto-derive location from runtime when not explicitly set.
 *   tmux   → local
 *   docker → docker
 */
function deriveLocation(runtime: RuntimeType): LocationType {
  return runtime === 'docker' ? 'docker' : 'local';
}
