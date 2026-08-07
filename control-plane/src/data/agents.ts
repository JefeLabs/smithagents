export interface AgentSeed {
  id: string;
  name: string;
  role: string;
  ring: string;
  status?: "idle" | "busy" | "in-meeting" | "offline";
  /** One-line reason when the agent has a raised hand. */
  hand?: string;
  /** True while the live utterance is addressing them ("Hey Manuel"). */
  listening?: boolean;
  /** Solo agent, squad/group rendered as one circle, or the broker host (never an agent). */
  kind?: "agent" | "squad" | "host";
  /** Squad entries: member display names for the edit-mode expansion. */
  members?: string[];
  /** Portrait filename from the roster frame. */
  avatar?: string;
  /** Set when this agent's engine CLI is confirmed inactive — drives the rail warning badge. */
  engineWarning?: string;
}

/** The broker's host identity as a rail entry. Presentation only — the host is never an agent. */
export function hostSeed(
  identity: { name: string; role: string; ring?: string; listening?: boolean } | null,
): AgentSeed | null {
  if (!identity) return null;
  return {
    id: "host",
    name: identity.name,
    role: identity.role,
    ring: identity.ring ?? "#8a93a6",
    listening: identity.listening,
    kind: "host",
  };
}

// Mirrors the personas module: agents are data, never a hardcoded enum.
export const AGENTS: AgentSeed[] = [
  { id: "manuel", name: "Manuel", role: "Architect", ring: "#6f8dff" },
  { id: "octavio", name: "Octavio", role: "Security / Integration", ring: "#e0a15a" },
  { id: "aurelio", name: "Aurelio", role: "UI Purist", ring: "#d977c8" },
];

export const RING_PALETTE = ["#6f8dff", "#e0a15a", "#d977c8", "#5fd0b0", "#f2778f", "#9b8cff"];

export function ringForIndex(i: number): string {
  return RING_PALETTE[i % RING_PALETTE.length] ?? "#6f8dff";
}
