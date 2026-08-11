/**
 * Manifests and promoted interests become derived sources (spec §4).
 *
 * Returns the DERIVED set only — the caller merges it with manual sources, so
 * a bug here can never delete something the human added by hand.
 */
import type { Dependency } from "./manifests.ts";
import type { FeedSource } from "./types.ts";
import type { Ecosystem } from "./versions.ts";

/** Stable, so regeneration updates a source in place instead of duplicating it. */
export function releaseSourceId(name: string, workspace: string): string {
  return `rel:${workspace}:${name}`;
}

export function deriveSources(input: {
  deps: Array<Dependency & { workspace: string }>;
  promoted: Array<{ name: string; eco: Ecosystem; mentions: number }>;
  existing: FeedSource[];
}): FeedSource[] {
  const dismissed = new Set(input.existing.filter((s) => s.dismissed).map((s) => s.id));
  const out = new Map<string, FeedSource>();

  const add = (name: string, eco: Ecosystem, workspace: string, reason: string) => {
    const id = releaseSourceId(name, workspace);
    if (out.has(id)) return;
    out.set(id, {
      id,
      label: name.includes(":") ? name.split(":")[1] : name,
      kind: "registry",
      locator: `${eco}:${name}`,
      tag: "release",
      origin: "derived",
      reason,
      enabled: true,
      // A dismissal is a standing instruction, not a one-off (spec §4.3).
      dismissed: dismissed.has(id) ? true : undefined,
      workspace,
    });
  };

  for (const dep of input.deps) {
    add(dep.name, dep.eco, dep.workspace, `from ${dep.manifest} in ${dep.workspace}`);
  }
  for (const p of input.promoted) {
    add(p.name, p.eco, "", `you've mentioned ${p.name} ${p.mentions}×`);
  }
  return [...out.values()];
}
