import assert from "node:assert/strict";
import { test } from "node:test";
import type { SttLike } from "./broker.ts";
import {
  createDiscordVoiceSurface,
  type VoiceConnectionLike,
  type VoiceGatewayLike,
  type VoiceReceiverLike,
} from "./discord-voice.ts";

// Every existing (mouths-only) test below is indifferent to the ear — these
// two satisfy DiscordVoiceOptions' now-required fields without exercising
// them; UNUSED_MAKE_STT fails loudly if a test's fake receiver ever DOES
// trigger a speaking-start unexpectedly, instead of silently no-opting.
const NOOP_ON_UTTERANCE = (): void => {};
const UNUSED_MAKE_STT = (): SttLike => {
  throw new Error("makeStt should not be called in this test");
};

interface FakeConnection extends VoiceConnectionLike {
  token: string;
  playbacks: Uint8Array[][]; // one entry per playPcm call (one entry per CLOSED segment), each the chunks drained from that call's iterable
  destroyed: boolean;
}

function fakeConnection(token: string): FakeConnection {
  const connection: FakeConnection = {
    token,
    playbacks: [],
    destroyed: false,
    async playPcm(pcm) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of pcm) chunks.push(chunk);
      connection.playbacks.push(chunks);
    },
    destroy() {
      connection.destroyed = true;
    },
  };
  return connection;
}

function fakeGateway() {
  const joins: Array<{ channelId: string; token: string }> = [];
  const connections: FakeConnection[] = [];
  const gateway: VoiceGatewayLike = {
    async join(channelId, token) {
      joins.push({ channelId, token });
      const connection = fakeConnection(token);
      connections.push(connection);
      return connection;
    },
  };
  return { gateway, joins, connections };
}

/**
 * A connection whose iterator is pulled ONE item at a time, only when the
 * test calls `pullOnce()` — unlike `fakeConnection`'s `for await` (which
 * drains as fast as items are pushed), this gives backpressure tests
 * explicit control over when "the consumer" makes progress, independent of
 * when `publishPcm` itself resolves.
 */
function manualConnection(): {
  connection: VoiceConnectionLike;
  drained: Uint8Array[];
  pullOnce(): Promise<IteratorResult<Uint8Array>>;
} {
  const drained: Uint8Array[] = [];
  let iterator: AsyncIterator<Uint8Array> | null = null;
  let resolvePlayPcm: (() => void) | null = null;
  const connection: VoiceConnectionLike = {
    playPcm(pcm) {
      iterator = pcm[Symbol.asyncIterator]();
      return new Promise<void>((resolve) => {
        resolvePlayPcm = resolve;
      });
    },
    destroy() {},
  };
  return {
    connection,
    drained,
    async pullOnce() {
      const result = await iterator!.next();
      if (result.done) resolvePlayPcm?.();
      else drained.push(result.value);
      return result;
    },
  };
}

// SEGMENT_IDLE_GAP_MS / SEGMENT_BACKLOG_CAP_BYTES in discord-voice.ts — kept
// in lockstep with the module's internal constants so tests advance fake
// time / size buffers by exactly enough, without hardcoding a second source
// of truth.
const SEGMENT_IDLE_GAP_MS = 400;
const SEGMENT_BACKLOG_CAP_BYTES = 882_000;

/**
 * Real macrotask boundary: guarantees any pending microtask chain inside the
 * segment machinery (a mock-timer tick resolving a `wake` promise, which
 * resumes an async generator, which ends a `for await` loop, ...) has fully
 * settled. Never touches the mocked setTimeout/clearTimeout pair.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A test-controlled `VoiceReceiverLike`: `trigger` simulates a real speaking-start event. */
function fakeReceiver(): {
  receiver: VoiceReceiverLike;
  trigger: (userId: string, displayName: string, isBot: boolean, pcm48kMono: AsyncIterable<Uint8Array>) => void;
} {
  let cb:
    | ((userId: string, displayName: string, isBot: boolean, pcm48kMono: AsyncIterable<Uint8Array>) => void)
    | null = null;
  return {
    receiver: {
      onSpeakingStart(handler) {
        cb = handler;
      },
    },
    trigger(userId, displayName, isBot, pcm48kMono) {
      cb?.(userId, displayName, isBot, pcm48kMono);
    },
  };
}

interface FakeStt extends SttLike {
  sent: Uint8Array[];
  stopped: boolean;
  fireUtterance(text: string): void;
}

