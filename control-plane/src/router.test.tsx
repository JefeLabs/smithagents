import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

async function renderAt(path: string, seed?: (client: QueryClient) => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY, refetchOnWindowFocus: false } },
  });
  client.setQueryData(qk.roster, { agents: ROSTER, identity: null });
  seed?.(client);
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  renderWithProviders(<RouterProvider router={router} />, { client });
  // The rail renders once the root layout is mounted. Sidebar.Menu is RAC Tree
  // built as a treegrid, not a <nav> — see ToolRail.tsx.
  await screen.findByRole("treegrid", { name: /tools/i });
  return router;
}

describe("stage routing", () => {
  beforeEach(() => {
    vi.mocked(useTheme).mockReturnValue({ theme: "dark", setTheme: vi.fn() });
    vi.mocked(useSpokenReplies).mockReturnValue({ playAudioFrame: vi.fn() });
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

  // BoardStage/MapStage render <section aria-label="..."> now, not <main> — a page
  // may only have one, un-nested <main> landmark, and HeroUI's required
  // Sidebar.Main already claims it (see base.css's .stage rule). A labelled
  // <section> maps to role="region", the same pattern NewSessionScreen already uses.
  it("renders the voice stage at / — no board region", async () => {
    await renderAt("/");
    expect(screen.queryByRole("region", { name: "Work boards" })).toBeNull();
  });

  it("board tool navigates to /board and highlights itself", async () => {
    const router = await renderAt("/");
    // Sidebar.MenuItem is RAC TreeItem — role="row", never "button" or a link.
    await userEvent.click(screen.getByRole("row", { name: /^board$/i }));
    expect(await screen.findByRole("region", { name: "Work boards" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/board");
    // isCurrent marks data-current, not aria-current, despite what the docs prose
    // claims — confirmed against the rendered DOM.
    expect(screen.getByRole("row", { name: /^board$/i }).getAttribute("data-current")).toBe("true");
  });

  it("dashboards tool navigates to /dashboards and highlights itself", async () => {
    const router = await renderAt("/");
    await userEvent.click(screen.getByRole("row", { name: /^dashboards$/i }));
    expect(await screen.findByRole("region", { name: "Dashboards" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/dashboards");
    expect(screen.getByRole("row", { name: /^dashboards$/i }).getAttribute("data-current")).toBe("true");
  });

  it("clicking the active board tool stays on the board (no toggle)", async () => {
    const router = await renderAt("/");
    await userEvent.click(screen.getByRole("row", { name: /^board$/i }));
    await screen.findByRole("region", { name: "Work boards" });
    await userEvent.click(screen.getByRole("row", { name: /^board$/i }));
    // Give a would-be toggle navigation time to land before asserting it didn't.
    await new Promise((r) => setTimeout(r, 50));
    expect(router.state.location.pathname).toBe("/board");
    expect(screen.getByRole("region", { name: "Work boards" })).toBeTruthy();
  });

  it("browser back restores the previous stage", async () => {
    const router = await renderAt("/");
    await userEvent.click(screen.getByRole("row", { name: /^map$/i }));
    await screen.findByRole("region", { name: "Story map" });
    act(() => router.history.back());
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(screen.queryByRole("region", { name: "Story map" })).toBeNull();
  });

  it("logo navigates home from a stage", async () => {
    const router = await renderAt("/map");
    await screen.findByRole("region", { name: "Story map" });
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
    await screen.findByRole("region", { name: "Work: Ignacio" });
    expect(router.state.location.pathname).toBe("/work/ignacio");
  });

  it("opening the sessions panel from the rail shows the active workspace in its header", async () => {
    await renderAt("/", (client) => {
      client.setQueryData(qk.session, {
        id: "s1",
        title: "Login spec",
        workspace: "acme",
        runtime: "local-in-process",
      });
    });
    await userEvent.click(screen.getByRole("row", { name: /^sessions$/i }));
    const panel = await screen.findByRole("dialog");
    expect(within(panel).getByText("acme")).toBeTruthy();
  });
});
