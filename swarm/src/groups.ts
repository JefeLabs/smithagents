// Workspace groups — VIEWS over the one context store (spec 2026-08-13,
// one-context-entity): a group is a workspace record whose `members` field is
// present. This module keeps the GroupT wire shape (name + split
// workspaces[]/groups[] + expansion) byte-compatible for the broker and the
// control plane while the storage is .smith/workspaces/ alone.
// Prior art: docs/superpowers/specs/2026-08-11-workspace-groups-design.md
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SmithPaths } from "./paths.js";
import { isGroupRecord, loadAllContexts, loadAllContextsFromDir, type Workspace } from "./workspaces.js";

export interface WorkspaceGroup {
  name: string;
  description?: string;
  workspaces: string[];
  groups: string[];
  /** Optional identity colour; the UI falls back to a hash of `name`. */
  color?: string;
  /** Opt-in sprint definition (date-range spec 2026-08-12) — absent means this context has no sprints. */
  sprint?: { anchor: string; lengthDays: number };
}

/** Shared with workspaces.ts's assert: an opt-in sprint block, valid or absent — never half-checked. */
export function validSprint(v: unknown): boolean {
  if (v === undefined) return true;
  const s = v as { anchor?: unknown; lengthDays?: unknown };
  return (
    typeof s === "object" &&
    s !== null &&
    typeof s.anchor === "string" &&
    !Number.isNaN(new Date(s.anchor).getTime()) &&
    typeof s.lengthDays === "number" &&
    Number.isInteger(s.lengthDays) &&
    s.lengthDays > 0
  );
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
    o.groups.every((n) => typeof n === "string") &&
    validSprint(o.sprint);
  if (!ok)
    throw new Error(`Invalid group file ${file}: requires name, workspaces[], groups[] (and a valid sprint if given)`);
  return o as WorkspaceGroup;
}

/**
 * The GroupT views over the one store: each groupish record's members split
 * into `workspaces`/`groups` by looking at what each MEMBER'S record is —
 * kind is derived, never stored twice. A dangling member name lists under
 * `workspaces` (visible beats vanished; expansion skips it anyway).
 */
export function groupViewsFrom(all: Workspace[]): WorkspaceGroup[] {
  const groupish = new Set(all.filter(isGroupRecord).map((w) => w.name));
  return all.filter(isGroupRecord).map((w) => ({
    name: w.name,
    description: w.description,
    workspaces: (w.members ?? []).filter((m) => !groupish.has(m)),
    groups: (w.members ?? []).filter((m) => groupish.has(m)),
    color: w.color,
    sprint: w.sprint,
  }));
}

/** Group views from the ONE context store — `dir` is .smith/workspaces now. */
export async function loadGroupsFromDir(dir: string): Promise<WorkspaceGroup[]> {
  return groupViewsFrom(await loadAllContextsFromDir(dir));
}

/**
 * Write one group into the ONE store: a workspace record whose `members` is
 * the union of the view's workspaces + groups (order preserved). Groupish
 * records carry only the context-identity fields, so a wholesale rewrite
 * loses nothing.
 */
export async function saveGroup(dir: string, group: WorkspaceGroup): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(group.name)) {
    throw new Error(`Invalid group name "${group.name}": use lowercase letters, digits and dashes`);
  }
  const record: Workspace = {
    name: group.name,
    description: group.description,
    repos: [],
    color: group.color,
    sprint: group.sprint,
    members: [...group.workspaces, ...group.groups],
  };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${group.name}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

/** Delete a GROUP record. Refuses plain workspaces — those belong to the workspace routes. */
export async function removeGroupFile(dir: string, name: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(join(dir, `${name}.json`), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Group "${name}" not found`);
    }
    throw error;
  }
  const record = JSON.parse(raw) as Workspace;
  if (!isGroupRecord(record)) {
    throw new Error(`"${name}" is a workspace, not a group`);
  }
  await rm(join(dir, `${name}.json`));
}

/**
 * ONE-WAY boot migration (spec 2026-08-13): every legacy .smith/groups/*.json
 * becomes a `members` record in the one store; a name collision with an
 * existing context renames the migrated group `<name>-group`; the legacy dir
 * is retired as `<dir>.migrated`. Returns human-readable log lines — the
 * caller prints them, because a silent migration is a mystery later.
 *
 * `taken` is the ONE NAMESPACE — every context name already in use — so it
 * must come from loadAllContexts, not loadAllContextsFromDir. A workspace
 * that has migrated to its own config/settings.json is invisible to the flat
 * directory alone; missing it here would let a legacy group silently reuse
 * that workspace's name instead of renaming.
 */
export async function migrateGroupsDir(paths: SmithPaths): Promise<string[]> {
  const groupsDir = paths.groups;
  const workspacesDir = paths.workspaces;
  let entries: string[];
  try {
    entries = await readdir(groupsDir);
  } catch {
    return []; // nothing to migrate — the common case forever after
  }
  const log: string[] = [];
  const taken = new Set((await loadAllContexts(paths)).map((w) => w.name));
  for (const file of entries.filter((f) => f.endsWith(".json"))) {
    const legacy = assertGroup(file, JSON.parse(await readFile(join(groupsDir, file), "utf8")));
    let name = legacy.name;
    if (taken.has(name)) {
      name = `${name}-group`;
      log.push(`[groups-migration] "${legacy.name}" collides with an existing context — renamed to "${name}"`);
    }
    await saveGroup(workspacesDir, { ...legacy, name });
    taken.add(name);
    log.push(
      `[groups-migration] ${file} → workspaces/${name}.json (members: ${legacy.workspaces.length + legacy.groups.length})`,
    );
  }
  await rename(groupsDir, `${groupsDir}.migrated`);
  log.push(`[groups-migration] retired ${groupsDir} → ${groupsDir}.migrated`);
  return log;
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
