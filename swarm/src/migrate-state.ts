// One-time copy of a legacy state root into the current one.
//
// COPY, never move. The source stays intact so rollback is "point the root
// back" rather than "restore from a backup you may not have" — this install
// lost boards and documents to an irreversible reset once already.
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Never migrated. `worktrees` holds live session working directories: tmux
 * processes hold them as cwd and git has registered them at absolute paths, so
 * a copy produces two divergent trees and a move breaks both. Existing sessions
 * keep the old location; new ones are created under the new root. `logs` is
 * append-only diagnostics with no value in a new root.
 */
export const SKIPPED_ENTRIES: readonly string[] = ["worktrees", "logs"];

/** Candidate legacy roots, most likely first. */
export function legacyStateRoots(cwd: string): string[] {
  return [resolve(cwd, ".smith"), resolve(cwd, "swarm", ".smith")];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The legacy root to migrate from, or null when nothing should happen —
 * either the target already holds state, or no candidate source exists.
 */
export async function needsMigration(to: string, candidates: string[]): Promise<string | null> {
  let targetEntries: string[] = [];
  try {
    targetEntries = await readdir(to);
  } catch {
    targetEntries = []; // absent target is an empty one
  }
  if (targetEntries.length > 0) return null;

  for (const candidate of candidates) {
    if (!(await exists(candidate))) continue;
    const entries = (await readdir(candidate)).filter((e) => !SKIPPED_ENTRIES.includes(e));
    if (entries.length > 0) return candidate;
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
    if (await exists(join(to, entry))) collisions.push(entry);
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
