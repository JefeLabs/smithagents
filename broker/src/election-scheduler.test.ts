import assert from "node:assert/strict";
import { test } from "node:test";
import { type ElectionResult, ElectionScheduler } from "./election.ts";

/** A hand-cranked clock: timers fire only when you say so. */
function fakeTimer() {
  const queued: Array<{ id: number; fn: () => void }> = [];
  let seq = 0;
  return {
    api: {
      set: ((fn: () => void) => {
        seq += 1;
        queued.push({ id: seq, fn });
        return seq as unknown as NodeJS.Timeout;
      }) as unknown as typeof setTimeout,
      clear: ((id: NodeJS.Timeout) => {
        const idx = queued.findIndex((q) => q.id === (id as unknown as number));
        if (idx >= 0) queued.splice(idx, 1);
      }) as unknown as typeof clearTimeout,
    },
    fire() {
      const due = [...queued];
      queued.length = 0;
      for (const q of due) q.fn();
    },
    pending: () => queued.length,
  };
}

const RESULT: ElectionResult = { leader: "josefina", claims: [], method: "vote" };

test("three rapid changes to one group hold ONE vote", async () => {
  const timer = fakeTimer();
  let runs = 0;
  const scheduler = new ElectionScheduler({
    run: async () => {
      runs += 1;
      return RESULT;
    },
    onResult: () => {},
    timer: timer.api,
  });
  scheduler.schedule("g1");
  scheduler.schedule("g1");
  scheduler.schedule("g1");
  assert.equal(timer.pending(), 1, "each schedule must replace the pending one");
  timer.fire();
  await new Promise((r) => setImmediate(r));
  assert.equal(runs, 1);
});

test("different groups elect independently", async () => {
  const timer = fakeTimer();
  const ran: string[] = [];
  const scheduler = new ElectionScheduler({
    run: async (id) => {
      ran.push(id);
      return RESULT;
    },
    onResult: () => {},
    timer: timer.api,
  });
  scheduler.schedule("g1");
  scheduler.schedule("g2");
  timer.fire();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ran.sort(), ["g1", "g2"]);
});

test("a change DURING an election supersedes it — the stale result is discarded", async () => {
  const timer = fakeTimer();
  const delivered: ElectionResult[] = [];
  let release!: (r: ElectionResult) => void;
  const scheduler = new ElectionScheduler({
    run: async () =>
      new Promise<ElectionResult>((resolve) => {
        release = resolve;
      }),
    onResult: (_id, r) => delivered.push(r),
    timer: timer.api,
  });
  scheduler.schedule("g1");
  timer.fire(); // election in flight

  scheduler.schedule("g1"); // membership changed underneath it
  release({ leader: "stale", claims: [], method: "vote" });
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(delivered, [], "a superseded election must never be written");
});

test("a run returning null (group vanished) delivers nothing", async () => {
  const timer = fakeTimer();
  const delivered: string[] = [];
  const scheduler = new ElectionScheduler({
    run: async () => null,
    onResult: (id) => delivered.push(id),
    timer: timer.api,
  });
  scheduler.schedule("g1");
  timer.fire();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(delivered, []);
});

test("a throwing run is swallowed — the broker must not crash on an election", async () => {
  const timer = fakeTimer();
  const scheduler = new ElectionScheduler({
    run: async () => {
      throw new Error("boom");
    },
    onResult: () => {},
    timer: timer.api,
  });
  scheduler.schedule("g1");
  timer.fire();
  await new Promise((r) => setImmediate(r));
  assert.ok(true, "reaching here without an unhandled rejection is the assertion");
});
