/**
 * Engine health: the join between the machine's CLI tool registry and the
 * agents that depend on those tools. Both halves are ordinary queries, so the
 * warning map is derived rather than fetched — invalidating either key
 * refreshes the badges with no bespoke refresh callback to thread through.
 */
import type { AgentRecord, CliToolListing } from "../api/types";
import { useAgentRecords, useCliTools } from "./http";

/**
 * Pure join: agentId -> warning for every agent whose engine tool the
 * registry confirms inactive. Absent knowledge (no probe, fetch failure)
 * flags nobody — same block-only-confirmed-negatives rule as the swarm gate.
 */
export function computeEngineWarnings(
  tools: CliToolListing[],
  agents: Array<{ id?: string; engine?: { cli?: string } }>,
): Record<string, string> {
  const inactive = new Map(tools.filter((t) => !t.active).map((t) => [t.cli, t.status?.detail || "unavailable"]));
  const warnings: Record<string, string> = {};
  for (const a of agents) {
    const cli = a.engine?.cli;
    if (a.id && cli && inactive.has(cli)) warnings[a.id] = `${cli}: ${inactive.get(cli) ?? "unavailable"}`;
  }
  return warnings;
}

// Stable empties so a pending or failed query does not hand `computeEngineWarnings`
// a fresh array identity on every render.
const NO_TOOLS: CliToolListing[] = [];
const NO_AGENTS: AgentRecord[] = [];

/**
 * `engine` lives only on the stored records (`useAgentRecords`), never on the
 * roster frame — joining against `useRoster()` would compile, return `{}` for
 * every agent, and silently retire the badges.
 */
export function useEngineWarnings(): Record<string, string> {
  const { data: tools = NO_TOOLS } = useCliTools();
  const { data } = useAgentRecords();
  return computeEngineWarnings(tools, data?.agents ?? NO_AGENTS);
}
