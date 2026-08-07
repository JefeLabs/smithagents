import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useBrokerChat } from "../hooks/useBrokerChat";
import { useCliToolHealth } from "../hooks/useCliToolHealth";
import { usePushToTalk } from "../hooks/usePushToTalk";
import { useSpokenReplies } from "../hooks/useSpokenReplies";
import { useTheme } from "../hooks/useTheme";
import { HomePage } from "./HomePage";

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

function mockBrokerChat() {
  vi.mocked(useBrokerChat).mockReturnValue({
    messages: [],
    roster: [],
    identity: null,
    connected: true,
    audioMode: false,
    session: null,
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

    render(<HomePage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:7790/agents"));
    const callsAfterMount = fetchMock.mock.calls.length;

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: /back to app/i }));

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterMount));
    expect(fetchMock).toHaveBeenLastCalledWith("http://127.0.0.1:7790/agents");
  });
});
