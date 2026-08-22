import { execFile } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { type GitAuthor, SMITH_IDENTITY } from "./git-author.js";
import type { SmithPaths } from "./paths.js";
import { loadRoster, saveRoster } from "./workspace-roster.js";
import {
  configDirFor,
  ensureWorkspaceDir,
  isGitRepo,
  loadWorkspaces,
  saveWorkspace,
  slugForDir,
  type Workspace,
  type WorkspaceRepo,
  workspaceDir,
} from "./workspaces.js";

const run = promisify(execFile);

/**
 * Commit identity for commits this code makes. The tool is always the
 * COMMITTER; the AUTHOR is whoever acted (spec 2026-08-22 §1.4), passed per
 * call. A machine with no global git identity therefore never fails to
 * commit, and `git blame` still names the person.
 */
const SMITH_COMMITTER = ["-c", `user.name=${SMITH_IDENTITY.name}`, "-c", `user.email=${SMITH_IDENTITY.email}`];

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
 * Make `paths.orgRepo` a git repo holding the org record, committing once.
 * Same contract as the per-workspace config repo it replaced: an existing
 * repo with a commit is never re-initialised and never gets a new commit
 * here — subsequent content reaches HEAD through `commitConfigFiles`.
 * Self-healing: a `.git` with no commits (a prior partial init) is completed,
 * so a worktree cut from the org repo is never a silently empty one.
 *
 * `org.name` is only written when no settings.json exists yet; an org record
 * the user has edited is never overwritten.
 */
export async function ensureOrgRepo(paths: SmithPaths, org: { name: string }): Promise<boolean> {
  const dir = paths.orgRepo;
  await mkdir(dir, { recursive: true });
  if (await hasCommit(dir)) return false;

  if (!(await exists(join(dir, ".git")))) {
    await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
  }
  if (!(await exists(join(dir, "settings.json")))) {
    await writeFile(join(dir, "settings.json"), `${JSON.stringify({ name: org.name }, null, 2)}\n`);
  }
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", [...SMITH_COMMITTER, "commit", "-q", "--allow-empty", "-m", "Org config"], { cwd: dir });
  return true;
}

/**
 * The only paths this codebase ever commits for ONE workspace, relative to
 * the org repo root. `specs`, `plans`, `dashboards`, `blueprints` are written
 * by later plans; listing them now costs nothing (absent paths are skipped)
 * and means the allowlist matches the spec's §1.4 in one place.
 */
export function workspaceConfigPaths(slug: string): string[] {
  return ["settings.json", "roster.json", "boards", "blueprints", "specs", "plans", "dashboards"].map(
    (p) => `workspaces/${slug}/${p}`,
  );
}

/** Org-level paths this codebase commits. */
const ORG_CONFIG_PATHS = ["settings.json", "blueprints"];

/**
 * Commit whichever allowlisted paths of `slug`'s subtree (plus the org-level
 * record) currently have uncommitted changes, inside the org repo.
 *
 * Stages ONLY these explicit paths — never `-A` — so a file the user drops
 * into the repo by hand is never staged or committed on their behalf. `git
 * add` with a pathspec that matches nothing fails the whole call, so each
 * candidate is checked with `exists()` first. A path that was DELETED on
 * disk (an archived boards/ dir) is therefore not staged either; its
 * deletion reaches HEAD only when something else under it is next committed.
 *
 * `opts.author` is whoever acted; absent means the tool healed something on
 * its own (boot). Returns whether it made a commit.
 */
export async function commitConfigFiles(
  paths: SmithPaths,
  slug: string,
  opts: { author?: GitAuthor; message?: string } = {},
): Promise<boolean> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`"${slug}" is not a workspace slug — refusing to build a commit pathspec from it`);
  }
  const dir = paths.orgRepo;
  const present: string[] = [];
  for (const path of [...ORG_CONFIG_PATHS, ...workspaceConfigPaths(slug)]) {
    if (await exists(join(dir, path))) present.push(path);
  }
  if (present.length === 0) return false;

  await run("git", ["add", "--", ...present], { cwd: dir });
  try {
    // Exit 0 means nothing is staged; a non-zero exit (thrown by execFile)
    // means there is a staged diff to commit.
    await run("git", ["diff", "--cached", "--quiet"], { cwd: dir });
    return false;
  } catch {
    /* fall through to commit below */
  }
  const author = opts.author ?? SMITH_IDENTITY;
  await run(
    "git",
    [
      ...SMITH_COMMITTER,
      "commit",
      "-q",
      "-m",
      opts.message ?? `config(${slug}): update`,
      `--author=${author.name} <${author.email}>`,
    ],
    { cwd: dir },
  );
  return true;
}

/**
 * Why a repo name cannot become a directory name inside a workspace, or null
 * if it's fine. A path separator or ".." would let `join` climb outside the
 * workspace directory — the repo-name equivalent of the guard `slugForDir`
 * already gives the *workspace* name (workspaces.ts). "." doesn't escape but
 * lands ON the workspace directory itself, merging the clone's own `.git`
 * with its unrelated siblings (.runtime/, the other project clones).
 *
 * Shared by `repoDirFor` below (the boot-time guard — no route validation
 * runs on that path) and `workspaceProblems` in server.ts (the route-time
 * guard, so POST/PUT /workspaces 400s on a bad name instead of surfacing an
 * unhandled 500 from `repoDirFor` further downstream). One predicate, so the
 * two never drift apart on what counts as invalid.
 */
