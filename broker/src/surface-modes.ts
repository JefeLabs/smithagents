/** Per-agent, per-surface presence modes parsed from the agent file's `channels`
 * field, plus the runtime admission state for on-request surfaces.
 *
 * The tauri app is NOT a surface: it is the management console, every agent
 * always appears there, and any `tauri` key lingering in an agent file is
 * parsed away (retired). Legacy compatibility is behavior-exact per call
 * site: an ARRAY means listed → autojoin, unlisted → disabled. An ABSENT
 * field historically passed the text delivery filter (channels.ts) but
 * failed the voice designation (discord-voice.ts), so it parses as
 * text-autojoin + voice-disabled.
 */
export type SurfaceMode = 'autojoin' | 'on-request' | 'disabled';
export type SurfaceModeMap = Record<string, SurfaceMode>;
export const KNOWN_SURFACES = ['discord', 'discord-voice'] as const;

const MODES: ReadonlySet<string> = new Set(['autojoin', 'on-request', 'disabled']);
/** Retired surface keys: skipped in every branch so old agent files stay valid. */
const RETIRED_SURFACES: ReadonlySet<string> = new Set(['tauri']);

export function surfaceModes(agent: { channels?: unknown }): SurfaceModeMap {
  const channels = agent.channels;
  if (channels === undefined || channels === null) {
    return { discord: 'autojoin', 'discord-voice': 'disabled' };
  }
  if (Array.isArray(channels)) {
    const out: SurfaceModeMap = {};
    for (const surface of KNOWN_SURFACES) {
      out[surface] = channels.includes(surface) ? 'autojoin' : 'disabled';
    }
    for (const surface of channels) {
      if (typeof surface === 'string' && !RETIRED_SURFACES.has(surface) && !(surface in out)) {
        out[surface] = 'autojoin';
      }
    }
    return out;
  }
  if (typeof channels === 'object') {
    const out: SurfaceModeMap = {};
    for (const surface of KNOWN_SURFACES) out[surface] = 'disabled';
    for (const [surface, mode] of Object.entries(channels as Record<string, unknown>)) {
      if (RETIRED_SURFACES.has(surface)) continue;
      out[surface] = typeof mode === 'string' && MODES.has(mode) ? (mode as SurfaceMode) : 'disabled';
    }
    return out;
  }
  return { discord: 'disabled', 'discord-voice': 'disabled' };
}

export class SurfacePolicy {
  private admissions = new Set<string>();

  constructor(private readonly getAgents: () => Array<{ id: string; channels?: unknown }>) {}

  modeFor(agentId: string, surface: string): SurfaceMode {
    const agent = this.getAgents().find((a) => a.id === agentId);
    if (!agent) return 'disabled';
    return surfaceModes(agent)[surface] ?? 'disabled';
  }

  attends(agentId: string, surface: string): boolean {
    const mode = this.modeFor(agentId, surface);
    if (mode === 'autojoin') return true;
    if (mode === 'on-request') return this.admissions.has(`${agentId}:${surface}`);
    return false;
  }

  admit(agentId: string, surface: string): void {
    this.admissions.add(`${agentId}:${surface}`);
  }

  revoke(agentId: string, surface: string): void {
    this.admissions.delete(`${agentId}:${surface}`);
  }

  revokeAll(surface: string): void {
    for (const key of this.admissions) {
      if (key.endsWith(`:${surface}`)) {
        this.admissions.delete(key);
      }
    }
  }
}

/** Pure gate for the join endpoint's mode check, shared by every surface (not
 * just voice): 'disabled' rejects outright — no join is attempted and no
 * admission is recorded; 'on-request' proceeds and needs an admission so
 * `attends()` honors it going forward; 'autojoin' proceeds too (the caller
 * still performs the actual join/no-op), but records no admission — an
 * autojoin surface doesn't need one, and revoking it later would wrongly gate
 * an agent that was never on-request to begin with. */
export type JoinDecision = { type: 'reject'; status: number; error: string } | { type: 'admit' } | { type: 'allow' };

export function decideJoin(agentId: string, surface: string, mode: SurfaceMode): JoinDecision {
  if (mode === 'disabled') return { type: 'reject', status: 409, error: `${agentId} is disabled on ${surface}` };
  if (mode === 'on-request') return { type: 'admit' };
  return { type: 'allow' };
}

/** Enforce a mode change's immediate effects. Voice: disabled ejects now;
 * autojoin joins now if a room is active. Every changed surface clears any
 * on-request admission (mode changes never smuggle an old admission along). */
export async function applyModeChange(
  deps: {
    leaveAgent(agentId: string): void;
    joinAgent(agentId: string): Promise<void>;
    roomActive(): boolean;
    revoke(agentId: string, surface: string): void;
    log(line: string): void;
  },
  agentId: string,
  before: SurfaceModeMap,
  after: SurfaceModeMap,
): Promise<void> {
  const surfaces = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const surface of surfaces) {
    const from = before[surface] ?? 'disabled';
    const to = after[surface] ?? 'disabled';
    if (from === to) continue;
    if (surface === 'discord-voice') {
      if (to === 'disabled') {
        deps.leaveAgent(agentId);
      } else if (to === 'autojoin' && deps.roomActive()) {
        try {
          await deps.joinAgent(agentId);
        } catch (err) {
          deps.log(`[surface-modes] ${agentId} autojoin flip failed to join: ${String(err)}`);
        }
      }
    }
    deps.revoke(agentId, surface);
  }
}
