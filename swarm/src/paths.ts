// Every `.smith` state path, resolved once from a single root.
//
// server.ts previously built these inline, resolving process.cwd() against a
// ".smith/x" suffix, at 91 call sites. That idiom has two defects: it
// re-derives the root on every call, and it can only ever name ONE location —
// so a process serving several workspaces has no way to say which one it
// means. Naming the paths here makes the root a parameter instead of an
// ambient fact.
//
// This module does NOT decide where the root is. Callers pass it in.
import { join, resolve } from "node:path";

/** Directories that get archived to a timestamped sibling rather than deleted. */
export type ArchivableKind = "work" | "squads" | "avatars" | "agents";

export interface SmithPaths {
  readonly root: string;
  readonly users: string;
  readonly workspaces: string;
  readonly agents: string;
  readonly cliTools: string;
  readonly apiKeys: string;
  readonly containers: string;
  readonly devices: string;
  readonly channels: string;
  readonly avatars: string;
  readonly sessions: string;
  readonly apiSessions: string;
  readonly work: string;
  readonly workCapabilities: string;
  readonly squads: string;
  readonly groups: string;
  /** Legacy markers: present only to warn that projects were replaced by workspaces. */
  readonly legacyProjectFile: string;
  readonly legacyProjectsDir: string;
  /** Timestamped archive sibling, e.g. work-archived-20260816T120000. */
  archived(kind: ArchivableKind, stamp: string): string;
}

export function smithPaths(root: string): SmithPaths {
  // Callers are not guaranteed to pass an absolute root (see config.ts's
  // override spread, which can hand back the caller's raw relative string).
  // Resolving once here, rather than trusting the argument, keeps every
  // member — and any caller who joins further onto `.root` — anchored to
  // the same location instead of splitting against the process's cwd.
  const resolvedRoot = resolve(root);
  return Object.freeze({
    root: resolvedRoot,
    users: join(resolvedRoot, "users"),
    workspaces: join(resolvedRoot, "workspaces"),
    agents: join(resolvedRoot, "agents"),
    cliTools: join(resolvedRoot, "cli-tools.json"),
    apiKeys: join(resolvedRoot, "api-keys.json"),
    containers: join(resolvedRoot, "containers.json"),
    devices: join(resolvedRoot, "devices.json"),
    channels: join(resolvedRoot, "channels"),
    avatars: join(resolvedRoot, "avatars"),
    sessions: join(resolvedRoot, "sessions"),
    apiSessions: join(resolvedRoot, "api-sessions"),
    work: join(resolvedRoot, "work"),
    workCapabilities: join(resolvedRoot, "work", "capabilities"),
    squads: join(resolvedRoot, "squads"),
    groups: join(resolvedRoot, "groups"),
    legacyProjectFile: join(resolvedRoot, "project.json"),
    legacyProjectsDir: join(resolvedRoot, "projects"),
    archived(kind: ArchivableKind, stamp: string): string {
      return join(resolvedRoot, `${kind}-archived-${stamp}`);
    },
  });
}
