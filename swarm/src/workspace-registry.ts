// The workspace registry: name -> absolute directory.
//
// It exists to solve a bootstrap problem. A workspace's record is moving into
// its own directory (<dir>/config/settings.json), so the directory has to be
// known BEFORE the record can be read. The registry is the one thing findable
// without knowing anything else.
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SmithPaths } from "./paths.js";

export function registryPath(paths: SmithPaths): string {
  return join(paths.root, "workspaces.json");
}

/**
 * name -> absolute workspace directory. An ABSENT registry is an empty one —
 * that is a fresh install. A MALFORMED one throws: reporting no workspaces
 * because the file could not be parsed would look identical to a fresh install
 * and would let the server come up owning nothing.
 */
export async function loadRegistry(paths: SmithPaths): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(registryPath(paths), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  return JSON.parse(raw) as Record<string, string>;
}

async function writeRegistry(paths: SmithPaths, entries: Record<string, string>): Promise<void> {
  // Write-and-rename: a torn registry is unrecoverable without it, since the
  // registry is how every workspace is found.
  const target = registryPath(paths);
  const tmp = `${target}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`);
  await rename(tmp, target);
}

export async function saveRegistryEntry(paths: SmithPaths, name: string, dir: string): Promise<void> {
  const entries = await loadRegistry(paths);
  entries[name] = dir;
  await writeRegistry(paths, entries);
}

export async function removeRegistryEntry(paths: SmithPaths, name: string): Promise<void> {
  const entries = await loadRegistry(paths);
  if (!(name in entries)) return;
  delete entries[name];
  await writeRegistry(paths, entries);
}
