/** Room-token mint, separated from room.ts so tests avoid the native module. */
import { AccessToken } from 'livekit-server-sdk';

export async function mintRoomToken(opts: {
  apiKey: string;
  apiSecret: string;
  roomName: string;
  identity: string;
}): Promise<string> {
  const at = new AccessToken(opts.apiKey, opts.apiSecret, { identity: opts.identity, ttl: '2h' });
  at.addGrant({ room: opts.roomName, roomJoin: true, canPublish: true, canSubscribe: true });
  return at.toJwt();
}
