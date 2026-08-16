// Every `.smith` state path, resolved once from a single root.
//
// server.ts previously built these inline as `resolve(process.cwd(), ".smith/x")`
// at 91 call sites. That idiom has two defects: it re-derives the root on every
// call, and it can only ever name ONE location — so a process serving several
// workspaces has no way to say which one it means. Naming the paths here makes
// the root a parameter instead of an ambient fact.
//
// This module does NOT decide where the root is. Callers pass it in.
import { join } from "node:path";

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
  return Object.freeze({
    root,
    users: join(root, "users"),
    workspaces: join(root, "workspaces"),
    agents: join(root, "agents"),
    cliTools: join(root, "cli-tools.json"),
    apiKeys: join(root, "api-keys.json"),
    containers: join(root, "containers.json"),
    devices: join(root, "devices.json"),
    channels: join(root, "channels"),
    avatars: join(root, "avatars"),
    sessions: join(root, "sessions"),
    apiSessions: join(root, "api-sessions"),
    work: join(root, "work"),
    workCapabilities: join(root, "work", "capabilities"),
    squads: join(root, "squads"),
    groups: join(root, "groups"),
    legacyProjectFile: join(root, "project.json"),
    legacyProjectsDir: join(root, "projects"),
    archived(kind: ArchivableKind, stamp: string): string {
      return join(root, `${kind}-archived-${stamp}`);
    },
  });
}
