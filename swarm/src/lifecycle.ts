// Removal lifecycle facts for composed agents. Swarm reports what IT knows —
// warm-session records and live tasks. Conversation evidence lives in the
// broker, which owns the archive-vs-delete decision (spec §1).
import type { ComposedAgent } from './agents.js';
import type { SessionRecord } from './session-store.js';

export interface AgentUsage {
  warmSessions: number;
  activeTasks: number;
}

/**
 * What a task's manifest says about which composed agent is running it.
 * `composedAgentId` is the stable handle (manifest.metadata.composedAgentId,
 * set from the id the broker addressed); `profileName` is the display name
 * captured on manifest.profile at dispatch time. Names are mutable — a
 * rename must not sever a running task's attribution — so id is preferred
 * whenever a task's manifest carries one.
 */
export interface ActiveTaskRef {
  composedAgentId?: string;
  profileName?: string;
}

/** Prefer the stable id; fall back to name-matching only for tasks whose manifest predates the id. */
function refMatchesAgent(ref: ActiveTaskRef, agent: ComposedAgent): boolean {
  if (ref.composedAgentId) return ref.composedAgentId === agent.id;
  return ref.profileName === agent.name;
}

export function agentUsage(
  agent: ComposedAgent,
  records: SessionRecord[],
  liveAgentIds: string[],
  activeTaskRefs: ActiveTaskRef[],
): AgentUsage {
  const warm = new Set(records.filter((r) => r.agentId === agent.id).map((r) => r.id));
  for (const id of liveAgentIds) if (id === agent.id) warm.add(`live:${id}`);
  return {
    warmSessions: warm.size,
    activeTasks: activeTaskRefs.filter((ref) => refMatchesAgent(ref, agent)).length,
  };
}

/** Live work only — a historical record does not lock the agent. */
export function isBusy(liveAgentIds: string[], activeTaskRefs: ActiveTaskRef[], agent: ComposedAgent): boolean {
  return liveAgentIds.includes(agent.id) || activeTaskRefs.some((ref) => refMatchesAgent(ref, agent));
}
