import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiKeyListing } from "../../api/types";
import { qk } from "../../queries/keys";
import { renderWithProviders } from "../../test/renderWithProviders";
import { ApiKeysGroup, pillForApiKey } from "./ApiKeysGroup";

const listing = (over: Partial<ApiKeyListing> = {}): ApiKeyListing => ({
  id: "google",
  label: "Google",
  description: "Gemini API — accelerates avatar generation.",
  hasKey: false,
  last4: null,
  verified: null,
  detail: null,
  lastCheckedAt: null,
  ...over,
});

const jsonResponse = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

/**
 * A live broker really is listening on 127.0.0.1:7790 on dev machines — this throws by
 * default so an un-stubbed route fails loudly instead of silently reaching it. Tests that
 * exercise a mutation replace this with their own `vi.stubGlobal("fetch", ...)`.
 */
function stubNoNetwork() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("no network in this test");
    }),
  );
}

describe("pillForApiKey", () => {
  it("maps the four states", () => {
    expect(pillForApiKey(listing()).label).toBe("no key");
    expect(pillForApiKey(listing({ hasKey: true, verified: false })).label).toBe("needs valid key");
    expect(pillForApiKey(listing({ hasKey: true, verified: "unknown" })).label).toBe("unverified");
    expect(pillForApiKey(listing({ hasKey: true, verified: true })).label).toBe("valid");
  });
});

describe("ApiKeysGroup", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders a card per provider with masked last4, never the key", async () => {
    stubNoNetwork();
    const { client } = renderWithProviders(<ApiKeysGroup />);
    client.setQueryData(qk.apiKeys, [listing({ hasKey: true, last4: "9876", verified: true })]);
    await screen.findByText(/•••• 9876/);
    expect(screen.getByText("valid")).toBeDefined();
  });

  it("save sends the typed key and re-renders from the response", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api-keys/google") && init?.method === "PUT") {
        expect(JSON.parse(String(init.body))).toEqual({ key: "sk-new-4321" });
        return jsonResponse({ providers: [listing({ hasKey: true, last4: "4321", verified: true })] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { client } = renderWithProviders(<ApiKeysGroup />);
    client.setQueryData(qk.apiKeys, [listing()]);
    await screen.findByText("no key");
    await userEvent.type(screen.getByLabelText(/api key/i), "sk-new-4321");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await screen.findByText(/•••• 4321/);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api-keys/google"),
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("surfaces errors inline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api-keys/google/verify")) return jsonResponse({ error: "no key stored for google" });
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const { client } = renderWithProviders(<ApiKeysGroup />);
    client.setQueryData(qk.apiKeys, [listing({ hasKey: true, last4: "9876", verified: "unknown" })]);
    await screen.findByText("unverified");
    await userEvent.click(screen.getByRole("button", { name: /verify/i }));
    await screen.findByText(/no key stored for google/);
  });

  it("keeps the typed draft in the input when save fails, so the user can correct it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api-keys/google") && init?.method === "PUT")
          return jsonResponse({ error: "invalid key format" });
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const { client } = renderWithProviders(<ApiKeysGroup />);
    client.setQueryData(qk.apiKeys, [listing()]);
    await screen.findByText("no key");
    const input = screen.getByLabelText(/api key/i) as HTMLInputElement;
    await userEvent.type(input, "sk-bad-key");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await screen.findByText(/invalid key format/);
    expect(input.value).toBe("sk-bad-key");
  });

  it("a load rejection surfaces a visible error instead of a silently empty grid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("broker unreachable");
      }),
    );
    renderWithProviders(<ApiKeysGroup />);
    expect(await screen.findByText(/could not load api keys — /i)).toBeDefined();
  });
});
