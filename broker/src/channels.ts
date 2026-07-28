/**
 * ChannelAdapter port — external text/voice surfaces (Discord, Slack, …)
 * plug into the broker here (spec §5). The hub sits at two seams:
 * onSpeechText feeds dispatchSpeech; handleUserText receives onUtterance.
 * Turns serialize in the broker, so one origin field is enough to route a
 * turn's replies back to the channel that asked. Unprefixed speech chunks
 * follow the last speaker (sticky-speaker, same rule the TTS path uses).
 */
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
  channels?: string[];
}

interface HubDeps {
  resolveSpeaker: (text: string) => { speaker?: string; spokenText: string };
  agents: () => HubAgent[];
  submitUserText: (text: string) => void;
}

export class AdapterHub {
  private adapters = new Map<string, ChannelAdapter>();
  private origin: { kind: string; channelRef: string } | null = null;
  private lastSpeaker: HubAgent | null = null;

  constructor(private readonly deps: HubDeps) {}

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.kind, adapter);
  }

  onUtterance(adapterKind: string, u: ChannelUtterance): void {
    this.origin = { kind: adapterKind, channelRef: u.channelRef };
    this.lastSpeaker = null;
    this.deps.submitUserText(`${u.author} (via ${adapterKind}): ${u.text}`);
  }

  dispatchSpeech(text: string): void {
    if (!this.origin) return;
    const adapter = this.adapters.get(this.origin.kind);
    if (!adapter) return;
    const { speaker, spokenText } = this.deps.resolveSpeaker(text);
    if (speaker) {
      const q = speaker.toLowerCase();
      this.lastSpeaker =
        this.deps.agents().find((a) => a.id.toLowerCase() === q || a.name.toLowerCase() === q) ?? null;
    }
    const agent = this.lastSpeaker;
    if (!agent) return; // narrator/unknown lines stay out of external channels
    if (agent.channels && !agent.channels.includes(adapter.kind)) return;
    void adapter
      .deliver({ agentId: agent.id, name: agent.name, text: spokenText }, this.origin.channelRef)
      .catch((err) => console.error(`[channels] delivery to ${adapter.kind} failed: ${String(err)}`));
  }

  clearOrigin(): void {
    this.origin = null;
    this.lastSpeaker = null;
  }
}
