/**
 * Who leads a collection of agents.
 *
 * Edwin's rule (2026-08-10): "every swarm has a leader or project manager" —
 * a group is addressed through whoever leads it, never as a faceless set. The
 * ladder below is the PERMANENT FLOOR under that rule: elections may decide
 * who leads, but when an election cannot run, returns nothing usable, or has
 * not finished yet, this file still answers. A group is never leaderless.
 *
 * Pure by design — no I/O, no model, no clock — because the part that must
 * never fail is the part that must be trivially testable.
 */

/** One claim to leadership, from one member. See election.ts for how these are gathered. */
export interface Claim {
  agent: string;
  willing: boolean;
  /** 0..1, already clamped by the parser. */
  confidence: number;
  reason: string;
}

/** An agent reduced to what ranking needs: its id and every role string it carries. */
export interface Rankable {
  id: string;
  /** Persona job title and (when the agent sits in a squad) its structural squad role. */
  roles: string[];
}

/**
 * Highest first. Coordination outranks technical seniority — Edwin: a scrum
 * master is the natural fit for leading a group, over a tech lead.
 *
 * Scrum Master is listed although no such persona exists yet: naming it here
 * costs nothing and means adding that persona later needs no routing change
 * (spec §12).
 */
const LADDER: ReadonlyArray<RegExp> = [
  /product manager|scrum master/, // 0 — coordination
  /^leader$/, //                     1 — structural squad position
  /architect/, //                    2
  /senior/, //                       3
];

/** Unmatched roles rank here. Never an error: the persona catalog is config, not an enum. */
const UNRANKED = 99;

/** Best (lowest) rank across every role the agent carries. */
export function rankOf(roles: string[]): number {
  let best = UNRANKED;
  for (const role of roles) {
    const needle = role.trim().toLowerCase();
    if (!needle) continue;
    const hit = LADDER.findIndex((re) => re.test(needle));
    if (hit !== -1 && hit < best) best = hit;
  }
  return best;
}

/**
 * The highest-ranked member. Ties break on the order given — callers pass
 * roster order, so the answer is stable across calls and across restarts.
 */
export function deriveLeader(members: Rankable[]): string | null {
  let winner: Rankable | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (const member of members) {
    const rank = rankOf(member.roles);
    if (rank < best) {
      best = rank;
      winner = member;
    }
  }
  return winner?.id ?? null;
}

/**
 * Resolve an election. Strongest willing claim wins; a confidence tie breaks
 * on the ladder; nobody willing (or nobody heard from) falls to the ladder
 * outright. `method` records which decided, so a surprising leader is always
 * explainable in the UI.
 */
export function pickLeader(claims: Claim[], members: Rankable[]): { leader: string | null; method: 'vote' | 'rank' } {
  const ids = new Set(members.map((m) => m.id));
  const willing = claims.filter((c) => c.willing && ids.has(c.agent));
  if (willing.length === 0) return { leader: deriveLeader(members), method: 'rank' };

  const top = Math.max(...willing.map((c) => c.confidence));
  const tied = willing.filter((c) => c.confidence === top).map((c) => c.agent);
  if (tied.length === 1) return { leader: tied[0]!, method: 'vote' };

  // Tie among the willing — the ladder breaks it, but a vote still happened.
  const tiedMembers = members.filter((m) => tied.includes(m.id));
  return { leader: deriveLeader(tiedMembers), method: 'vote' };
}
