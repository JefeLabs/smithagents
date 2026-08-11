import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveLazyWorkspace,
  type Session,
  SessionManager,
  type SessionStoreLike,
  truncateTitle,
} from "./sessions.ts";

const T = "2026-01-01T00:00:00.000Z";

function memoryStore(initial: Session[] = []): SessionStoreLike & { saved: Session[]; removed: string[] } {
  const byId = new Map(initial.map((s) => [s.id, s]));
  const store = {
    saved: [] as Session[],
    removed: [] as string[],
    loadAll: () => [...byId.values()],
    save: (s: Session) => {
      byId.set(s.id, JSON.parse(JSON.stringify(s)) as Session);
      store.saved.push(s);
    },
    remove: (id: string) => {
      byId.delete(id);
      store.removed.push(id);
    },
  };
  return store;
}

test("init with an empty store returns null and creates nothing", () => {
  const mgr = new SessionManager(memoryStore());
  assert.equal(mgr.init(), null);
  assert.equal(mgr.hasActive(), false);
  assert.equal(mgr.activeOrNull(), null);
  assert.deepEqual(mgr.list(), []);
});

test("init resumes the most recently updated persisted session and keeps ids monotonic", () => {
  const store = memoryStore([
    {
      id: "s1",
      title: "old",
      workspace: "jefelabs",
      runtime: "local-in-process",
      createdAt: "a",
      updatedAt: "2026-01-01",
      transcript: [],
      brainHistory: [],
    },
    {
      id: "s2",
      title: "fresh",
      workspace: "jefelabs",
      runtime: "local-in-process",
      createdAt: "b",
      updatedAt: "2026-06-01",
      transcript: [],
      brainHistory: [],
    },
  ]);
  const mgr = new SessionManager(store);
  assert.equal(mgr.init()?.id, "s2");
  assert.equal(mgr.create("jefelabs").id, "s3"); // no id reuse after restart
});

test("legacy persisted sessions without runtime read as local-in-process", () => {
  const store = memoryStore();
  store.save({
    id: "s1",
    title: "old",
    workspace: "w",
    createdAt: T,
    updatedAt: T,
    transcript: [],
    brainHistory: [],
  } as never);
  const mgr = new SessionManager(store);
  mgr.init();
  assert.equal(mgr.list()[0].runtime, "local-in-process");
});

test("create carries runtime and truncated title; retitle applies exactly once", () => {
  const mgr = new SessionManager(memoryStore());
  const s = mgr.create("w", {
    runtime: "remote-docker",
    title: truncateTitle("fix the flaky deploy pipeline that keeps timing out on arm builds"),
    awaitingTitle: true,
  });
  assert.equal(s.runtime, "remote-docker");
  assert.equal(s.title.length <= 40, true);
  assert.equal(s.title.endsWith("…"), true);
  assert.equal(mgr.retitle(s.id, "Flaky deploy pipeline"), true);
  assert.equal(mgr.retitle(s.id, "Second try"), false);
  assert.equal(mgr.activeOrNull()?.title, "Flaky deploy pipeline");
});

test("truncateTitle collapses whitespace and caps at 40 chars", () => {
  assert.equal(truncateTitle("  hello   world  "), "hello world");
  assert.equal(truncateTitle(""), "New session");
  assert.equal(truncateTitle("x".repeat(60)).length, 40);
});

test("resetAll leaves zero sessions", () => {
  const mgr = new SessionManager(memoryStore());
  mgr.create("w", { runtime: "local-in-process" });
  mgr.resetAll();
  assert.equal(mgr.hasActive(), false);
  assert.deepEqual(mgr.list(), []);
});

test("resolveLazyWorkspace: discord lands in the attended workspace, everything else in the default", () => {
  assert.equal(resolveLazyWorkspace({ kind: "discord", channelRef: "c" }, "acme", "main"), "acme");
  assert.equal(resolveLazyWorkspace({ kind: "discord", channelRef: "c" }, null, "main"), "main");
  assert.equal(resolveLazyWorkspace(undefined, "acme", "main"), "main");
  assert.equal(resolveLazyWorkspace({ kind: "stdin", channelRef: "c" }, "acme", "main"), "main");
});

test("sessions list with their artifacts; none means an empty array", () => {
  const mgr = new SessionManager(memoryStore());
  mgr.create("acme", {});
  assert.deepEqual(mgr.list()[0].artifacts, []);
});

test("addArtifact appends once, bumps updatedAt, persists; an unknown session is null", () => {
  let n = 0;
  const store = memoryStore();
  const mgr = new SessionManager(store, () => new Date(Date.parse(T) + n++ * 1000).toISOString());
  const s = mgr.create("acme", {});
  const created = s.updatedAt;
  assert.ok(mgr.addArtifact(s.id, "d1"));
  assert.equal(mgr.addArtifact(s.id, "d1")?.artifacts?.length, 1); // append-once
  assert.ok(mgr.addArtifact(s.id, "d2"));
  assert.deepEqual(mgr.list()[0].artifacts, ["d1", "d2"]);
  assert.notEqual(mgr.list()[0].updatedAt, created);
  assert.equal(mgr.addArtifact("s99", "d3"), null);
  assert.equal(store.saved.length, 3); // create + the two effective appends
});