/** A fake `SttLike`: records what it's sent, and lets a test fire its utterance callback on demand. */
function fakeStt(): FakeStt {
  let onUtterance: ((text: string) => void) | null = null;
  const stt: FakeStt = {
    sent: [],
    stopped: false,
    start(cb) {
      onUtterance = cb;
    },
    sendAudio(pcm) {
      stt.sent.push(pcm);
    },
    stop() {
      stt.stopped = true;
    },
    fireUtterance(text) {
      onUtterance?.(text);
    },
  };
  return stt;
}

async function* pcmChunks(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

/** Yields its chunks, then throws — simulates a speaker's stream failing mid-utterance (e.g. a decode error). */
async function* throwingPcm(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk;
  throw new Error("opus decode exploded");
}

// Shared roster: ignacio is discord-voice-designated with a token (real mouth),
// wilkin is discord-voice-designated with NO token (degrades to the ear),
// manuel is designated for text only (never joins voice at all).
const AGENTS = () => [
  { id: "ignacio", channels: ["discord-voice"] },
  { id: "wilkin", channels: ["discord-voice"] },
  { id: "manuel", channels: ["discord"] },
];
const AGENT_TOKENS = () => new Map([["ignacio", "ignacio-token"]]);

test("joinAll connects the ear plus every discord-voice-designated agent with a token, exactly once each", async () => {
  const { gateway, joins } = fakeGateway();
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1"],
    earToken: "ear-token",
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    onUtterance: NOOP_ON_UTTERANCE,
    makeStt: UNUSED_MAKE_STT,
    gateway,
  });

  await surface.joinAll("chan-1");

  assert.deepEqual(joins, [
    { channelId: "chan-1", token: "ear-token" },
    { channelId: "chan-1", token: "ignacio-token" },
  ]);
  assert.deepEqual(surface.connectedAgentIds(), ["ignacio"]);
});

test("publish with a tokened agent's persona id plays on that agent's own connection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gateway, connections } = fakeGateway();
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1"],
    earToken: "ear-token",
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    onUtterance: NOOP_ON_UTTERANCE,
    makeStt: UNUSED_MAKE_STT,
    gateway,
  });
  await surface.joinAll("chan-1");
  const [earConn, ignacioConn] = connections;

  const bytes = new Uint8Array([1, 2, 3]);
  await surface.publishPcm(bytes, 44100, "ignacio");

  // publishPcm resolves once the bytes are queued, not once played — the
  // segment only closes (and playbacks becomes observable) after the idle
  // gap elapses with no further publish.
  t.mock.timers.tick(SEGMENT_IDLE_GAP_MS);
  await flushMicrotasks();

  assert.deepEqual(ignacioConn!.playbacks, [[bytes]]);
  assert.deepEqual(earConn!.playbacks, []);
});

test("publish for a designated-but-untokened agent batches into one segment on the ear connection, with ONE degradation log", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gateway, connections } = fakeGateway();
  const logs: string[] = [];
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1"],
    earToken: "ear-token",
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    onUtterance: NOOP_ON_UTTERANCE,
    makeStt: UNUSED_MAKE_STT,
    gateway,
    log: (line) => logs.push(line),
  });

  await surface.joinAll("chan-1");
  const wilkinLogsAfterJoin = logs.filter((l) => l.includes("wilkin"));
  assert.equal(wilkinLogsAfterJoin.length, 1, "exactly one degradation log at join time");

  const [earConn] = connections;
  const chunks = [new Uint8Array([9]), new Uint8Array([9]), new Uint8Array([9])];
  for (const chunk of chunks) await surface.publishPcm(chunk, 44100, "wilkin");

  assert.equal(logs.filter((l) => l.includes("wilkin")).length, 1, "no per-chunk spam");
  assert.equal(earConn!.playbacks.length, 0, "segment still open — nothing closed yet");

  t.mock.timers.tick(SEGMENT_IDLE_GAP_MS);
  await flushMicrotasks();

  // Same persona, no gap between publishes -> one open segment -> exactly
  // one playPcm() call carrying all three chunks, not three separate calls.
  assert.equal(earConn!.playbacks.length, 1, "all three chunks batched into one playPcm call");
  assert.deepEqual(earConn!.playbacks[0], chunks);
  assert.equal(surface.connectedAgentIds().includes("wilkin"), false);
});

