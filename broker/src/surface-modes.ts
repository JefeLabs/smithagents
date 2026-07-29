/** Per-agent, per-surface presence modes parsed from the agent file's `channels`
 * field, plus the runtime admission state for on-request surfaces.
 *
 * Legacy compatibility is behavior-exact per call site: an ARRAY means listed →
 * autojoin, unlisted → disabled. An ABSENT field historically passed the text
 * delivery filter (channels.ts) but failed the voice designation
 * (discord-voice.ts), so it parses as text-autojoin + voice-disabled.
 */
export type SurfaceMode = 'autojoin' | 'on-request' | 'disabled';
export type SurfaceModeMap = Record<string, SurfaceMode>;
export const KNOWN_SURFACES = ['tauri', 'discord', 'discord-voice'] as const;

const MODES: ReadonlySet<string> = new Set(['autojoin', 'on-request', 'disabled']);

export function surfaceModes(agent: { channels?: unknown }): SurfaceModeMap {
  const channels = agent.channels;
  if (channels === undefined || channels === null) {
    return { tauri: 'autojoin', discord: 'autojoin', 'discord-voice': 'disabled' };
  }
  if (Array.isArray(channels)) {
    const out: SurfaceModeMap = {};
    for (const surface of KNOWN_SURFACES) {
      out[surface] = channels.includes(surface) ? 'autojoin' : 'disabled';
    }
    for (const surface of channels) {
      if (typeof surface === 'string' && !(surface in out)) out[surface] = 'autojoin';
    }
    return out;
  }
  if (typeof channels === 'object') {
    const out: SurfaceModeMap = {};
    for (const surface of KNOWN_SURFACES) out[surface] = 'disabled';
    for (const [surface, mode] of Object.entries(channels as Record<string, unknown>)) {
      out[surface] = typeof mode === 'string' && MODES.has(mode) ? (mode as SurfaceMode) : 'disabled';
    }
    return out;
  }
  return { tauri: 'disabled', discord: 'disabled', 'discord-voice': 'disabled' };
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