test("a legacy persisted document-kind session normalizes to artifacts", () => {
  const store = memoryStore();
  store.save({
    id: "s4",
    title: "Login spec",
    workspace: "w",
    runtime: "local-in-process",
    kind: "document",
    docId: "d7",
    createdAt: T,
    updatedAt: T,
    transcript: [],
    brainHistory: [],
  } as never);
  const mgr = new SessionManager(store);
  mgr.init();
  assert.deepEqual(mgr.list()[0].artifacts, ["d7"]);
  assert.equal((mgr.activeOrNull() as unknown as { kind?: string }).kind, undefined);
});

test("a legacy persisted chat session with no kind normalizes to no artifacts", () => {
  const store = memoryStore();
  store.save({
    id: "s1",
    title: "old",
    workspace: "w",
    runtime: "local-in-process",
    createdAt: T,
    updatedAt: T,
    transcript: [],
    brainHistory: [],
  } as never);
  const mgr = new SessionManager(store);
  mgr.init();
  assert.deepEqual(mgr.list()[0].artifacts, []);
});

test("transcript and brain history persist through the store; switching swaps them", () => {
  const store = memoryStore();
  const mgr = new SessionManager(store);
  mgr.create("jefelabs");
  mgr.appendTranscript("user", "hola equipo");
  mgr.saveBrainHistory([{ role: "user", content: "hola equipo" }]);
  const second = mgr.create("jefelabs", { title: "Voice work" });
  assert.equal(mgr.active().id, second.id);
  assert.deepEqual(mgr.active().transcript, []); // fresh conversation
  mgr.activate("s1");
  assert.equal(mgr.active().transcript[0]?.text, "hola equipo");
  assert.equal(mgr.active().brainHistory.length, 1);
  assert.equal(mgr.activate("nope"), null);
});

test("remove deletes the session from memory and from the store", () => {
  const store = memoryStore();
  const mgr = new SessionManager(store);
  mgr.create("jefelabs", { title: "keep" });
  const doomed = mgr.create("jefelabs", { title: "doomed" });
  const outcome = mgr.remove(doomed.id);
  assert.equal(outcome?.removed.id, doomed.id);
  assert.deepEqual(store.removed, [doomed.id]);
  assert.deepEqual(
    mgr.list().map((s) => s.id),
    ["s1"],
  );
});

test("remove of an unknown session reports nothing removed and touches no state", () => {
  const store = memoryStore();
  const mgr = new SessionManager(store);
  mgr.create("jefelabs");
  assert.equal(mgr.remove("s99"), null);
  assert.deepEqual(store.removed, []);
  assert.equal(mgr.active().id, "s1");
});

test("removing the ACTIVE session hands back the most recent survivor as the new active", () => {
  const store = memoryStore();
  const mgr = new SessionManager(store);
  const older = mgr.create("jefelabs", { title: "older" });
  mgr.saveBrainHistory([{ role: "user", content: "remember me" }]);
  const active = mgr.create("acme", { title: "active" });
  assert.equal(mgr.active().id, active.id);
  const outcome = mgr.remove(active.id);
  // The successor is returned so the caller can reload the brain and re-point
  // Discord — a deleted active session must not leave either one dangling.
  assert.equal(outcome?.active?.id, older.id);
  assert.equal(outcome?.active?.brainHistory[0]?.content, "remember me");
  assert.equal(mgr.active().id, older.id);
});

test("removing the LAST session leaves no active session rather than inventing one", () => {
  const store = memoryStore();
  const mgr = new SessionManager(store);
  const only = mgr.create("jefelabs");
  const outcome = mgr.remove(only.id);
  assert.equal(outcome?.active, null);
  assert.equal(mgr.hasActive(), false);
  assert.equal(mgr.activeOrNull(), null);
  assert.deepEqual(mgr.list(), []);
});

test("removing a NON-active session leaves the active pointer where it was", () => {
  const store = memoryStore();
  const mgr = new SessionManager(store);
  const bystander = mgr.create("jefelabs", { title: "bystander" });
  const active = mgr.create("jefelabs", { title: "active" });
  const outcome = mgr.remove(bystander.id);
  assert.equal(outcome?.active?.id, active.id);
  assert.equal(mgr.active().id, active.id);
});

test("ids are never reused after a remove — the sequence only moves forward", () => {
  const store = memoryStore();
  const mgr = new SessionManager(store);
  mgr.create("jefelabs");
  const second = mgr.create("jefelabs");
  mgr.remove(second.id);
  assert.equal(mgr.create("jefelabs").id, "s3");
});
