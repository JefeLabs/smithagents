import { execFile } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SmithPaths } from "./paths.js";
import { ensureWorkspaceDir, isGitRepo, type Workspace, type WorkspaceRepo } from "./workspaces.js";

const run = promisify(execFile);

/**
 * Commit identity for repos this code creates on the user's behalf. Their own
 * commits use their own identity; this only labels the initial import so a
 * machine with no global git identity does not fail to initialise a workspace.
 */
const AUTHOR = ["-c", "user.name=smithagents", "-c", "user.email=smithagents@localhost"];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function hasCommit(dir: string): Promise<boolean> {
  try {
    await run("git", ["rev-parse", "--verify", "HEAD"], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

/**
 * Make `<workspaceDir>/config` a git repo, committing whatever is already in it
 * (settings.json, boards/). Returns true if it initialised one, false if a repo
 * was already there.
 *
 * Idempotent in the strong sense: an existing repo is never re-initialised and
 * never gets a new commit, so uncommitted edits the user is holding stay
 * uncommitted. Committing on their behalf would put half-finished work into
 * history they did not ask for.
 *
 * Self-healing: if a prior partial init left a `.git` with no commits, this call
 * will complete it. This ensures that git worktree operations against config/ always
 * produce valid worktrees, not silent empty ones.
 */
export async function ensureConfigRepo(workspaceDir: string): Promise<boolean> {
  const dir = join(workspaceDir, "config");
  await mkdir(dir, { recursive: true });
  if (await hasCommit(dir)) return false;

  if (!(await exists(join(dir, ".git")))) {
    await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
  }
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", [...AUTHOR, "commit", "-q", "--allow-empty", "-m", "Workspace config"], { cwd: dir });
  return true;
}

/** Where a project repo lives inside its workspace. */
export function repoDirFor(workspaceDir: string, repo: WorkspaceRepo): string {
  return join(workspaceDir, repo.name);
}

/**
 * Clone a project repo into its workspace and return the absolute path.
 *
 * An existing clone is REUSED, never cloned over: it may hold the user's
 * uncommitted work, and re-cloning would destroy it. Reuse is detected by
 * checking for a resolvable HEAD, so a partial clone (with .git but no commits)
 * is not treated as usable. Callers that want a fresh copy delete the
 * directory first, deliberately.
 *
 * Requires `repository`. A repo recorded only as a local path has nothing to
 * clone from, and inventing a remote from its path would silently bind the
 * workspace to a checkout it does not own.
 */
export async function cloneRepoInto(workspaceDir: string, repo: WorkspaceRepo): Promise<string> {
  const dir = repoDirFor(workspaceDir, repo);
  if (await hasCommit(dir)) return dir;

  if (!repo.repository) {
    throw new Error(
      `Repo "${repo.name}" has no repository URL, so it cannot be cloned into ${workspaceDir} — ` +
        `add a remote to the workspace record, or leave the repo where it is`,
    );
  }

  if (repo.repository.startsWith("-")) {
    throw new Error(`Repo "${repo.name}": invalid repository URL`);
  }
  if (repo.branch?.startsWith("-")) {
    throw new Error(`Repo "${repo.name}": invalid branch`);
  }

  // Check for non-empty destination with no resolvable HEAD (interrupted clone or stale debris)
  if (await exists(dir)) {
    const entries = await readdir(dir);
    if (entries.length > 0) {
      throw new Error(
        `Repo "${repo.name}": destination ${dir} exists and is not empty, but is not a usable git clone ` +
          `(no resolvable HEAD). This looks like an interrupted clone. Remove the directory by hand before ` +
          `cloning this repo.`,
      );
    }
  }

  await mkdir(workspaceDir, { recursive: true });
  const branch = repo.branch ? ["--branch", repo.branch] : [];
  try {
    await run("git", ["clone", "-q", ...branch, "--", repo.repository, dir]);
  } catch (err) {
    throw new Error(`Repo "${repo.name}": clone failed — ${(err as Error).message}`);
  }
  return dir;
}

/**
 * Give a workspace the shape §1.2 requires before it is saved: its own
 * directory, a git config repo, and every project repo present locally.
 *
 * A repo already at a valid local git path is LEFT THERE. Creation is not the
 * moment to relocate someone's existing checkout — the boot migration handles
 * that deliberately, and non-destructively.
 *
 * Returns a copy; the caller's record is never mutated.
 */
export async function materializeRepos(paths: SmithPaths, ws: Workspace): Promise<Workspace> {
  const dir = await ensureWorkspaceDir(paths, ws);
  await ensureConfigRepo(dir);
  const repos: WorkspaceRepo[] = [];
  for (const repo of ws.repos) {
    if (repo.path && (await isGitRepo(repo.path))) {
      repos.push(repo);
      continue;
    }
    repos.push({ ...repo, path: await cloneRepoInto(dir, repo) });
  }
  return { ...ws, repos };
}
