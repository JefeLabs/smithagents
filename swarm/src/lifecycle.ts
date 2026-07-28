// Removal lifecycle facts for composed agents. Swarm reports what IT knows —
// warm-session records and live tasks. Conversation evidence lives in the
// broker, which owns the archive-vs-delete decision (spec §1).
import type { ComposedAgent } from './agents.js';
import type { SessionRecord } from './session-store.js';

export interface AgentUsage {
  warmSessions: number;
  activeTasks: number;
}

export function agentUsage(
  agent: ComposedAgent,
  records: SessionRecord[],
  liveAgentIds: string[],
  activeTaskProfileNames: string[],
): AgentUsage {
  const warm = new Set(records.filter((r) => r.agentId === agent.id).map((r) => r.id));
  for (const id of liveAgentIds) if (id === agent.id) warm.add(`live:${id}`);
  return {
    warmSessions: warm.size,
    activeTasks: activeTaskProfileNames.filter((n) => n === agent.name).length,
  };
}

/** Live work only — a historical record does not lock the agent. */
export function isBusy(liveAgentIds: string[], activeTaskProfileNames: string[], agent: ComposedAgent): boolean {
  return liveAgentIds.includes(agent.id) || activeTaskProfileNames.includes(agent.name);
}
