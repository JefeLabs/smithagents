// Two kinds of one-time migration into the current state root.
//
// migrateState() COPIES a legacy root wholesale — the source stays intact so
// rollback is "point the root back" rather than "restore from a backup you
// may not have" (this install lost boards and documents to an irreversible
// reset once already). migrateBoards() and migrateWorkspaceRecords() below
// instead MOVE individual records within the current root — copy/write,
// verify, then remove the source — since there is no second root to roll
// back to for those.
import { execFile } from "node:child_process";
import { cp, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import type { SmithPaths } from "./paths.js";
import { loadBoards } from "./work-items.js";
import { loadRegistry, registryPath, saveRegistryEntry } from "./workspace-registry.js";
import { commitConfigFiles } from "./workspace-repos.js";
import {
  configDirFor,
  configDirForName,
  ensureWorkspaceDir,
  loadWorkspaceFilesFromDir,
  probeSettings,
  settingsPathFor,
  slugForDir,
  type Workspace,
} from "./workspaces.js";

/**
 * Never migrated. `worktrees` holds live session working directories: tmux
 * processes hold them as cwd and git has registered them at absolute paths, so
 * a copy produces two divergent trees and a move breaks both. Existing sessions
 * keep the old location; new ones are created under the new root. `logs` is
 * append-only diagnostics with no value in a new root.
 */
export const SKIPPED_ENTRIES: readonly string[] = ["worktrees", "logs"];

/**
 * Candidate legacy roots, most likely first.
 *
 * `swarmDir` must be the swarm package's own directory on disk — NOT the
 * caller's cwd. The pre-migration default resolved state against
 * `process.cwd()`, so real legacy state could only ever land in one of two
 * physical places: `<repo>/swarm/.smith` (the documented "cd swarm && start"
 * workflow) or `<repo>/.smith` (starting from the repo root, where nothing
 * about swarm/ was involved). Deriving `swarmDir` from process.cwd() would
 * reintroduce the exact bug this guards against — a server started from
 * anywhere else finds no candidate and boots empty, silently. Callers should
 * derive it from this module's own file location (stable regardless of
 * launch directory) instead.
 */
export function legacyStateRoots(swarmDir: string): string[] {
  return [resolve(swarmDir, ".smith"), resolve(swarmDir, "..", ".smith")];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    // Only a genuinely absent path means "does not exist". A permissions
    // failure or anything else must propagate — treating it as absent would
    // let a collision or a legacy root hide behind an inaccessible entry.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return false;
  }
}

/** Written into a state root the first time a server boots cleanly against it. */
export const STATE_MARKER = "state-version.json";

/**
 * True when this root has booted before — migration was already settled for
 * it. Once a root reaches this state it stays settled forever: an in-app
 * reset that later clears out individual subdirectories (POST /reset removes
 * work/, for instance, without recreating it) must never be mistaken for a
 * fresh, unmigrated root and re-trigger the startup guard.
 */
export async function isInitialized(root: string): Promise<boolean> {
  return exists(join(root, STATE_MARKER));
}

/** Record that this root is initialized. Idempotent. */
export async function markInitialized(root: string): Promise<void> {
  await writeFile(join(root, STATE_MARKER), JSON.stringify({ version: 1, initializedAt: new Date().toISOString() }));
}

/**
 * A collision is something a copy could destroy or shadow, not merely
 * something present. A file always collides, and a non-empty directory
 * always collides — but an empty directory holds nothing, so copying into it
 * loses nothing. ensureDirectories()/boot routinely seed empty scaffolding
 * (queue/, ...) under a fresh root before this ever runs; treating that as a
 * collision made the guard's own remedy command fail for every user who ran
 * it verbatim.
 */
async function isCollision(path: string): Promise<boolean> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return false; // absent — nothing to lose
  }
  if (!info.isDirectory()) return true; // a file always collides, any size
  return (await readdir(path)).length > 0;
}

