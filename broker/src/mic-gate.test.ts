import assert from "node:assert/strict";
import { test } from "node:test";
import { MicSessionGate } from "./mic-gate.ts";

test("reserve claims an empty slot; a second reserve for the same client while pending is a no-op", () => {
  const gate = new MicSessionGate<string>();
  assert.equal(gate.reserve(1), true);
  assert.equal(gate.reserve(1), false); // second mic-start before the first's gate resolves
});

test("commit succeeds on a still-pending reservation and get() then returns the session", () => {
  const gate = new MicSessionGate<string>();
  gate.reserve(1);
  assert.equal(gate.commit(1, "session-a"), true);
  assert.equal(gate.get(1), "session-a");
});

test("a mic-stop landing mid-gate clears the reservation, so the gate's later commit is rejected", () => {
  const gate = new MicSessionGate<string>();
  gate.reserve(1);
  assert.equal(gate.stop(1), undefined); // stop() while still pending — nothing real to tear down yet
  assert.equal(gate.commit(1, "session-a"), false); // the gate resolves after stop() already landed
  assert.equal(gate.get(1), undefined); // the late session must never become "the" session
});

test("stop() on a committed session returns it (so the caller can tear it down) and clears the slot", () => {
  const gate = new MicSessionGate<string>();
  gate.reserve(1);
  gate.commit(1, "session-a");
  assert.equal(gate.stop(1), "session-a");
  assert.equal(gate.get(1), undefined);
  assert.equal(gate.reserve(1), true); // slot is free again after stop()
});

test("cancel clears a still-pending reservation (e.g. no STT key), freeing the slot for a fresh reserve", () => {
  const gate = new MicSessionGate<string>();
  gate.reserve(1);
  gate.cancel(1);
  assert.equal(gate.reserve(1), true);
});

test("cancel never clobbers an already-committed session (a stale cancel from a superseded gate is a no-op)", () => {
  const gate = new MicSessionGate<string>();
  gate.reserve(1);
  gate.commit(1, "session-a");
  gate.cancel(1); // e.g. a second, now-irrelevant gate deciding "no key" after the first already committed
  assert.equal(gate.get(1), "session-a");
});

test("two independent clients never share a slot", () => {
  const gate = new MicSessionGate<string>();
  assert.equal(gate.reserve(1), true);
  assert.equal(gate.reserve(2), true);
  gate.commit(1, "session-a");
  assert.equal(gate.get(1), "session-a");
  assert.equal(gate.get(2), undefined);
});
