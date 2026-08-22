import { execFile } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { type GitAuthor, SMITH_IDENTITY } from "./git-author.js";
import type { SmithPaths } from "./paths.js";
import { loadRoster, saveRoster } from "./workspace-roster.js";
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
 * Commit identity for commits this code makes. The tool is always the
 * COMMITTER; the AUTHOR is whoever acted (spec 2026-08-22 §1.4), passed per
 * call. A machine with no global git identity therefore never fails to
 * commit, and `git blame` still names the person.
 */
const SMITH_COMMITTER = ["-c", `user.name=${SMITH_IDENTITY.name}`, "-c", `user.email=${SMITH_IDENTITY.email}`];
const AUTHOR = SMITH_COMMITTER; // legacy alias — removed with ensureConfigRepo in the cutover task

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
 * Make `paths.orgRepo` a git repo holding the org record, committing once.
 * Same contract as the per-workspace `ensureConfigRepo` it replaces: an
 * existing repo with a commit is never re-initialised and never gets a new
 * commit here — subsequent content reaches HEAD through `commitConfigFiles`.
 * Self-healing: a `.git` with no commits (a prior partial init) is completed.
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

/** The only files this codebase ever commits into a workspace's config/ repo. */
const SYSTEM_OWNED_CONFIG_PATHS = ["settings.json", "boards", "roster.json"];

/**
 * Commit whichever of settings.json, boards/, and roster.json currently have
 * uncommitted changes, inside `<workspaceDir>/config`.
 *
 * Unlike `ensureConfigRepo` — which creates the repo and commits exactly
 * once, ever — this is idempotent and meant to be called repeatedly: once
 * right after each of those files is written, and once more on every boot,
 * so a config repo whose one-shot creation commit predates one of them (the
 * normal case: creation makes an empty repo before settings.json or boards/
 * exist; migration writes roster.json only after ensureConfigRepo has
 * already committed) still ends up with that content in HEAD.
 *
 * Stages ONLY these explicit paths — never `-A` — so a file the user drops
 * into config/ by hand is never staged or committed on their behalf, the same
 * guarantee `ensureConfigRepo`'s one-shot contract protects. `git add` with a
 * pathspec that matches nothing fails the whole call, so each candidate is
 * checked with `exists()` first and only the ones actually on disk are
 * passed. Returns whether it made a commit.
 */
export async function commitLegacyConfigFiles(workspaceDir: string): Promise<boolean> {
  const dir = join(workspaceDir, "config");
  const present: string[] = [];
  for (const path of SYSTEM_OWNED_CONFIG_PATHS) {
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
  await run("git", [...AUTHOR, "commit", "-q", "-m", "Update workspace config"], { cwd: dir });
  return true;
}

/**
 * Why a repo name cannot become a directory name inside a workspace, or null
 * if it's fine. A path separator or ".." would let `join` climb outside the
 * workspace directory — the repo-name equivalent of the guard `slugForDir`
 * already gives the *workspace* name (workspaces.ts). "." doesn't escape but
 * lands ON the workspace directory itself, merging the clone's own `.git`
 * with its unrelated siblings (config/, .runtime/).
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
          // Save BEFORE the config/ commit below: when config/ is not yet a
          // repo, its initial commit snapshots whatever is on disk at that
          // moment. Committing first would capture the pre-migration
          // settings.json — the external path — instead of the repointed
          // record this migration exists to produce.
          await saveWorkspace(paths, { ...ws, repos });
          // Confirmed here, independent of ensureConfigRepo below: a clone
          // whose record was saved IS a completed migration, whether or not
          // config/ separately becomes a git repo. Reporting it under
          // `skipped` because of an unrelated config failure would be false
          // — the boot log's "cloned:" line exists so a silent, successful
          // migration can be confirmed at all, and a false "could not save"
          // note would point someone at the wrong problem.
          cloned.push(...justCloned);
        } catch (err) {
          skipped.push(...justCloned);
          notes.push(
            `[repo-migration] cloned ${ws.name}'s repos but could not save the record — ${(err as Error).message}`,
          );
        }
      }

      // Outside the `changed` gate, and in its own try/catch, deliberately:
      // this must run every boot, not just the boot that happened to clone
      // something, so a workspace whose config/ failed to become a repo on
      // some prior run keeps getting another chance rather than resting
      // silently unhealed — per ensureConfigRepo's own docstring, a worktree
      // cut from a repo-less config/ comes out silently empty.
      try {
        await ensureConfigRepo(dir);
      } catch (err) {
        notes.push(`[repo-migration] ${ws.name}'s config/ could not become a git repo — ${(err as Error).message}`);
      }

      // Record today's assignment — every global agent and squad — so the
      // file exists. This preserves current behaviour exactly; it does not
      // start gating on the roster. Getting it into HEAD is
      // commitLegacyConfigFiles' job below, not this write — this only needs
      // to put the content on disk to be staged. Also outside the `changed`
      // gate and in its own try/catch, for the same reason as
      // ensureConfigRepo above: a workspace whose roster failed to save on
      // some prior run keeps getting another chance.
      //
      // A null or empty globalAgentIds means the caller could not determine
      // — or truly has no — global agents this boot; skip seeding rather
      // than write a roster that looks identical to "deliberately assigned
      // nothing" (see the docstring above). Leaving roster.json absent lets
      // a later boot, once there is a real list, seed it correctly.
      try {
        if (globalAgentIds !== null && globalAgentIds.length > 0 && (await loadRoster(dir)) === null) {
          await saveRoster(dir, { agents: globalAgentIds, squads: globalSquadIds });
        }
      } catch (err) {
        notes.push(`[repo-migration] ${ws.name}'s roster could not be recorded — ${(err as Error).message}`);
      }

      // Idempotent healing, outside the `changed` gate and in its own
      // try/catch for the same reason as the two blocks above: ensureConfigRepo
      // only ever commits once, so whichever of settings.json/boards/roster.json
      // didn't exist yet at that moment (creation: neither did; migration:
      // roster.json never does) needs a later, separate commit to ever reach
      // HEAD. Runs every boot so an already-migrated workspace — one that got
      // its one-shot commit before this function existed — heals too.
      try {
        await commitLegacyConfigFiles(dir);
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