test("publish with an unknown persona id, then a different unknown/undefined persona id, closes the first segment and opens a second on the ear", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gateway, connections } = fakeGateway();
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1"],
    earToken: "ear-token",
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    onUtterance: NOOP_ON_UTTERANCE,
    makeStt: UNUSED_MAKE_STT,
    gateway,
  });
  await surface.joinAll("chan-1");
  const [earConn] = connections;

  const first = new Uint8Array([1]);
  const second = new Uint8Array([2]);
  await surface.publishPcm(first, 44100, "nobody-the-broker-knows");
  // Different persona id (here: undefined) on the same connection — the ear
  // must not splice two different speakers into one continuous segment, so
  // this closes the first segment and opens a second immediately, with no
  // idle gap required.
  await surface.publishPcm(second, 44100, undefined);

  t.mock.timers.tick(SEGMENT_IDLE_GAP_MS);
  await flushMicrotasks();

  assert.equal(earConn!.playbacks.length, 2, "persona switch produced two separate playPcm calls");
  assert.deepEqual(earConn!.playbacks, [[first], [second]]);
});

test("leaveAll destroys the ear and every agent connection", async () => {
  const { gateway, connections } = fakeGateway();
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1"],
    earToken: "ear-token",
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    onUtterance: NOOP_ON_UTTERANCE,
    makeStt: UNUSED_MAKE_STT,
    gateway,
  });
  await surface.joinAll("chan-1");

  await surface.leaveAll();

  assert.equal(connections.length, 2); // ear + ignacio
  assert.ok(connections.every((c) => c.destroyed));
  assert.deepEqual(surface.connectedAgentIds(), []);
});

test("leaveAll tears down every connection even when one connection's destroy() throws", async () => {
  // Regression: @discordjs/voice's VoiceConnection.destroy() THROWS on an
  // already-destroyed connection ("Cannot destroy VoiceConnection - it has
  // already been destroyed"). Before each teardown was isolated, one
  // mouth's throw aborted leaveAll partway — the caller's leave-crew path
  // (main.ts) never reached detachVoiceSurface/markLeft, wedging the
  // surface attached until restart. leaveAll must finish tearing down
  // every OTHER connection and STT session regardless.
  const { gateway, connections } = fakeGateway();
  const logs: string[] = [];
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1"],
    earToken: "ear-token",
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    onUtterance: NOOP_ON_UTTERANCE,
    makeStt: UNUSED_MAKE_STT,
    gateway,
    log: (line) => logs.push(line),
  });
  await surface.joinAll("chan-1");
  const [earConn, ignacioConn] = connections;
  earConn!.destroy = () => {
    throw new Error("Cannot destroy VoiceConnection - it has already been destroyed");
  };

  await assert.doesNotReject(surface.leaveAll());

  assert.ok(ignacioConn!.destroyed, "ignacio's connection was torn down despite the ear's destroy() throwing");
  assert.deepEqual(surface.connectedAgentIds(), []);
  assert.ok(
    logs.some((l) => l.includes("ear teardown failed")),
    "the ear failure was logged readably, not swallowed silently",
  );
});

test("a second joinAll after leaveAll reconnects everything fresh", async () => {
  const { gateway, joins, connections } = fakeGateway();
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1"],
    earToken: "ear-token",
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    onUtterance: NOOP_ON_UTTERANCE,
    makeStt: UNUSED_MAKE_STT,
    gateway,
  });

  await surface.joinAll("chan-1");
  await surface.leaveAll();
  await surface.joinAll("chan-1");

  assert.equal(joins.length, 4); // (ear + ignacio) x2
  assert.equal(connections.length, 4);
  assert.deepEqual(surface.connectedAgentIds(), ["ignacio"]);
  // the fresh connections are live (not the destroyed originals)
  assert.ok(connections.slice(2).every((c) => !c.destroyed));
});

test("joinAll is a no-op when already joined the same channel, and leaves first when switching channels", async () => {
  const { gateway, joins, connections } = fakeGateway();
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1", "chan-2"],
    earToken: "ear-token",
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    onUtterance: NOOP_ON_UTTERANCE,
    makeStt: UNUSED_MAKE_STT,
    gateway,
  });

  await surface.joinAll("chan-1");
  await surface.joinAll("chan-1"); // same channel — must not clobber or leak the existing connections

  assert.equal(joins.length, 2, "no second round of joins for a repeat call to the same channel");
  assert.equal(connections.length, 2);
  assert.ok(
    connections.every((c) => !c.destroyed),
    "the original connections are still live",
  );
  assert.deepEqual(surface.connectedAgentIds(), ["ignacio"]);

  await surface.joinAll("chan-2"); // different channel — must leave chan-1 before joining chan-2

  assert.ok(
    connections.slice(0, 2).every((c) => c.destroyed),
    "chan-1 connections were torn down",
  );
  assert.deepEqual(
    joins.slice(2),
    [
      { channelId: "chan-2", token: "ear-token" },
      { channelId: "chan-2", token: "ignacio-token" },
    ],
    "fresh joins landed on chan-2",
  );
  assert.equal(connections.length, 4);
});

