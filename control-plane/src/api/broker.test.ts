import { afterEach, describe, expect, it, vi } from "vitest";
import { getApiKeys, getWorkspaceRecords, saveApiKey, setCliToolEnabled } from "./broker";

afterEach(() => vi.unstubAllGlobals());

function stubJson(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) => ({ ok, status, json: async () => body }) as unknown as Response,
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("broker api", () => {
  it("unwraps the envelope key for list endpoints", async () => {
    // The broker's real envelope key is "providers" (swarm/src/server.ts:1777), not "keys".
    stubJson({ providers: [{ id: "google", label: "Google" }] });
    const keys = await getApiKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]?.id).toBe("google");
  });

  it("returns [] when an envelope key is absent rather than throwing", async () => {
    stubJson({});
    expect(await getWorkspaceRecords()).toEqual([]);
  });

  it("posts the typed key to the right url", async () => {
    const fetchMock = stubJson({ providers: [] });
    await saveApiKey("google", "sk-live-123");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api-keys/google");
    expect(JSON.parse(String(init.body))).toEqual({ key: "sk-live-123" });
  });

  it("surfaces a broker error body instead of the parsed list", async () => {
    stubJson({ error: "unknown tool" }, false, 400);
    expect(await setCliToolEnabled("nope", true)).toEqual({ error: "unknown tool" });
  });
});
