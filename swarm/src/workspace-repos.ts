import { execFile } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SmithPaths } from "./paths.js";
import {
  ensureWorkspaceDir,
  isGitRepo,
  loadWorkspaces,
  saveWorkspace,
  type Workspace,
  type WorkspaceRepo,
  workspaceDir,
} from "./workspaces.js";

const run = promisify(execFile);

/**
 * Commit identity for repos this code creates on the user's behalf. Their own
 * commits use their own identity; this only labels the initial import so a
 * machine with no global git identity does not fail to initialise a workspace.
 */
const AUTHOR = ["-c", "user.name=smithagents", "-c", "user.email=smithagents@localhost"];

/**
 * Strip `user:token@` credentials from a URL embedded in a git error message
 * before it reaches a note — and, through server.ts, the boot log at warn. A
 * private repo's URL of that shape is echoed verbatim into both execFile's
 * "Command failed" line and git's own stderr; this is the one place that
 * text is persisted, so a live credential must never survive into it.
 */
function redactCredentials(message: string): string {
  return message.replace(/:\/\/[^/@\s]+@/g, "://***@");
}

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

/**
 * Where a project repo lives inside its workspace.
 *
 * Rejects a name containing a path separator, or equal to "..": a bare `join`
 * would let such a name climb outside the workspace directory — the repo-name
 * equivalent of the guard `slugForDir` already gives the *workspace* name
 * (workspaces.ts). Checked here, not at each call site, so every caller
 * (cloneRepoInto, materializeRepos, migrateReposIntoWorkspace) is covered.
 */
export function repoDirFor(workspaceDir: string, repo: WorkspaceRepo): string {
  if (/[/\\]/.test(repo.name) || repo.name === "..") {
    throw new Error(
      `Repo "${repo.name}": invalid repo name — a path separator or ".." would let it escape the workspace directory`,
    );
  }
  return join(workspaceDir, repo.name);
}

/**
 * git clone runs against a possibly slow or unreachable remote, at boot,
 * before the server can start listening — it must not be allowed to hang
 * forever. Bounded to 10 minutes: generous for a real clone of a large repo,
 * but finite, so an unreachable remote can never keep the process from ever
 * reaching app.listen(). GIT_TERMINAL_PROMPT=0 means a repo needing
 * credentials git does not have fails immediately instead of blocking on an
 * interactive prompt nothing at boot time can answer.
 *
 * Split out as its own pure function (and exported) so a test can assert
 * what gets passed to git without needing a fixture that actually hangs.
 */
export const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

export function cloneExecOptions(): { timeout: number; env: NodeJS.ProcessEnv } {
  return { timeout: CLONE_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } };
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
    await run("git", ["clone", "-q", ...branch, "--", repo.repository, dir], cloneExecOptions());
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

/**
 * Relocate project repos recorded OUTSIDE their workspace to a clone inside it.
 *
 * Non-destructive by decision (Edwin, 2026-08-17): the external checkout is
 * never moved or deleted, only cloned from its remote. The consequence is real
 * and worth stating — the fresh clone does NOT carry uncommitted work from the
 * old checkout, so anything unstaged there stays there, in a directory the
 * workspace no longer points at.
 *
 * A repo with no `repository` cannot be cloned; it keeps its external path and
 * is reported in `skipped`. That workspace cannot host an instance until it is
 * given a remote — which is what the note says.
 *
 * Runs at boot. One bad workspace is isolated, never fatal: a throw here would
 * brick every subsequent start.
 */
export async function migrateReposIntoWorkspace(
  paths: SmithPaths,
): Promise<{ cloned: string[]; skipped: string[]; notes: string[] }> {
  const cloned: string[] = [];
  const skipped: string[] = [];
  const notes: string[] = [];

  for (const ws of await loadWorkspaces(paths)) {
    try {
      // workspaceDir() can throw — a malformed `dir` field (assertContext
      // never type-checks it) reaches resolve() and blows up here, before any
      // repo is even looked at. This whole per-workspace body is inside the
      // try below for exactly that reason: one bad record must not brick
      // every subsequent boot.
      const dir = workspaceDir(paths, ws);
      const repos: WorkspaceRepo[] = [];
      const justCloned: string[] = [];
      let changed = false;

      for (const repo of ws.repos) {
        const label = `${ws.name}/${repo.name}`;
        try {
          // repoDirFor() also throws (an escaping repo name) — caught here,
          // per repo, so one bad repo in a workspace doesn't take down its
          // siblings the way a bad workspace-level failure takes down this
          // workspace's own repos.
          const inside = repoDirFor(dir, repo);
          if (repo.path === inside) {
            repos.push(repo);
            continue;
          }
          if (!repo.repository) {
            skipped.push(label);
            notes.push(
              `[repo-migration] ${label} lives outside its workspace at ${repo.path} and has no repository URL to ` +
                `clone from — add a remote to the workspace record, or leave it where it is; until then this ` +
                `workspace cannot host an instance`,
            );
            repos.push(repo);
            continue;
          }
          repos.push({ ...repo, path: await cloneRepoInto(dir, repo) });
          justCloned.push(label);
          changed = true;
        } catch (err) {
          skipped.push(label);
          notes.push(
            `[repo-migration] ${label} could not be cloned into ${dir} — ${redactCredentials((err as Error).message)}`,
          );
          repos.push(repo);
        }
      }

      if (!changed) continue;
      try {
        // Save BEFORE the first config/ commit: when config/ is not yet a
        // repo, ensureConfigRepo's initial commit snapshots whatever is on
        // disk at that moment. Committing first would capture the
        // pre-migration settings.json — the external path — instead of the
        // repointed record this migration exists to produce.
        await saveWorkspace(paths, { ...ws, repos });
        await ensureConfigRepo(dir);
        // Only confirmed here: a clone that succeeded but whose record could
        // not be saved is not a completed migration, and must not be
        // reported as one — the boot log's "cloned:" line is the one thing
        // that lets a silent, successful migration be confirmed at all.
        cloned.push(...justCloned);
      } catch (err) {
        skipped.push(...justCloned);
        notes.push(
          `[repo-migration] cloned ${ws.name}'s repos but could not save the record — ${(err as Error).message}`,
        );
      }
    } catch (err) {
      for (const repo of ws.repos) skipped.push(`${ws.name}/${repo.name}`);
      notes.push(`[repo-migration] workspace "${ws.name}" could not be migrated — ${(err as Error).message}`);
    }
  }
  return { cloned, skipped, notes };
}
