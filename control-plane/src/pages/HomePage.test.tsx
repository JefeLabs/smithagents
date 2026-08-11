import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { usePushToTalk } from "../hooks/usePushToTalk";
import { useSpokenReplies } from "../hooks/useSpokenReplies";
import { useTheme } from "../hooks/useTheme";
import { qk } from "../queries/keys";
import { createAppRouter } from "../router";
import { useSocketStore } from "../stores/socketStore";
import { useUiStore } from "../stores/uiStore";
import { renderWithProviders } from "../test/renderWithProviders";

// Only the hooks that reach for browser hardware are module-mocked: speech
// synthesis + AudioContext, getUserMedia, and matchMedia. Everything the page
// used to get from `useBrokerChat` now comes from the query cache and the
// socket store, so it is seeded rather than mocked. What those two hooks DO
// with the data they read for themselves is covered in their own suites —
// this file only asserts that the page mounts them at app scope.
vi.mock("../hooks/useSpokenReplies");
vi.mock("../hooks/usePushToTalk");
vi.mock("../hooks/useTheme");

/**
 * Stand-in for the browser WebSocket. A live broker really is listening on
 * 127.0.0.1:7790 on dev machines — without this every test here would open a
 * socket to it. `live` counts sockets that were opened and not closed, so a
 * missing teardown is visible rather than merely a missing construction.
 */
class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static last: FakeSocket | null = null;
  static count = 0;
  static live = 0;

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.last = this;
    FakeSocket.count++;
    FakeSocket.live++;
  }

  /** The handshake completing — a real socket fires this well after the constructor returns. */
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  emit(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  send() {}

  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    FakeSocket.live--;
    this.onclose?.();
  }
}

const SESSION_FRAME = {
  type: "session",
  session: null,
  sessions: [],
  workspaces: ["acme"],
  transcript: [],
};

let fetchMock: ReturnType<typeof vi.fn>;

function stubBroker() {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/agents")) return new Response(JSON.stringify({ agents: [], voice: { stt: false, tts: true } }));
    if (url.endsWith("/workspaces")) return new Response(JSON.stringify({ workspaces: [] }));
    if (url.endsWith("/cli-tools")) return new Response(JSON.stringify({ tools: [] }));
    return new Response(JSON.stringify({}));
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);
}

/**
 * A dedicated client seeded BEFORE the first render: the app's own
 * QueryClient is created inside `renderWithProviders`, and seeding after the
 * router's async mount would race its garbage collector for keys no observer
 * has subscribed to yet.
 */
function renderApp(seed?: (c: QueryClient) => void, path = "/") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY, refetchOnWindowFocus: false } },
  });
  seed?.(client);
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  return { ...renderWithProviders(<RouterProvider router={router} />, { client }), router };
}

/**
 * The rail renders once the root layout (HomePage) is mounted. Sidebar.Menu is
 * RAC Tree built as a treegrid, not a <nav> — see ToolRail.tsx.
 */
const appMounted = () => screen.findByRole("treegrid", { name: /tools/i });

const callsTo = (suffix: string) => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith(suffix)).length;

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

