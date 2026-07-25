import type { AgentSeed } from "../data/agents";
import { AgentAvatar } from "../molecules/AgentAvatar";

interface AgentRosterProps {
  agents: AgentSeed[];
  onAdd: () => void;
}

export function AgentRoster({ agents, onAdd }: AgentRosterProps) {
  return (
    <aside className="rail rail--right" aria-label="Agents">
      <div className="rail__label">agents</div>
      <div className="roster">
        {agents.map((agent) => (
          <AgentAvatar key={agent.id} name={agent.name} role={agent.role} ring={agent.ring} />
        ))}
      </div>
      <button type="button" className="add" onClick={onAdd} title="Configure a new agent" aria-label="Add agent">
        +
      </button>
      <div className="spacer" />
    </aside>
  );
}
