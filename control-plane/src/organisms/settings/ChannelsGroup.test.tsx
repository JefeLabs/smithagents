import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../test/renderWithProviders";
import { ChannelsGroup } from "./ChannelsGroup";

const jsonResponse = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

/** Routes every endpoint ChannelsGroup can hit; overrides fill in the per-test response. */
function stubFetch(overrides: { channels?: unknown; save?: unknown; verify?: unknown } = {}) {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/workspaces")) return jsonResponse({ workspaces: [{ name: "acme", default: true, repos: [] }] });
    if (url.endsWith("/channels/verify-discord")) {
      return jsonResponse(overrides.verify ?? { ok: true, detail: "unknown" });
    }
    if (url.endsWith("/channels") && init?.method === "PUT") {
      return jsonResponse(overrides.save ?? { hasDiscordToken: false, textChannels: [], voiceChannels: [] });
    }
    if (url.endsWith("/channels")) {
      return jsonResponse(overrides.channels ?? { hasDiscordToken: false, textChannels: [], voiceChannels: [] });
    }
    throw new Error(`unexpected fetch ${url} ${init?.method ?? "GET"}`);
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

describe("ChannelsGroup", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("picking a workspace loads its channel config; saving submits the bot token and channel lists", async () => {
    const { calls } = stubFetch({
      channels: { hasDiscordToken: false, textChannels: [], voiceChannels: [] },
      save: { hasDiscordToken: true, textChannels: ["111"], voiceChannels: [] },
    });
    renderWithProviders(<ChannelsGroup />);
    await userEvent.click(await screen.findByText("acme"));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/workspaces/acme/channels") && !c.method)).toBe(true));

    await userEvent.type(screen.getByPlaceholderText(/discord bot token/i), "disc-tok");
    await userEvent.type(screen.getByPlaceholderText(/text channel id/i), "111");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url.endsWith("/workspaces/acme/channels") &&
            c.method === "PUT" &&
            (c.body as { discord?: { botToken?: string; textChannels?: string[] } }).discord?.botToken === "disc-tok" &&
            (c.body as { discord?: { botToken?: string; textChannels?: string[] } }).discord?.textChannels?.[0] ===
              "111",
        ),
      ).toBe(true),
    );
  });

  it("Test connection calls verifyDiscord for the selected workspace and shows the result", async () => {
    const { calls } = stubFetch({
      channels: { hasDiscordToken: true, textChannels: [], voiceChannels: [] },
      verify: { ok: true, detail: "Bot authenticated as smithagents-crew" },
    });
    renderWithProviders(<ChannelsGroup />);
    await userEvent.click(await screen.findByText("acme"));
    await userEvent.click(await screen.findByRole("button", { name: /test connection/i }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith("/workspaces/acme/channels/verify-discord"))).toBe(true),
    );
    expect(await screen.findByText(/authenticated as smithagents-crew/i)).toBeDefined();
  });
});
