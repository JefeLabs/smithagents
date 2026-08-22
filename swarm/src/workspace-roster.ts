import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Which GLOBAL agents and squads this workspace uses. Definitions live at the
 * host root (§4.1: definitions are global, assignments are per workspace);
 * this records only the assignment.
 */
export interface WorkspaceRoster {
  agents: string[];
  squads: string[];
}

/** A workspace's roster, inside its org-repo subtree (`configDirFor`). */
export function rosterPathFor(configDir: string): string {
  return join(configDir, "roster.json");
}

function assertRoster(file: string, value: unknown): WorkspaceRoster {
  const o = value as Partial<WorkspaceRoster> | null;
  const ok =
    o &&
    typeof o === "object" &&
    Array.isArray(o.agents) &&
    Array.isArray(o.squads) &&
    o.agents.every((a) => typeof a === "string") &&
    o.squads.every((s) => typeof s === "string");
  if (!ok) throw new Error(`Invalid roster file ${file}: requires agents[] and squads[] of strings`);
  return o as WorkspaceRoster;
}

/**
 * This workspace's roster, or `null` if it has never had one.
 *
 * The absent/empty distinction is load-bearing and callers must respect it:
 * `null` means "not recorded, every global agent applies" — today's behaviour —
 * while `{agents: [], squads: []}` means someone deliberately assigned nothing.
 * Collapsing them would turn a missing file into a workspace with no agents.
 *
 * A malformed roster THROWS. Returning null on a parse failure would make a
 * corrupt file indistinguishable from a workspace that never had a roster.
 */
export async function loadRoster(configDir: string): Promise<WorkspaceRoster | null> {
  const file = rosterPathFor(configDir);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid roster file ${file}: not valid JSON — ${(err as Error).message}`);
  }
  return assertRoster(file, parsed);
}

export async function saveRoster(configDir: string, roster: WorkspaceRoster): Promise<void> {
  const file = rosterPathFor(configDir);
  await mkdir(configDir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(roster, null, 2)}\n`);
  await rename(tmp, file);
}
