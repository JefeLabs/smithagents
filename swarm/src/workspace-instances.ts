import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { repoNameProblem } from "./workspace-repos.js";
import { slugForDir, type Workspace } from "./workspaces.js";

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
 * Resolve `base` to an unambiguous start-point for `git worktree add -b` in
 * `source`.
 *
 * A bare branch name that exists ONLY as a remote-tracking ref in `source` —
 * entirely normal: the task's base branch need not be the one this particular
 * clone happened to check out — hits a git worktree-add quirk: with
 * `-b <newBranch> -- <base>`, once `<base>` requires the remote-DWIM
 * resolution, git silently creates a branch named after `<base>` itself
 * (e.g. "main") and discards the requested `-b` name entirely — no error, no
 * warning, wrong branch. Verified empirically against git 2.55: reproduced
 * with `-b` on either side of the path, with and without `--`, 100% of runs.
 *
 * Resolving to the fully-qualified `origin/<base>` sidesteps the DWIM path
 * (git only takes that shortcut for a *bare* name), so `-b` is honored. A
 * local branch, when one already exists, is unambiguous on its own and is
 * used as-is. When `base` is neither, the bare name is returned unchanged so
 * `worktree add` fails with its own "invalid reference" error, for the caller
 * to wrap.
 *
 * Exported: dispatcher.ts's legacy (non-workspace) worktree creation hits the
 * exact same `git worktree add -b <new> -- <base>` shape and needs the same
 * protection — this is the one place the fix lives, not duplicated.
 */
export async function resolveStartPoint(source: string, base: string): Promise<string> {
  try {
    await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${base}`], { cwd: source });
    return base;
  } catch {
    // Not a local branch in this clone — fall through to the remote check.
  }
  try {
    await run("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`], { cwd: source });
    return `origin/${base}`;
  } catch {
    // Neither local nor remote-tracking — let worktree add's own error surface.
    return base;
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
 *
 * `opts.base`, when given, is the start-point for each REPO member (the task's
 * base branch — not necessarily wherever that repo's clone currently sits;
 * see `resolveStartPoint`). The config member is a sparse worktree of the ORG
 * repo (`opts.orgRepo`) showing `blueprints/` and this workspace's
 * `workspaces/<slug>/`; it has no base-branch concept and is cut from the org
 * repo's own HEAD. Omitting `opts.base` keeps the pre-existing behavior (every
 * repo member cut from the source's own HEAD) — unchanged for existing
 * callers.
 *
 * The config member therefore reflects the org repo's HEAD, not its live
 * tree: writes that have not been committed (board edits, archive flags) are
 * not visible in an instance until the next commit. Per-mutation commits for
 * board writes land with Plan 2's write queue; until then boards reach HEAD
 * at the next boot's healing pass or the next workspace create/update/archive.
 */
export async function createInstance(
  workspaceDir: string,
  ws: Workspace,
  workId: string,
  repoNames: string[],
  opts: { orgRepo: string; base?: string },
): Promise<Instance> {
  const problem = workIdProblem(workId);
  if (problem) throw new Error(`Invalid work id: ${problem}`);

  const dir = instanceDir(workspaceDir, workId);
  const branch = `smith/${workId}`;

  // The config member is a SPARSE worktree of the org repo (spec 2026-08-22
  // §8): this workspace's subtree plus the shared blueprints/, never a
  // sibling workspace's material. `sparse` is the cone-mode directory list.
  //
  // A name that slugs to nothing would cone in `workspaces/` itself — the
  // shared parent of every workspace's subtree, i.e. exactly the leak this
  // sparse checkout exists to prevent. Mirrors configDirForName's guard.
  const slug = slugForDir(ws.name);
  if (!slug) {
    throw new Error(
      `Workspace name "${ws.name}" has no characters usable in a directory name — refusing a cone that would expose every workspace`,
    );
  }
  const sources: Array<{ name: string; source: string; sparse?: string[] }> = [
    { name: "config", source: opts.orgRepo, sparse: ["blueprints", `workspaces/${slug}`] },
  ];
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
  for (const { name, source, sparse } of sources) {
    const path = join(dir, name);
    if (!(await isWorktree(path))) {
      // Prune stale worktree registrations in the source repo; a removed worktree
      // directory that still appears in .git/worktrees/ would make `worktree add`
      // refuse the path.
      await run("git", ["worktree", "prune"], { cwd: source });

      // Check if the branch already exists (e.g., the worktree was removed but
      // the branch commits remain). If so, attach to it; if not, create it.
      // `workIdProblem` already refused a leading dash, so `branch` cannot be
      // read as a flag.
      let branchExists = false;
      try {
        await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: source });
        branchExists = true;
      } catch {
        // Branch does not exist.
      }

      // Which ref the worktree starts on. Reattaching to an existing branch
      // takes no start-point; a repo member with a base starts there (see
      // resolveStartPoint); the config member has no base-branch concept and
      // is cut from the org repo's own HEAD. `usedBase` tracks exactly the
      // branch that actually consumed `opts.base`, so a failure elsewhere
      // (reattach, or the config member) never misattributes itself to it.
      let refArgs: string[];
      let usedBase = false;
      if (branchExists) {
        refArgs = [branch];
      } else if (!sparse && opts.base) {
        const startPoint = await resolveStartPoint(source, opts.base);
        refArgs = ["-b", branch, "--", startPoint];
        usedBase = true;
      } else {
        refArgs = ["-b", branch];
      }

      try {
        if (sparse) {
          // --no-checkout, set the cone, THEN populate: checking out the whole
          // org repo first and narrowing afterwards would briefly materialise
          // every workspace's files in this instance.
          await run("git", ["worktree", "add", "-q", "--no-checkout", path, ...refArgs], { cwd: source });
          try {
            await run("git", ["sparse-checkout", "set", "--cone", ...sparse], { cwd: path });
            await run("git", ["checkout", "-q", branch], { cwd: path });
          } catch (err) {
            // `worktree add` already wrote `path/.git`, so isWorktree(path)
            // would read this half-made worktree as done on the next call —
            // silently, since isWorktree only checks that `.git` exists. Left
            // in place, a retry (the normal path: dispatcher.ts calls
            // createInstance on every dispatch of the same taskId) would hand
            // back an empty, unconfigured config member with no error at all,
            // and a caller committing into it would record a commit that
            // deletes the entire org tree on this branch. Tear the half-made
            // worktree down so a retry starts clean. Best-effort: swallow
            // teardown failures so the ORIGINAL error is what propagates.
            await run("git", ["worktree", "remove", "--force", path], { cwd: source }).catch(() => {});
            await run("git", ["worktree", "prune"], { cwd: source }).catch(() => {});
            throw err;
          }
        } else {
          await run("git", ["worktree", "add", "-q", path, ...refArgs], { cwd: source });
        }
      } catch (err) {
        throw new Error(
          `Member "${name}": could not create a worktree${usedBase ? ` from base "${opts.base}"` : ""} — ${(err as Error).message}`,
        );
      }
    }
    members.push({ name, path, source });
  }
  return { workId, dir, branch, members };
}

