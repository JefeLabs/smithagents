// One-time copy of a legacy state root into the current one.
//
// COPY, never move. The source stays intact so rollback is "point the root
// back" rather than "restore from a backup you may not have" — this install
// lost boards and documents to an irreversible reset once already.
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SmithPaths } from "./paths.js";
import { loadBoards } from "./work-items.js";
import { saveRegistryEntry } from "./workspace-registry.js";
import {
  assertContext,
  ensureWorkspaceDir,
  loadWorkspaceFilesFromDir,
  settingsPathFor,
  type Workspace,
  workspaceDir,
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
    const targetDir = join(workspaceDir(paths, ws), "config", "boards");
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

type SettingsProbe = { kind: "missing" } | { kind: "corrupt" } | { kind: "parsed"; value: Workspace };

/**
 * `stat` proves a file exists, not that it holds a complete record —
 * `saveWorkspace`'s `writeFile` is not atomic, so a crash mid-write leaves a
 * settings.json that exists but is truncated garbage. Distinguish "nothing
 * written yet" from "something unreadable was written" so callers can decide
 * per case instead of treating both as "already migrated".
 *
 * "Unreadable" includes parses-as-JSON-but-fails-validation, not just
 * malformed JSON: `assertContext` is what actually decides whether a record
 * is usable, so a bare `JSON.parse` alone would let something like
 * `{"name":"pg"}` (missing `repos`) through as "parsed" — trusting that is
 * how one hand-edited settings.json turns into `loadWorkspaces()` throwing
 * for the whole install on the next boot, after the flat backup that could
 * have fixed it is already gone.
 *
 * The validated value is returned too, so a caller can confirm the record
 * belongs to the workspace it thinks it does — two names can slug to the
 * same directory (`assertContext` does not enforce `saveWorkspace`'s name
 * format, so legacy data can carry names like "Foo" and "foo" that only
 * differ by case), and a settings.json that merely validates is not proof it
 * is *this* workspace's.
 */
async function probeSettings(settings: string): Promise<SettingsProbe> {
  let raw: string;
  try {
    raw = await readFile(settings, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { kind: "missing" };
  }
  try {
    return { kind: "parsed", value: assertContext(settings, JSON.parse(raw)) };
  } catch {
    return { kind: "corrupt" };
  }
}

/**
 * Move each flat workspace record into its own directory as config/settings.json
 * and register the directory. Write first, verify it reads back and validates,
 * then remove the flat file — a record is never in neither place, and the flat
 * copy is never deleted on the strength of a destination that merely *exists*.
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
 * same directory. Whichever name claims the directory first wins it; the
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
      const settings = settingsPathFor(dir);
      const before = await probeSettings(settings);

      if (before.kind === "corrupt") {
        skipped.push(ws.name);
        notes.push(`[workspace-migration] ${settings} exists but is not a valid record — leaving ${flatFile} in place`);
        continue;
      }

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
        moved.push(ws.name);
      } else if (before.value.name !== ws.name) {
        // Validates fine, but it is someone else's record — two names
        // slugged to this same directory and the other one got here first.
        skipped.push(ws.name);
        notes.push(
          `[workspace-migration] ${settings} already holds workspace "${before.value.name}" — ` +
            `refusing to remove ${flatFile} for "${ws.name}" (both slug to ${dir})`,
        );
        continue;
      } else if (!isDeepStrictEqual(before.value, ws)) {
        // Same name, but different content — a distinct record that merely
        // shares a name with whatever migrated here first.
        skipped.push(ws.name);
        notes.push(
          `[workspace-migration] ${settings} holds a different "${ws.name}" record than ${flatFile} — ` +
            `leaving ${flatFile} in place`,
        );
        continue;
      } else {
        // Same name, identical content — a byte-for-byte duplicate of what's
        // already migrated. Safe to drop.
        skipped.push(ws.name);
      }

      // A valid settings.json for this exact record is confirmed on disk —
      // safe to register the directory and drop the now-stale flat copy.
      await saveRegistryEntry(paths, ws.name, dir);
      await rm(flatFile, { force: true });
    } catch (err) {
      skipped.push(ws.name);
      notes.push(`[workspace-migration] skipping "${ws.name}" (${flatFile}) — ${(err as Error).message}`);
    }
  }
  return { moved, skipped, notes };
}
