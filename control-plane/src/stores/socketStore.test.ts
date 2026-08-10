import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "../queries/keys";
import { resetAllStores } from "./reset";
import { useSocketStore } from "./socketStore";

/**
 * Stand-in for the browser WebSocket. `readyState` and the OPEN/CONNECTING
 * constants are real fields on purpose: micControl guards on
 * `socket.readyState === WebSocket.OPEN`, and a fake carrying neither would
 * make that comparison `undefined === undefined` — true — so a mic test would
 * pass identically with the guard deleted.
 */
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static last: FakeSocket | null = null;
  static all: FakeSocket[] = [];
  static count = 0;

  readyState = FakeSocket.CONNECTING;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: unknown[] = [];

  constructor(readonly url: string) {
    FakeSocket.last = this;
    FakeSocket.all.push(this);
    FakeSocket.count++;
  }

  /** The handshake completing — a real socket fires this well after the constructor returns. */
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  emit(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
}

/**
 * Sockets that are still open. Counting constructions alone would pass a fix
 * that opens a replacement without closing the socket it replaced.
 */
const liveSockets = () => FakeSocket.all.filter((s) => !s.closed);

/** The frames under test are hand-built objects, so the store's parse gets exercised for real. */
function emit(frame: unknown) {
  FakeSocket.last?.emit(frame);
}

const store = () => useSocketStore.getState();

beforeEach(() => {
  FakeSocket.count = 0;
  FakeSocket.last = null;
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  // A live broker really is listening on 127.0.0.1:7790 on this machine. Nothing
  // in this store fetches, and this makes that a testable claim rather than a hope.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("no network in this test");
    }),
  );
});

afterEach(() => {
  store().disconnect();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("socketStore connection lifecycle", () => {
  it("opens exactly one socket even when connect is called twice (StrictMode)", () => {
    const qc = new QueryClient();
    store().connect(qc);
    store().connect(qc);
    expect(FakeSocket.count).toBe(1);
  });

  it("tracks the open/closed state of the socket", () => {
    store().connect(new QueryClient());
    expect(store().connected).toBe(false);
    FakeSocket.last?.open();
    expect(store().connected).toBe(true);
    FakeSocket.last?.close();
    expect(store().connected).toBe(false);
  });

  it("reconnects after a close, and stops reconnecting once disconnected", () => {
    vi.useFakeTimers();
    store().connect(new QueryClient());
    FakeSocket.last?.close();
    expect(FakeSocket.count).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(FakeSocket.count).toBe(2);

    store().disconnect();
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.count).toBe(2);
  });

  it("cancels an armed reconnect on disconnect", () => {
    // The test above only disconnects AFTER the timer has fired, so it proves the
    // `if (active)` check in onclose and never the clearTimeout. Unmounting while
    // the broker is down lands here: a socket built after teardown would keep
    // writing into the QueryClient captured in its closure, unreachable forever.
    vi.useFakeTimers();
    store().connect(new QueryClient());
    FakeSocket.last?.close(); // armed, not yet fired
    store().disconnect();
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.count).toBe(1);
    expect(liveSockets()).toHaveLength(0);
  });

  it("does not open a second socket when connect races a pending reconnect", () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    store().connect(qc);
    FakeSocket.last?.close(); // reconnect now armed, socket handle is null
    store().connect(qc); // a remount landing inside the backoff window
    vi.advanceTimersByTime(5000);
    // The armed timer must not fire on top of the socket connect() just opened:
    // exactly one socket is alive, and no third was ever constructed.
    expect(liveSockets()).toHaveLength(1);
    expect(FakeSocket.count).toBe(2);
  });

  it("ignores a late close from a socket that was already superseded", () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    store().connect(qc);
    const first = FakeSocket.last;
    store().disconnect(); // StrictMode unmount — a real close() resolves later
    store().connect(qc); // StrictMode remount
    const second = FakeSocket.last;
    expect(second).not.toBe(first);

    first?.onclose?.(); // the first socket's close finally lands
    vi.advanceTimersByTime(5000);
    expect(FakeSocket.count).toBe(2); // no duplicate reconnect
    expect(liveSockets()).toEqual([second]);

    second?.open();
    store().micControl("mic-start");
    expect(second?.sent).toHaveLength(1); // the live handle was not stolen
  });

  it("ignores frames from a socket that was already superseded", () => {
    const qc = new QueryClient();
    store().connect(qc);
    const first = FakeSocket.last;
    store().disconnect();
    store().connect(qc);
    const second = FakeSocket.last;

    // CLOSING, not CLOSED: buffered frames can still arrive on the old socket, and
    // both sockets close over the same QueryClient.
    first?.emit({ type: "speech", text: "ghost" });
    expect(qc.getQueryData(qk.transcript)).toBeUndefined();

    second?.emit({ type: "speech", text: "live" });
    expect(qc.getQueryData(qk.transcript)).toHaveLength(1);
  });

  it("stays recoverable when the WebSocket constructor throws", () => {
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor() {
          throw new Error("bad base");
        }
      },
    );
    // `active` is module-scoped, so unlike the old hook's per-component flag, a
    // remount cannot heal it — a stuck guard would kill the store for the page.
    expect(() => store().connect(new QueryClient(), "no:such:base")).toThrow("bad base");

    vi.stubGlobal("WebSocket", FakeSocket);
    store().connect(new QueryClient());
    expect(FakeSocket.count).toBe(1);
    expect(liveSockets()).toHaveLength(1);
  });
});