test("joinAll declines a non-allowlisted channel and connects nothing", async () => {
  const { gateway, joins } = fakeGateway();
  const logs: string[] = [];
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1"],
    earToken: "ear-token",
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    onUtterance: NOOP_ON_UTTERANCE,
    makeStt: UNUSED_MAKE_STT,
    gateway,
    log: (line) => logs.push(line),
  });

  await surface.joinAll("some-other-channel");

  assert.deepEqual(joins, []);
  assert.deepEqual(surface.connectedAgentIds(), []);
  assert.ok(logs.some((l) => l.includes("some-other-channel")));
});

test("a declined channel switch leaves the currently joined channel fully intact", async () => {
  const { gateway, joins, connections } = fakeGateway();
  const logs: string[] = [];
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1"], // chan-2 is deliberately NOT allowlisted
    earToken: "ear-token",
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    onUtterance: NOOP_ON_UTTERANCE,
    makeStt: UNUSED_MAKE_STT,
    gateway,
    log: (line) => logs.push(line),
  });

  await surface.joinAll("chan-1");
  const joinedConnections = [...connections];

  await surface.joinAll("chan-2"); // declined — must NOT tear down chan-1 first

  assert.equal(joins.length, 2, "no join attempt was made for the declined channel");
  assert.ok(
    logs.some((l) => l.includes("chan-2")),
    "the decline was logged",
  );
  assert.ok(
    joinedConnections.every((c) => !c.destroyed),
    "chan-1 connections were never torn down",
  );
  assert.deepEqual(surface.connectedAgentIds(), ["ignacio"], "still fully joined to chan-1");

  // chan-1 is still live: a publish still reaches ignacio's own connection.
  const [, ignacioConn] = connections;
  await surface.publishPcm(new Uint8Array([1]), 44100, "ignacio");
  assert.ok(ignacioConn === joinedConnections[1], "still the original chan-1 connection, not a fresh one");
});

test("an agent whose real join rejects degrades to the ear with one log line, same as an untokened agent", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const earConn = fakeConnection("ear-token");
  const joinedTokens: string[] = [];
  const gateway: VoiceGatewayLike = {
    async join(_channelId, token) {
      joinedTokens.push(token);
      if (token === "bad-token") throw new Error("4004: Authentication failed");
      return earConn;
    },
  };
  const logs: string[] = [];
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1"],
    earToken: "ear-token",
    agentTokens: new Map([["ignacio", "bad-token"]]),
    agents: () => [{ id: "ignacio", channels: ["discord-voice"] }],
    onUtterance: NOOP_ON_UTTERANCE,
    makeStt: UNUSED_MAKE_STT,
    gateway,
    log: (line) => logs.push(line),
  });

  await surface.joinAll("chan-1");

  assert.deepEqual(joinedTokens, ["ear-token", "bad-token"]);
  assert.deepEqual(surface.connectedAgentIds(), []);
  assert.equal(logs.filter((l) => l.includes("ignacio")).length, 1);

  await surface.publishPcm(new Uint8Array([1]), 44100, "ignacio");
  t.mock.timers.tick(SEGMENT_IDLE_GAP_MS);
  await flushMicrotasks();
  assert.equal(earConn.playbacks.length, 1);
});

test("N rapid publishes to one persona batch into exactly one playPcm call, with buffers in order", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gateway, connections } = fakeGateway();
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1"],
    earToken: "ear-token",
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    onUtterance: NOOP_ON_UTTERANCE,
    makeStt: UNUSED_MAKE_STT,
    gateway,
  });
  await surface.joinAll("chan-1");
  const [, ignacioConn] = connections;

  const chunks = Array.from({ length: 5 }, (_, i) => new Uint8Array([i]));
  for (const chunk of chunks) await surface.publishPcm(chunk, 44100, "ignacio");

  assert.equal(ignacioConn!.playbacks.length, 0, "segment still open — no idle gap yet");

  t.mock.timers.tick(SEGMENT_IDLE_GAP_MS);
  await flushMicrotasks();

  assert.equal(ignacioConn!.playbacks.length, 1, "all five publishes landed in one playPcm() call");
  assert.deepEqual(ignacioConn!.playbacks[0], chunks, "buffers preserved their publish order");
});

