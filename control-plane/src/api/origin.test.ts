import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../stores/authStore";
import { brokerBase, brokerFetch, httpUrl, isCloud, LOCAL_BASE, wsUrl } from "./origin";

const dev = { hostname: "localhost", host: "localhost:1420", protocol: "http:" };
const tauri = { hostname: "tauri.localhost", host: "tauri.localhost", protocol: "tauri:" };
const cloud = { hostname: "skoolscout.smith.app", host: "skoolscout.smith.app", protocol: "https:" };

afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.getState().clearSessionLost();
});

describe("origin derivation", () => {
  it("dev + tauri are local; a real https host is cloud", () => {
    expect(isCloud(dev)).toBe(false);
    expect(isCloud(tauri)).toBe(false);
    expect(isCloud(cloud)).toBe(true);
  });
  it("brokerBase follows the page's own hostname locally, so the session cookie is same-site", () => {
    expect(brokerBase(dev)).toBe("localhost:7790");
    expect(brokerBase({ hostname: "127.0.0.1", host: "127.0.0.1:1420", protocol: "http:" })).toBe("127.0.0.1:7790");
    expect(brokerBase(tauri)).toBe(LOCAL_BASE);
    expect(brokerBase(cloud)).toBe("skoolscout.smith.app");
  });
  it("httpUrl/wsUrl follow the page scheme", () => {
    expect(httpUrl("/sessions", LOCAL_BASE, dev)).toBe("http://127.0.0.1:7790/sessions");
    expect(wsUrl("/events", "skoolscout.smith.app", cloud)).toBe("wss://skoolscout.smith.app/events");
  });
  it("brokerFetch sends credentials and passes the path through", async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await brokerFetch("/sessions", LOCAL_BASE, { method: "POST" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/sessions$/);
    expect(init?.credentials).toBe("include");
    expect(init?.method).toBe("POST");
  });
  it("a 401 flips sessionLost locally too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );
    await brokerFetch("/me");
    expect(useAuthStore.getState().sessionLost).toBe(true);
  });
  it("a 401 from /auth/me never flips it (it IS the check)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );
    await brokerFetch("/auth/me");
    expect(useAuthStore.getState().sessionLost).toBe(false);
  });
});
