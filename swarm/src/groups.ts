// Workspace groups — nested, named sets of workspaces and other groups.
// One JSON file per group under .smith/groups/, mirroring workspaces.ts.
// Spec: docs/superpowers/specs/2026-08-11-workspace-groups-design.md
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Workspace } from "./workspaces.js";

export interface WorkspaceGroup {
  name: string;
  description?: string;
  workspaces: string[];
  groups: string[];
  /** Optional identity colour; the UI falls back to a hash of `name`. */
  color?: string;
}

export function assertGroup(file: string, v: unknown): WorkspaceGroup {
  const o = v as Partial<WorkspaceGroup>;
  const ok =
    o &&
    typeof o.name === "string" &&
    o.name.length > 0 &&
    Array.isArray(o.workspaces) &&
    o.workspaces.every((w) => typeof w === "string") &&
    Array.isArray(o.groups) &&
    o.groups.every((n) => typeof n === "string");
  if (!ok) throw new Error(`Invalid group file ${file}: requires name, workspaces[], groups[]`);
  return o as WorkspaceGroup;
}

/** Load every *.json in `dir` as a WorkspaceGroup. Throws (naming the file) on malformed input. */
export async function loadGroupsFromDir(dir: string): Promise<WorkspaceGroup[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const groups: WorkspaceGroup[] = [];
  for (const file of entries.filter((f) => f.endsWith(".json"))) {
    groups.push(assertGroup(file, JSON.parse(await readFile(join(dir, file), "utf8"))));
  }
  return groups;
}

/**
 * Transitive member WORKSPACES of a group. Cycle-safe (visited set); missing
 * members and archived workspaces are skipped silently — a dangling reference
 * is stale data, not an error (delete does not cascade).
 */
export function expandGroup(name: string, all: WorkspaceGroup[], workspaces: Workspace[]): Set<string> {
  const active = new Set(workspaces.filter((w) => !w.archived).map((w) => w.name));
  const byName = new Map(all.map((grp) => [grp.name, grp]));
  const out = new Set<string>();
  const visited = new Set<string>();
  const walk = (n: string) => {
    if (visited.has(n)) return;
    visited.add(n);
    const grp = byName.get(n);
    if (!grp) return;
    for (const w of grp.workspaces) if (active.has(w)) out.add(w);
    for (const child of grp.groups) walk(child);
  };
  walk(name);
  return out;
}

/** True if saving `candidate` would let it reach itself through `all` (which may contain its old version). */
export function wouldCycle(candidate: WorkspaceGroup, all: WorkspaceGroup[]): boolean {
  const byName = new Map(all.filter((grp) => grp.name !== candidate.name).map((grp) => [grp.name, grp]));
  byName.set(candidate.name, candidate);
  const visited = new Set<string>();
  const reaches = (n: string): boolean => {
    if (visited.has(n)) return false;
    visited.add(n);
    const grp = byName.get(n);
    if (!grp) return false;
    for (const child of grp.groups) {
      if (child === candidate.name || reaches(child)) return true;
    }
    return false;
  };
  return reaches(candidate.name);
}