/**
 * The legacy root to migrate from, or null when nothing should happen —
 * either every candidate is absent, or the target already holds everything
 * each candidate does.
 *
 * This is a set-difference question, not an emptiness one. A target is not
 * "already migrated" merely because it is non-empty: by the time this runs,
 * loadConfig()'s ensureDirectories() and boot have typically already seeded
 * the new root with structural dirs (queue/, worktrees/, logs/) and a
 * settings file, none of which is the user's actual state. Checking
 * emptiness alone let a scaffolding-only target hide real state sitting in
 * a legacy root — the server started clean instead of refusing.
 */
export async function needsMigration(to: string, candidates: string[]): Promise<string | null> {
  let targetEntries: string[] = [];
  try {
    targetEntries = await readdir(to);
  } catch (err) {
    // Only a genuinely absent target is an empty one. Anything else — most
    // notably EACCES on an unreadable target — must propagate, so an
    // inaccessible target is never reported as "safe to migrate into".
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    targetEntries = [];
  }
  const targetSet = new Set(targetEntries);

  for (const candidate of candidates) {
    if (!(await exists(candidate))) continue;
    const entries = (await readdir(candidate)).filter((e) => !SKIPPED_ENTRIES.includes(e));
    // Does this candidate hold anything the target lacks? If so it still
    // needs migrating, regardless of what else the target already has.
    if (entries.some((entry) => !targetSet.has(entry))) return candidate;
  }
  return null;
}

/**
 * Copy every migratable entry from `from` into `to`. Throws — before copying
 * anything — if an entry already exists in the target, so a half-populated
 * target is never silently merged into.
 */
export async function migrateState(from: string, to: string): Promise<{ copied: string[]; skipped: string[] }> {
  const entries = await readdir(from);
  const migratable = entries.filter((e) => !SKIPPED_ENTRIES.includes(e));
  const skipped = entries.filter((e) => SKIPPED_ENTRIES.includes(e));

  // Check every collision first: a partial copy is worse than a refusal.
  const collisions: string[] = [];
  for (const entry of migratable) {
    if (await isCollision(join(to, entry))) collisions.push(entry);
  }
  if (collisions.length > 0) {
    throw new Error(
      `refusing to migrate into ${to} — these already exist: ${collisions.join(", ")}. ` +
        `Move them aside and retry; nothing has been copied.`,
    );
  }

  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const entry of migratable) {
    await cp(join(from, entry), join(to, entry), { recursive: true, preserveTimestamps: true });
  }
  return { copied: migratable, skipped };
}

/**
 * Relocate each workspace-owned board out of the flat host directory and into
 * its workspace's config/boards. Copy first, verify, then remove the source —
 * a board is never in neither place.
 *
 * Two kinds of board deliberately stay put: the workspace-less `personal`
 * board, and any board whose workspace record no longer exists. Dropping an
 * orphan would destroy the only copy of work that a later recreate might want.
 *
 * A workspace copy that already exists at the target is never overwritten.
 * Since board reads went workspace-first, an edit made after that change
 * lands only in the workspace copy while the host original goes stale — so
 * the target, when present, is the authoritative one, and copying the host
 * version over it would silently destroy the newer edit. The stale host
 * source is still removed and the board still reported as moved.
 */
export async function migrateBoards(
  paths: SmithPaths,
  workspaces: Workspace[],
): Promise<{ moved: Array<{ id: string; to: string }>; kept: string[] }> {
  const { boards } = await loadBoards(paths.work);
  const moved: Array<{ id: string; to: string }> = [];
  const kept: string[] = [];

  for (const board of boards) {
    const ws = board.workspaceId ? workspaces.find((w) => w.name === board.workspaceId) : undefined;
    if (!ws) {
      kept.push(board.id);
      continue;
    }
    const targetDir = join(configDirFor(paths, ws), "boards");
    await mkdir(targetDir, { recursive: true });
    const from = join(paths.work, `${board.id}.json`);
    const to = join(targetDir, `${board.id}.json`);
    if (await exists(to)) {
      // The workspace copy is already authoritative — do not touch it, just
      // clear away the stale duplicate left behind in the host directory.
      await rm(from);
      moved.push({ id: board.id, to });
      continue;
    }
    await cp(from, to, { preserveTimestamps: true });
    // Only once the copy is on disk does the source go.
    await stat(to);
    await rm(from);
    moved.push({ id: board.id, to });
  }
  return { moved, kept };
}

