import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelsManagerModal } from "./ChannelsManagerModal";

describe("ChannelsManagerModal", () => {
  afterEach(() => {
    cleanup();
  });

  it("picking a workspace loads its channel config; saving submits the bot token and channel lists", async () => {
    const listWorkspaces = vi.fn(async () => [{ name: "acme", description: undefined, default: true, repos: [] }]);
    const getChannels = vi.fn(async () => ({ hasDiscordToken: false, textChannels: [], voiceChannels: [] }));
    const saveChannels = vi.fn(async () => ({ hasDiscordToken: true, textChannels: ["111"], voiceChannels: [] }));
    render(
      <ChannelsManagerModal
        open
        onClose={() => {}}
        listWorkspaces={listWorkspaces}
        getChannels={getChannels}
        saveChannels={saveChannels}
        verifyDiscord={vi.fn()}
      />,
    );
    await waitFor(() => expect(listWorkspaces).toHaveBeenCalled());
    await userEvent.click(await screen.findByText("acme"));
    await waitFor(() => expect(getChannels).toHaveBeenCalledWith("acme"));

    await userEvent.type(screen.getByPlaceholderText(/discord bot token/i), "disc-tok");
    await userEvent.type(screen.getByPlaceholderText(/text channel id/i), "111");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(saveChannels).toHaveBeenCalledWith(
        "acme",
        expect.objectContaining({ discord: expect.objectContaining({ botToken: "disc-tok", textChannels: ["111"] }) }),
      ),
    );
  });

  it("Test connection calls verifyDiscord for the selected workspace and shows the result", async () => {
    const verifyDiscord = vi.fn(async () => ({ ok: true, detail: "Bot authenticated as smithagents-crew" }));
    render(
      <ChannelsManagerModal
        open
        onClose={() => {}}
        listWorkspaces={vi.fn(async () => [{ name: "acme", description: undefined, default: true, repos: [] }])}
        getChannels={vi.fn(async () => ({ hasDiscordToken: true, textChannels: [], voiceChannels: [] }))}
        saveChannels={vi.fn()}
        verifyDiscord={verifyDiscord}
      />,
    );
    await userEvent.click(await screen.findByText("acme"));
    await userEvent.click(await screen.findByRole("button", { name: /test connection/i }));
    await waitFor(() => expect(verifyDiscord).toHaveBeenCalledWith("acme"));
    expect(await screen.findByText(/authenticated as smithagents-crew/i)).toBeDefined();
  });
});
