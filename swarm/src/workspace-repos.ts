import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceRepo } from "./workspaces.js";
import { isGitRepo } from "./workspaces.js";

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
 * uncommitted work, and re-cloning would destroy it. Callers that want a fresh
 * copy delete the directory first, deliberately.
 *
 * Requires `repository`. A repo recorded only as a local path has nothing to
 * clone from, and inventing a remote from its path would silently bind the
 * workspace to a checkout it does not own.
 */
export async function cloneRepoInto(workspaceDir: string, repo: WorkspaceRepo): Promise<string> {
  const dir = repoDirFor(workspaceDir, repo);
  if (await isGitRepo(dir)) return dir;
  if (!repo.repository) {
    throw new Error(
      `Repo "${repo.name}" has no repository URL, so it cannot be cloned into ${workspaceDir} — ` +
        `add a remote to the workspace record, or leave the repo where it is`,
    );
  }
  await mkdir(workspaceDir, { recursive: true });
  const branch = repo.branch ? ["--branch", repo.branch] : [];
  await run("git", ["clone", "-q", ...branch, repo.repository, dir]);
  return dir;
}
