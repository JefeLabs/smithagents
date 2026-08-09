import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { joinNowVisible, modesFrom, useSurfacePolicy } from "./useSurfacePolicy";

describe("modesFrom", () => {
  it("parses map form with retired tauri skipped", () => {
    const result = modesFrom({ channels: { tauri: "autojoin", discord: "autojoin" } });
    expect(result).toMatchObject({
      discord: "autojoin",
      "discord-voice": "disabled",
    });
    expect("tauri" in result).toBe(false);
  });
  it("parses legacy array: listed autojoin, unlisted disabled, retired tauri skipped", () => {
    const result = modesFrom({ channels: ["discord", "tauri"] });
    expect(result).toMatchObject({
      discord: "autojoin",
      "discord-voice": "disabled",
    });
    expect("tauri" in result).toBe(false);
  });
  it("absent field: text autojoin, voice disabled", () => {
    const result = modesFrom({});
    expect(result).toMatchObject({
      discord: "autojoin",
      "discord-voice": "disabled",
    });
    expect("tauri" in result).toBe(false);
  });
  it("garbage channels value: all disabled, no tauri key", () => {
    const result = modesFrom({ channels: "discord" });
    expect(result).toEqual({ discord: "disabled", "discord-voice": "disabled" });
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

function agentsResponse(...agents: Array<{ id: string; channels: unknown }>) {
  return { agents, discord: { configured: true, voiceReady: true } };
}

/** Retry off so a rejected queryFn surfaces immediately rather than after backoff. */
function providerWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
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

    const { result } = renderHook(() => useSurfacePolicy("fabian"), { wrapper: providerWrapper() });

    act(() => {
      getReq.resolve(okJson(agentsResponse({ id: "fabian", channels: { discord: "autojoin" } })));
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

  it("an agent-id switch re-selects from the one cached response instead of racing a second GET", async () => {
    // This replaces a request-generation guard. The hook used to issue its own
    // GET per agent id, so a slow response for the id we navigated AWAY from
    // could land last and win; the guard discarded it by ticket number. Both
    // ids now come out of a single shared cache entry, so the stale response
    // it defended against cannot be constructed — there is only one request.
    const get = deferred<Response>();
    fetchMock.mockImplementation(() => get.promise);

    const { result, rerender } = renderHook(({ id }) => useSurfacePolicy(id), {
      initialProps: { id: "alice" },
      wrapper: providerWrapper(),
    });

    await act(async () => {
      get.resolve(
        okJson(
          agentsResponse(
            { id: "alice", channels: { discord: "autojoin" } },
            { id: "bob", channels: { discord: "on-request" } },
          ),
        ),
      );
      await flush();
    });
    await waitFor(() => expect(result.current.modes.discord).toBe("autojoin"));

    rerender({ id: "bob" });

    // Bob's modes, read synchronously from data already in hand.
    await waitFor(() => expect(result.current.modes.discord).toBe("on-request"));
    // Asserted, not assumed: a per-id fetch would make this 2 and reopen the
    // exact race the deleted guard existed to lose.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports the discord availability sibling, which only this endpoint carries", async () => {
    // `discord` rides GET /agents alongside the records and gates the popover's
    // rows. The WS roster frame has no such field, so a hook reading the roster
    // would report unconfigured for a perfectly healthy Discord.
    fetchMock.mockResolvedValue(okJson(agentsResponse({ id: "fabian", channels: {} })));
    const { result } = renderHook(() => useSurfacePolicy("fabian"), { wrapper: providerWrapper() });
    await waitFor(() => expect(result.current.discord).toEqual({ configured: true, voiceReady: true }));
    expect(result.current.loading).toBe(false);
  });
});