/**
 * A squad member's branch.
 *
 * Deliberately NOT `smith/<workId>/<name>`: git's ref store cannot hold both a
 * branch `a` and a branch `a/b`, because a loose ref is a literal file under
 * `.git/refs/heads/` and `a` would have to be a file and a directory at once.
 * The instance's own branch is already `smith/<workId>`, so every name nested
 * beneath it is unusable — `git branch smith/w-1/fabian` fails with
 * "cannot lock ref ... 'refs/heads/smith/w-1' exists". Verified against git 2.55.
 *
 * `smith/members/` is its own namespace and is never itself a branch, so it
 * cannot collide, and it keeps every member across every instance listable with
 * `git branch --list 'smith/members/*'`.
 */
export function memberBranch(workId: string, name: string): string {
  return `smith/members/${workId}/${name}`;
}

/** Where a squad's member worktrees live inside its instance. */
export function membersDir(instanceDir: string): string {
  return join(instanceDir, "members");
}

/**
 * One worktree per squad member, under `<instance>/members/<name>/`.
 *
 * A BRANCH PER MEMBER because git refuses to check out one branch in two
 * worktrees. That is also what makes member isolation structural rather than a
 * convention: two members physically cannot edit the same tree, so no
 * turn-taking protocol is needed and no member can stomp another's work.
 *
 * They still share the workspace clone's object store, so a peer's COMMIT is
 * visible immediately via `git show <branch>:<path>` with no push or fetch —
 * commit is the handoff, and the feed announces it. Uncommitted work is
 * invisible to peers, which is the one real cost of this shape.
 *
 * Members are cut from the instance's own `smith/<workId>` by default, not from
 * the source clone's HEAD: integration merges member branches back into that
 * branch, and a member that started somewhere else would drag unrelated
 * divergence into the merge. `base` overrides it for a caller that needs to.
 *
 * Idempotent in the same sense as createInstance: an existing member worktree is
 * left exactly as it is, because it may hold work in progress, and a member
 * whose worktree was removed but whose branch survives is reattached rather than
 * recreated — which is what returns committed work after a partial teardown.
 */
