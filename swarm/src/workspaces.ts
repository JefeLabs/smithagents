// Workspaces — named groupings of one or more repos the crew can work in.
// One JSON file per workspace under .smith/workspaces/. Delegations name a
// workspace/repo; the dispatcher cuts the task's worktree from that repo.
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export interface WorkspaceRepo {
  name: string;
  /** Absolute path to the local clone the dispatcher worktrees from. */
  path: string;
  /** Git remote URL — informational (PRs, prompts). */
  repository?: string;
  /** Base branch for task worktrees. Default: main. */
  branch?: string;
}

export interface Workspace {
  name: string;
  description?: string;
  repos: WorkspaceRepo[];
  /** The workspace used when a delegation names none. */
  default?: boolean;
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
  const workspace = workspaceName
    ? workspaces.find((w) => w.name.toLowerCase() === workspaceName.toLowerCase())
    : (workspaces.find((w) => w.default) ?? workspaces[0]);
  if (!workspace) return null;
  const repo = repoName ? workspace.repos.find((r) => r.name.toLowerCase() === repoName.toLowerCase()) : workspace.repos[0];
  return repo ? { workspace, repo } : null;
}
