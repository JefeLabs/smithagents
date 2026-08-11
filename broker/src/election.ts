/**
 * A group elects its own leader by self-nomination: each member is asked, in
 * character, whether THEY should lead — and answers blind to what the others
 * said (spec §5.2).
 *
 * WHY THIS RUNS HERE, not on the agents: there is no API engine today
 * (`engine: { cli: 'agy' | 'claude' | 'codex' }`), so every agent is a coding
 * CLI in a pinned tmux session. Asking members through their own runtimes
 * would start a coding agent per voter and mark the whole group BUSY to hold
 * a vote. Instead each member gets one short call on the broker's existing
 * model client, seeded with only that member's directives.
 */
import { type Claim, pickLeader, type Rankable } from "./leadership.ts";

/** One short, non-streaming model call. Injected so tests script it without network. */
export type AskFactory = (params: { system: string; prompt: string }) => Promise<string>;

export interface Candidate {
  id: string;
  name: string;
  /** Persona job title, e.g. "Product Manager". */
  role: string;
  /** The persona prompt — this is what makes the agent answer as itself. */
  directives: string;
  /** Structural squad role when the agent sits in a squad, e.g. "architect". */
  squadRole?: string;
}

export interface ElectionResult {
  leader: string | null;
  claims: Claim[];
  method: "vote" | "rank";
}

/** Both role vocabularies, as leadership.ts wants them. */
function rankableOf(c: Candidate): Rankable {
  return { id: c.id, roles: c.squadRole ? [c.role, c.squadRole] : [c.role] };
}

/**
 * Read a claim out of a model reply. Never throws: an unparseable answer is a
 * decline that keeps its raw text as the reason, so a weird election can be
 * explained after the fact.
 */
export function parseClaim(agent: string, raw: string): Claim {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (match) {
    try {
      const body = JSON.parse(match[0]) as { willing?: unknown; confidence?: unknown; reason?: unknown };
      const confidence = Number(body.confidence);
      return {
        agent,
        willing: Boolean(body.willing),
        confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
        reason: typeof body.reason === "string" ? body.reason : "",
      };
    } catch {
      /* fall through to the decline below */
    }
  }
  return { agent, willing: false, confidence: 0, reason: raw.trim().slice(0, 200) };
}

function promptFor(groupName: string, members: Candidate[]): string {
  const roster = members.map((m) => `- ${m.name} (${m.role})`).join("\n");
  return [
    `A working group called "${groupName}" has just formed. Its members:`,
    roster,
    "",
    "Should YOU lead this group? Consider what the group is for and what you are for.",
    "Answer with JSON only, no prose:",
    '{"willing": true|false, "confidence": 0.0-1.0, "reason": "one short sentence"}',
  ].join("\n");
}

/**
 * Run the round. Every member is asked in parallel; a member who throws or
 * answers nonsense is recorded as a decline rather than failing the election.
 * With nobody willing — or nobody reachable — the rank ladder decides.
 */
export async function runElection(
  ask: AskFactory,
  group: { name: string },
  members: Candidate[],
): Promise<ElectionResult> {
  const prompt = promptFor(group.name, members);
  const claims = await Promise.all(
    members.map(async (member): Promise<Claim> => {
      try {
        const raw = await ask({ system: member.directives, prompt });
        return parseClaim(member.id, raw);
      } catch (err) {
        return { agent: member.id, willing: false, confidence: 0, reason: `unreachable: ${String(err)}` };
      }
    }),
  );
  const { leader, method } = pickLeader(claims, members.map(rankableOf));
  return { leader, claims, method };
}

/**
 * Debounces elections per group and discards superseded ones.
 *
 * Dragging three agents into a group fires three membership changes; that is
 * one vote, not three. And a change that lands while a vote is in flight wins
 * — the older result describes a group that no longer exists, so it is thrown
 * away rather than written (spec §5.3).
 */
export class ElectionScheduler {
  private pending = new Map<string, NodeJS.Timeout>();
  /** Bumped on every schedule; a result whose generation is stale is discarded. */
  private generation = new Map<string, number>();
  private readonly delayMs: number;
  private readonly timer: { set: typeof setTimeout; clear: typeof clearTimeout };

  constructor(
    private readonly deps: {
      /** Gather candidates and run the round. Null when the group no longer exists. */
      run(groupId: string): Promise<ElectionResult | null>;
      onResult(groupId: string, result: ElectionResult): void;
      delayMs?: number;
      timer?: { set: typeof setTimeout; clear: typeof clearTimeout };
    },
  ) {
    this.delayMs = deps.delayMs ?? 250;
    this.timer = deps.timer ?? { set: setTimeout, clear: clearTimeout };
  }

  schedule(groupId: string): void {
    const existing = this.pending.get(groupId);
    if (existing) this.timer.clear(existing);
    const generation = (this.generation.get(groupId) ?? 0) + 1;
    this.generation.set(groupId, generation);

    const handle = this.timer.set(() => {
      this.pending.delete(groupId);
      void this.deps
        .run(groupId)
        .then((result) => {
          if (!result) return;
          // Superseded while we were away: the group changed under us.
          if (this.generation.get(groupId) !== generation) return;
          this.deps.onResult(groupId, result);
        })
        .catch((err: unknown) => {
          console.error(`[election] ${groupId} failed:`, err);
        });
    }, this.delayMs);
    this.pending.set(groupId, handle);
  }
}