export async function addMemberWorktrees(
  instanceDir: string,
  repoSource: string,
  workId: string,
  memberNames: string[],
  base?: string,
): Promise<InstanceMember[]> {
  const problem = workIdProblem(workId);
  if (problem) throw new Error(`Invalid work id: ${problem}`);

  // Validate EVERY name before creating ANYTHING. A bad name discovered midway
  // would leave a half-built members/ directory whose partial state the caller
  // has no way to distinguish from a complete one.
  for (const name of memberNames) {
    const nameProblem = repoNameProblem(name);
    if (nameProblem) throw new Error(`Member "${name}": invalid member name — ${nameProblem}`);
  }

  const dir = membersDir(instanceDir);
  await mkdir(dir, { recursive: true });

  const members: InstanceMember[] = [];
  for (const name of memberNames) {
    const path = join(dir, name);
    const branch = memberBranch(workId, name);
    if (!(await isWorktree(path))) {
      // Prune stale registrations first: a worktree directory that was removed
      // but still appears in .git/worktrees/ would make `worktree add` refuse
      // the path.
      await run("git", ["worktree", "prune"], { cwd: repoSource });

      let branchExists = false;
      try {
        await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoSource });
        branchExists = true;
      } catch {
        // Branch does not exist — create it below.
      }

      if (branchExists) {
        // Reattaching to a surviving branch — a start-point would be meaningless.
        await run("git", ["worktree", "add", "-q", path, branch], { cwd: repoSource });
      } else {
        const wanted = base ?? `smith/${workId}`;
        const startPoint = await resolveStartPoint(repoSource, wanted);
        try {
          await run("git", ["worktree", "add", "-q", path, "-b", branch, "--", startPoint], { cwd: repoSource });
        } catch (err) {
          throw new Error(
            `Member "${name}": could not create a worktree from base "${wanted}" — ${(err as Error).message}`,
          );
        }
      }
    }
    members.push({ name, path, source: repoSource });
  }
  return members;
}

