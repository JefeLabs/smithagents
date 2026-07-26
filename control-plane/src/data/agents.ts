export interface AgentSeed {
  id: string;
  name: string;
  role: string;
  ring: string;
  status?: "idle" | "busy" | "in-meeting" | "offline";
  /** One-line reason when the agent has a raised hand. */
  hand?: string;
  /** Solo agent, or a squad/group rendered as one circle. */
  kind?: "agent" | "squad";
  /** Squad entries: member display names for the edit-mode expansion. */
  members?: string[];
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