test("an idle gap after the last publish closes the segment; the next publish opens a fresh one", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gateway, connections } = fakeGateway();
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1"],
    earToken: "ear-token",
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    onUtterance: NOOP_ON_UTTERANCE,
    makeStt: UNUSED_MAKE_STT,
    gateway,
  });
  await surface.joinAll("chan-1");
  const [, ignacioConn] = connections;

  await surface.publishPcm(new Uint8Array([1]), 44100, "ignacio");
  t.mock.timers.tick(SEGMENT_IDLE_GAP_MS);
  await flushMicrotasks();
  assert.equal(ignacioConn!.playbacks.length, 1, "first segment closed on the idle gap");

  await surface.publishPcm(new Uint8Array([2]), 44100, "ignacio");
  t.mock.timers.tick(SEGMENT_IDLE_GAP_MS);
  await flushMicrotasks();

  assert.equal(ignacioConn!.playbacks.length, 2, "the post-gap publish opened a second, independent segment");
  assert.deepEqual(ignacioConn!.playbacks, [[new Uint8Array([1])], [new Uint8Array([2])]]);
});

test("per-connection ordering: a segment that opens while the previous one is still playing waits for it to settle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const order: string[] = [];
  let releaseFirst: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let sawFirst = false;
  const connection: VoiceConnectionLike = {
    async playPcm(pcm) {
      const isFirst = !sawFirst;
      sawFirst = true;
      order.push(isFirst ? "first-start" : "second-start");
      if (isFirst) await gate; // simulates a still-playing first segment
      for await (const _chunk of pcm) {
        // drain
      }
      order.push(isFirst ? "first-end" : "second-end");
    },
    destroy() {},
  };
  const gateway: VoiceGatewayLike = { join: async () => connection };
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1"],
    earToken: "ear-token",
    agentTokens: new Map(),
    agents: () => [],
    onUtterance: NOOP_ON_UTTERANCE,
    makeStt: UNUSED_MAKE_STT,
    gateway,
  });
  await surface.joinAll("chan-1"); // only the ear connects — agents() is empty

  await surface.publishPcm(new Uint8Array([1]), 44100); // opens segment 1; its playPcm() call is now gated
  // The idle gap closes segment 1's queue (so its playPcm() can eventually
  // drain and finish once released) without waiting for playback itself —
  // publishPcm never blocks on playback under the new design.
  t.mock.timers.tick(SEGMENT_IDLE_GAP_MS);
  await flushMicrotasks();

  const second = surface.publishPcm(new Uint8Array([2]), 44100); // opens segment 2, chained after segment 1's tail
  await flushMicrotasks();
  assert.deepEqual(order, ["first-start"], "segment 2's playPcm must not start before segment 1's settles");

  releaseFirst();
  await second;
  t.mock.timers.tick(SEGMENT_IDLE_GAP_MS);
  await flushMicrotasks();

  assert.deepEqual(order, ["first-start", "first-end", "second-start", "second-end"]);
});

test("publishPcm resolves immediately while the segment backlog stays under the cap", async () => {
  const { connection, drained } = manualConnection();
  const gateway: VoiceGatewayLike = { join: async () => connection };
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1"],
    earToken: "ear-token",
    agentTokens: new Map(),
    agents: () => [],
    onUtterance: NOOP_ON_UTTERANCE,
    makeStt: UNUSED_MAKE_STT,
    gateway,
  });
  await surface.joinAll("chan-1");

  const small = new Uint8Array(1000); // well under SEGMENT_BACKLOG_CAP_BYTES
  await surface.publishPcm(small, 44100); // must resolve with nobody pulling from the iterable

  assert.deepEqual(drained, [], "no playback progress happened — publishPcm resolved on enqueue alone");
});

