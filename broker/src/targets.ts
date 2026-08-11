/**
 * Who a composed message is for.
 *
 * The one rule (spec §2): every target resolves to exactly ONE addressable
 * agent. A squad is addressed through its leader, a group through the leader
 * its members elected, the whole crew through Anderson — who is the brain, so
 * that stays a brain turn. This keeps exactly two dispatch kinds and therefore
 * exactly one new code path.
 */
import { deriveLeader } from "./leadership.ts";

export type Target =
  | { kind: "host" }
  | { kind: "crew" }
  | { kind: "squad"; id: string }
  | { kind: "group"; id: string }
  | { kind: "agent"; id: string };

export type Resolution = { kind: "brain" } | { kind: "agent"; name: string } | { error: string };

export interface TargetRoster {
  squads: Array<{ id: string; leader: { name: string } }>;
  groups: Array<{
    id: string;
    name: string;
    leader?: string;
    members: Array<{ id: string; name: string; roles: string[] }>;
  }>;
  agents: Array<{ id: string; name: string }>;
}

const NEEDS_ID = new Set(["squad", "group", "agent"]);

/** Narrow untrusted JSON to a Target. Anything unrecognised is `undefined` — i.e. a brain turn. */
export function parseTarget(raw: unknown): Target | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { kind, id } = raw as { kind?: unknown; id?: unknown };
  if (kind === "host" || kind === "crew") return { kind };
  if (typeof kind !== "string" || !NEEDS_ID.has(kind)) return undefined;
  if (typeof id !== "string" || !id) return undefined;
  return { kind: kind as "squad" | "group" | "agent", id };
}

export function resolveTarget(target: Target | undefined, roster: TargetRoster): Resolution {
  if (!target || target.kind === "host" || target.kind === "crew") return { kind: "brain" };

  if (target.kind === "squad") {
    const squad = roster.squads.find((s) => s.id === target.id);
    return squad ? { kind: "agent", name: squad.leader.name } : { error: `unknown squad: ${target.id}` };
  }

  if (target.kind === "group") {
    const group = roster.groups.find((g) => g.id === target.id);
    if (!group) return { error: `unknown group: ${target.id}` };
    // The stored leader when the election has landed; the ladder while it is
    // still in flight. Sending never waits for a vote (spec §2).
    const leaderId = group.leader ?? deriveLeader(group.members);
    const leader = group.members.find((m) => m.id === leaderId);
    return leader ? { kind: "agent", name: leader.name } : { error: `group ${group.name} has no members` };
  }

  const agent = roster.agents.find((a) => a.id === target.id);
  return agent ? { kind: "agent", name: agent.name } : { error: `unknown agent: ${target.id}` };
}