describe("socketStore frame handling", () => {
  it("writes a session frame into the query cache instead of refetching", () => {
    const qc = new QueryClient();
    store().connect(qc);
    emit({
      type: "session",
      session: { id: "s1", title: "t", workspace: "w", runtime: "local-in-process" },
      sessions: [{ id: "s1", title: "t", workspace: "w", updatedAt: "now", active: true, runtime: "local-in-process" }],
      workspaces: ["w"],
      transcript: [
        { role: "user", text: "hi" },
        { role: "broker", text: "hello" },
      ],
    });

    expect(qc.getQueryData(qk.session)).toMatchObject({ id: "s1" });
    expect(qc.getQueryData(qk.sessions)).toHaveLength(1);
    expect(qc.getQueryData(qk.workspaces)).toEqual(["w"]);
    expect(qc.getQueryData(qk.transcript)).toEqual([
      { id: 0, role: "user", text: "hi" },
      { id: 1, role: "broker", text: "hello" },
    ]);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  // An older broker sends session rows with no `artifacts` at all. Every
  // consumer reads `.artifacts` unguarded, so the parser — not the callers —
  // is where the absent list becomes an empty one.
  it("normalizes a session frame that carries no artifacts", () => {
    const qc = new QueryClient();
    store().connect(qc);
    emit({
      type: "session",
      session: { id: "s1", title: "t", workspace: "w", runtime: "local-in-process" },
      sessions: [
        { id: "s1", title: "t", workspace: "w", updatedAt: "now", active: true, runtime: "local-in-process" },
        {
          id: "s2",
          title: "u",
          workspace: "w",
          updatedAt: "now",
          active: false,
          runtime: "local-in-process",
          artifacts: ["d1"],
        },
      ],
      workspaces: ["w"],
      transcript: [],
    });

    expect(qc.getQueryData(qk.session)).toMatchObject({ id: "s1", artifacts: [] });
    const rows = qc.getQueryData(qk.sessions) as Array<{ id: string; artifacts: string[] }>;
    expect(rows[0].artifacts).toEqual([]);
    expect(rows[1].artifacts).toEqual(["d1"]);
  });

  it("an open socket with no frame yet leaves the session key untouched", () => {
    // The flash window: `connected` is already true for a beat before the
    // broker speaks. qk.session must have NO cache entry there, because
    // useSessionKnown() reads status === "success" and a premature write of
    // any kind — including null — would read as a confirmed zero and force
    // the composer open on every load.
    const qc = new QueryClient();
    store().connect(qc);
    FakeSocket.last?.open();

    expect(store().connected).toBe(true);
    expect(qc.getQueryState(qk.session)).toBeUndefined();
  });

  it("treats a null session as known-zero, not as still-unknown", () => {
    const qc = new QueryClient();
    store().connect(qc);
    emit({ type: "session", session: null, sessions: [], workspaces: ["w"], transcript: [] });

    // useSessionKnown() reads status === "success"; null data still counts as
    // a frame having landed, which is exactly what the old sessionKnown flag meant.
    expect(qc.getQueryState(qk.session)?.status).toBe("success");
    expect(qc.getQueryData(qk.session)).toBeNull();
  });

  it("a dropped socket does not un-know the session it already delivered", () => {
    // The old hook kept `sessionKnown` sticky across close/reconnect on
    // purpose. The cache inherits that only because no close path writes to
    // qk.session — clearing it on disconnect would send the composer back to
    // "unknown" every time the broker restarts.
    const qc = new QueryClient();
    store().connect(qc);
    emit({
      type: "session",
      session: { id: "s1", title: "t", workspace: "w", runtime: "local-in-process" },
      sessions: [],
      workspaces: [],
      transcript: [],
    });

    FakeSocket.last?.close();
    expect(store().connected).toBe(false);
    expect(qc.getQueryState(qk.session)?.status).toBe("success");
    expect(qc.getQueryData(qk.session)).toMatchObject({ id: "s1" });

    store().disconnect(); // the harder case: an explicit teardown, not just a drop
    expect(qc.getQueryData(qk.session)).toMatchObject({ id: "s1" });
  });

  it("appends utterance, speech and notice to the transcript rather than replacing it", () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.transcript, [{ id: 0, role: "user", text: "first" }]);
    store().connect(qc);
    emit({ type: "speech", text: "second" });
    emit({ type: "utterance", text: "third" });
    emit({ type: "notice", text: "fourth" });

    const list = qc.getQueryData(qk.transcript) as Array<{ role: string; text: string }>;
    expect(list).toHaveLength(4);
    expect(list[0]).toMatchObject({ text: "first" }); // a replace would have dropped this
    expect(list.map((m) => m.role)).toEqual(["user", "broker", "user", "notice"]);
  });

  it("restarts transcript ids on a session frame so a replayed transcript has no duplicates", () => {
    const qc = new QueryClient();
    store().connect(qc);
    emit({ type: "speech", text: "before" });
    emit({ type: "session", session: null, sessions: [], workspaces: [], transcript: [{ role: "user", text: "a" }] });
    emit({ type: "speech", text: "b" });

    const list = qc.getQueryData(qk.transcript) as Array<{ id: number }>;
    expect(list.map((m) => m.id)).toEqual([0, 1]);
  });

  it("writes the roster with the host identity, defaulting it to null when absent", () => {
    const qc = new QueryClient();
    store().connect(qc);
    emit({ type: "roster", agents: [{ id: "a1", name: "Ana", role: "dev", status: "idle", kind: "agent" }] });
    expect(qc.getQueryData(qk.roster)).toEqual({
      agents: [{ id: "a1", name: "Ana", role: "dev", status: "idle", kind: "agent" }],
      identity: null,
    });

    emit({ type: "roster", agents: [], identity: { name: "Anderson", role: "host" } });
    expect(qc.getQueryData(qk.roster)).toMatchObject({ identity: { name: "Anderson" } });
  });

  it("records broker-side audio from the config frame and keeps it out of the cache", () => {
    const qc = new QueryClient();
    store().connect(qc);
    expect(store().audioMode).toBe(false);

    emit({ type: "config", audio: true });

    // HomePage passes !audioMode as useSpokenReplies' webSpeechEnabled. Drop this
    // frame and the browser speaks every reply on top of the broker's own TTS.
    expect(store().audioMode).toBe(true);
    expect(qc.getQueryCache().getAll()).toHaveLength(0);
  });

  it("invalidates rather than writes for id-only frames", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const write = vi.spyOn(qc, "setQueryData");
    store().connect(qc);

    emit({ type: "board-updated", boardId: "b1" });
    emit({ type: "capability-updated", capabilityId: "c1" });

    // Boards/capabilities are fetched as whole collections (no per-item GET),
    // so the id the frame names is invalidation fodder only — the key that
    // must be invalidated is the collection key, not qk.board(id)/qk.capability(id).
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.boards });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.capabilities });
    // The frame carried an id, not data — writing anything would be inventing it.
    expect(write).not.toHaveBeenCalled();
    expect(qc.getQueryData(qk.boards)).toBeUndefined();
    expect(qc.getQueryData(qk.capabilities)).toBeUndefined();
  });

  it("routes audio frames to subscribers, never to the cache", () => {
    const qc = new QueryClient();
    const heard: unknown[] = [];
    store().connect(qc);
    const off = store().onAudioFrame((f) => heard.push(f));

    emit({ type: "audio", speaker: "Ana", mime: "audio/mp3", dataB64: "AA" });

    expect(heard).toEqual([{ type: "audio", speaker: "Ana", mime: "audio/mp3", dataB64: "AA" }]);
    expect(qc.getQueryCache().getAll()).toHaveLength(0);

    off();
    emit({ type: "audio", mime: "audio/mp3", dataB64: "BB" });
    expect(heard).toHaveLength(1);
  });

  it("a documents frame replaces the documents cache wholesale", () => {
    const qc = new QueryClient();
    store().connect(qc);
    emit({
      type: "documents",
      documents: [
        {
          id: "d1",
          title: "Spec",
          blueprintId: "spec",
          workType: "feature",
          sections: [],
          participants: [],
          status: "drafting",
          createdAt: "t",
          updatedAt: "t",
        },
      ],
    });

    expect(qc.getQueryData(qk.documents)).toEqual([
      {
        id: "d1",
        title: "Spec",
        blueprintId: "spec",
        workType: "feature",
        sections: [],
        participants: [],
        status: "drafting",
        createdAt: "t",
        updatedAt: "t",
      },
    ]);
  });

  it("ignores task-dispatched and unknown frames without touching the cache", () => {
    const qc = new QueryClient();
    store().connect(qc);
    emit({ type: "task-dispatched", taskId: "t1", agent: "Ana", task: "ship it" });
    emit({ type: "who-knows", payload: 1 });
    expect(qc.getQueryCache().getAll()).toHaveLength(0);
  });
});