test("publishPcm pends once the segment backlog exceeds the cap, until the fake consumer drains it", async () => {
  const { connection, drained, pullOnce } = manualConnection();
  const gateway: VoiceGatewayLike = { join: async () => connection };
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1"],
    earToken: "ear-token",
    agentTokens: new Map(),
    agents: () => [],
    onUtterance: NOOP_ON_UTTERANCE,
    makeStt: UNUSED_MAKE_STT,
    gateway,
  });
  await surface.joinAll("chan-1");

  const huge = new Uint8Array(SEGMENT_BACKLOG_CAP_BYTES + 1); // a single push that alone crosses the cap
  let resolved = false;
  const publish = surface.publishPcm(huge, 44100).then(() => {
    resolved = true;
  });

  await flushMicrotasks(); // let the chained playPcm() call attach; the push is now gated on the backlog
  assert.equal(resolved, false, "an over-cap push must not resolve before the consumer drains it");

  await pullOnce(); // the fake consumer pulls the one buffered chunk, dropping the backlog back under the cap
  await publish;

  assert.equal(resolved, true);
  assert.deepEqual(drained, [huge]);
});

test("a settled (rejected) playPcm closes its segment: a parked over-cap push resolves, and the next publish opens a fresh segment", async () => {
  // Regression: before openSegment's tail chain closed the segment on
  // playPcm() settling, a connection whose playPcm() finished (resolved,
  // rejected, or timed out) WITHOUT the segment ever idling out or a
  // persona switch left mouth.segment pointed at a segment nobody was
  // pulling from anymore. Any further push to that mouth was silently lost
  // below the backlog cap, and a push that crossed the cap pended forever
  // — nothing left to drain it — wedging every later publishPcm on this
  // mouth (and, transitively, the broker's serialized speech chain).
  let playCalls = 0;
  const connection: VoiceConnectionLike = {
    async playPcm(_pcm) {
      playCalls += 1;
      // Rejects WITHOUT ever touching the iterable — simulates a connection
      // failure mid-segment (e.g. the underlying player erroring out) that
      // leaves whatever was already queued in the segment unpulled.
      throw new Error("connection died mid-segment");
    },
    destroy() {},
  };
  const gateway: VoiceGatewayLike = { join: async () => connection };
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1"],
    earToken: "ear-token",
    agentTokens: new Map(),
    agents: () => [],
    onUtterance: NOOP_ON_UTTERANCE,
    makeStt: UNUSED_MAKE_STT,
    gateway,
  });
  await surface.joinAll("chan-1");

  // A push that alone crosses the backlog cap: with the segment held open
  // by a dead (already-settled) playPcm() call, this would pend forever.
  const huge = new Uint8Array(SEGMENT_BACKLOG_CAP_BYTES + 1);
  let resolved = false;
  const publish = surface.publishPcm(huge, 44100).then(() => {
    resolved = true;
  });

  await flushMicrotasks(); // let the chained playPcm() call attach and reject
  assert.equal(playCalls, 1, "the segment opened and called playPcm once");
  await publish; // must resolve — the settled playPcm closes the segment and releases the parked push
  assert.equal(resolved, true, "the parked push was released once the segment closed on playPcm settling");

  // A subsequent publish must open a FRESH segment (a second playPcm call),
  // not silently write into the dead one nobody's pulling from.
  await surface.publishPcm(new Uint8Array([1]), 44100);
  await flushMicrotasks();
  assert.equal(playCalls, 2, "the next publish opened a new segment instead of reusing the dead one");
});

test("a human speaking-start creates a per-user STT session; its utterance callback pre-attributes the turn", async () => {
  const { gateway } = fakeGateway();
  const { receiver, trigger } = fakeReceiver();
  const sttInstances: FakeStt[] = [];
  const rates: number[] = [];
  const utterances: string[] = [];
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1"],
    earToken: "ear-token",
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    onUtterance: (text) => utterances.push(text),
    makeStt: (sampleRate) => {
      rates.push(sampleRate);
      const stt = fakeStt();
      sttInstances.push(stt);
      return stt;
    },
    gateway,
    receiver,
  });
  await surface.joinAll("chan-1");

  const chunk1 = new Uint8Array([1]);
  const chunk2 = new Uint8Array([2]);
  trigger("u-edwin", "Edwin", false, pcmChunks(chunk1, chunk2));
  await flushMicrotasks();

  assert.deepEqual(rates, [48000], "the ear's STT sessions run at Discord's receive rate, not the mouths' 44.1kHz");
  assert.equal(sttInstances.length, 1);
  assert.deepEqual(sttInstances[0]!.sent, [chunk1, chunk2], "chunks forwarded to the session in order");

  sttInstances[0]!.fireUtterance("que lo que");
  assert.deepEqual(utterances, ["Edwin (via discord-voice): que lo que"]);
});

