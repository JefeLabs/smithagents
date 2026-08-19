import assert from "node:assert/strict";
import { test } from "node:test";
import { createTalkPrefsReader, type TalkPrefs } from "./talk-prefs.ts";

/** A clock the test moves by hand — no timers, no sleeps. */
function fakeClock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

test("the first turn reads /me; a burst of turns inside the TTL reads nothing more", async () => {
  const clock = fakeClock();
  let reads = 0;
  const prefs = createTalkPrefsReader(
    async () => {
      reads++;
      return { smallTalk: false };
    },
    { ttlMs: 15_000, now: clock.now },
  );

  assert.deepEqual(await prefs.get(), { smallTalk: false });
  clock.advance(14_999);
  assert.deepEqual(await prefs.get(), { smallTalk: false });
  assert.deepEqual(await prefs.get(), { smallTalk: false });
  assert.equal(reads, 1);
});

test("past the TTL the next turn sees the NEW answer — a wizard change is never stuck until restart", async () => {
  const clock = fakeClock();
  let current: TalkPrefs = { smallTalk: true, worldAware: true };
  const prefs = createTalkPrefsReader(async () => current, { ttlMs: 15_000, now: clock.now });

  assert.deepEqual(await prefs.get(), { smallTalk: true, worldAware: true });
  // The human answers the wizard between turns.
  current = { smallTalk: false, worldAware: false };
  clock.advance(15_000);
  assert.deepEqual(await prefs.get(), { smallTalk: false, worldAware: false });
});

test("invalidate() makes the very next turn see the change — the wizard's own write path", async () => {
  const clock = fakeClock();
  let current: TalkPrefs = { worldAware: true };
  let reads = 0;
  const prefs = createTalkPrefsReader(
    async () => {
      reads++;
      return current;
    },
    { ttlMs: 15_000, now: clock.now },
  );

  assert.deepEqual(await prefs.get(), { worldAware: true });
  current = { worldAware: false };
  // Still deep inside the TTL: without the invalidation the old answer would stand.
  assert.deepEqual(await prefs.get(), { worldAware: true });
  prefs.invalidate();
  assert.deepEqual(await prefs.get(), { worldAware: false });
  assert.equal(reads, 2);
});

test("a failing read keeps the last known answer, never throws, and retries next time", async () => {
  const clock = fakeClock();
  let mode: "ok" | "boom" = "ok";
  let reads = 0;
  const prefs = createTalkPrefsReader(
    async () => {
      reads++;
      if (mode === "boom") throw new Error("swarm is down");
      return { smallTalk: false };
    },
    { ttlMs: 15_000, now: clock.now },
  );

  assert.deepEqual(await prefs.get(), { smallTalk: false });
  mode = "boom";
  clock.advance(15_000);
  assert.deepEqual(await prefs.get(), { smallTalk: false }, "the last known answer survives a failed read");
  // The failure is not cached as an answer: the next call tries again rather
  // than waiting out another TTL window.
  mode = "ok";
  assert.deepEqual(await prefs.get(), { smallTalk: false });
  assert.equal(reads, 3);
});

test("a first read that fails yields today's behaviour — empty prefs, not a thrown turn", async () => {
  const prefs = createTalkPrefsReader(async () => {
    throw new Error("swarm is down");
  });
  assert.deepEqual(await prefs.get(), {});
});

test("concurrent turns share one read — never one fetch per caller", async () => {
  let reads = 0;
  let release: ((p: TalkPrefs) => void) | null = null;
  const prefs = createTalkPrefsReader(() => {
    reads++;
    return new Promise<TalkPrefs>((resolve) => {
      release = resolve;
    });
  });

  const a = prefs.get();
  const b = prefs.get();
  await Promise.resolve();
  assert.equal(typeof release, "function");
  release?.({ smallTalk: false });
  assert.deepEqual(await a, { smallTalk: false });
  assert.deepEqual(await b, { smallTalk: false });
  assert.equal(reads, 1);
});

test("an absent setup block reads as empty prefs — today's behaviour for everyone who never answered", async () => {
  const prefs = createTalkPrefsReader(async () => undefined);
  assert.deepEqual(await prefs.get(), {});
});
