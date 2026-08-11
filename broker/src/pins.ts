// Pin-target resolution. One array, two namespaces: bare entries are workspace
// names; "group:<name>" entries resolve through the group's precomputed
// expansion (swarm's GET /groups). Down-only by construction — nothing here
// ever attributes a member's pins to its parent (spec decisions 3-5,
// docs/superpowers/specs/2026-08-11-workspace-groups-design.md).
export const GROUP_PIN_PREFIX = "group:";

export function docSeedsInWorkspace(
  pins: string[] | undefined,
  workspace: string,
  groups: Array<{ name: string; expansion: string[] }>,
): boolean {
  if (!pins) return false;
  const expansions = new Map(groups.map((g) => [g.name, g.expansion]));
  return pins.some((p) =>
    p.startsWith(GROUP_PIN_PREFIX)
      ? (expansions.get(p.slice(GROUP_PIN_PREFIX.length)) ?? []).includes(workspace)
      : p === workspace,
  );
}
