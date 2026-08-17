import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { repoNameProblem } from "./workspace-repos.js";
import type { Workspace } from "./workspaces.js";

const run = promisify(execFile);

/** Ephemeral instances live in the workspace's unversioned half (spec §1.2). */
export function instancesDir(workspaceDir: string): string {
  return join(workspaceDir, ".runtime", "instances");
}

/** One instance's directory. */
export function instanceDir(workspaceDir: string, workId: string): string {
  return join(instancesDir(workspaceDir), workId);
}

/**
 * Whether a work id is usable, and why not if it isn't.
 *
 * A work id becomes BOTH a directory name under `.runtime/instances/` and part
 * of a git branch name, so it is checked for two different escapes: a path
 * separator or `..`/`.` would climb out of the instances directory, and a
 * leading `-` would be read by git as a flag rather than a value.
 *
 * Surrounding whitespace is rejected outright so the validated string remains
 * identical to the raw one, preventing "which string did you actually use" bugs.
 * Control characters are forbidden because they break git refs.
 */
export function workIdProblem(workId: string): string | null {
  if (!workId?.trim()) return "a work id cannot be blank";
  if (workId !== workId.trim()) return `"${workId}" has surrounding whitespace, which must be removed`;
  if (workId === "." || workId === "..") return `"${workId}" would resolve to the current or parent directory`;
  if (/[/\\]/.test(workId)) return `"${workId}" contains a path separator, which would escape the instances directory`;
  if (workId.startsWith("-")) return `"${workId}" starts with "-", which git would read as a flag`;
  if (!/^[\w.-]+$/.test(workId)) return `"${workId}" contains control characters or other forbidden characters`;
  return null;
}

export interface InstanceMember {
  /** "config", or the repo's name in the workspace record. */
  name: string;
  /** The worktree, inside the instance. */
  path: string;
  /** The workspace's own clone this worktree was cut from. */
  source: string;
}

export interface Instance {
  workId: string;
  dir: string;
  branch: string;
  members: InstanceMember[];
}

// biome-ignore lint/correctness/noUnusedVariables: used by Task 3 (destroyInstance)
async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Whether this path is already a git worktree.
 *
 * A worktree's `.git` is a FILE (it points into the parent's `.git/worktrees/`),
 * a plain clone's is a directory — so this tests for either, and only for the
 * marker itself. Testing that the DIRECTORY exists instead would read an empty
 * leftover from a partial teardown as an existing member and skip creating its
 * worktree. Testing with `git rev-parse` would be worse still: from an empty
 * directory git walks UP and can answer about an enclosing repo.
 */
async function isWorktree(path: string): Promise<boolean> {
  try {
    await stat(join(path, ".git"));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Create the workspace-instance for `workId`: a worktree of `config/` plus one
 * of each named repo, all on the SAME branch (spec §2.1). One branch across
 * every member is what makes a coordinated cross-repo change the default rather
 * than a special case.
 *
 * Worktrees rather than clones: instances are disposable and share the
 * workspace's object store, which is also what makes the eventual rebase local.
 *
 * Idempotent — an existing member worktree is left exactly as it is, because it
 * may hold work in progress. Only missing members are added, so an instance
 * that gained a repo mid-flight can be completed by calling again. A removed
 * worktree whose branch still exists is reattached, returning the committed work.
 */
export async function createInstance(
  workspaceDir: string,
  ws: Workspace,
  workId: string,
  repoNames: string[],
): Promise<Instance> {
  const problem = workIdProblem(workId);
  if (problem) throw new Error(`Invalid work id: ${problem}`);

  const dir = instanceDir(workspaceDir, workId);
  const branch = `smith/${workId}`;

  const sources: Array<{ name: string; source: string }> = [{ name: "config", source: join(workspaceDir, "config") }];
  for (const name of repoNames) {
    // Validate repo name before touching the filesystem.
    if (name === "config") {
      throw new Error(`Repo name "config" collides with the workspace's reserved config member`);
    }
    const nameProblem = repoNameProblem(name);
    if (nameProblem) throw new Error(`Repo "${name}": invalid repo name — ${nameProblem}`);

    const repo = ws.repos.find((r) => r.name === name);
    if (!repo) throw new Error(`Repo "${name}" is not in workspace "${ws.name}"`);
    sources.push({ name, source: repo.path });
  }

  await mkdir(dir, { recursive: true });
  const members: InstanceMember[] = [];
  for (const { name, source } of sources) {
    const path = join(dir, name);
    if (!(await isWorktree(path))) {
      // Prune stale worktree registrations in the source repo; a removed worktree
      // directory that still appears in .git/worktrees/ would make `worktree add`
      // refuse the path.
      await run("git", ["worktree", "prune"], { cwd: source });

      // Check if the branch already exists (e.g., the worktree was removed but
      // the branch commits remain). If so, attach to it; if not, create it.
      // `workIdProblem` already refused a leading dash, so `branch` cannot be
      // read as a flag. The base is this source's current HEAD.
      let branchExists = false;
      try {
        await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: source });
        branchExists = true;
      } catch {
        // Branch does not exist.
      }

      if (branchExists) {
        await run("git", ["worktree", "add", "-q", path, branch], { cwd: source });
      } else {
        await run("git", ["worktree", "add", "-q", path, "-b", branch], { cwd: source });
      }
    }
    members.push({ name, path, source });
  }
  return { workId, dir, branch, members };
}
