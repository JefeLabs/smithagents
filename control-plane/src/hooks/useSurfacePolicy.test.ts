import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { joinNowVisible, modesFrom, useSurfacePolicy } from "./useSurfacePolicy";

describe("modesFrom", () => {
  it("parses map form with absent keys disabled", () => {
    expect(modesFrom({ channels: { tauri: "autojoin" } })).toMatchObject({
      tauri: "autojoin",
      discord: "disabled",
      "discord-voice": "disabled",
    });
  });
  it("parses legacy array: listed autojoin, unlisted disabled", () => {
    expect(modesFrom({ channels: ["discord"] })).toMatchObject({
      tauri: "disabled",
      discord: "autojoin",
      "discord-voice": "disabled",
    });
  });
  it("absent field: text autojoin, voice disabled", () => {
    expect(modesFrom({})).toMatchObject({
      tauri: "autojoin",
      discord: "autojoin",
      "discord-voice": "disabled",
    });
  });
});

describe("joinNowVisible", () => {
  it("shows only for on-request and not present", () => {
    expect(joinNowVisible("on-request", false)).toBe(true);
    expect(joinNowVisible("on-request", true)).toBe(false);
    expect(joinNowVisible("autojoin", false)).toBe(false);
    expect(joinNowVisible("disabled", false)).toBe(false);
  });
});

// Deferred promise: lets a test control exactly when a given fetch() call's
// response arrives, so resolution order can be driven independently of
// dispatch order — the only way to actually exercise a race.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function errJson(status: number, body: unknown): Response {
  return { ok: false, status, json: async () => body } as Response;
}

function agentsResponse(id: string, channels: unknown) {
  return { agents: [{ id, channels }], discord: { configured: true, voiceReady: true } };
}

// Real timers; a macrotask tick reliably drains any number of chained
// promise microtasks (fetch().then(json).then(handler), including the
// nested `await res.json()` on the failure path) before assertions run.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("useSurfacePolicy races", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a stale setMode failure never clobbers a later setMode for the same surface", async () => {
    const getReq = deferred<Response>();
    const putReq1 = deferred<Response>();
    const putReq2 = deferred<Response>();
    fetchMock
      .mockImplementationOnce(() => getReq.promise)
      .mockImplementationOnce(() => putReq1.promise)
      .mockImplementationOnce(() => putReq2.promise);

    const { result } = renderHook(() => useSurfacePolicy("fabian"));

    act(() => {
      getReq.resolve(okJson(agentsResponse("fabian", { discord: "autojoin" })));
    });
    await waitFor(() => expect(result.current.modes.discord).toBe("autojoin"));

    act(() => {
      result.current.setMode("discord", "on-request"); // dispatch #1 -> putReq1
    });
    expect(result.current.modes.discord).toBe("on-request");

    act(() => {
      result.current.setMode("discord", "disabled"); // dispatch #2 -> putReq2, #1 still pending
    });
    expect(result.current.modes.discord).toBe("disabled");

    // The LATEST request (#2) settles first, as a success.
    await act(async () => {
      putReq2.resolve(okJson({ ok: true }));
      await flush();
    });
    expect(result.current.modes.discord).toBe("disabled");
    expect(result.current.errors.discord).toBeUndefined();

    // The STALE request (#1) settles after, as a failure. It must be ignored.
    await act(async () => {
      putReq1.resolve(errJson(409, { error: "stale failure" }));
      await flush();
    });
    expect(result.current.modes.discord).toBe("disabled");
    expect(result.current.errors.discord).toBeUndefined();
  });

  it("a stale GET response after an agent-id switch never overwrites the newer agent's state", async () => {
    const getAlice = deferred<Response>();
    const getBob = deferred<Response>();
    fetchMock.mockImplementationOnce(() => getAlice.promise).mockImplementationOnce(() => getBob.promise);

    const { result, rerender } = renderHook(({ id }) => useSurfacePolicy(id), {
      initialProps: { id: "alice" },
    });

    rerender({ id: "bob" }); // fires bob's GET while alice's is still in flight

    // Bob's GET (the newer request) settles first.
    await act(async () => {
      getBob.resolve(okJson(agentsResponse("bob", { discord: "on-request" })));
      await flush();
    });
    await waitFor(() => expect(result.current.modes.discord).toBe("on-request"));

    // Alice's stale GET settles after. It must not overwrite bob's state.
    await act(async () => {
      getAlice.resolve(okJson(agentsResponse("alice", { discord: "autojoin" })));
      await flush();
    });
    expect(result.current.modes.discord).toBe("on-request");
  });
});
