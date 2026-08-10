import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { usePushToTalk } from "../hooks/usePushToTalk";
import { useSpokenReplies } from "../hooks/useSpokenReplies";
import { useTheme } from "../hooks/useTheme";
import { AddAgentModal } from "../organisms/AddAgentModal";
import { qk } from "../queries/keys";
import { createAppRouter } from "../router";
import { useSocketStore } from "../stores/socketStore";
import { renderWithProviders } from "../test/renderWithProviders";
import { AlertMenu } from "./AlertMenu";

// The two halves of the engine-warning join: a CLI the registry has confirmed
// inactive, and an agent whose engine points at it. `computeEngineWarnings`
// renders that as "claude: not logged in", so the alert reads
// "ana — claude: not logged in" and targets /work/ana.
const INACTIVE_CLAUDE = [
  {
    cli: "claude",
    label: "claude",
    models: [],
    warmSessions: true,
    active: false,
    status: {
      detected: true,
      authOk: false,
      enabled: true,
      detail: "not logged in",
      lastCheckedAt: "2026-08-09T00:00:00.000Z",
    },
  },
];

/** One engine warning (target /work/ana) plus one board error (target /board) — two alerts. */
function seedTwoAlerts(c: QueryClient) {
  c.setQueryData(qk.cliTools, INACTIVE_CLAUDE);
  c.setQueryData(qk.agentRecords, { agents: [{ id: "ana", engine: { cli: "claude" } }] });
  c.setQueryData(qk.boards, { boards: [], errors: [{ file: "boards.json", error: "could not load boards" }] });
}

/** Everything healthy — every source seeded empty so nothing is merely "not loaded yet". */
function seedNoAlerts(c: QueryClient) {
  c.setQueryData(qk.cliTools, []);
  c.setQueryData(qk.agentRecords, { agents: [] });
  c.setQueryData(qk.boards, { boards: [], errors: [] });
}

/**
 * A live broker really is listening on 127.0.0.1:7790 on dev machines. Every
 * query this component joins is HTTP-backed, so without a stub these tests
 * would read the developer's actual machine state and pass or fail with it.
 */
function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/agents"))
        return new Response(JSON.stringify({ agents: [], voice: { stt: false, tts: true } }));
      if (url.endsWith("/cli-tools")) return new Response(JSON.stringify({ tools: [] }));
      // FULLY shaped, not empty. AddAgentModal reads `catalog?.engines.find(...)`,
      // `catalog?.stereotypes.find(...)` and `catalog?.jobRoles.find(...)` — each
      // optional-chained on the catalog but NOT on the array, so any missing key throws
      // during render rather than degrading.
      if (url.endsWith("/agent-catalog"))
        return new Response(JSON.stringify({ presets: [], engines: [], stereotypes: [], jobRoles: [], languages: [] }));
      return new Response(JSON.stringify({}));
    }),
  );
}

function renderMenu(seed: (c: QueryClient) => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Number.POSITIVE_INFINITY } },
  });
  seed(client);
  const onNavigate = vi.fn();
  return { ...renderWithProviders(<AlertMenu onNavigate={onNavigate} />, { client }), onNavigate };
}

beforeEach(() => {
  useSocketStore.setState({ connected: true });
  stubFetch();
});

