import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@simplewebauthn/browser", () => ({
  startRegistration: vi.fn(async () => ({ id: "cred-1", type: "public-key" })),
  startAuthentication: vi.fn(async () => ({ id: "cred-1", type: "public-key" })),
}));

import { beginEnroll, EnrollError, finishEnroll, getMe, login } from "./auth";

const res = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("auth api", () => {
  it("getMe returns the human on 200, null on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res(200, { kind: "human", name: "edwin" })),
    );
    expect((await getMe())?.name).toBe("edwin");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res(401, { error: "unauthorized" })),
    );
    expect(await getMe()).toBeNull();
  });

  it("beginEnroll throws bad-code on 410", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res(410, { error: "invalid-code" })),
    );
    await expect(beginEnroll("XXXX-XXXX", "edwin")).rejects.toMatchObject({ code: "bad-code" });
  });

  it("finishEnroll runs the ceremony and posts the result, returning the user", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith("/auth/register/verify") ? res(201, { userId: "u1", name: "edwin" }) : res(200, {}),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await finishEnroll("ABCD-EFGH", { challenge: "c" } as never);
    expect(out).toEqual({ userId: "u1", name: "edwin" });
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/auth/register/verify"))).toBe(true);
  });

  it("login runs begin → ceremony → verify", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith("/auth/login/verify")
        ? res(200, { userId: "u1", name: "edwin" })
        : res(200, { challenge: "c" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await login()).toEqual({ userId: "u1", name: "edwin" });
  });

  it("a cancelled ceremony surfaces as EnrollError('ceremony-failed')", async () => {
    const browser = await import("@simplewebauthn/browser");
    (browser.startRegistration as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("cancelled"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res(200, {})),
    );
    await expect(finishEnroll("ABCD-EFGH", { challenge: "c" } as never)).rejects.toBeInstanceOf(EnrollError);
  });
});
