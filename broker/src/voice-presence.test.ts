import assert from "node:assert/strict";
import { test } from "node:test";
import { VoicePresence } from "./voice-presence.ts";

test("non-allowlisted channel human-joined → none", () => {
  const vp = new VoicePresence(["allowed-1", "allowed-2"]);
  const action = vp.handle({ type: "human-joined", channelId: "not-allowed" }, () => 1);
  assert.deepEqual(action, { type: "none" });
  assert.equal(vp.joinedChannel(), null);
});

test("first human in allowlisted channel → join-crew", () => {
  const vp = new VoicePresence(["allowed-1", "allowed-2"]);
  const action = vp.handle({ type: "human-joined", channelId: "allowed-1" }, () => 1);
  assert.deepEqual(action, { type: "join-crew", channelId: "allowed-1" });
  assert.equal(vp.joinedChannel(), null); // state not updated until markJoined
});

test("markJoined updates joinedChannel", () => {
  const vp = new VoicePresence(["allowed-1"]);
  vp.handle({ type: "human-joined", channelId: "allowed-1" }, () => 1);
  vp.markJoined("allowed-1");
  assert.equal(vp.joinedChannel(), "allowed-1");
});

test("second human while joined → none", () => {
  const vp = new VoicePresence(["allowed-1"]);
  vp.handle({ type: "human-joined", channelId: "allowed-1" }, () => 1);
  vp.markJoined("allowed-1");
  const action = vp.handle({ type: "human-joined", channelId: "allowed-1" }, () => 2);
  assert.deepEqual(action, { type: "none" });
});

test("human-left with multiple humans remaining → none", () => {
  const vp = new VoicePresence(["allowed-1"]);
  vp.handle({ type: "human-joined", channelId: "allowed-1" }, () => 2);
  vp.markJoined("allowed-1");
  const action = vp.handle({ type: "human-left", channelId: "allowed-1" }, () => 1);
  assert.deepEqual(action, { type: "none" });
});

test("humans drop to zero → leave-crew", () => {
  const vp = new VoicePresence(["allowed-1"]);
  vp.handle({ type: "human-joined", channelId: "allowed-1" }, () => 1);
  vp.markJoined("allowed-1");
  const action = vp.handle({ type: "human-left", channelId: "allowed-1" }, () => 0);
  assert.deepEqual(action, { type: "leave-crew", channelId: "allowed-1" });
});

test("markLeft clears joinedChannel", () => {
  const vp = new VoicePresence(["allowed-1"]);
  vp.handle({ type: "human-joined", channelId: "allowed-1" }, () => 1);
  vp.markJoined("allowed-1");
  assert.equal(vp.joinedChannel(), "allowed-1");
  vp.markLeft();
  assert.equal(vp.joinedChannel(), null);
});

test("human joins a SECOND allowlisted channel while crew is in the first → none (single-room rule)", () => {
  const vp = new VoicePresence(["allowed-1", "allowed-2"]);
  vp.handle({ type: "human-joined", channelId: "allowed-1" }, () => 1);
  vp.markJoined("allowed-1");
  const action = vp.handle({ type: "human-joined", channelId: "allowed-2" }, () => 1);
  assert.deepEqual(action, { type: "none" });
  assert.equal(vp.joinedChannel(), "allowed-1");
});

test("join-failed → state stays unjoined", () => {
  const vp = new VoicePresence(["allowed-1"]);
  vp.handle({ type: "human-joined", channelId: "allowed-1" }, () => 1);
  // Do NOT call markJoined
  const action = vp.handle({ type: "join-failed", channelId: "allowed-1" }, () => 1);
  assert.deepEqual(action, { type: "none" });
  assert.equal(vp.joinedChannel(), null);
});

test("after join-failed, next human-joined in same channel retries", () => {
  const vp = new VoicePresence(["allowed-1"]);
  vp.handle({ type: "human-joined", channelId: "allowed-1" }, () => 1);
  vp.handle({ type: "join-failed", channelId: "allowed-1" }, () => 1);
  const action = vp.handle({ type: "human-joined", channelId: "allowed-1" }, () => 1);
  assert.deepEqual(action, { type: "join-crew", channelId: "allowed-1" });
});

test("events for the joined channel after markLeft behave as fresh", () => {
  const vp = new VoicePresence(["allowed-1"]);
  vp.handle({ type: "human-joined", channelId: "allowed-1" }, () => 1);
  vp.markJoined("allowed-1");
  vp.markLeft();
  const action = vp.handle({ type: "human-joined", channelId: "allowed-1" }, () => 1);
  assert.deepEqual(action, { type: "join-crew", channelId: "allowed-1" });
});

test("human-left from non-joined channel → none", () => {
  const vp = new VoicePresence(["allowed-1"]);
  const action = vp.handle({ type: "human-left", channelId: "allowed-1" }, () => 0);
  assert.deepEqual(action, { type: "none" });
});

test("join-failed from non-joined channel → none", () => {
  const vp = new VoicePresence(["allowed-1"]);
  const action = vp.handle({ type: "join-failed", channelId: "allowed-1" }, () => 1);
  assert.deepEqual(action, { type: "none" });
});

test("human-left for a different allowlisted channel while joined elsewhere → none", () => {
  const vp = new VoicePresence(["allowed-1", "allowed-2"]);
  vp.handle({ type: "human-joined", channelId: "allowed-1" }, () => 1);
  vp.markJoined("allowed-1");
  const action = vp.handle({ type: "human-left", channelId: "allowed-2" }, () => 0);
  assert.deepEqual(action, { type: "none" });
  assert.equal(vp.joinedChannel(), "allowed-1");
});
