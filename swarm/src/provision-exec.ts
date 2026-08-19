// Provisioning execution — the impure half. Policy lives in provisioning.ts.
import { cp } from "node:fs/promises";
import { join } from "node:path";

/**
 * Copy each planned path from the workspace's own checkout into the new member.
 *
 * NEVER THROWS. A failed copy is an optimization that did not happen: the plan's
 * setup commands rebuild whatever copy would have provided, so the worst outcome
 * is a cold build — which is exactly the status quo without this feature. Raising
 * here would convert a slow instance into a broken one.
 *
 * NEVER SYMLINKS THE DESTINATION. Every instance owns its own tree, because a
 * shared node_modules is shared mutable state between concurrent agents and that
 * is precisely what instance isolation exists to prevent.
 *
 * Links INSIDE the tree are preserved rather than resolved. pnpm's node_modules
 * is largely links into a content-addressed store; copying it by value would
 * duplicate gigabytes to no purpose, and the store it points at is immutable.
 */
export async function copyProvisionPaths(
  source: string,
  dest: string,
  paths: string[],
): Promise<{ copied: string[]; failed: Array<{ path: string; reason: string }> }> {
  const copied: string[] = [];
  const failed: Array<{ path: string; reason: string }> = [];
  for (const path of paths) {
    try {
      await cp(join(source, path), join(dest, path), {
        recursive: true,
        // Preserve links as links — see the note above about pnpm's store.
        dereference: false,
        force: true,
      });
      copied.push(path);
    } catch (err) {
      // Recorded and carried on: one unavailable path must not deny the member
      // every other path in its plan.
      failed.push({ path, reason: (err as Error).message });
    }
  }
  return { copied, failed };
}
