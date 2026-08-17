import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

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
