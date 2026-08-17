import { join } from "node:path";

/** Ephemeral instances live in the workspace's unversioned half (spec §1.2). */
export function instancesDir(workspaceDir: string): string {
  return join(workspaceDir, ".runtime", "instances");
}

/** One instance's directory. */
export function instanceDir(workspaceDir: string, workId: string): string {
  return join(instancesDir(workspaceDir), workId);
}

/**
 * Whether a work id is usable, and why not if it isn't.
 *
 * A work id becomes BOTH a directory name under `.runtime/instances/` and part
 * of a git branch name, so it is checked for two different escapes: a path
 * separator or `..`/`.` would climb out of the instances directory, and a
 * leading `-` would be read by git as a flag rather than a value.
 */
export function workIdProblem(workId: string): string | null {
  const trimmed = workId.trim();
  if (!trimmed) return "a work id cannot be blank";
  if (trimmed === "." || trimmed === "..") return `"${workId}" is not a usable work id`;
  if (/[/\\]/.test(trimmed)) return `"${workId}" contains a path separator, which would escape the instances directory`;
  if (trimmed.startsWith("-")) return `"${workId}" starts with "-", which git would read as a flag`;
  return null;
}