/**
 * Move each flat workspace record into its subtree of the org repo as
 * settings.json, and register its runtime directory. Write first, verify it
 * reads back and validates, then remove the flat file — a record is never in
 * neither place, and the flat copy is never deleted on the strength of a
 * destination that merely *exists*.
 *
 * Deletes the exact file each record was read from, never a name-derived path:
 * a record's `name` field is not guaranteed to match its filename (a
 * copied-then-hand-edited record, for instance), so guessing `${ws.name}.json`
 * can delete an unrelated sibling file whose content was never migrated.
 *
 * Records are isolated per-file in a try/catch, so one bad one (an unslugable
 * name, a permissions failure) is skipped rather than aborting the rest —
 * this is called at boot (server.ts, before reloadWorkspaces), so it must
 * always return. That isolation does not reach a record that fails
 * validation up front: `loadWorkspaceFilesFromDir` builds its whole list
 * before this loop ever runs, so one `*.json` sibling that is not valid JSON
 * or not a valid context throws from that call and aborts before anything is
 * touched — the same pre-existing behavior `loadWorkspaces()` has, unchanged
 * here.
 *
 * An existing settings.json for the SAME workspace, with the SAME content, is
 * NEVER overwritten — since writes have been going there since the registry
 * landed, it is the newer (or an identical) copy, and the flat file is a
 * stale leftover safe to remove either way. Two further cases do NOT count as
 * "the same workspace, migrated":
 *
 * - It exists but does not validate (parses as JSON but fails `assertContext`,
 *   e.g. a hand-edited `{"name":"pg"}` missing `repos`) — left alone rather
 *   than trusted or overwritten: the flat record may be the only good copy
 *   left, so nothing is deleted and the workspace is retried on the next run.
 * - It validates and even names the same workspace, but its CONTENT differs
 *   from the flat record being migrated — two distinct records that merely
 *   share a name (e.g. a copy made before a hand-edit). Deleting on a name
 *   match alone would destroy whichever one lost the race to migrate first.
 *
 * A settings.json that validates is also not proof it belongs to the
 * workspace being migrated at all: `slugForDir` is identity only for names
 * that already pass `saveWorkspace`'s `^[a-z0-9][a-z0-9-]{0,63}$` check, but
 * `assertContext` does not enforce that format — legacy flat records can
 * carry names like "Foo" and "foo" that differ only by case and slug to the
 * same subtree. Whichever name claims the directory first wins it; the
 * second sees a settings.json that validates fine but names someone else,
 * and must not delete its own flat record on the strength of that — it is
 * left in place, unregistered, for a human to resolve.
 *
 * Group records (`members`, no `repos`) are never touched: the loader this
 * function uses filters them out before this loop ever sees them. Groups
 * deliberately stay flat.
 */