export function repoNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") {
    return "a repo name can't be empty";
  }
  if (/[/\\]/.test(name) || trimmed === ".." || trimmed === ".") {
    return `a path separator, "..", or "." would let it escape onto or outside the workspace directory`;
  }
  return null;
}

/**
 * Where a project repo lives inside its workspace. Checked here, not at each
 * call site, so every caller (cloneRepoInto, materializeRepos,
 * migrateReposIntoWorkspace) is covered by one guard.
 */
export function repoDirFor(workspaceDir: string, repo: WorkspaceRepo): string {
  const problem = repoNameProblem(repo.name);
  if (problem) {
    throw new Error(`Repo "${repo.name}": invalid repo name — ${problem}`);
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
 * directory and every project repo present locally. The versioned half needs
 * no repo of its own — it is a subtree of the org repo, ensured at boot.
 *
 * A repo already at a valid local git path is LEFT THERE. Creation is not the
 * moment to relocate someone's existing checkout — the boot migration handles
 * that deliberately, and non-destructively.
 *
 * Returns a copy; the caller's record is never mutated.
 */
export async function materializeRepos(paths: SmithPaths, ws: Workspace): Promise<Workspace> {
  const dir = await ensureWorkspaceDir(paths, ws);
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
 *
 * `globalAgentIds` and `globalSquadIds` are today's full roster of definitions
 * at the host root (§4.1) — passed in, not loaded here, so this stays a pure
 * function of its arguments and the caller (server.ts, which already has the
 * agent registry and SQUAD_ROSTER in hand at boot) owns sourcing them.
 *
 * `globalAgentIds` is `null` when the caller could not determine it at all
 * (loading the global agent registry threw) — that must skip roster seeding
 * entirely, not fall back to `[]`: an empty array is itself a real, distinct
 * roster ("deliberately assigned nothing", per loadRoster's contract), and
 * writing it here would be a permanent lie the next boot can never correct,
 * because a workspace only ever gets a roster written once.
 */
export async function migrateReposIntoWorkspace(
  paths: SmithPaths,
  globalAgentIds: string[] | null,
  globalSquadIds: string[],
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

      if (changed) {
        try {
          // Save BEFORE the commit below: the commit snapshots whatever is on
          // disk at that moment. Committing first would capture the
          // pre-migration settings.json — the external path — instead of the
          // repointed record this migration exists to produce.
          await saveWorkspace(paths, { ...ws, repos });
          // Confirmed here, independent of the commit below: a clone whose
          // record was saved IS a completed migration, whether or not its
          // subtree separately reaches the org repo's HEAD. Reporting it
          // under `skipped` because of an unrelated config failure would be
          // false — the boot log's "cloned:" line exists so a silent,
          // successful migration can be confirmed at all, and a false "could
          // not save" note would point someone at the wrong problem.
          cloned.push(...justCloned);
        } catch (err) {
          skipped.push(...justCloned);
          notes.push(
            `[repo-migration] cloned ${ws.name}'s repos but could not save the record — ${(err as Error).message}`,
          );
        }
      }

      // Record today's assignment — every global agent and squad — so the
      // file exists. This preserves current behaviour exactly; it does not
      // start gating on the roster. Getting it into HEAD is the commit
      // below's job, not this write — this only needs to put the content on
      // disk to be staged. Outside the `changed` gate and in its own
      // try/catch, deliberately: it must run every boot, so a workspace whose
      // roster failed to save on some prior run keeps getting another chance
      // rather than resting silently unhealed.
      //
      // A null or empty globalAgentIds means the caller could not determine
      // — or truly has no — global agents this boot; skip seeding rather
      // than write a roster that looks identical to "deliberately assigned
      // nothing" (see the docstring above). Leaving roster.json absent lets
      // a later boot, once there is a real list, seed it correctly.
      const configDir = configDirFor(paths, ws);
      try {
        if (globalAgentIds !== null && globalAgentIds.length > 0 && (await loadRoster(configDir)) === null) {
          await saveRoster(configDir, { agents: globalAgentIds, squads: globalSquadIds });
        }
      } catch (err) {
        notes.push(`[repo-migration] ${ws.name}'s roster could not be recorded — ${(err as Error).message}`);
      }

      // Idempotent healing of this workspace's subtree in the org repo,
      // outside the `changed` gate and in its own try/catch for the same
      // reason as the block above. `ensureOrgRepo` (boot) commits the org
      // repo exactly once, so whichever of settings.json/boards/roster.json
      // didn't exist yet at that moment — roster.json never does, since it is
      // written just above — needs a later, separate commit to ever reach
      // HEAD. Runs every boot so an already-migrated workspace heals too.
      try {
        await commitConfigFiles(paths, slugForDir(ws.name));
      } catch (err) {
        notes.push(`[repo-migration] ${ws.name}'s config files did not get committed — ${(err as Error).message}`);
      }
    } catch (err) {
      for (const repo of ws.repos) skipped.push(`${ws.name}/${repo.name}`);
      notes.push(`[repo-migration] workspace "${ws.name}" could not be migrated — ${(err as Error).message}`);
    }
  }
  return { cloned, skipped, notes };
}