describe("socketStore mic pipe", () => {
  it("sends mic control and pcm only while the socket is OPEN", () => {
    store().connect(new QueryClient());
    const sock = FakeSocket.last;

    store().micControl("mic-start");
    store().micAudio(new ArrayBuffer(8));
    expect(sock?.sent).toHaveLength(0); // still CONNECTING — the broker would never see these

    sock?.open();
    store().micControl("mic-start");
    store().micAudio(new ArrayBuffer(8));
    expect(sock?.sent).toEqual([JSON.stringify({ type: "mic-start" }), new ArrayBuffer(8)]);
  });

  it("does not throw when the mic is used with no socket at all", () => {
    expect(() => {
      store().micControl("mic-stop");
      store().micAudio(new ArrayBuffer(4));
    }).not.toThrow();
  });
});

describe("socketStore reset", () => {
  it("closes the socket and clears audioMode on resetAllStores", () => {
    store().connect(new QueryClient());
    FakeSocket.last?.open();
    emit({ type: "config", audio: true });
    expect(store().connected).toBe(true);

    resetAllStores();

    expect(liveSockets()).toHaveLength(0); // "closes the socket" — asserted, not just named
    expect(store().connected).toBe(false);
    expect(store().audioMode).toBe(false);
    store().connect(new QueryClient()); // reset released the guard, so this opens fresh
    expect(FakeSocket.count).toBe(2);
  });

  it("drops audio subscribers on resetAllStores", () => {
    const heard: unknown[] = [];
    store().connect(new QueryClient());
    store().onAudioFrame((f) => heard.push(f));

    resetAllStores();

    store().connect(new QueryClient());
    emit({ type: "audio", mime: "audio/mp3", dataB64: "AA" });
    expect(heard).toHaveLength(0);
  });
});