export async function migrateWorkspaceRecords(
  paths: SmithPaths,
): Promise<{ moved: string[]; skipped: string[]; notes: string[] }> {
  const moved: string[] = [];
  const skipped: string[] = [];
  const notes: string[] = [];

  for (const { file: flatFile, ws } of await loadWorkspaceFilesFromDir(paths.workspaces)) {
    try {
      const dir = await ensureWorkspaceDir(paths, ws);
      const configDir = configDirFor(paths, ws);
      await mkdir(configDir, { recursive: true });
      const settings = settingsPathFor(configDir);
      const before = await probeSettings(settings);

      if (before.kind === "corrupt") {
        skipped.push(ws.name);
        notes.push(
          `[workspace-migration] ${settings} exists but is not a valid record — leaving ${flatFile} in place; ` +
            `fix or delete ${settings} so this migration can regenerate it from ${flatFile}; ` +
            `until then this warns on every boot`,
        );
        continue;
      }

      // Only the WRITE case (settings.json created fresh from this flat
      // record) is a genuine relocation; the byte-identical-duplicate case
      // is a no-op consumption of a stale copy. Neither is reported until
      // registration and removal below actually succeed — pushing here and
      // pushing again from the catch block on a later failure would land
      // the same name in both `moved` and `skipped`, and server.ts's boot
      // log treats `moved` as the positive signal a completed relocation
      // actually happened.
      let wasWritten: boolean;
      if (before.kind === "missing") {
        await writeFile(settings, `${JSON.stringify(ws, null, 2)}\n`);
        const after = await probeSettings(settings);
        if (after.kind !== "parsed") {
          // The write didn't take, or produced something unreadable — same
          // rule applies: no confirmed replacement on disk, no deletion.
          skipped.push(ws.name);
          notes.push(`[workspace-migration] ${settings} did not verify after writing — leaving ${flatFile} in place`);
          continue;
        }
        wasWritten = true;
      } else if (before.value.name !== ws.name) {
        // Validates fine, but it is someone else's record — two names
        // slugged to this same directory and the other one got here first.
        skipped.push(ws.name);
        notes.push(
          `[workspace-migration] ${settings} already holds workspace "${before.value.name}" — ` +
            `refusing to remove ${flatFile} for "${ws.name}" (both slug to ${configDir}); ` +
            `rename one of them so they no longer collide; until then this warns on every boot`,
        );
        continue;
      } else if (!isDeepStrictEqual(before.value, ws)) {
        // Same name, but different content — a distinct record that merely
        // shares a name with whatever migrated here first.
        skipped.push(ws.name);
        notes.push(
          `[workspace-migration] two different records are both named "${ws.name}": ${settings} and ${flatFile} — ` +
            `compare them and delete the stale one; until then this warns on every boot`,
        );
        continue;
      } else {
        // Same name, identical content — a byte-for-byte duplicate of what's
        // already migrated. Safe to drop.
        wasWritten = false;
      }

      // A valid settings.json for this exact record is confirmed on disk —
      // safe to register the directory and drop the now-stale flat copy.
      // The registry file (workspaces.json) is a SEPARATE file from anything
      // named above; if it is what fails to parse or write, the error must
      // say so — blaming ${flatFile} would send a human fixing the wrong file.
      try {
        await saveRegistryEntry(paths, ws.name, dir);
      } catch (err) {
        skipped.push(ws.name);
        notes.push(
          `[workspace-migration] could not register "${ws.name}" — ${registryPath(paths)}: ${(err as Error).message}; ` +
            `fix ${registryPath(paths)} (or the underlying I/O problem) and this will resolve on the next boot`,
        );
        continue;
      }
      await rm(flatFile, { force: true });
      if (wasWritten) moved.push(ws.name);
      else skipped.push(ws.name);
    } catch (err) {
      skipped.push(ws.name);
      notes.push(
        `[workspace-migration] skipping "${ws.name}" (${flatFile}) — ${(err as Error).message}; ` +
          `fix the underlying problem and this will resolve on the next boot`,
      );
    }
  }
  return { moved, skipped, notes };
}

const run = promisify(execFile);

/**
 * Whether `workspaces/<slug>/settings.json` is present in the org repo's
 * HEAD — the authority for "this workspace has actually been imported",
 * as opposed to "a file happens to sit at its target path". `ensureOrgRepo`
 * always leaves at least one (possibly empty) commit, so HEAD always
 * resolves by the time this is called; a non-existent path under a valid
 * HEAD is simply a non-zero exit, not a thrown error about a missing ref.
 */
async function importedInOrgRepo(paths: SmithPaths, slug: string): Promise<boolean> {
  try {
    await run("git", ["cat-file", "-e", `HEAD:workspaces/${slug}/settings.json`], { cwd: paths.orgRepo });
    return true;
  } catch {
    return false;
  }
}

