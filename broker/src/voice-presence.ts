/** Pure presence state machine for Discord voice channels.
 *
 * Single-room rule: the crew lives in at most one voice channel at a time.
 * First human to join an allowlisted channel wins; subsequent joins to other
 * channels are rejected. Discord voice-state events (human-joined, human-left)
 * drive the state machine. join-failed signals a transient retry condition
 * (keep state unjoined so the next human-joined attempt retries).
 */

export type PresenceEvent =
  | { type: 'human-joined'; channelId: string }
  | { type: 'human-left'; channelId: string }
  | { type: 'join-failed'; channelId: string };

export type PresenceAction =
  | { type: 'join-crew'; channelId: string }
  | { type: 'leave-crew'; channelId: string }
  | { type: 'none' };

export class VoicePresence {
  private allowlist: Set<string>;
  private joined: string | null = null;

  constructor(allowlist: string[]) {
    this.allowlist = new Set(allowlist);
  }

  handle(e: PresenceEvent, humanCountFor: (channelId: string) => number): PresenceAction {
    if (e.type === 'human-joined') {
      // Ignore if channel not allowlisted
      if (!this.allowlist.has(e.channelId)) {
        return { type: 'none' };
      }

      // Single-room rule: if already joined to a channel, reject
      if (this.joined !== null) {
        return { type: 'none' };
      }

      // First human in an allowlisted channel: join
      return { type: 'join-crew', channelId: e.channelId };
    }

    if (e.type === 'human-left') {
      // Ignore if not currently joined
      if (this.joined === null) {
        return { type: 'none' };
      }

      // Ignore if event is for a different channel
      if (e.channelId !== this.joined) {
        return { type: 'none' };
      }

      // If humans drop to zero, leave
      const count = humanCountFor(e.channelId);
      if (count === 0) {
        return { type: 'leave-crew', channelId: e.channelId };
      }

      return { type: 'none' };
    }

    if (e.type === 'join-failed') {
      // State stays unjoined so next human-joined retries
      return { type: 'none' };
    }

    return { type: 'none' };
  }

  joinedChannel(): string | null {
    return this.joined;
  }

  markJoined(channelId: string): void {
    this.joined = channelId;
  }

  markLeft(): void {
    this.joined = null;
  }
}
