import { useCallback, useEffect, useState } from "react";
import type { CliToolListing } from "./useBrokerChat";

const BASE = "127.0.0.1:7790";

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

/** Fetches the registry + agent records once on mount; `refresh` re-joins on demand (settings close, agent edits). */
export function useCliToolHealth() {
  const [warnings, setWarnings] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      const [toolsRes, agentsRes] = await Promise.all([
        fetch(`http://${BASE}/cli-tools`),
        fetch(`http://${BASE}/agents`),
      ]);
      const tools = ((await toolsRes.json()) as { tools?: CliToolListing[] }).tools ?? [];
      const agents =
        ((await agentsRes.json()) as { agents?: Array<{ id?: string; engine?: { cli?: string } }> }).agents ?? [];
      setWarnings(computeEngineWarnings(tools, agents));
    } catch {
      setWarnings({}); // no knowledge -> no badges, never stale ones
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { warnings, refresh };
}
