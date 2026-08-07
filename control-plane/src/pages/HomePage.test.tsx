import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useBrokerChat } from "../hooks/useBrokerChat";
import { useCliToolHealth } from "../hooks/useCliToolHealth";
import { usePushToTalk } from "../hooks/usePushToTalk";
import { useSpokenReplies } from "../hooks/useSpokenReplies";
import { useTheme } from "../hooks/useTheme";
import { createAppRouter } from "../router";

// HomePage owns no injectable props for its dependencies (unlike every other tested
// component) — it calls these hooks directly, and useBrokerChat opens a real WebSocket
// on mount. Module-mocking is the only way to render it in isolation; useVoiceStatus is
// deliberately left real (below) so its own `/agents` fetch is the thing under test.
vi.mock("../hooks/useBrokerChat");
vi.mock("../hooks/useSpokenReplies");
vi.mock("../hooks/usePushToTalk");
vi.mock("../hooks/useCliToolHealth");
vi.mock("../hooks/useTheme");

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

function mockBrokerChat(overrides: Record<string, unknown> = {}) {
  vi.mocked(useBrokerChat).mockReturnValue({
    messages: [],
    roster: [],
    identity: null,
    connected: true,
    audioMode: false,
    session: null,
    sessionKnown: true, // preserves this suite's intent: session:null is a confirmed zero-session state, not "unknown yet"
    sessions: [],
    workspaces: [],
    send: vi.fn(),
    compose: vi.fn(),
    activity: vi.fn(),
    removalPreview: vi.fn(),
    removeAgent: vi.fn(),
    workAction: vi.fn(),
    micControl: vi.fn(),
    micAudio: vi.fn(),
    createSession: vi.fn(),
    activateSession: vi.fn(),
    resetSetup: vi.fn(),
    listExecutionModes: vi.fn(async () => ({})),
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
    getMe: vi.fn(),
    updateMe: vi.fn(),
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
    ...overrides,
  } as unknown as ReturnType<typeof useBrokerChat>);
}

describe("HomePage — voice status refresh on Settings close", () => {
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
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("re-fetches /agents when Settings closes, so a key added mid-session takes effect without a reload", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ agents: [], voice: { stt: false, tts: true } })));
    vi.stubGlobal("fetch", fetchMock);

    const router = createAppRouter(createMemoryHistory({ initialEntries: ["/"] }));
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:7790/agents"));
    const callsAfterMount = fetchMock.mock.calls.length;

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: /back to app/i }));

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterMount));
    expect(fetchMock).toHaveBeenLastCalledWith("http://127.0.0.1:7790/agents");
  });
});

describe("HomePage — composer closes when another session is activated", () => {
  const activateSession = vi.fn();
  const SESSIONS = [
    {
      id: "s-active",
      title: "Current work",
      workspace: "acme",
      updatedAt: "2026-08-01T00:00:00Z",
      active: true,
      runtime: "local-in-process",
    },
    {
      id: "s-other",
      title: "Other work",
      workspace: "acme",
      updatedAt: "2026-08-02T00:00:00Z",
      active: false,
      runtime: "local-docker",
    },
  ];

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
    activateSession.mockClear();
    mockBrokerChat({
      session: { id: "s-active", title: "Current work", workspace: "acme", runtime: "local-in-process" },
      sessions: SESSIONS,
      workspaces: ["acme"],
      activateSession,
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("picking another session backs out of an explicitly-opened composer (spec §3)", async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ["/"] }));
    render(<RouterProvider router={router} />);

    // Open the sessions panel and start a new session in "acme" — opens the composer explicitly.
    // findByRole waits out the router's async first mount before the first interaction.
    await userEvent.click(await screen.findByRole("button", { name: "Sessions" }));
    await userEvent.click(screen.getByRole("button", { name: /new session · acme/i }));
    expect(screen.getByText("Start a session")).toBeDefined();

    // Reopen sessions and activate the other (inactive) session.
    await userEvent.click(screen.getByRole("button", { name: "Sessions" }));
    await userEvent.click(screen.getByText("Other work"));

    expect(activateSession).toHaveBeenCalledWith("s-other");
    expect(screen.queryByText("Start a session")).toBeNull();
  });
});
