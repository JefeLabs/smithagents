// ---------------------------------------------------------------------------
// orchestrator/names.ts — Agent Name Roster
//
// Fixed roster of 10 human names (3 syllables each) for voice control.
// Each active agent slot gets a name. When you say "What's Tobias doing?"
// or "Kill Natasha", voice recognition picks it up cleanly.
//
// Names are assigned to task slots, not generated randomly.
// When a slot frees up, its name is available for the next task.
// ---------------------------------------------------------------------------

/**
 * The 10 agent names — all 3 syllables, phonetically distinct for voice.
 *
 * Designed so no two names sound alike when spoken aloud.
 */
export const AGENT_ROSTER = [
  "Sebastian", // se-BAS-tian
  "Dominic", // DOM-i-nic
  "Nathaniel", // na-THAN-iel
  "Tobias", // to-BI-as
  "Cameron", // CAM-er-on
  "Samantha", // sa-MAN-tha
  "Natasha", // na-TA-sha
  "Camila", // ca-MI-la
  "Olivia", // o-LI-via
  "Vanessa", // va-NES-sa
] as const;

export type AgentName = (typeof AGENT_ROSTER)[number];

/**
 * Agent name pool — tracks which names are in use.
 *
 * Names are claimed when a task starts and released when it finishes.
 * This gives you a stable, voice-friendly identity for each running agent.
 */
export class AgentNamePool {
  private inUse = new Map<AgentName, string>(); // name → taskId

  /**
   * Claim the next available name for a task.
   *
   * @param taskId - The task UUID to assign the name to
   * @returns The assigned agent name, or null if all 10 slots are full
   */
  claim(taskId: string): AgentName | null {
    for (const name of AGENT_ROSTER) {
      if (!this.inUse.has(name)) {
        this.inUse.set(name, taskId);
        return name;
      }
    }
    return null; // All 10 names in use
  }

  /**
   * Release a name back to the pool.
   *
   * @param name - The agent name to release
   */
  release(name: AgentName): void {
    this.inUse.delete(name);
  }

  /**
   * Release the name assigned to a specific task.
   *
   * @param taskId - The task UUID whose name should be freed
   */
  releaseByTaskId(taskId: string): void {
    for (const [name, id] of this.inUse) {
      if (id === taskId) {
        this.inUse.delete(name);
        return;
      }
    }
  }

  /**
   * Look up which name is assigned to a task.
   */
  getNameForTask(taskId: string): AgentName | undefined {
    for (const [name, id] of this.inUse) {
      if (id === taskId) return name;
    }
    return undefined;
  }

  /**
   * Look up which task owns a name.
   */
  getTaskForName(name: string): string | undefined {
    const normalized = this.normalize(name);
    return normalized ? this.inUse.get(normalized) : undefined;
  }

  /**
   * Case-insensitive name lookup — for voice input where casing varies.
   */
  private normalize(input: string): AgentName | undefined {
    const lower = input.toLowerCase();
    return AGENT_ROSTER.find((n) => n.toLowerCase() === lower);
  }

  /**
   * Resolve a name or taskId to a taskId.
   * Accepts: "Tobias", "tobias", or a raw taskId.
   */
  resolve(nameOrId: string): string | undefined {
    // Try as agent name first
    const byName = this.getTaskForName(nameOrId);
    if (byName) return byName;

    // Try as taskId
    for (const [, id] of this.inUse) {
      if (id === nameOrId || id.startsWith(nameOrId)) return id;
    }

    return undefined;
  }

  /**
   * List all currently assigned names with their task IDs.
   */
  list(): Array<{ name: AgentName; taskId: string }> {
    return Array.from(this.inUse.entries()).map(([name, taskId]) => ({
      name,
      taskId,
    }));
  }

  /**
   * List available (unassigned) names.
   */
  available(): AgentName[] {
    return AGENT_ROSTER.filter((n) => !this.inUse.has(n));
  }

  /**
   * How many names are currently in use.
   */
  get activeCount(): number {
    return this.inUse.size;
  }
}

/**
 * @deprecated Use AgentNamePool.claim() instead.
 * Kept for backwards compatibility during migration.
 */
export function generateAgentName(taskId: string): string {
  // Deterministic fallback for tasks that bypass the pool
  const hash = simpleHash(taskId);
  return AGENT_ROSTER[hash % AGENT_ROSTER.length];
}

/**
 * Parse an agent name — now just validates against the roster.
 */
export function parseAgentName(name: string): {
  name: string;
  isValid: boolean;
} {
  const match = AGENT_ROSTER.find((n) => n.toLowerCase() === name.toLowerCase());
  return { name: match ?? name, isValid: !!match };
}

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash);
}
