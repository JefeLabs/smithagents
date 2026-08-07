import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiKeyListing } from "../../hooks/useBrokerChat";
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

describe("pillForApiKey", () => {
  it("maps the four states", () => {
    expect(pillForApiKey(listing()).label).toBe("no key");
    expect(pillForApiKey(listing({ hasKey: true, verified: false })).label).toBe("needs valid key");
    expect(pillForApiKey(listing({ hasKey: true, verified: "unknown" })).label).toBe("unverified");
    expect(pillForApiKey(listing({ hasKey: true, verified: true })).label).toBe("valid");
  });
});

describe("ApiKeysGroup", () => {
  afterEach(() => cleanup());

  it("renders a card per provider with masked last4, never the key", async () => {
    render(
      <ApiKeysGroup
        listApiKeys={async () => [listing({ hasKey: true, last4: "9876", verified: true })]}
        saveApiKey={vi.fn()}
        verifyApiKey={vi.fn()}
        deleteApiKey={vi.fn()}
      />,
    );
    await screen.findByText(/•••• 9876/);
    expect(screen.getByText("valid")).toBeDefined();
  });

  it("save sends the typed key and re-renders from the response", async () => {
    const saveApiKey = vi.fn(async () => [listing({ hasKey: true, last4: "4321", verified: true })]);
    render(
      <ApiKeysGroup
        listApiKeys={async () => [listing()]}
        saveApiKey={saveApiKey}
        verifyApiKey={vi.fn()}
        deleteApiKey={vi.fn()}
      />,
    );
    await screen.findByText("no key");
    await userEvent.type(screen.getByLabelText(/api key/i), "sk-new-4321");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(saveApiKey).toHaveBeenCalledWith("google", "sk-new-4321");
    await screen.findByText(/•••• 4321/);
  });

  it("surfaces errors inline", async () => {
    render(
      <ApiKeysGroup
        listApiKeys={async () => [listing({ hasKey: true, last4: "9876", verified: "unknown" })]}
        saveApiKey={vi.fn()}
        verifyApiKey={vi.fn(async () => ({ error: "no key stored for google" }))}
        deleteApiKey={vi.fn()}
      />,
    );
    await screen.findByText("unverified");
    await userEvent.click(screen.getByRole("button", { name: /verify/i }));
    await screen.findByText(/no key stored for google/);
  });

  it("keeps the typed draft in the input when save fails, so the user can correct it", async () => {
    const saveApiKey = vi.fn(async () => ({ error: "invalid key format" }));
    render(
      <ApiKeysGroup
        listApiKeys={async () => [listing()]}
        saveApiKey={saveApiKey}
        verifyApiKey={vi.fn()}
        deleteApiKey={vi.fn()}
      />,
    );
    await screen.findByText("no key");
    const input = screen.getByLabelText(/api key/i) as HTMLInputElement;
    await userEvent.type(input, "sk-bad-key");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await screen.findByText(/invalid key format/);
    expect(input.value).toBe("sk-bad-key");
  });
});