beforeEach(() => {
  FakeSocket.last = null;
  FakeSocket.count = 0;
  FakeSocket.live = 0;
  vi.mocked(useTheme).mockReturnValue({ theme: "dark", setTheme: vi.fn() });
  vi.mocked(useSpokenReplies).mockReturnValue({ playAudioFrame: vi.fn() });
  vi.mocked(usePushToTalk).mockReturnValue({ micLive: false, micError: null, toggleMic: vi.fn() });
  stubBroker();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("HomePage — the broker socket", () => {
  it("opens one socket on mount and closes it on unmount", async () => {
    const { unmount } = renderApp();
    await appMounted();
    expect(FakeSocket.count).toBe(1);
    expect(FakeSocket.live).toBe(1);

    unmount();
    expect(FakeSocket.live).toBe(0);
  });

  it("routes frames into the CURRENT QueryClient after a remount, not the retired one", async () => {
    // connect() short-circuits while the store is already active, so a teardown
    // that forgets to disconnect leaves the first mount's socket — and its
    // captured QueryClient — as the live one forever.
    const first = renderApp();
    await appMounted();
    first.unmount();

    const second = renderApp();
    await appMounted();
    act(() => FakeSocket.last?.emit(SESSION_FRAME));

    expect(second.client.getQueryData(qk.workspaces)).toEqual(["acme"]);
    expect(first.client.getQueryData(qk.workspaces)).toBeUndefined();
  });

  it("mounts the two audio hooks at app scope, above the router", async () => {
    // Both are pinned here for reasons a stage route cannot satisfy:
    // usePushToTalk holds a live MediaStream in refs, so navigating with a hot
    // mic would orphan it, and useSpokenReplies must keep voicing replies on
    // /board and /map, not only on /voice. Neither takes data arguments any
    // more — what they do with what they read is covered in their own suites.
    renderApp(undefined, "/board");
    await appMounted();
    expect(vi.mocked(useSpokenReplies)).toHaveBeenCalled();
    expect(vi.mocked(usePushToTalk)).toHaveBeenCalled();
  });
});

describe("HomePage — the zero-session composer", () => {
  const knownZero = (c: QueryClient) => {
    c.setQueryData(qk.session, null);
    c.setQueryData(qk.sessions, []);
    c.setQueryData(qk.workspaces, ["acme"]);
  };

  it("forces the composer open when the broker confirms zero sessions", async () => {
    renderApp(knownZero);
    await appMounted();
    act(() => FakeSocket.last?.open());

    expect(await screen.findByRole("heading", { name: /start a session/i })).toBeInTheDocument();
  });

  it("holds the execution-mode and workspace-record probes until the composer is on screen", async () => {
    renderApp(knownZero);
    await appMounted();
    // The persistent ChatDock is a labelled <section> (role="region") named "Chat",
    // covering the home surface where VoiceStage's "Voice" region used to be.
    await screen.findByRole("region", { name: "Chat" });
    // The handshake has not finished, so the composer is off screen and neither
    // probe has any reason to run yet.
    expect(callsTo("/execution-modes")).toBe(0);
    expect(callsTo("/workspaces")).toBe(0);

    act(() => FakeSocket.last?.open());
    await screen.findByRole("heading", { name: /start a session/i });

    await waitFor(() => expect(callsTo("/execution-modes")).toBe(1));
    expect(callsTo("/workspaces")).toBe(1);
  });

  it("re-reads the probes every time the composer reopens, not only the first time", async () => {
    // The hand-rolled effect this replaced refetched on each open, so a mode
    // that vanished (or a workspace edited) while the composer was closed is
    // current the moment it comes back. `enabled` flipping false→true has to
    // carry that, or the picker silently shows a stale answer.
    renderApp((c) => {
      c.setQueryData(qk.session, { id: "s1", title: "Current", workspace: "acme", runtime: "local-in-process" });
      c.setQueryData(qk.sessions, []);
      c.setQueryData(qk.workspaces, ["acme"]);
    });
    await appMounted();

    await userEvent.click(screen.getByRole("row", { name: "Sessions" }));
    await userEvent.click(screen.getByRole("button", { name: /new session · acme/i }));
    await screen.findByRole("heading", { name: /start a session/i });
    await waitFor(() => expect(callsTo("/execution-modes")).toBe(1));

    await userEvent.click(screen.getByRole("button", { name: /cancel new session/i }));
    // The persistent ChatDock is a labelled <section> (role="region") named "Chat",
    // covering the home surface where VoiceStage's "Voice" region used to be.
    await screen.findByRole("region", { name: "Chat" });

    await userEvent.click(screen.getByRole("row", { name: "Sessions" }));
    await userEvent.click(screen.getByRole("button", { name: /new session · acme/i }));
    await screen.findByRole("heading", { name: /start a session/i });

    await waitFor(() => expect(callsTo("/execution-modes")).toBe(2));
    expect(callsTo("/workspaces")).toBe(2);
  });

  it("leaves the stage alone while the broker has not answered yet", async () => {
    // Nothing seeded: the session query stays `pending`, which is the state the
    // old `sessionKnown` flag existed to distinguish from a confirmed null.
    renderApp();
    await appMounted();
    act(() => FakeSocket.last?.open());
    // Asserted, not assumed: the optional chaining above would quietly no-op on a
    // null socket, and this case would then be passing through the `connected`
    // gate rather than the status gate it exists to isolate.
    expect(useSocketStore.getState().connected).toBe(true);

    // The persistent ChatDock is a labelled <section> (role="region") named "Chat",
    // covering the home surface where VoiceStage's "Voice" region used to be.
    await screen.findByRole("region", { name: "Chat" });
    expect(screen.queryByRole("heading", { name: /start a session/i })).toBeNull();
  });

  it("leaves the stage alone until the socket is connected", async () => {
    renderApp(knownZero);
    await appMounted();
    // FakeSocket.open() deliberately never called — the handshake has not finished.

    // The persistent ChatDock is a labelled <section> (role="region") named "Chat",
    // covering the home surface where VoiceStage's "Voice" region used to be.
    await screen.findByRole("region", { name: "Chat" });
    expect(screen.queryByRole("heading", { name: /start a session/i })).toBeNull();
  });
});

describe("HomePage — voice status refresh on Settings close", () => {
  it("re-fetches /agents when Settings closes, so a key added mid-session takes effect without a reload", async () => {
    renderApp();
    await appMounted();
    await waitFor(() => expect(callsTo("/agents")).toBeGreaterThan(0));
    const callsAfterMount = callsTo("/agents");

    await userEvent.click(screen.getByRole("row", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: /back to app/i }));

    await waitFor(() => expect(callsTo("/agents")).toBeGreaterThan(callsAfterMount));
  });
});

describe("HomePage — composer closes when another session is activated", () => {
  const SESSIONS = [
    {
      id: "s-active",
      title: "Current work",
      workspace: "acme",
      updatedAt: "2026-08-01T00:00:00Z",
      active: true,
      runtime: "local-in-process" as const,
    },
    {
      id: "s-other",
      title: "Other work",
      workspace: "acme",
      updatedAt: "2026-08-02T00:00:00Z",
      active: false,
      runtime: "local-docker" as const,
    },
  ];

  it("picking another session backs out of an explicitly-opened composer (spec §3)", async () => {
    renderApp((c) => {
      c.setQueryData(qk.session, {
        id: "s-active",
        title: "Current work",
        workspace: "acme",
        runtime: "local-in-process",
      });
      c.setQueryData(qk.sessions, SESSIONS);
      c.setQueryData(qk.workspaces, ["acme"]);
    });
    await appMounted();

    // Open the sessions panel and start a new session in "acme" — opens the composer explicitly.
    await userEvent.click(screen.getByRole("row", { name: "Sessions" }));
    await userEvent.click(screen.getByRole("button", { name: /new session · acme/i }));
    expect(screen.getByRole("heading", { name: /start a session/i })).toBeInTheDocument();

    // Reopen sessions and activate the other (inactive) session.
    await userEvent.click(screen.getByRole("row", { name: "Sessions" }));
    await userEvent.click(screen.getByText("Other work"));

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:7790/sessions/s-other/activate", {
      credentials: "include",
      method: "POST",
    });
    expect(screen.queryByRole("heading", { name: /start a session/i })).toBeNull();
  });
});