// vitest.config.ts doesn't set test.globals, so RTL's auto-cleanup (which
// feature-detects a *global* afterEach) never registers — without this, each
// render() in this file leaks into the next test's queries.
afterEach(() => {
  cleanup();
  useSocketStore.setState({ connected: false });
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("AlertMenu — the badge", () => {
  it("names itself with the alert count, and shows that count as a badge", async () => {
    renderMenu(seedTwoAlerts);
    // The count rides the accessible NAME, not only a visual badge: a screen
    // reader never reaches a decorative <span>, so a static "Alerts" label
    // beside a badge would announce nothing about how many.
    const button = await screen.findByRole("button", { name: "2 alerts" });
    expect(button.textContent).toBe("2");
  });

  it("says one alert in the singular", async () => {
    renderMenu((c) => {
      c.setQueryData(qk.cliTools, []);
      c.setQueryData(qk.agentRecords, { agents: [] });
      c.setQueryData(qk.boards, { boards: [], errors: [{ file: "boards.json", error: "could not load boards" }] });
    });
    await screen.findByRole("button", { name: "1 alert" });
  });

  it("renders no badge when there is nothing wrong, and says so in its name", async () => {
    renderMenu(seedNoAlerts);
    const button = await screen.findByRole("button", { name: "No alerts" });
    // No badge at all, rather than a badge reading "0" — the icon carries the
    // state and the name explains it.
    expect(button.textContent).toBe("");
  });
});

describe("AlertMenu — the menu", () => {
  it("opening lists every alert", async () => {
    renderMenu(seedTwoAlerts);
    await userEvent.click(await screen.findByRole("button", { name: "2 alerts" }));

    await screen.findByRole("dialog", { name: /alerts/i });
    expect(screen.getByText("ana — claude: not logged in")).toBeInTheDocument();
    expect(screen.getByText("could not load boards")).toBeInTheDocument();
  });

  it("carries severity in the accessible name, not only in the border colour", async () => {
    // Asserted as an EXACT name on purpose. A substring regex would match with
    // or without the visually-hidden prefix, so the prefix could be deleted
    // without failing anything — which is not a guarantee at all.
    renderMenu(seedTwoAlerts);
    await userEvent.click(await screen.findByRole("button", { name: "2 alerts" }));

    expect(await screen.findByRole("button", { name: "Warning: ana — claude: not logged in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Error: could not load boards" })).toBeInTheDocument();
  });

  it("pressing a row with a target calls onNavigate with that target", async () => {
    const { onNavigate } = renderMenu(seedTwoAlerts);
    await userEvent.click(await screen.findByRole("button", { name: "2 alerts" }));

    await userEvent.click(await screen.findByRole("button", { name: "Error: could not load boards" }));
    expect(onNavigate).toHaveBeenCalledWith("/board");
  });

  it("opening with nothing wrong says so, rather than showing an empty panel", async () => {
    renderMenu(seedNoAlerts);
    await userEvent.click(await screen.findByRole("button", { name: "No alerts" }));

    await screen.findByRole("dialog", { name: /alerts/i });
    expect(screen.getByText("Nothing to report")).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("a row with no target is not a button", async () => {
    // A disconnected broker is the one alert `computeAlerts` emits with no
    // target — there is nowhere useful to send the click, so the row must not
    // advertise itself as pressable.
    useSocketStore.setState({ connected: false });
    const { onNavigate } = renderMenu(seedTwoAlerts);

    await userEvent.click(await screen.findByRole("button", { name: "1 alert" }));
    expect(screen.getByText("Broker disconnected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Broker disconnected/ })).toBeNull();
    // The severity prefix still has to reach the row that is NOT a button —
    // it has no accessible name of its own to carry it.
    expect(screen.getByRole("listitem").textContent).toBe("Error: Broker disconnected");
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    renderMenu(seedTwoAlerts);
    await userEvent.click(await screen.findByRole("button", { name: "2 alerts" }));
    await screen.findByRole("dialog", { name: /alerts/i });

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /alerts/i })).toBeNull());
  });

  it("a modal opened over the menu takes Escape for itself — one dismissal, not two", async () => {
    // BOTH OVERLAYS OPEN AT ONCE, which only a keyboard can reach: AlertMenu closes on
    // outside `mousedown`, so clicking any modal trigger dismisses the menu before the
    // modal exists. A test that opens the modal by clicking reports "cannot reproduce"
    // and is wrong about why.
    function Both() {
      const [modalOpen, setModalOpen] = useState(false);
      return (
        <>
          <AlertMenu onNavigate={vi.fn()} />
          <button type="button" onClick={() => setModalOpen(true)}>
            Add agent
          </button>
          <AddAgentModal open={modalOpen} onClose={() => setModalOpen(false)} />
        </>
      );
    }
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Number.POSITIVE_INFINITY } },
    });
    seedTwoAlerts(client);
    renderWithProviders(<Both />, { client });

    await userEvent.click(await screen.findByRole("button", { name: "2 alerts" }));
    await screen.findByRole("dialog", { name: /alerts/i });

    // `fireEvent.click` dispatches ONLY a click. `userEvent.click` would fire a mousedown
    // first, and AlertMenu closes on any outside mousedown — which is exactly why this
    // overlap cannot be reached with a mouse, and why a test that used one would report
    // "cannot reproduce" while proving nothing.
    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    expect(await screen.findByRole("dialog", { name: /create an agent/i })).toBeTruthy();
    // The menu is asserted through the DOM, not through a role query. The modal carries
    // `aria-modal="true"`, which takes everything outside it out of the accessibility
    // tree that `getByRole` reads — so while the modal is open the still-mounted menu is
    // invisible to role queries and a role-based assertion would report it closed.
    const menuInDom = () => document.querySelector(".alert-menu__popover");
    expect(menuInDom()).not.toBeNull();

    // ONE Escape dismisses ONE thing: the topmost.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /create an agent/i })).toBeNull());
    expect(menuInDom()).not.toBeNull();

    // …and the next one dismisses the menu, so nothing is stranded.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(menuInDom()).toBeNull());
  });

  it("Escape from inside a row returns focus to the trigger, not to <body>", async () => {
    // Closing while a row holds focus unmounts the focused element underneath
    // the user. Without an explicit restore, focus falls to <body> and the
    // keyboard user loses their place in the tab order entirely.
    renderMenu(seedTwoAlerts);
    const bell = await screen.findByRole("button", { name: "2 alerts" });
    await userEvent.click(bell);

    const row = await screen.findByRole("button", { name: "Error: could not load boards" });
    row.focus();
    expect(document.activeElement).toBe(row);

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /alerts/i })).toBeNull());
    expect(document.activeElement).toBe(bell);
  });

  it("closes when focus tabs out of the panel, and leaves focus where it landed", async () => {
    // The panel is not modal and does not trap the keyboard, so Tab from the last
    // row walks clean out of it — previously leaving a role="dialog" mounted and
    // announced behind the user. Leaving IS the close gesture here, the same one
    // an outside click already performs.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Number.POSITIVE_INFINITY } },
    });
    seedTwoAlerts(client);
    // A real neighbour to tab INTO. Focusing <body> would also blur the panel, but
    // it would not reproduce the defect: the complaint is that focus lands on some
    // other app control while the dialog stays open behind it.
    renderWithProviders(
      <>
        <AlertMenu onNavigate={vi.fn()} />
        <button type="button">somewhere else</button>
      </>,
      { client },
    );

    await userEvent.click(await screen.findByRole("button", { name: "2 alerts" }));
    await screen.findByRole("dialog", { name: /alerts/i });

    // The board-error row is LAST (computeAlerts emits engine warnings first), so
    // one Tab from it is exactly the keystroke that leaves the panel.
    screen.getByRole("button", { name: "Error: could not load boards" }).focus();
    await userEvent.tab();

    const outside = screen.getByRole("button", { name: "somewhere else" });
    expect(document.activeElement).toBe(outside);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /alerts/i })).toBeNull());
    // `setOpen`, NOT `closeAndRestoreFocus` — the assertion that distinguishes the
    // two. Restoring focus here would rip it back out of the control the user just
    // reached under their own keystroke.
    expect(document.activeElement).toBe(outside);
  });

  it("moving focus BETWEEN rows leaves the panel open", async () => {
    // The guard above rides on `currentTarget.contains(relatedTarget)`. Without
    // that check, an onBlur close would fire on every internal focus move and the
    // panel would collapse the instant a keyboard user tabbed from row one to row
    // two — a fix strictly worse than the leak it replaced.
    renderMenu(seedTwoAlerts);
    await userEvent.click(await screen.findByRole("button", { name: "2 alerts" }));

    const first = await screen.findByRole("button", { name: "Warning: ana — claude: not logged in" });
    first.focus();
    await userEvent.tab();

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Error: could not load boards" }));
    expect(screen.getByRole("dialog", { name: /alerts/i })).toBeInTheDocument();
  });

  it("pressing a row returns focus to the trigger too, not only Escape", async () => {
    // The pressed row IS the element that unmounts, and the route it navigates
    // to claims no focus of its own — the same defect as the Escape path, so it
    // needs the same guarantee and its own test rather than riding on that one.
    const { onNavigate } = renderMenu(seedTwoAlerts);
    const bell = await screen.findByRole("button", { name: "2 alerts" });
    await userEvent.click(bell);

    await userEvent.click(await screen.findByRole("button", { name: "Error: could not load boards" }));

    expect(onNavigate).toHaveBeenCalledWith("/board");
    expect(document.activeElement).toBe(bell);
  });
});

