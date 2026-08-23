// ONE-WAY migration (spec 2026-08-22 §9.3): the broker's legacy JSON
// documents become files in the swarm's org repo. The broker owns this
// because the directory is relative to ITS cwd and because session
// artifacts (`sessions/*.json` → `artifacts: [docId]`) must be remapped to
// the new ids at the same time. Archive, never delete; idempotent; a
// failure leaves the directory in place so the next boot retries.
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GROUP_PIN_PREFIX } from "./pins.ts";

export interface ImportClient {
  importDocument(workspace: string, doc: unknown): Promise<{ id: string }>;
  listWorkspaces(): Promise<Array<{ name: string; default?: boolean; archived?: boolean }>>;
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

/** A 409 from the import route carries the id it was already imported as (`already imported as <id>`); `SwarmClient.http()` puts the status on the error. */
function alreadyImportedId(err: unknown): string | null {
  const e = err as { status?: number; message?: string };
  if (e.status !== 409) return null;
  const m = /already imported as (\S+)/.exec(e.message ?? "");
  return m ? m[1] : null;
}

export async function importLegacyDocuments(opts: {
  documentsDir: string;
  sessionsDir: string;
  stamp: string;
  client: ImportClient;
  log: (line: string) => void;
}): Promise<{ imported: Array<{ from: string; to: string }>; notes: string[] }> {
  const imported: Array<{ from: string; to: string }> = [];
  const notes: string[] = [];
  let files: string[];
  try {
    files = (await readdir(opts.documentsDir)).filter((f) => /^d\d+\.json$/.test(f)).sort();
  } catch {
    return { imported, notes };
  }
  if (files.length === 0) return { imported, notes };

  const workspaces = await opts.client.listWorkspaces();
  const idMap = new Map<string, string>();
  let allDone = true;
  for (const file of files) {
    try {
      const doc = JSON.parse(await readFile(join(opts.documentsDir, file), "utf8")) as LegacyShape;
      const ws = targetWorkspace(doc, workspaces);
      if (!ws) throw new Error("no active workspace to import into");
      let to: string;
      try {
        to = (await opts.client.importDocument(ws, doc)).id;
      } catch (err) {
        const existing = alreadyImportedId(err);
        if (!existing) throw err;
        to = existing;
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
  await remapSessionArtifacts(opts.sessionsDir, idMap);

  if (allDone) {
    await rename(opts.documentsDir, `${opts.documentsDir}-archived-${opts.stamp}`);
    opts.log(`[documents-import] archived ${opts.documentsDir} → ${opts.documentsDir}-archived-${opts.stamp}`);
  }
  return { imported, notes };
}

async function remapSessionArtifacts(sessionsDir: string, idMap: Map<string, string>): Promise<void> {
  if (idMap.size === 0) return;
  let files: string[];
  try {
    files = (await readdir(sessionsDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  for (const f of files) {
    const path = join(sessionsDir, f);
    try {
      const s = JSON.parse(await readFile(path, "utf8")) as { artifacts?: string[] };
      if (!Array.isArray(s.artifacts)) continue;
      const next = s.artifacts.map((id) => idMap.get(id) ?? id);
      if (next.some((id, i) => id !== s.artifacts?.[i])) {
        await writeFile(path, `${JSON.stringify({ ...s, artifacts: next }, null, 2)}\n`);
      }
    } catch {
      /* a session file that does not parse is not this migration's to fix */
    }
  }
}
