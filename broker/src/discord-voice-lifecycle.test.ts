import assert from "node:assert/strict";
import { test } from "node:test";
import type { createDiscordVoiceSurface } from "./discord-voice.ts";
import {
  createDiscordVoiceLifecycle,
  type DiscordEarClientLike,
  type DiscordEarVoiceStateLike,
  type DiscordVoiceLifecycleDeps,
} from "./discord-voice-lifecycle.ts";
import type { VoicePresence } from "./voice-presence.ts";

type Surface = ReturnType<typeof createDiscordVoiceSurface>;

/** Models createEarClient's real return shape without touching discord.js or the network. */
function fakeEarClient() {
  const loginCalls: string[] = [];
  let destroyCalls = 0;
  const voiceStateHandlers: Array<(oldState: DiscordEarVoiceStateLike, newState: DiscordEarVoiceStateLike) => void> =
    [];
  const client: DiscordEarClientLike = {
    login: async (token) => {
      loginCalls.push(token);
    },
    destroy: async () => {
      destroyCalls += 1;
    },
    on: (event, handler) => {
      if (event === "voiceStateUpdate") voiceStateHandlers.push(handler);
    },
    channels: {
      fetch: async () => {
        throw new Error("channels.fetch should not be called in this test");
      },
      cache: { get: () => undefined },
    },
  };
  return {
    client,
    loginCalls,
    destroyCalls: () => destroyCalls,
    voiceStateHandlers,
  };
}

function fakeDeps(overrides: Partial<DiscordVoiceLifecycleDeps> = {}) {
  const revoked: string[] = [];
  const attachCalls: Array<{ publishPcm: unknown }> = [];
  let detachCalls = 0;
  const utterances: string[] = [];
  const surfaceChanges: Array<{ surface: Surface | null; presence: VoicePresence | null }> = [];
  const deps: DiscordVoiceLifecycleDeps = {
    directory: { list: () => [] },
    policy: { revokeAll: (surface) => void revoked.push(surface) },
    broker: {
      attachVoiceSurface: (surface) => {
        attachCalls.push(surface);
        return true;
      },
      detachVoiceSurface: () => {
        detachCalls += 1;
      },
    },
    onUtterance: (text) => void utterances.push(text),
    makeStt: () => {
      throw new Error("makeStt should not be called in this test");
    },
    onSurfaceChange: (surface, presence) => void surfaceChanges.push({ surface, presence }),
    checkFfmpeg: () => true,
    ...overrides,
  };
  return { deps, revoked, attachCalls, detachCalls: () => detachCalls, utterances, surfaceChanges };
}

test("bootDiscordVoice: ffmpeg unavailable returns null without constructing an ear client", async () => {
  const { deps, surfaceChanges } = fakeDeps({
    checkFfmpeg: () => false,
    createEarClient: () => {
      throw new Error("createEarClient should not be called when ffmpeg is unavailable");
    },
  });
  const lifecycle = createDiscordVoiceLifecycle(deps);
  const result = await lifecycle.bootDiscordVoice("tok", ["chan-1"]);
  assert.equal(result, null);
  assert.deepEqual(surfaceChanges, []);
});

test("bootDiscordVoice: missing token returns null without constructing an ear client", async () => {
  const { deps, surfaceChanges } = fakeDeps({
    createEarClient: () => {
      throw new Error("createEarClient should not be called when the token is missing");
    },
  });
  const lifecycle = createDiscordVoiceLifecycle(deps);
  const result = await lifecycle.bootDiscordVoice(undefined, ["chan-1"]);
  assert.equal(result, null);
  assert.deepEqual(surfaceChanges, []);
});

test("bootDiscordVoice: no STT or TTS keys configured returns null without constructing an ear client", async () => {
  const { deps, surfaceChanges } = fakeDeps({
    voiceCapabilities: () => ({ stt: false, tts: false }),
    createEarClient: () => {
      throw new Error("createEarClient should not be called when no voice keys are configured");
    },
  });
  const lifecycle = createDiscordVoiceLifecycle(deps);
  const result = await lifecycle.bootDiscordVoice("tok", ["chan-1"]);
  assert.equal(result, null);
  assert.deepEqual(surfaceChanges, []);
});

test("bootDiscordVoice: logs in the injected ear client and reports the new surface/presence via onSurfaceChange", async () => {
  const fakeClient = fakeEarClient();
  const { deps, surfaceChanges } = fakeDeps({ createEarClient: () => fakeClient.client });
  const lifecycle = createDiscordVoiceLifecycle(deps);
  const teardown = await lifecycle.bootDiscordVoice("ear-tok", ["chan-1"]);

  assert.equal(typeof teardown, "function");
  assert.deepEqual(fakeClient.loginCalls, ["ear-tok"]);
  assert.equal(surfaceChanges.length, 1);
  assert.notEqual(surfaceChanges[0]!.surface, null);
  assert.notEqual(surfaceChanges[0]!.presence, null);
  // Registers exactly one voiceStateUpdate listener on the ear client for presence tracking.
  assert.equal(fakeClient.voiceStateHandlers.length, 1);
});