describe("HomePage — creating a session lands in its conversation", () => {
  const ONE_SESSION = [
    {
      id: "s1",
      title: "Current work",
      workspace: "acme",
      updatedAt: "2026-08-01T00:00:00Z",
      active: true,
      runtime: "local-in-process" as const,
    },
  ];

  const seedOneSession = (c: QueryClient) => {
    c.setQueryData(qk.session, { id: "s1", title: "Current work", workspace: "acme", runtime: "local-in-process" });
    c.setQueryData(qk.sessions, ONE_SESSION);
    c.setQueryData(qk.workspaces, ["acme"]);
  };

  /** Open the composer explicitly and send a prompt, from wherever we currently are. */
  async function createSession() {
    await userEvent.click(screen.getByRole("row", { name: "Sessions" }));
    await userEvent.click(screen.getByRole("button", { name: /new session · acme/i }));
    await userEvent.type(await screen.findByRole("textbox"), "fix the build");
    await userEvent.click(screen.getByRole("button", { name: /send|start/i }));
  }

  it("routes to the conversation on success, leaving whatever stage was showing", async () => {
    // Starting on /board is the whole point: the composer replaces the stage, so
    // without an explicit navigation, closing it drops the user back on the board
    // while the broker is already streaming the reply into the transcript.
    const { router } = renderApp(seedOneSession, "/board");
    await appMounted();
    expect(router.state.location.pathname).toBe("/board");

    await createSession();

    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("stays put when the broker rejects the create, so the error stays on screen", async () => {
    // The failure path returns before closeComposer/navigate. Navigating anyway
    // would unmount the composer holding the message explaining what went wrong.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/sessions")) {
          return new Response(JSON.stringify({ error: 'execution mode "local-docker" is not available' }), {
            status: 409,
          });
        }
        if (url.endsWith("/agents"))
          return new Response(JSON.stringify({ agents: [], voice: { stt: false, tts: true } }));
        if (url.endsWith("/workspaces")) return new Response(JSON.stringify({ workspaces: [] }));
        if (url.endsWith("/cli-tools")) return new Response(JSON.stringify({ tools: [] }));
        return new Response(JSON.stringify({}));
      }),
    );
    const { router } = renderApp(seedOneSession, "/board");
    await appMounted();

    await createSession();

    expect(await screen.findByText(/not available/)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/board");
  });

  it("dashboards docks the chat right immediately when a thread exists, and body carries the variant", async () => {
    renderApp((client) => {
      client.setQueryData(qk.transcript, [{ id: "m1", role: "user", text: "hola", at: "t" }]);
    }, "/dashboards");
    const dock = await screen.findByRole("region", { name: "Chat" });
    expect(dock.className).toContain("chat-dock--dock");
    // The stage's width reservation keys off this stamp — it must track the
    // ACTUAL variant (thread-docked ask view included), not just board view.
    expect(document.body.getAttribute("data-dock")).toBe("dock");
  });

  it("dashboards docks the chat right while a board displays, center otherwise", async () => {
    renderApp(undefined, "/dashboards");
    const dock = await screen.findByRole("region", { name: "Chat" });
    expect(dock.className).toContain("chat-dock--center");
    act(() => useUiStore.getState().setDashBoardShowing(true));
    await waitFor(() => expect(screen.getByRole("region", { name: "Chat" }).className).toContain("chat-dock--dock"));
    act(() => useUiStore.getState().setDashBoardShowing(false));
    await waitFor(() => expect(screen.getByRole("region", { name: "Chat" }).className).toContain("chat-dock--center"));
  });

  it("a send from /doc carries the viewed doc and the aimed section, then spends the aim", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith("/agents"))
          return new Response(JSON.stringify({ agents: [], voice: { stt: false, tts: true } }));
        if (url.endsWith("/workspaces")) return new Response(JSON.stringify({ workspaces: [] }));
        if (url.endsWith("/cli-tools")) return new Response(JSON.stringify({ tools: [] }));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    renderApp((client) => {
      client.setQueryData(qk.documents, [
        {
          id: "d1",
          title: "Login spec",
          blueprintId: "spec",
          workType: "feature",
          sections: [{ id: "overview", heading: "What this is", body: "Words." }],
          participants: [],
          status: "drafting",
          createdAt: "t",
          updatedAt: "t",
        },
      ]);
    }, "/doc/d1");
    await screen.findByRole("region", { name: "Document" });
    act(() => FakeSocket.last?.open()); // the composer enables once the broker socket is up
    act(() => useUiStore.getState().setDocTarget({ docId: "d1", sectionId: "overview", heading: "What this is" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Type a request" }), "tighten this");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      const sent = calls.find((c) => c.url.endsWith("/utterance"));
      expect(sent?.body).toMatchObject({
        text: "tighten this",
        doc: { docId: "d1", sectionId: "overview" },
      });
    });
    expect(useUiStore.getState().docTarget).toBeNull(); // one send spends the aim
  });

  it("focus mode stamps body[data-focus]; Esc exits", async () => {
    renderApp();
    await userEvent.click(await screen.findByRole("row", { name: "Focus" }));
    expect(document.body.hasAttribute("data-focus")).toBe(true);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.body.hasAttribute("data-focus")).toBe(false));
  });
});