/**
 * ONE-WAY migration (spec 2026-08-22 §9.2): each workspace's own `config/`
 * git repo becomes the `workspaces/<slug>/` subtree of the org repo.
 *
 * Reads the legacy location by its literal name — after the cutover no other
 * code knows `<dir>/config` ever existed — and writes through
 * `configDirForName`, so this is the one place both layouts meet.
 *
 * Copy, verify, commit, THEN archive: the legacy repo is renamed to
 * `config-archived-<stamp>` beside the workspace only after its content is
 * verified readable in the subtree and in the org repo's HEAD. Nothing is
 * ever deleted. History is not rewritten into the org repo — a single-user
 * install has a handful of "Update workspace config" commits, and a
 * filter-repo pass is not worth its risk; the archived repo keeps it.
 *
 * Idempotent: an already-imported workspace is skipped. A legacy copy found
 * beside an imported subtree (restored from a backup) is archived, never
 * re-imported — the subtree is where writes have been landing, so it is the
 * newer one. A registered workspace with config in neither place is noted:
 * that install would otherwise boot owning a workspace it cannot load.
 *
 * "Already imported" is asked of git, not the filesystem: a bare `exists()`
 * on `target/settings.json` would be fooled by an uncommitted partial copy
 * left behind by a run that failed after `cp` but before the commit — the
 * very next boot would then read that leftover as proof of a completed
 * import and archive the still-broken legacy source out from under it.
 * `importedInOrgRepo` instead asks whether the path is in the org repo's
 * HEAD, which is only ever true once `commitConfigFiles` has actually
 * succeeded.
 *
 * One workspace's failure never stops the others — this runs at boot.
 */
export async function migrateConfigIntoOrgRepo(
  paths: SmithPaths,
  stamp: string,
): Promise<{ imported: string[]; notes: string[] }> {
  const imported: string[] = [];
  const notes: string[] = [];

  for (const [name, dir] of Object.entries(await loadRegistry(paths))) {
    try {
      const legacy = join(dir, "config");
      const target = configDirForName(paths, name);
      const slug = slugForDir(name);
      const hasLegacy = await exists(join(legacy, "settings.json"));

      if (await importedInOrgRepo(paths, slug)) {
        if (hasLegacy) {
          const archived = `${legacy}-archived-${stamp}`;
          await rename(legacy, archived);
          notes.push(`[org-migration] ${name}: already imported — archived a stale legacy config at ${archived}`);
        }
        continue;
      }
      if (!hasLegacy) {
        notes.push(
          `[org-migration] ${name}: no settings.json at ${legacy} or ${target} — the workspace is registered but has ` +
            `no config anywhere; re-create it, or remove it from ${registryPath(paths)}`,
        );
        continue;
      }

      await mkdir(target, { recursive: true });
      // The legacy repo's own .git must not come along: the subtree belongs to
      // the ORG repo's history from here on, and a nested .git would make git
      // treat the subtree as an embedded repository and refuse to track it.
      await cp(legacy, target, { recursive: true, filter: (src) => basename(src) !== ".git" });

      const probe = await probeSettings(join(target, "settings.json"));
      if (probe.kind !== "parsed") {
        // This removes the COPY, never the legacy source — "nothing is ever
        // deleted" still holds for the one copy of this data that actually
        // exists. A copy left behind here would sit uncommitted at `target`
        // forever: invisible, and — since `importedInOrgRepo` now only
        // trusts HEAD — no longer even able to fake a completed import, but
        // still clutter a retry has no reason to carry.
        await rm(target, { recursive: true, force: true });
        notes.push(
          `[org-migration] ${name}: copied config does not verify at ${join(target, "settings.json")} — ` +
            `leaving ${legacy} in place; fix the record so this can complete`,
        );
        continue;
      }
      try {
        await commitConfigFiles(paths, slug, { message: `Import workspace ${slug}` });
      } catch (err) {
        // Same reasoning as the probe-failure branch: nothing reached HEAD,
        // so the copy at `target` must not survive to be mistaken for a
        // completed import on the next run.
        await rm(target, { recursive: true, force: true });
        throw err;
      }
      await rename(legacy, `${legacy}-archived-${stamp}`);
      imported.push(name);
    } catch (err) {
      notes.push(`[org-migration] ${name}: could not be imported — ${(err as Error).message}`);
    }
  }
  return { imported, notes };
}