test("the returned teardown closure destroys the ear client, revokes discord-voice admissions, detaches the broker surface, and resets onSurfaceChange to (null, null)", async () => {
  const fakeClient = fakeEarClient();
  const { deps, revoked, detachCalls, surfaceChanges } = fakeDeps({ createEarClient: () => fakeClient.client });
  const lifecycle = createDiscordVoiceLifecycle(deps);
  const teardown = await lifecycle.bootDiscordVoice("ear-tok", ["chan-1"]);

  await teardown!();

  assert.equal(fakeClient.destroyCalls(), 1);
  assert.deepEqual(revoked, ["discord-voice"]);
  assert.equal(detachCalls(), 1);
  assert.equal(surfaceChanges.length, 2);
  assert.deepEqual(surfaceChanges[1], { surface: null, presence: null });
});

test("teardown is safe when nothing was ever joined — leaveAll no-ops rather than throwing", async () => {
  const fakeClient = fakeEarClient();
  const { deps } = fakeDeps({ createEarClient: () => fakeClient.client });
  const lifecycle = createDiscordVoiceLifecycle(deps);
  const teardown = await lifecycle.bootDiscordVoice("ear-tok", ["chan-1"]);

  await assert.doesNotReject(() => teardown!());
  assert.equal(fakeClient.destroyCalls(), 1);
});

test("bootDiscordVoice can be called again after a previous teardown, logging in a fresh ear client", async () => {
  const clients = [fakeEarClient(), fakeEarClient()];
  let created = 0;
  const { deps, surfaceChanges } = fakeDeps({
    createEarClient: () => clients[created++]!.client,
  });
  const lifecycle = createDiscordVoiceLifecycle(deps);

  const firstTeardown = await lifecycle.bootDiscordVoice("tok", ["chan-1"]);
  await firstTeardown!();
  const secondTeardown = await lifecycle.bootDiscordVoice("tok", ["chan-1"]);

  assert.equal(created, 2);
  assert.deepEqual(clients[0]!.loginCalls, ["tok"]);
  assert.equal(clients[0]!.destroyCalls(), 1);
  assert.deepEqual(clients[1]!.loginCalls, ["tok"]);
  assert.equal(clients[1]!.destroyCalls(), 0);
  // (null,null) from the first teardown, then a fresh (surface,presence) from the second boot.
  assert.equal(surfaceChanges.length, 3);
  assert.deepEqual(surfaceChanges[1], { surface: null, presence: null });
  assert.notEqual(surfaceChanges[2]!.surface, null);

  await secondTeardown!();
  assert.equal(clients[1]!.destroyCalls(), 1);
});

test("two independent lifecycles do not share state", async () => {
  const a = fakeDeps({ createEarClient: () => fakeEarClient().client });
  const b = fakeDeps({ createEarClient: () => fakeEarClient().client });
  const lifecycleA = createDiscordVoiceLifecycle(a.deps);
  const lifecycleB = createDiscordVoiceLifecycle(b.deps);

  await lifecycleA.bootDiscordVoice("tok", ["chan-1"]);
  assert.equal(a.surfaceChanges.length, 1);
  assert.equal(b.surfaceChanges.length, 0);
});

test("activeVoiceTeardown tracks the active boot; teardownDiscordVoice() tears it down and is idempotent", async () => {
  const fakeClient = fakeEarClient();
  const { deps } = fakeDeps({ createEarClient: () => fakeClient.client });
  const lifecycle = createDiscordVoiceLifecycle(deps);

  assert.equal(lifecycle.activeVoiceTeardown, null);
  const teardown = await lifecycle.bootDiscordVoice("tok", ["chan-1"]);
  assert.equal(lifecycle.activeVoiceTeardown, teardown);

  await lifecycle.teardownDiscordVoice();
  assert.equal(fakeClient.destroyCalls(), 1);
  assert.equal(lifecycle.activeVoiceTeardown, null);

  // Idempotent: a second teardownDiscordVoice with nothing active is a no-op, not a second destroy().
  await lifecycle.teardownDiscordVoice();
  assert.equal(fakeClient.destroyCalls(), 1);
});

