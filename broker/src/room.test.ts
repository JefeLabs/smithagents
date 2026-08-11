import assert from "node:assert/strict";
import { test } from "node:test";
// NOTE: import from token.ts (pure) — never from room.ts, which loads @livekit/rtc-node native code.
import { mintRoomToken } from "./token.ts";

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const payload = jwt.split(".")[1]!;
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
}

test("mints a joinable publish/subscribe token for the room", async () => {
  const jwt = await mintRoomToken({
    apiKey: "devkey",
    apiSecret: "secret",
    roomName: "meeting-abc",
    identity: "smith-broker",
  });
  const payload = decodeJwtPayload(jwt);
  assert.equal(payload.sub, "smith-broker");
  const video = payload.video as Record<string, unknown>;
  assert.equal(video.room, "meeting-abc");
  assert.equal(video.roomJoin, true);
  assert.equal(video.canPublish, true);
  assert.equal(video.canSubscribe, true);
});