/** Work ids with an instance directory, sorted. */
export async function listInstances(workspaceDir: string): Promise<string[]> {
  try {
    const entries = await readdir(instancesDir(workspaceDir), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Squad member worktrees under `<instance>/members/`, as `{name, path}`.
 *
 * Discovered from disk rather than taken from a caller, because the teardown
 * path has no way to know which members were ever added — and a member it does
 * not know about is exactly the one whose work would be lost silently.
 */
async function listMemberWorktrees(instanceDir: string): Promise<Array<{ name: string; path: string }>> {
  let entries: Dirent[];
  try {
    entries = await readdir(membersDir(instanceDir), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: Array<{ name: string; path: string }> = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const path = join(membersDir(instanceDir), e.name);
    // Qualified with "members/" so a member and a repo of the same name stay
    // distinguishable in the refusal message.
    if (await isWorktree(path)) out.push({ name: `members/${e.name}`, path });
  }
  return out;
}

/**
 * Members holding uncommitted changes or ignored content that would be
 * discarded on destroy.
 *
 * Covers squad member worktrees as well as the instance's own members: they are
 * worktrees whose contents exist nowhere else, so leaving them out would let
 * `destroyInstance` delete a member's uncommitted work without the refusal that
 * protects everything else.
 */
export async function instanceIsDirty(inst: Instance): Promise<string[]> {
  const dirty: string[] = [];
  const all = [...inst.members, ...(await listMemberWorktrees(inst.dir))];
  for (const m of all) {
    if (!(await isDir(m.path))) continue;
    // Check for both uncommitted changes and ignored files. Ignored files matter because
    // they may contain irreplaceable content like .env, and a worktree's contents exist
    // nowhere else. The `!!` prefix marks ignored files in the output.
    const { stdout } = await run("git", ["status", "--porcelain", "--ignored"], { cwd: m.path });
    if (stdout.trim()) dirty.push(m.name);
  }
  return dirty;
}

/**
 * Categorize a member's dirty status into uncommitted changes vs ignored content.
 * Returns { hasChanges: boolean, hasIgnored: boolean }.
 */
async function categorizeMemberDirtiness(path: string): Promise<{ hasChanges: boolean; hasIgnored: boolean }> {
  const { stdout } = await run("git", ["status", "--porcelain", "--ignored"], { cwd: path });
  let hasChanges = false;
  let hasIgnored = false;
  for (const line of stdout.trim().split("\n")) {
    if (!line) continue;
    if (line.startsWith("!!")) {
      hasIgnored = true;
    } else {
      hasChanges = true;
    }
  }
  return { hasChanges, hasIgnored };
}

/**
 * Remove an instance and deregister its worktrees.
 *
 * REFUSES when any member holds uncommitted changes or ignored files with content.
 * §2.2 destroys an instance only after the workspace clone has been fast-forwarded,
 * so a dirty member means the caller is destroying too early — and a worktree's
 * contents exist nowhere else. Ignored files matter because they may contain
 * irreplaceable content like .env. `force` is for a caller that has already
 * preserved the work.
 *
 * An absent instance is a no-op: this is the tail of a lifecycle, and making it
 * idempotent is what lets a retry finish a partial teardown.
 */
export async function destroyInstance(
  workspaceDir: string,
  ws: Workspace,
  workId: string,
  repoNames: string[],
  opts: { orgRepo: string; force?: boolean },
): Promise<void> {
  const problem = workIdProblem(workId);
  if (problem) throw new Error(`Invalid work id: ${problem}`);

  const dir = instanceDir(workspaceDir, workId);
  if (!(await isDir(dir))) return;

  const sources: Array<{ name: string; source: string }> = [{ name: "config", source: opts.orgRepo }];
  for (const name of repoNames) {
    const repo = ws.repos.find((r) => r.name === name);
    if (repo) sources.push({ name, source: repo.path });
  }
  const members: InstanceMember[] = sources.map(({ name, source }) => ({ name, path: join(dir, name), source }));

  // Squad member worktrees are found on disk: they were added after the
  // instance was built, so `repoNames` says nothing about them.
  const memberWorktrees = await listMemberWorktrees(dir);

  if (!opts.force) {
    const dirty = await instanceIsDirty({ workId, dir, branch: `smith/${workId}`, members });
    if (dirty.length > 0) {
      // Distinguish between uncommitted changes and ignored content for a better message
      const categorized: { changes: string[]; ignored: string[] } = { changes: [], ignored: [] };
      for (const m of [...members, ...memberWorktrees]) {
        if (!dirty.includes(m.name)) continue;
        if (!(await isDir(m.path))) continue;
        const { hasChanges, hasIgnored } = await categorizeMemberDirtiness(m.path);
        if (hasIgnored) categorized.ignored.push(m.name);
        if (hasChanges) categorized.changes.push(m.name);
      }

      const parts: string[] = [];
      if (categorized.changes.length > 0) {
        parts.push(`uncommitted changes in ${categorized.changes.join(", ")}`);
      }
      if (categorized.ignored.length > 0) {
        parts.push(`ignored content in ${categorized.ignored.join(", ")}`);
      }
      throw new Error(
        `Instance "${workId}" has ${parts.join(" and ")} — commit them, or destroy with force to discard`,
      );
    }
  }

  for (const m of members) {
    if (!(await isDir(m.path))) continue;
    // --force here removes the worktree registration; the dirty check above is
    // what protects the contents, and it has already run unless the caller
    // deliberately opted out.
    await run("git", ["worktree", "remove", "--force", m.path], { cwd: m.source }).catch(() => {});
  }
  await rm(dir, { recursive: true, force: true });

  // Member worktrees are deregistered by pruning rather than by `worktree
  // remove`: their registrations live in whichever source they were cut from,
  // which the caller never told us. Once the instance directory is gone their
  // registrations are stale, and prune is defined as removing exactly those —
  // so it cannot touch a live worktree even if a member came from elsewhere.
  if (memberWorktrees.length > 0) {
    for (const { source } of sources) {
      await run("git", ["worktree", "prune"], { cwd: source }).catch(() => {});
    }
  }
}