test("bot and webhook speakers never create an STT session, including a mouth's own bot id", async () => {
  const { gateway } = fakeGateway();
  const { receiver, trigger } = fakeReceiver();
  let makeSttCalls = 0;
  const utterances: string[] = [];
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1"],
    earToken: "ear-token",
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    onUtterance: (text) => utterances.push(text),
    makeStt: () => {
      makeSttCalls += 1;
      return fakeStt();
    },
    gateway,
    receiver,
  });
  await surface.joinAll("chan-1");

  // "ignacio-bot-id" stands in for one of the crew's own mouths speaking in
  // the same VC — the ear must not transcribe the crew talking to itself.
  trigger("ignacio-bot-id", "Ignacio", true, pcmChunks(new Uint8Array([9])));
  await flushMicrotasks();

  assert.equal(makeSttCalls, 0, "a bot speaker must never get an STT session");
  assert.deepEqual(utterances, []);
});

test("two humans get two independent STT sessions, keyed by userId and reused on a later speaking-start", async () => {
  const { gateway } = fakeGateway();
  const { receiver, trigger } = fakeReceiver();
  const sttInstances: FakeStt[] = [];
  const utterances: string[] = [];
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1"],
    earToken: "ear-token",
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    onUtterance: (text) => utterances.push(text),
    makeStt: () => {
      const stt = fakeStt();
      sttInstances.push(stt);
      return stt;
    },
    gateway,
    receiver,
  });
  await surface.joinAll("chan-1");

  const a = new Uint8Array([1]);
  const b = new Uint8Array([2]);
  trigger("u1", "Edwin", false, pcmChunks(a));
  trigger("u2", "Maria", false, pcmChunks(b));
  await flushMicrotasks();

  assert.equal(sttInstances.length, 2, "two independent sessions, one per speaker");

  const c = new Uint8Array([3]);
  trigger("u1", "Edwin", false, pcmChunks(c)); // u1's SECOND speaking-start
  await flushMicrotasks();

  assert.equal(sttInstances.length, 2, "no new session was created — u1 reused their existing one");
  assert.deepEqual(sttInstances[0]!.sent, [a, c], "both of u1's speaking-starts fed the same underlying session");
  assert.deepEqual(sttInstances[1]!.sent, [b], "u2's session is untouched by u1's second speaking-start");

  sttInstances[0]!.fireUtterance("hola");
  sttInstances[1]!.fireUtterance("oye");
  assert.deepEqual(utterances, ["Edwin (via discord-voice): hola", "Maria (via discord-voice): oye"]);
});

test("a speaker's STT session error kills only that speaker's session, logged readably; other speakers keep working", async () => {
  const { gateway } = fakeGateway();
  const { receiver, trigger } = fakeReceiver();
  const sttInstances: FakeStt[] = [];
  const utterances: string[] = [];
  const logs: string[] = [];
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1"],
    earToken: "ear-token",
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    onUtterance: (text) => utterances.push(text),
    makeStt: () => {
      const stt = fakeStt();
      sttInstances.push(stt);
      return stt;
    },
    gateway,
    log: (line) => logs.push(line),
    receiver,
  });
  await surface.joinAll("chan-1");

  trigger("u1", "Edwin", false, throwingPcm(new Uint8Array([1])));
  trigger("u2", "Maria", false, pcmChunks(new Uint8Array([2])));
  await flushMicrotasks();

  assert.ok(
    logs.some((l) => l.includes("Edwin")),
    "the failure is logged readably, naming the speaker",
  );
  assert.ok(sttInstances[0]!.stopped, "the failed speaker's session was stopped and torn down");

  sttInstances[1]!.fireUtterance("still here");
  assert.deepEqual(utterances, ["Maria (via discord-voice): still here"], "the other speaker's session is unaffected");

  // Recoverable: a later speaking-start for the SAME (previously failed) user opens a fresh session.
  trigger("u1", "Edwin", false, pcmChunks(new Uint8Array([3])));
  await flushMicrotasks();
  assert.equal(sttInstances.length, 3, "u1's next speaking-start created a brand-new session");
});

test("leaveAll stops every open STT session", async () => {
  const { gateway } = fakeGateway();
  const { receiver, trigger } = fakeReceiver();
  const sttInstances: FakeStt[] = [];
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1"],
    earToken: "ear-token",
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    onUtterance: NOOP_ON_UTTERANCE,
    makeStt: () => {
      const stt = fakeStt();
      sttInstances.push(stt);
      return stt;
    },
    gateway,
    receiver,
  });
  await surface.joinAll("chan-1");

  trigger("u1", "Edwin", false, pcmChunks(new Uint8Array([1])));
  trigger("u2", "Maria", false, pcmChunks(new Uint8Array([2])));
  await flushMicrotasks();
  assert.equal(sttInstances.length, 2);

  await surface.leaveAll();

  assert.ok(
    sttInstances.every((s) => s.stopped),
    "every open session was stopped",
  );
});

