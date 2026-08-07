import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useBrokerChat } from "./hooks/useBrokerChat";
import { useCliToolHealth } from "./hooks/useCliToolHealth";
import { usePushToTalk } from "./hooks/usePushToTalk";
import { useSpokenReplies } from "./hooks/useSpokenReplies";
import { useTheme } from "./hooks/useTheme";
import { createAppRouter } from "./router";

// Same isolation story as HomePage.test.tsx: HomePage calls these hooks
// directly and useBrokerChat opens a real WebSocket on mount.
vi.mock("./hooks/useBrokerChat");
vi.mock("./hooks/useSpokenReplies");
vi.mock("./hooks/usePushToTalk");
vi.mock("./hooks/useCliToolHealth");
vi.mock("./hooks/useTheme");

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

const ROSTER = [{ id: "ignacio", name: "Ignacio", role: "Builder", status: "busy" as const }];

function mockBrokerChat() {
  vi.mocked(useBrokerChat).mockReturnValue({
    messages: [],
    roster: ROSTER,
    identity: null,
    connected: true,
    audioMode: false,
    session: null,
    sessions: [],
    workspaces: [],
    lastBoardUpdate: null,
    lastCapabilityUpdate: null,
    send: vi.fn(),
    compose: vi.fn(),
    activity: vi.fn(async () => ({ busy: true, label: "compiling" })),
    removalPreview: vi.fn(),
    removeAgent: vi.fn(),
    workAction: vi.fn(async () => null),
    micControl: vi.fn(),
    micAudio: vi.fn(),
    createSession: vi.fn(),
    activateSession: vi.fn(),
    resetSetup: vi.fn(),
    listWorkspaceRecords: vi.fn(async () => []),
    saveWorkspace: vi.fn(),
    removeWorkspace: vi.fn(),
    verifyWorkspaceAtlassian: vi.fn(),
    verifyRepoGithub: vi.fn(),
    getWorkspaceChannels: vi.fn(),
    saveWorkspaceChannels: vi.fn(),
    verifyWorkspaceDiscord: vi.fn(),
    getVoiceSettings: vi.fn(async () => ({ stt: null, tts: null, hideInactive: false })),
    saveVoiceSettings: vi.fn(),
    listConnectorVendors: vi.fn(async () => []),
    listMyConnectors: vi.fn(async () => []),
    addConnector: vi.fn(),
    updateConnector: vi.fn(),
    deleteConnector: vi.fn(),
    verifyConnector: vi.fn(),
    listCliTools: vi.fn(async () => []),
    refreshCliTools: vi.fn(),
    setCliToolEnabled: vi.fn(),
    listApiKeys: vi.fn(async () => []),
    saveApiKey: vi.fn(),
    verifyApiKey: vi.fn(),
    deleteApiKey: vi.fn(),
  } as unknown as ReturnType<typeof useBrokerChat>);
}

async function renderAt(path: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(<RouterProvider router={router} />);
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
    mockBrokerChat();
    // Board/Map/voice-status fetches all hit the broker; answer them all empty.
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
    cleanup();
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

  it("clicking the active board tool returns home", async () => {
    const router = await renderAt("/");
    await userEvent.click(screen.getByRole("button", { name: /^board$/i }));
    await screen.findByRole("main", { name: "Work boards" });
    await userEvent.click(screen.getByRole("button", { name: /^board$/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(screen.queryByRole("main", { name: "Work boards" })).toBeNull();
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