test("calling the returned teardown closure directly (bypassing teardownDiscordVoice) also clears activeVoiceTeardown", async () => {
  const fakeClient = fakeEarClient();
  const { deps } = fakeDeps({ createEarClient: () => fakeClient.client });
  const lifecycle = createDiscordVoiceLifecycle(deps);

  const teardown = await lifecycle.bootDiscordVoice("tok", ["chan-1"]);
  await teardown!();
  assert.equal(lifecycle.activeVoiceTeardown, null);
  // teardownDiscordVoice must not re-destroy an already-destroyed client, since activeVoiceTeardown is already cleared.
  await lifecycle.teardownDiscordVoice();
  assert.equal(fakeClient.destroyCalls(), 1);
});

/** Flushes every microtask queued so far (a macrotask boundary), more robust than guessing a fixed number of `await Promise.resolve()` ticks. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("teardown quiesces in-flight presence handling: lets an already-started join finish (even if it ultimately fails) before leaving/destroying, and the torn-down guard stops a later-queued event from starting a new one", async () => {
  const fakeClient = fakeEarClient();
  let resolveFetchGate: (() => void) | undefined;
  const fetchGate = new Promise<void>((resolve) => {
    resolveFetchGate = resolve;
  });
  let attachCount = 0;
  let detachCount = 0;
  const { deps } = fakeDeps({
    createEarClient: () => ({
      ...fakeClient.client,
      channels: {
        // Gated: earAwareGateway.join() (this module's own code) calls this
        // as the FIRST thing it does for the ear's token, so gating it here
        // — rather than needing a working @discordjs/voice connection —
        // keeps surface.joinAll() genuinely "in flight" without ever
        // reaching the real gateway/joinVoiceChannel.
        fetch: async () => {
          await fetchGate;
          throw new Error(
            "simulated channel fetch failure — ends the in-flight join without touching the real gateway",
          );
        },
        cache: fakeClient.client.channels.cache,
      },
    }),
    broker: {
      attachVoiceSurface: () => {
        attachCount += 1;
        return true;
      },
      detachVoiceSurface: () => {
        detachCount += 1;
      },
    },
  });
  const lifecycle = createDiscordVoiceLifecycle(deps);
  const teardown = await lifecycle.bootDiscordVoice("tok", ["chan-1"]);
  const onVoiceStateUpdate = fakeClient.voiceStateHandlers[0]!;
  const human = { user: { bot: false } };

  // Event 1: immediate member resolution (member already present, so
  // guild.members.fetch is never even called) reaches onPresenceEvent right
  // away — tornDown is still false, so it calls attachVoiceSurface and starts
  // surface.joinAll(), which blocks inside earAwareGateway.join() on the
  // gated channels.fetch above. This join is genuinely in flight by the time
  // teardown() is called below.
  onVoiceStateUpdate(
    { channelId: null, id: "user-1", member: human, guild: { members: { fetch: async () => human } } },
    { channelId: "chan-1", id: "user-1", member: human, guild: { members: { fetch: async () => human } } },
  );
  await flushMicrotasks(); // let event 1 run synchronously up through attachVoiceSurface and into the gated fetch
  assert.equal(attachCount, 1); // confirms the join genuinely started BEFORE teardown begins below

  const teardownPromise = teardown!();

  // Event 2 arrives WHILE teardown is already quiescing — tornDown was set
  // synchronously by teardown(), before it awaits presenceChain. Its own
  // member resolution is immediate too, but it's still queued behind event
  // 1 on the serial chain, so it only runs once event 1's join settles.
  onVoiceStateUpdate(
    { channelId: null, id: "user-2", member: human, guild: { members: { fetch: async () => human } } },
    { channelId: "chan-1", id: "user-2", member: human, guild: { members: { fetch: async () => human } } },
  );

  await flushMicrotasks();
  assert.equal(fakeClient.destroyCalls(), 0); // teardown is still awaiting presenceChain — event 1's join hasn't settled yet
  assert.equal(attachCount, 1); // still just the one call — event 1 hasn't failed yet, event 2 hasn't run yet

  resolveFetchGate!();
  await teardownPromise;
  await flushMicrotasks(); // let event 2's own (now-unblocked) chain link fully settle before asserting

  // Event 1's join was allowed to finish — it fails (the gated fetch
  // rejects), and its own catch handling ran (detachVoiceSurface called once
  // from the join failure), rather than being abandoned mid-flight. Event 2
  // never called attachVoiceSurface a second time: it hit the torn-down
  // guard in onPresenceEvent instead of starting a new join after teardown
  // had already begun. detachVoiceSurface ends up called TWICE: once from
  // event 1's own join-failure catch, once more from teardown's own
  // unconditional detach — both legitimate, independent calls.
  assert.equal(attachCount, 1);
  assert.equal(detachCount, 2);
  assert.equal(fakeClient.destroyCalls(), 1);
});
