import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ExecutionMode,
  fetchExecutionModes,
  postSession,
  type SessionFrame,
  useBrokerChat,
} from "./useBrokerChat";

afterEach(() => vi.unstubAllGlobals());

/** Minimal WebSocket stand-in: the hook only reads/assigns onopen/onmessage/onclose/onerror and calls close(). */
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  send(_data: unknown) {}
}

function sessionFrame(session: SessionFrame["session"]): SessionFrame {
  return { type: "session", session, sessions: [], transcript: [], workspaces: [] };
}

describe("postSession", () => {
  it("POSTs {workspace, runtime, prompt} and resolves {} on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await postSession("127.0.0.1:7790", "acme", "local-in-process" as ExecutionMode, "fix the build");
    expect(fetchMock.mock.calls[0][0]).toContain("/sessions");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      workspace: "acme",
      runtime: "local-in-process",
      prompt: "fix the build",
    });
    expect(r).toEqual({});
  });

  it("surfaces {error, status} on 409", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'execution mode "remote-docker" is not available' }), { status: 409 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const r = await postSession("127.0.0.1:7790", "acme", "remote-docker" as ExecutionMode, "fix the build");
    expect(fetchMock.mock.calls[0][0]).toContain("/sessions");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      workspace: "acme",
      runtime: "remote-docker",
      prompt: "fix the build",
    });
    expect(r).toEqual({ error: 'execution mode "remote-docker" is not available', status: 409 });
  });

  it("surfaces a fallback error when the broker is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const r = await postSession("127.0.0.1:7790", "acme", "local-in-process" as ExecutionMode, "fix the build");
    expect(r).toEqual({ error: "broker unreachable" });
  });
});

describe("fetchExecutionModes", () => {
  it("GETs /execution-modes and returns the modes map", async () => {
    const modes: Record<ExecutionMode, boolean> = {
      "local-in-process": true,
      "local-docker": false,
      "remote-in-process": false,
      "remote-docker": false,
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ modes }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchExecutionModes("127.0.0.1:7790");
    expect(fetchMock.mock.calls[0][0]).toContain("/execution-modes");
    expect(r).toEqual(modes);
  });

  it("falls back to local-in-process-only when the broker omits modes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchExecutionModes("127.0.0.1:7790");
    expect(r).toEqual({
      "local-in-process": true,
      "local-docker": false,
      "remote-in-process": false,
      "remote-docker": false,
    });
  });
});

describe("SessionFrame (lockstep pin)", () => {
  it("session frame type accepts null", () => {
    // Compile-time: this literal must satisfy the exported SessionFrame type.
    const frame: SessionFrame = { type: "session", session: null, sessions: [], transcript: [], workspaces: [] };
    expect(frame.session).toBeNull();
  });

  it("session frame type accepts a populated session with runtime", () => {
    const frame: SessionFrame = {
      type: "session",
      session: { id: "s1", title: "Fix the build", workspace: "acme", runtime: "local-docker" },
      sessions: [
        {
          id: "s1",
          title: "Fix the build",
          workspace: "acme",
          updatedAt: "2026-08-07T00:00:00.000Z",
          active: true,
          runtime: "local-docker",
        },
      ],
      transcript: [{ role: "user", text: "hi" }],
      workspaces: ["acme"],
    };
    expect(frame.session?.runtime).toBe("local-docker");
  });
});

describe("useBrokerChat — sessionKnown", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("stays false while connected but before any session frame — the flash window this fix closes", () => {
    const { result, unmount } = renderHook(() => useBrokerChat({ base: "127.0.0.1:7790" }));
    const socket = MockWebSocket.instances[0];
    expect(socket).toBeDefined();
    expect(result.current.sessionKnown).toBe(false);

    act(() => socket.onopen?.());
    expect(result.current.connected).toBe(true);
    expect(result.current.sessionKnown).toBe(false); // connected, but the broker hasn't spoken yet

    unmount();
  });

  it("a null session frame still marks it KNOWN — confirmed zero, not unknown", () => {
    const { result, unmount } = renderHook(() => useBrokerChat({ base: "127.0.0.1:7790" }));
    const socket = MockWebSocket.instances[0];

    act(() => socket.onmessage?.({ data: JSON.stringify(sessionFrame(null)) }));

    expect(result.current.sessionKnown).toBe(true);
    expect(result.current.session).toBeNull();

    unmount();
  });

  it("a populated session frame marks it known, and closing the socket does not un-know it", () => {
    const { result, unmount } = renderHook(() => useBrokerChat({ base: "127.0.0.1:7790" }));
    const socket = MockWebSocket.instances[0];

    act(() =>
      socket.onmessage?.({
        data: JSON.stringify(
          sessionFrame({ id: "s1", title: "Fix the build", workspace: "acme", runtime: "local-in-process" }),
        ),
      }),
    );
    expect(result.current.sessionKnown).toBe(true);
    expect(result.current.session?.id).toBe("s1");

    act(() => socket.close());
    expect(result.current.connected).toBe(false);
    expect(result.current.sessionKnown).toBe(true); // same lifecycle as `session`: not nulled on disconnect

    unmount();
  });
});
