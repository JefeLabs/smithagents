import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useCliToolHealth } from "./hooks/useCliToolHealth";
import { usePushToTalk } from "./hooks/usePushToTalk";
import { useSpokenReplies } from "./hooks/useSpokenReplies";
import { useTheme } from "./hooks/useTheme";
import { qk } from "./queries/keys";
import { createAppRouter } from "./router";
import { renderWithProviders } from "./test/renderWithProviders";

// Same isolation story as HomePage.test.tsx: only the hardware-touching hooks
// are module-mocked. The roster the work route resolves against is seeded into
// the query cache, exactly as a roster frame would deliver it.
vi.mock("./hooks/useSpokenReplies");
vi.mock("./hooks/usePushToTalk");
vi.mock("./hooks/useCliToolHealth");
vi.mock("./hooks/useTheme");

/** Keeps the root layout's `connect()` off the live broker on 127.0.0.1:7790. */
class FakeSocket {
  static OPEN = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  send() {}
  close() {}
}

const ROSTER = [{ id: "ignacio", name: "Ignacio", role: "Builder", status: "busy" as const, kind: "agent" as const }];

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = () => {};
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
});

async function renderAt(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY, refetchOnWindowFocus: false } },
  });
  client.setQueryData(qk.roster, { agents: ROSTER, identity: null });
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  renderWithProviders(<RouterProvider router={router} />, { client });
  // The rail renders once the root layout is mounted.
  await screen.findByRole("navigation", { name: /tools/i });
  return router;
}

describe("stage routing", () => {
  beforeEach(() => {
    vi.mocked(useTheme).mockReturnValue({ theme: "dark", setTheme: vi.fn() });
    vi.mocked(useCliToolHealth).mockReturnValue({ warnings: {}, refresh: vi.fn() });
    vi.mocked(useSpokenReplies).mockReturnValue({
      soundOn: false,
      toggleSound: vi.fn(),
      playAudioFrame: vi.fn(),
      audioBlocked: false,
    });
    vi.mocked(usePushToTalk).mockReturnValue({ micLive: false, micError: null, toggleMic: vi.fn() });
    vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);
    // Board/Map/voice-status/settings fetches all hit the broker; answer them all empty.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/agents"))
          return new Response(JSON.stringify({ agents: [], voice: { stt: false, tts: false } }));
        if (url.endsWith("/work/boards")) return new Response(JSON.stringify({ boards: [] }));
        if (url.endsWith("/work/capabilities")) return new Response(JSON.stringify({ capabilities: [] }));
        if (url.endsWith("/workspaces")) return new Response(JSON.stringify({ workspaces: [] }));
        return new Response(JSON.stringify({}));
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders the voice stage at / — no board main", async () => {
    await renderAt("/");
    expect(screen.queryByRole("main", { name: "Work boards" })).toBeNull();
  });

  it("board tool navigates to /board and highlights itself", async () => {
    const router = await renderAt("/");
    await userEvent.click(screen.getByRole("button", { name: /^board$/i }));
    expect(await screen.findByRole("main", { name: "Work boards" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/board");
    expect(screen.getByRole("button", { name: /^board$/i }).getAttribute("aria-current")).toBe("true");
  });

  it("clicking the active board tool stays on the board (no toggle)", async () => {
    const router = await renderAt("/");
    await userEvent.click(screen.getByRole("button", { name: /^board$/i }));
    await screen.findByRole("main", { name: "Work boards" });
    await userEvent.click(screen.getByRole("button", { name: /^board$/i }));
    // Give a would-be toggle navigation time to land before asserting it didn't.
    await new Promise((r) => setTimeout(r, 50));
    expect(router.state.location.pathname).toBe("/board");
    expect(screen.getByRole("main", { name: "Work boards" })).toBeTruthy();
  });

  it("browser back restores the previous stage", async () => {
    const router = await renderAt("/");
    await userEvent.click(screen.getByRole("button", { name: /^map$/i }));
    await screen.findByRole("main", { name: "Story map" });
    act(() => router.history.back());
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(screen.queryByRole("main", { name: "Story map" })).toBeNull();
  });

  it("logo navigates home from a stage", async () => {
    const router = await renderAt("/map");
    await screen.findByRole("main", { name: "Story map" });
    await userEvent.click(screen.getByRole("button", { name: /home/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("an unknown route redirects home", async () => {
    const router = await renderAt("/nonsense");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("an unknown agent id redirects home", async () => {
    const router = await renderAt("/work/ghost");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("a known roster agent renders the work stage", async () => {
    const router = await renderAt("/work/ignacio");
    await waitFor(() => expect(document.querySelector("main.work-stage")).toBeTruthy());
    expect(router.state.location.pathname).toBe("/work/ignacio");
  });
});
