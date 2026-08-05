// Workspaces — named groupings of one or more repos the crew can work in.
// One JSON file per workspace under .smith/workspaces/. Delegations name a
// workspace/repo; the dispatcher cuts the task's worktree from that repo.
import { readdir, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface WorkspaceRepo {
  name: string;
  /** Absolute path to the local clone the dispatcher worktrees from. */
  path: string;
  /** Git remote URL — informational (PRs, prompts). */
  repository?: string;
  /** Base branch for task worktrees. Default: main. */
  branch?: string;
  /** GitHub API pointer — separate from `repository` (informational remote URL, used for PR/prompt display). */
  github?: { owner: string; repo: string };
}

export interface Workspace {
  name: string;
  description?: string;
  repos: WorkspaceRepo[];
  /** The workspace used when a delegation names none. */
  default?: boolean;
  /** Archived in place: hidden from roster/delegation, kept for history. */
  archived?: boolean;
  /** Non-secret Jira/Confluence pointer. Credentials live on User, never here. */
  atlassian?: {
    siteUrl: string;
    jiraProjectKeys?: string[];
    confluenceSpaceKeys?: string[];
  };
}

function assertWorkspace(file: string, v: unknown): Workspace {
  const o = v as Partial<Workspace>;
  const ok =
    o &&
    typeof o.name === 'string' &&
    Array.isArray(o.repos) &&
    o.repos.length > 0 &&
    o.repos.every((r) => r && typeof r.name === 'string' && typeof r.path === 'string' && isAbsolute(r.path));
  if (!ok) {
    throw new Error(`Invalid workspace file ${file}: requires name and repos[]{name, absolute path}`);
  }
  return o as Workspace;
}

/** Load every *.json in `dir` as a Workspace. Throws (naming the file) on malformed input. */
export async function loadWorkspacesFromDir(dir: string): Promise<Workspace[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const workspaces: Workspace[] = [];
  for (const file of entries.filter((f) => f.endsWith('.json'))) {
    const raw = await readFile(join(dir, file), 'utf8');
    workspaces.push(assertWorkspace(file, JSON.parse(raw)));
  }
  return workspaces;
}

/** Workspaces visible to the roster, catalog, and delegation. */
export function activeWorkspaces(workspaces: Workspace[]): Workspace[] {
  return workspaces.filter((w) => !w.archived);
}

/** Default a blank/omitted branch to "main" — mirrors POST /workspaces so PUT can't persist an empty branch. */
export function normalizeRepoBranch(repos: WorkspaceRepo[]): WorkspaceRepo[] {
  return repos.map((r) => ({ ...r, branch: r.branch?.trim() || 'main' }));
}

/**
 * Resolve a delegation's workspace/repo names to a concrete repo.
 * Omitted workspace -> the default (flagged, else first). Omitted repo -> the
 * workspace's first repo. Returns null when nothing matches.
 */
export function resolveRepo(
  workspaces: Workspace[],
  workspaceName?: string,
  repoName?: string,
): { workspace: Workspace; repo: WorkspaceRepo } | null {
  const live = activeWorkspaces(workspaces);
  const workspace = workspaceName
    ? live.find((w) => w.name.toLowerCase() === workspaceName.toLowerCase())
    : (live.find((w) => w.default) ?? live[0]);
  if (!workspace) return null;
  const repo = repoName ? workspace.repos.find((r) => r.name.toLowerCase() === repoName.toLowerCase()) : workspace.repos[0];
  return repo ? { workspace, repo } : null;
}

/** Write one workspace to `dir`. Mirror of agents.saveAgent. */
export async function saveWorkspace(dir: string, ws: Workspace): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(ws.name)) {
    throw new Error(`Invalid workspace name "${ws.name}": use lowercase letters, digits and dashes`);
  }
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${ws.name}.json`), `${JSON.stringify(ws, null, 2)}\n`);
}

export async function removeWorkspaceFile(dir: string, name: string): Promise<void> {
  try {
    await rm(join(dir, `${name}.json`));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Workspace "${name}" not found`);
    }
    throw error;
  }
}

/** True when `path` is inside a git repository (worktrees are cut from here). */
export async function isGitRepo(path: string): Promise<boolean> {
  try {
    await promisify(execFile)('git', ['rev-parse', '--git-dir'], { cwd: path });
    return true;
  } catch {
    return false;
  }
}

/**
 * The invariant: while any OTHER active workspace exists, the default cannot
 * be archived or deleted — the caller must crown a successor first.
 * Returns the human-readable refusal, or null when the removal is fine.
 */
export function defaultViolation(all: Workspace[], removingName: string): string | null {
  const active = activeWorkspaces(all);
  const target = active.find((w) => w.name === removingName);
  const isDefault = target && (Boolean(target.default) || (!active.some((w) => w.default) && active[0] === target));
  if (isDefault && active.length > 1) {
    return `"${removingName}" is the default workspace — set another default first`;
  }
  return null;
}
