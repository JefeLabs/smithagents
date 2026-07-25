import { randomUUID } from 'node:crypto';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
// Agent dispatch types — verified against the installed @livekit/protocol
// version (Task 4 pulls current docs for the worker side).
import { RoomConfiguration, RoomAgentDispatch } from '@livekit/protocol';
import type { ComposedAgent } from './agents.js';
import { findAgent } from './agents.js';
import type { LiveKitConfig } from './config.js';

// The name the LiveKit agent worker registers under (Task 4 `cli.runApp`).
// Explicit dispatch (below) uses it to route our worker into a meeting room.
const AGENT_NAME = 'smith-agent';

export interface Meeting {
  id: string;
  roomName: string;
  agentIds: string[];
  mode: 'solo' | 'council';
  status: 'open' | 'closed';
  createdAt: string;
}

// Field names match LiveKit's token-endpoint convention so Plan 2's client SDK
// TokenSource consumes this response directly.
export interface MeetingJoin {
  meetingId: string;
  roomName: string;
  serverUrl: string;
  participantToken: string;
}

export interface RoomServiceLike {
  createRoom(opts: { name: string }): Promise<unknown>;
  deleteRoom(name: string): Promise<void>;
}

export type MintToken = (identity: string, room: string, agentIds: string[]) => Promise<string>;

/**
 * Opens/closes voice meetings backed by LiveKit rooms. A meeting seats one agent
 * (solo) or all agents (council) plus the human. Real-time media exists only
 * while a meeting is open — this is the "meeting mode only" activation boundary.
 */
export class MeetingOrchestrator {
  private readonly meetings = new Map<string, Meeting>();
  private readonly roomService: RoomServiceLike;
  private readonly mintToken: MintToken;

  constructor(
    private readonly cfg: LiveKitConfig,
    private readonly agents: ComposedAgent[],
    deps?: { roomService?: RoomServiceLike; mintToken?: MintToken },
  ) {
    // livekit-server-sdk's RoomServiceClient takes an HTTP(S) host; LIVEKIT_URL is ws(s).
    const httpUrl = cfg.url.replace(/^ws/, 'http');
    this.roomService =
      deps?.roomService ?? (new RoomServiceClient(httpUrl, cfg.apiKey, cfg.apiSecret) as unknown as RoomServiceLike);
    this.mintToken =
      deps?.mintToken ??
      (async (identity, room, agentIds) => {
        const at = new AccessToken(cfg.apiKey, cfg.apiSecret, { identity, ttl: '2h' });
        at.addGrant({ roomJoin: true, room });
        // Explicit agent dispatch: LiveKit sends our worker into this room and
        // hands it the chosen composed-agent ids as metadata (Task 4 reads them).
        at.roomConfig = new RoomConfiguration({
          agents: [new RoomAgentDispatch({ agentName: AGENT_NAME, metadata: JSON.stringify({ agentIds }) })],
        });
        return at.toJwt();
      });
  }

  async open(scope: { agent?: string; all?: boolean }): Promise<MeetingJoin> {
    let agentIds: string[];
    let mode: Meeting['mode'];
    if (scope.all) {
      agentIds = this.agents.map((a) => a.id);
      mode = 'council';
    } else {
      const found = scope.agent ? findAgent(this.agents, scope.agent) : undefined;
      if (!found) throw new Error(`unknown agent: ${scope.agent}`);
      agentIds = [found.id];
      mode = 'solo';
    }

    const id = randomUUID();
    const roomName = `meeting-${id}`;
    // Rooms auto-create on first join; we create it up front so it exists
    // immediately and so close() can deleteRoom to end the meeting.
    await this.roomService.createRoom({ name: roomName });

    const meeting: Meeting = {
      id,
      roomName,
      agentIds,
      mode,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    this.meetings.set(id, meeting);

    const participantToken = await this.mintToken('human', roomName, agentIds);
    return { meetingId: id, roomName, serverUrl: this.cfg.url, participantToken };
  }

  async close(id: string): Promise<void> {
    const meeting = this.meetings.get(id);
    if (!meeting || meeting.status === 'closed') return;
    await this.roomService.deleteRoom(meeting.roomName);
    meeting.status = 'closed';
  }

  list(): Meeting[] {
    return [...this.meetings.values()];
  }

  get(id: string): Meeting | undefined {
    return this.meetings.get(id);
  }
}
