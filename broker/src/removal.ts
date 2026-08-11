/**
 * The archive-vs-delete decision (spec §1). Pure — every branch testable
 * without a broker. Evidence spans two services: transcriptHit is ours,
 * warmSessions/activeTasks come from swarm's usage endpoint.
 *
 * Known approximation: transcripts cap at 500 lines per session, so speech
 * that rolled off no longer counts as evidence — once the record is gone,
 * deleting the speaker orphans nothing.
 */
import type { Session } from "./sessions.ts";

export interface RemovalEvidence {
  transcriptHit: boolean;
  warmSessions: number;
  activeTasks: number;
}

export function resolveRemoval(e: RemovalEvidence): "delete" | "archive" {
  return e.transcriptHit || e.warmSessions > 0 || e.activeTasks > 0 ? "archive" : "delete";
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Did this agent ever SPEAK (speaker-prefixed broker line) in any session? */
export function transcriptMentions(sessions: Session[], agent: { id: string; name: string }): boolean {
  const prefix = new RegExp(`^\\s*(?:${escapeRe(agent.name)}|${escapeRe(agent.id)})\\s*:`, "i");
  return sessions.some((s) => s.transcript.some((line) => line.role === "broker" && prefix.test(line.text)));
}

export interface RemovalPorts {
  registry: () => Promise<Array<{ id: string; name: string }>>;
  agentUsage: (id: string) => Promise<{ warmSessions: number; activeTasks: number }>;
  deleteAgent: (id: string) => Promise<void>;
  archiveAgent: (id: string) => Promise<void>;
  sessions: () => Session[];
  /** Post-removal refresh: reseed the directory, rebroadcast the roster. */
  onChanged: () => Promise<void>;
}

/** The whole decision path behind "remove". Swarm is a port, so this tests with stubs. */
export function createRemovalService(ports: RemovalPorts) {
  const preview = async (
    id: string,
  ): Promise<{ outcome: "delete" | "archive"; reasons: string[] } | { error: string }> => {
    const agent = (await ports.registry()).find((a) => a.id === id);
    if (!agent) return { error: `Unknown agent: ${id}` };
    const usage = await ports.agentUsage(id);
    const transcriptHit = transcriptMentions(ports.sessions(), agent);
    const reasons = [
      ...(transcriptHit ? ["has spoken in a session"] : []),
      ...(usage.warmSessions > 0 ? [`${usage.warmSessions} warm session(s)`] : []),
      ...(usage.activeTasks > 0 ? [`${usage.activeTasks} running task(s)`] : []),
    ];
    return { outcome: resolveRemoval({ transcriptHit, ...usage }), reasons };
  };
  const execute = async (id: string): Promise<{ outcome: "deleted" | "archived" } | { error: string }> => {
    const decision = await preview(id);
    if ("error" in decision) return decision;
    try {
      if (decision.outcome === "delete") await ports.deleteAgent(id);
      else await ports.archiveAgent(id);
    } catch (err) {
      return { error: String((err as Error).message) }; // swarm's busy-lock 409s land here, readable
    }
    await ports.onChanged();
    return { outcome: decision.outcome === "delete" ? "deleted" : "archived" };
  };
  return { preview, execute };
}