// Mode-aware voice joins (Presence Task 2): agents whose `channels` field is
// the mode-map form (surface-modes.ts's parser output), not the legacy array
// used by AGENTS/AGENT_TOKENS above. ignacio is autojoin, wilkin is
// on-request (never auto-joins — only reachable via joinAgent), manuel is
// disabled (never joins at all). All three have bot tokens, so the only
// thing distinguishing them here is mode, not token availability.
const MODE_AGENTS = () => [
  { id: "ignacio", channels: { "discord-voice": "autojoin" } },
  { id: "wilkin", channels: { "discord-voice": "on-request" } },
  { id: "manuel", channels: { "discord-voice": "disabled" } },
];
const MODE_AGENT_TOKENS = () =>
  new Map([
    ["ignacio", "ignacio-token"],
    ["wilkin", "wilkin-token"],
    ["manuel", "manuel-token"],
  ]);

test("joinAll joins only discord-voice autojoin agents (map form)", async () => {
  const { gateway } = fakeGateway();
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1"],
    earToken: "ear-token",
    agentTokens: MODE_AGENT_TOKENS(),
    agents: MODE_AGENTS,
    onUtterance: NOOP_ON_UTTERANCE,
    makeStt: UNUSED_MAKE_STT,
    gateway,
  });

  await surface.joinAll("chan-1");

  assert.deepEqual(
    surface.connectedAgentIds(),
    ["ignacio"],
    "only the autojoin agent connects — on-request and disabled agents do not, even though both have tokens",
  );
});

test("joinAgent joins one on-request agent into the current room; throws with no room", async () => {
  const { gateway, joins } = fakeGateway();
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1"],
    earToken: "ear-token",
    agentTokens: MODE_AGENT_TOKENS(),
    agents: MODE_AGENTS,
    onUtterance: NOOP_ON_UTTERANCE,
    makeStt: UNUSED_MAKE_STT,
    gateway,
  });

  await assert.rejects(surface.joinAgent("wilkin"), /no active voice channel/);

  await surface.joinAll("chan-1"); // ear + ignacio
  await surface.joinAgent("wilkin");
  assert.deepEqual(surface.connectedAgentIds().sort(), ["ignacio", "wilkin"]);

  const joinsAfterSummon = joins.length;
  await surface.joinAgent("wilkin"); // already connected — no-op
  assert.equal(joins.length, joinsAfterSummon, "a second joinAgent is a no-op, not a duplicate connection");
  assert.deepEqual(surface.connectedAgentIds().sort(), ["ignacio", "wilkin"]);
});

test("joinAgent throws when the agent has no bot token", async () => {
  const { gateway } = fakeGateway();
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1"],
    earToken: "ear-token",
    agentTokens: new Map(), // nobody has a token
    agents: MODE_AGENTS,
    onUtterance: NOOP_ON_UTTERANCE,
    makeStt: UNUSED_MAKE_STT,
    gateway,
  });
  await surface.joinAll("chan-1");

  await assert.rejects(surface.joinAgent("wilkin"), /wilkin has no bot token/);
});

test("leaveAgent disconnects exactly that agent; others stay", async () => {
  const { gateway } = fakeGateway();
  const surface = createDiscordVoiceSurface({
    allowlist: ["chan-1"],
    earToken: "ear-token",
    agentTokens: MODE_AGENT_TOKENS(),
    agents: MODE_AGENTS,
    onUtterance: NOOP_ON_UTTERANCE,
    makeStt: UNUSED_MAKE_STT,
    gateway,
  });
  await surface.joinAll("chan-1"); // ear + ignacio
  await surface.joinAgent("wilkin");
  assert.deepEqual(surface.connectedAgentIds().sort(), ["ignacio", "wilkin"]);

  surface.leaveAgent("wilkin");

  assert.deepEqual(surface.connectedAgentIds(), ["ignacio"], "only wilkin left — ignacio's own mouth is untouched");

  assert.doesNotThrow(
    () => surface.leaveAgent("nobody-connected"),
    "leaveAgent on an absent agent is a no-op, not a throw",
  );
});
