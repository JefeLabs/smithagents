/**
 * AgentDirectory — the brain's live picture of who the agents are and where
 * they are. A READ-MODEL, not a source of truth: identity comes from the swarm
 * registry, work placement from swarm /ws events (joined via bindTask, since
 * the broker knows which agent it delegated for), meeting membership from the
 * broker's own LiveKit state.
 */
import type { RegistryAgent, SwarmEvent } from './swarm-client.ts';

export type AgentStatus = 'idle' | 'busy' | 'in-meeting' | 'offline';

export interface AgentPresence {
  agent: RegistryAgent;
  status: AgentStatus;
  taskId?: string;
  taskSummary?: string;
  swarmName?: string;
}

interface Placement {
  taskId: string;
  summary?: string;
  swarmName?: string;
  dispatched: boolean;
}

export class AgentDirectory {
  private agents = new Map<string, RegistryAgent>();
  private placements = new Map<string, Placement>(); // agentId -> placement
  private meetingIds = new Set<string>();

  seed(agents: RegistryAgent[]): void {
    this.agents = new Map(agents.map((a) => [a.id, a]));
  }

  resolve(nameOrId: string): RegistryAgent | undefined {
    const q = nameOrId.trim().toLowerCase();
    for (const a of this.agents.values()) {
      if (a.id.toLowerCase() === q || a.name.toLowerCase() === q) return a;
    }
    return undefined;
  }

  bindTask(agentId: string, bind: { taskId: string; summary?: string; swarmName?: string }): void {
    if (!this.agents.has(agentId)) return;
    this.placements.set(agentId, { ...bind, dispatched: false });
  }

  onEvent(e: SwarmEvent): void {
    if (e.type === 'task:dispatched') {
      const hit = this.entryByTask(e.taskId);
      if (hit) hit[1].dispatched = true;
      return;
    }
    if (e.type === 'task:completed' || e.type === 'task:failed' || e.type === 'task:quarantined') {
      const hit = this.entryByTask(e.taskId);
      if (hit) this.placements.delete(hit[0]);
    }
  }

  setMeeting(agentIds: string[]): void {
    this.meetingIds = new Set(agentIds);
  }

  clearMeeting(): void {
    this.meetingIds.clear();
  }

  findByTask(taskId: string): AgentPresence | undefined {
    const hit = this.entryByTask(taskId);
    if (!hit) return undefined;
    return this.snapshot().find((p) => p.agent.id === hit[0]);
  }

  snapshot(): AgentPresence[] {
    return [...this.agents.values()].map((agent) => {
      const placement = this.placements.get(agent.id);
      let status: AgentStatus = 'idle';
      if (placement) status = 'busy';
      else if (this.meetingIds.has(agent.id)) status = 'in-meeting';
      return {
        agent,
        status,
        taskId: placement?.taskId,
        taskSummary: placement?.summary,
        swarmName: placement?.swarmName,
      };
    });
  }

  /** Roster block injected into the brain's system prompt each turn. */
  describeForPrompt(): string {
    return this.snapshot()
      .map((p) => {
        const base = `${p.agent.name} (${p.agent.role}) — ${p.status}`;
        return p.status === 'busy' && p.taskSummary ? `${base}: ${p.taskSummary}` : base;
      })
      .join('\n');
  }

  private entryByTask(taskId: string): [string, Placement] | undefined {
    for (const entry of this.placements.entries()) {
      if (entry[1].taskId === taskId) return entry;
    }
    return undefined;
  }
}
