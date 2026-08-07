import { afterEach, describe, expect, it, vi } from "vitest";
import { type ExecutionMode, fetchExecutionModes, postSession, type SessionFrame } from "./useBrokerChat";

afterEach(() => vi.unstubAllGlobals());

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
