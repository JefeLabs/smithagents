// ONE-WAY migration (spec 2026-08-22 §9.3): the broker's legacy JSON
// documents become files in the swarm's org repo. The broker owns this
// because the directory is relative to ITS cwd and because session
// artifacts (`sessions/*.json` → `artifacts: [docId]`) must be remapped to
// the new ids at the same time. Archive, never delete; idempotent; a
// failure leaves the directory in place so the next boot retries.
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GROUP_PIN_PREFIX } from "./pins.ts";

export interface ImportClient {
  importDocument(workspace: string, doc: unknown): Promise<{ id: string }>;
}

interface LegacyShape {
  id: string;
  pins?: string[];
}

/** The workspace a legacy doc belongs to: its first bare pin naming an active workspace, else the default. */
function targetWorkspace(
  doc: LegacyShape,
  workspaces: Array<{ name: string; default?: boolean; archived?: boolean }>,
): string | null {
  const active = workspaces.filter((w) => !w.archived);
  for (const pin of doc.pins ?? []) {
    if (pin.startsWith(GROUP_PIN_PREFIX)) continue;
    if (active.some((w) => w.name === pin)) return pin;
  }
  return (active.find((w) => w.default) ?? active[0])?.name ?? null;
}

/**
 * A 409 from the import route carries the id it was already imported as
 * (`already imported as <id>`); `SwarmClient.http()` puts the status on the
 * error. This reads the message text — not just the status — because the
 * response has no structured id field; the id has to come from somewhere.
 * Do not "simplify" this into a bare `status === 409` check: without the
 * parsed id there is nothing to remap the sessions to.
 */
function alreadyImportedId(err: unknown): string | null {
  const e = err as { status?: number; message?: string };
  if (e.status !== 409) return null;
  const m = /already imported as (\S+)/.exec(e.message ?? "");
  return m ? m[1] : null;
}

/** A 400 means the swarm looked at this document and refused it for good — retrying it unchanged will never succeed. */
function permanentFailureReason(err: unknown): string | null {
  const e = err as { status?: number; message?: string };
  if (e.status !== 400) return null;
  return e.message || "the swarm rejected this document (400)";
}

/** Moves one permanently-unimportable file out of the way, never deleting it. */
async function setAside(documentsDir: string, stamp: string, file: string): Promise<string> {
  const dir = `${documentsDir}-unimportable-${stamp}`;
  await mkdir(dir, { recursive: true });
  await rename(join(documentsDir, file), join(dir, file));
  return dir;
}

export async function importLegacyDocuments(opts: {
  documentsDir: string;
  sessionsDir: string;
  stamp: string;
  /** Already resolved by the caller (main.ts's own `.catch`-guarded boot fetch) — this function makes no network round-trip of its own. */
  workspaces: Array<{ name: string; default?: boolean; archived?: boolean }>;
  client: ImportClient;
  log: (line: string) => void;
}): Promise<{ imported: Array<{ from: string; to: string }>; notes: string[] }> {
  const imported: Array<{ from: string; to: string }> = [];
  const notes: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(opts.documentsDir);
  } catch {
    return { imported, notes };
  }
  const files = entries.filter((f) => /^d\d+\.json$/.test(f)).sort();
  for (const f of entries) {
    if (f.endsWith(".json") && !/^d\d+\.json$/.test(f)) {
      notes.push(
        `[documents-import] ${f}: not a legacy document filename (expected d<N>.json) — left in place, not imported`,
      );
    }
  }
  if (files.length === 0) return { imported, notes };

  const idMap = new Map<string, string>();
  let allDone = true;
  for (const file of files) {
    try {
      const doc = JSON.parse(await readFile(join(opts.documentsDir, file), "utf8")) as LegacyShape;
      const ws = targetWorkspace(doc, opts.workspaces);
      if (!ws) throw new Error("no active workspace to import into");
      let to: string;
      try {
        to = (await opts.client.importDocument(ws, doc)).id;
      } catch (err) {
        const permanent = permanentFailureReason(err);
        if (permanent) {
          const sidecar = await setAside(opts.documentsDir, opts.stamp, file);
          const note = `[documents-import] UNIMPORTABLE: ${file} — ${permanent}; moved to ${sidecar}/ for manual review`;
          notes.push(note);
          opts.log(note);
          continue; // resolved by moving it aside — does not block the rest of this run
        }
        const existing = alreadyImportedId(err);
        if (!existing) throw err;
        to = existing;
      }
      if ([...idMap.values()].includes(to)) {
        // Two legacy files derived the same target (a filename collision, not
        // a genuine cross-boot re-import — idMap only holds THIS run's
        // entries). The winner already has `to`; this file's own content
        // never reached the store separately, so it must not be reported as
        // imported nor remapped to someone else's document.
        allDone = false;
        notes.push(
          `[documents-import] ${file}: already imported as ${to}, which this run already used for another document — a filename collision; will retry next boot`,
        );
        continue;
      }
      idMap.set(doc.id, to);
      imported.push({ from: doc.id, to });
      opts.log(`[documents-import] ${doc.id} → ${ws}/${to}`);
    } catch (err) {
      allDone = false;
      notes.push(`[documents-import] ${file}: not imported — ${(err as Error).message}; will retry next boot`);
    }
  }

  // Remap whatever DID import, even if something else failed: a session that
  // points at an old id would otherwise show a hole until the retry succeeds.
  const remapNotes = await remapSessionArtifacts(opts.sessionsDir, idMap);
  if (remapNotes.length > 0) {
    notes.push(...remapNotes);
    allDone = false;
  }

  if (allDone) {
    // Not wrapped in try/catch on purpose: a rename failure here (ENOTEMPTY
    // reproduced against a pre-existing target) must reject this call so the
    // caller's own guard (main.ts wraps this whole call in `.catch`) is what
    // keeps the broker up — imports and session remaps above already landed
    // on disk regardless, so nothing is lost, only the archive step retries.
    await rename(opts.documentsDir, `${opts.documentsDir}-archived-${opts.stamp}`);
    opts.log(`[documents-import] archived ${opts.documentsDir} → ${opts.documentsDir}-archived-${opts.stamp}`);
  }
  return { imported, notes };
}

async function remapSessionArtifacts(sessionsDir: string, idMap: Map<string, string>): Promise<string[]> {
  const notes: string[] = [];
  if (idMap.size === 0) return notes;
  let files: string[];
  try {
    files = (await readdir(sessionsDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return notes;
  }
  for (const f of files) {
    const path = join(sessionsDir, f);
    let s: { artifacts?: string[] };
    try {
      s = JSON.parse(await readFile(path, "utf8")) as { artifacts?: string[] };
    } catch {
      continue; // a session file that does not parse is not this migration's to fix
    }
    if (!Array.isArray(s.artifacts)) continue;
    const next = s.artifacts.map((id) => idMap.get(id) ?? id);
    if (!next.some((id, i) => id !== s.artifacts?.[i])) continue;
    try {
      await writeFile(path, `${JSON.stringify({ ...s, artifacts: next }, null, 2)}\n`);
    } catch (err) {
      notes.push(`[documents-import] ${f}: artifacts not remapped — ${(err as Error).message}; will retry next boot`);
    }
  }
  return notes;
}
