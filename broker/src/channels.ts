/**
 * ChannelAdapter port — external text/voice surfaces (Discord, Slack, …)
 * plug into the broker here (spec §5). The hub sits at two seams:
 * onSpeechText feeds dispatchSpeech; handleUserText receives onUtterance.
 *
 * Origin is TURN-SCOPED, not a field this hub owns the lifecycle of:
 * `onUtterance` only formats the line and hands the derived origin to
 * `submitUserText` — it never touches hub state. The broker's serialized
 * turn queue is what actually activates it, via `setActiveOrigin(origin)`
 * right before that turn's brain call and `setActiveOrigin(undefined)` once
 * it settles (broker.ts's onTurnStart/onTurnEnd). That means `dispatchSpeech`
 * only ever reaches the channel that asked for the turn CURRENTLY running —
 * a second utterance queued from a different channel can't clobber the
 * first turn's routing before its speech goes out, and a meeting-sourced
 * turn (no origin) is always inert for external delivery, regardless of
 * what any earlier or later turn's origin was. Unprefixed speech chunks
 * follow the last speaker (sticky-speaker, same rule the TTS path uses) —
 * reset on every `setActiveOrigin` call so a new turn never inherits the
 * previous turn's speaker.
 */
import type { TurnOrigin } from "./broker.ts";

export interface ChannelSpeechLine {
  agentId?: string;
  name?: string;
  text: string;
}

export interface ChannelUtterance {
  text: string;
  author: string;
  channelRef: string;
}

export interface ChannelAdapter {
  /** Stable kind, e.g. "discord" — matched against ComposedAgent.channels. */
  kind: string;
  deliver(line: ChannelSpeechLine, channelRef: string): Promise<void>;
}

export interface HubAgent {
  id: string;
  name: string;
  /** Legacy array (listed = designated) or a per-surface mode map — swarm persists either; only the array form is legacy-membership-checked below. */
  channels?: string[] | Record<string, string>;
}

interface HubDeps {
  resolveSpeaker: (text: string) => { speaker?: string; spokenText: string };
  agents: () => HubAgent[];
  submitUserText: (text: string, origin: TurnOrigin) => void;
}

export class AdapterHub {
  private adapters = new Map<string, ChannelAdapter>();
  private activeOrigin: TurnOrigin | undefined;
  private lastSpeaker: HubAgent | null = null;

  /** Presence policy hook (surface-modes). When set, replaces the legacy
   * channels-array membership check for external delivery. */
  attendsPolicy: ((agentId: string, kind: string) => boolean) | null = null;

  constructor(private readonly deps: HubDeps) {}

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.kind, adapter);
  }

  /** Removes the adapter of `kind`, if any — the register() counterpart a
   * lifecycle teardown needs so a stop()-ed adapter is never left reachable
   * by dispatchSpeech (which would try to deliver() through a dead connection). */
  unregister(kind: string): void {
    this.adapters.delete(kind);
  }

  /** Formats the line and forwards it with its origin — never touches hub state directly. */
  onUtterance(adapterKind: string, u: ChannelUtterance): void {
    const origin: TurnOrigin = { kind: adapterKind, channelRef: u.channelRef };
    this.deps.submitUserText(`${u.author} (via ${adapterKind}): ${u.text}`, origin);
  }

  /** Activates (or deactivates, with `undefined`) origin for exactly the turn now running. Always resets sticky-speaker. */
  setActiveOrigin(origin: TurnOrigin | undefined): void {
    this.activeOrigin = origin;
    this.lastSpeaker = null;
  }

  dispatchSpeech(text: string): void {
    if (!this.activeOrigin) return;
    const adapter = this.adapters.get(this.activeOrigin.kind);
    if (!adapter) return;
    const { speaker, spokenText } = this.deps.resolveSpeaker(text);
    if (speaker) {
      const q = speaker.toLowerCase();
      this.lastSpeaker = this.deps.agents().find((a) => a.id.toLowerCase() === q || a.name.toLowerCase() === q) ?? null;
    }
    const agent = this.lastSpeaker;
    if (!agent) return; // narrator/unknown lines stay out of external channels
    // Legacy fallback only understands the array form (listed = designated).
    // A map-shaped channels (reachable now that swarm persists it) is not
    // this check's business — surfaceModes/attendsPolicy owns that — so
    // treat it like an absent field rather than crashing on `.includes`.
    const attends = this.attendsPolicy
      ? this.attendsPolicy(agent.id, adapter.kind)
      : !(Array.isArray(agent.channels) && !agent.channels.includes(adapter.kind));
    if (!attends) return;
    void adapter
      .deliver({ agentId: agent.id, name: agent.name, text: spokenText }, this.activeOrigin.channelRef)
      .catch((err) => console.error(`[channels] delivery to ${adapter.kind} failed: ${String(err)}`));
  }
}
