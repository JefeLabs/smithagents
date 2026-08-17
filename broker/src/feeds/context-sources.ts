// Context sources → FeedSource rows (spec 2026-08-13 queue-sources). The
// swarm's workspace records own the definitions; this mirrors the pollable
// ones into the feeds store on the hourly derive tick, the exact pattern
// deriveSources uses for manifests. releases/topic presets produce NO row:
// their executors (registry derivation, topic machinery) already exist and
// only their TARGETING moves to bindings.
import type { FeedSource } from "./types.ts";

export interface ContextSourceWire {
  id: string;
  name: string;
  // Not a closed union: the swarm's workspaces.ts derives the real closed set
  // (allPresetIds/validSources) from WORK_KINDS, which now includes kind-specific
  // presets (tiktok, crm, tickers, …) this file never needs to know by name. Here
  // `preset` is presentational — only "jira"/"releases"/"topic" get behavioral
  // dispatch below, everything else falls through to a plain http-kind row.
  preset: string;
  origin: { connectorId?: string; url?: string; query?: string };
  cadence: "hourly" | "6h" | "nightly";
  transform: { mode: "map" } | { mode: "analyze"; prompt?: string };
  enabled: boolean;
}

export function contextSourceId(workspace: string, id: string): string {
  return `ctx:${workspace}:${id}`;
}

export function fromContextSources(
  workspaces: Array<{ name: string; sources?: ContextSourceWire[] }>,
  existing: FeedSource[],
): FeedSource[] {
  const dismissed = new Set(existing.filter((s) => s.dismissed).map((s) => s.id));
  const rows: FeedSource[] = [];
  for (const ws of workspaces) {
    for (const src of ws.sources ?? []) {
      if (!src.enabled) continue;
      if (src.preset === "releases" || src.preset === "topic") continue;
      const id = contextSourceId(ws.name, src.id);
      rows.push({
        id,
        label: src.name,
        kind: src.preset === "jira" ? "jira" : "http",
        locator: src.origin.url ?? "",
        tag: "tech",
        origin: "derived",
        reason: `context source of ${ws.name}`,
        enabled: true,
        dismissed: dismissed.has(id) ? true : undefined,
        workspace: ws.name,
        contextId: src.id,
        cadence: src.cadence,
        connectorId: src.origin.connectorId,
        query: src.origin.query,
        analyzePrompt: src.transform.mode === "analyze" ? src.transform.prompt : undefined,
      });
    }
  }
  return rows;
}
