import assert from "node:assert/strict";
import { test } from "node:test";
import { pingBrain } from "./brain-ping.ts";

/** A clock the test moves by hand — no timers, no sleeps. */
function fakeClock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

test("a successful ask reports the reply and the measured elapsed time", async () => {
  const clock = fakeClock();
  const result = await pingBrain(async () => {
    clock.advance(812);
    return { reply: "Ready when you are." };
  }, clock.now);

  assert.deepEqual(result, { ok: true, reply: "Ready when you are.", latencyMs: 812 });
});

test("the number is MEASURED, not assumed — a slower ask reports a larger figure", async () => {
  const clock = fakeClock();
  const slow = await pingBrain(async () => {
    clock.advance(2_400);
    return { reply: "x" };
  }, clock.now);
  assert.equal(slow.ok && slow.latencyMs, 2_400);
});

test("an engine that cannot answer one-shot is a failure, not a zero-latency success", async () => {
  const clock = fakeClock();
  const result = await pingBrain(async () => ({ notApiAgent: true }), clock.now);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /one-shot|answer/i);
});

test("a thrown ask is reported, never a fabricated number", async () => {
  const clock = fakeClock();
  const result = await pingBrain(async () => {
    throw new Error("swarm is down");
  }, clock.now);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /swarm is down/);
});

test("an empty reply is not a pass — a receipt needs something answered", async () => {
  const clock = fakeClock();
  const result = await pingBrain(async () => ({ reply: "   " }), clock.now);
  assert.equal(result.ok, false);
});