// ---------------------------------------------------------------------------
// Mounted in the real app: does the target actually navigate?
// ---------------------------------------------------------------------------

vi.mock("../hooks/useSpokenReplies");
vi.mock("../hooks/usePushToTalk");
vi.mock("../hooks/useTheme");

/** Stand-in for the browser WebSocket — HomePage opens one on mount. */
class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static last: FakeSocket | null = null;

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.last = this;
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  send() {}

  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
}

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

describe("AlertMenu — mounted in the navbar", () => {
  beforeEach(() => {
    vi.mocked(useTheme).mockReturnValue({ theme: "dark", setTheme: vi.fn() });
    vi.mocked(useSpokenReplies).mockReturnValue({ playAudioFrame: vi.fn() });
    vi.mocked(usePushToTalk).mockReturnValue({ micLive: false, micError: null, toggleMic: vi.fn() });
    vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);
  });

  it("an engine-warning row lands on the work route, param and all", async () => {
    // The alert carries a FLAT path (`/work/ana`) while the route is declared
    // as the pattern `/work/$agentId`. Asserting that onNavigate fired with a
    // string would pass even if that never resolved — so this asserts the
    // router's actual pathname after the press.
    // staleTime Infinity is load-bearing, not boilerplate: every source behind
    // `useAlerts` is an HTTP query, so seeded-but-stale data is refetched on
    // mount and the stub's empty payloads would erase the seeds mid-test.
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          gcTime: Number.POSITIVE_INFINITY,
          refetchOnWindowFocus: false,
          staleTime: Number.POSITIVE_INFINITY,
        },
      },
    });
    seedTwoAlerts(client);
    // A session, so the zero-session composer does not force itself over the
    // stage; a roster containing ana, so WorkRoute resolves her rather than
    // bouncing back to "/" as it does for a stale id.
    client.setQueryData(qk.session, { id: "s1", title: "Current", workspace: "acme", runtime: "local-in-process" });
    client.setQueryData(qk.sessions, []);
    client.setQueryData(qk.workspaces, ["acme"]);
    client.setQueryData(qk.roster, {
      agents: [{ id: "ana", name: "Ana", role: "Engineer", status: "idle", kind: "agent" }],
      identity: null,
    });

    const router = createAppRouter(createMemoryHistory({ initialEntries: ["/"] }));
    renderWithProviders(<RouterProvider router={router} />, { client });
    await screen.findByRole("treegrid", { name: /tools/i });
    // `connected` gates the whole join: a socket still handshaking collapses
    // every alert into the single broker-disconnected one.
    act(() => FakeSocket.last?.open());

    await userEvent.click(await screen.findByRole("button", { name: "2 alerts" }));
    await userEvent.click(await screen.findByRole("button", { name: /ana — claude: not logged in/ }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/work/ana"));
    // The pathname alone would not prove the $param bound — this is the leaf
    // match, and its params are what WorkRoute reads to find the agent.
    const leaf = router.state.matches[router.state.matches.length - 1];
    expect(leaf?.routeId).toBe("/work/$agentId");
    expect(leaf?.params).toEqual({ agentId: "ana" });
  });
});
