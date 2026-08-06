import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SurfacePolicyPopover } from "./SurfacePolicyPopover";

const agentsPayload = (channels: unknown, presence: Record<string, boolean>, configured = true) => ({
  agents: [{ id: "ignacio", name: "Ignacio", channels, presence }],
  discord: { configured, voiceReady: configured },
});

describe("SurfacePolicyPopover", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // vitest.config.ts doesn't set test.globals, so RTL's auto-cleanup (which
  // feature-detects a *global* afterEach) never registers — without this,
  // each render() in this file leaks into the next test's queries.
  afterEach(() => {
    cleanup();
  });

  it("renders only the two Discord rows — a stale tauri key never renders a row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              agentsPayload(
                { tauri: "on-request", discord: "on-request", "discord-voice": "on-request" },
                {
                  discord: true,
                  "discord-voice": false,
                },
              ),
            ),
          ),
      ),
    );
    render(<SurfacePolicyPopover agentId="ignacio" name="Ignacio" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Discord voice")).toBeDefined());
    expect(screen.queryByText("Tauri app")).toBeNull();
    expect(screen.getByText("Discord text")).toBeDefined();
    // discord is on-request but PRESENT (admitted) → no Join now; discord-voice absent → Join now.
    expect(screen.getAllByRole("button", { name: /join now/i })).toHaveLength(1);
  });

  it("mode click PUTs the full record with a tauri-free channels map", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return new Response(JSON.stringify({ ok: true }));
      return new Response(JSON.stringify(agentsPayload(["tauri", "discord"], { discord: true })));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SurfacePolicyPopover agentId="ignacio" name="Ignacio" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Discord text")).toBeDefined());
    const disabledTabs = screen.getAllByRole("tab", { name: /disabled/i });
    await userEvent.click(disabledTabs[0] as HTMLElement); // first row = Discord text (autojoin → disabled)
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(put).toBeDefined();
    const [, init] = put ?? [];
    const body = JSON.parse(String(init?.body));
    expect(body.channels).toMatchObject({ discord: "disabled", "discord-voice": "disabled" });
    expect("tauri" in body.channels).toBe(false);
  });

  it("grays the Discord rows when Discord is unconfigured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(agentsPayload({}, {}, false)))),
    );
    render(<SurfacePolicyPopover agentId="ignacio" name="Ignacio" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/not configured/i)).toBeDefined());
  });
});
