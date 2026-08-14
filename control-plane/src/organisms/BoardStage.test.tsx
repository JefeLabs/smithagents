import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_WORKSPACES } from "../lib/board-aggregate";
import { qk } from "../queries/keys";
import { useSocketStore } from "../stores/socketStore";
import { useUiStore } from "../stores/uiStore";
import { renderWithProviders } from "../test/renderWithProviders";
import type { WorkBoardT } from "./BoardStage";
import { BoardStage, moveCard, resolveCrossBoardDrop, resolveDrop } from "./BoardStage";

const BOARD = {
  id: "alpha",
  name: "Alpha",
  type: "personal" as const,
  columns: [
    { id: "todo", name: "Todo" },
    { id: "doing", name: "Doing" },
    { id: "done", name: "Done" },
    { id: "not-doing", name: "Not Doing" },
  ],
  cards: [
    { id: "c1", title: "Write the spec", columnId: "todo", order: 0 },
    {
      id: "c2",
      title: "Fix login",
      columnId: "doing",
      order: 0,
      jira: { key: "PROJ-1", url: "https://a/browse/PROJ-1" },
    },
    {
      id: "c3",
      title: "Ship avatars",
      columnId: "done",
      order: 0,
      delegation: { agentId: "minerva", taskId: "t1", state: "working" },
    },
  ],
};
const ROSTER = [
  {
    id: "minerva",
    name: "Minerva",
    role: "Security",
    ring: "#5fd0b0",
    avatar: "minerva.png",
    status: "idle" as const,
    kind: "agent" as const,
  },
];

function stubFetch(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const respond = (b: unknown, status = 200) => ({ ok: status < 400, status, json: async () => b }) as Response;
    if (url.endsWith("/work/boards") && method === "GET")
      return respond(overrides.boards ?? { boards: [BOARD], errors: [] });
    if (url.endsWith("/work/boards") && method === "POST")
      return respond(overrides.created ?? { ...BOARD, id: "beta", name: "Beta", cards: [] }, 201);
    if (url.endsWith("/workspaces") && method === "GET")
      return respond(overrides.workspaces ?? { workspaces: [{ name: "acme" }, { name: "beta-ws" }] });
    if (url.endsWith("/me") && method === "GET")
      return respond(overrides.me ?? { id: "edwin", name: "Edwin", connectors: [] });
    if (url.endsWith("/work/delegate") && method === "POST")
      return respond(overrides.delegated ?? { taskId: "t9" }, (overrides.delegateStatus as number) ?? 200);
    if (url.includes("/jira/import") && method === "POST")
      return respond(overrides.imported ?? { ok: true }, (overrides.importStatus as number) ?? 200);
    if (url.includes("/cards") && method === "POST")
      return respond({ id: "new", title: "New card", columnId: "backlog", order: 1 }, 201);
    if (url.includes("/cards") && method === "DELETE")
      return respond(overrides.deleted ?? {}, (overrides.deleteStatus as number) ?? 200);
    if (method === "PATCH") return respond(overrides.patched ?? {}, (overrides.patchStatus as number) ?? 200);
    return respond({});
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

function renderBoardStage(roster = ROSTER) {
  return renderWithProviders(<BoardStage roster={roster} />);
}

/**
 * Seeds the pushed-query cache the way the socket store would, per
 * src/test/renderWithProviders.tsx — BoardStage's scope now follows this
 * instead of an in-stage picker, so this is how tests drive it.
 */
function seedSessionFrame(client: QueryClient, session: { workspace: string }) {
  client.setQueryData(qk.session, { id: "s0", title: "t", workspace: session.workspace, runtime: "local-in-process" });
}

/**
 * fireDrop reaches applyMove through a module-level seam that a passive
 * effect registers. The tab derives synchronously from `boards`, so the
 * column heading appears in the SAME commit that loads them — findByText can
 * resolve before the effect has re-registered applyMove over the loaded
 * boards, leaving the seam holding a closure whose board list is still empty.
 * applyMove then bails without PATCHing. Flush effects before dropping.
 */
async function readyToDrop(columnName: string) {
  await screen.findByText(columnName);
  await act(async () => {});
}

describe("BoardStage", () => {
  beforeEach(() => stubFetch());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders columns and cards of the first board", async () => {
    stubFetch();
    renderWithProviders(<BoardStage roster={ROSTER} />);
    expect(await screen.findByText("Todo")).toBeTruthy();
    expect(screen.getByText("Write the spec")).toBeTruthy();
    expect(screen.getByText("PROJ-1")).toBeTruthy();
  });

  it("the context window hides cards not touched in range; a wide window shows everything", async () => {
    // c1 stamped inside the narrow window, c2 outside it, c3 undated
    // (undated cards can't be judged, so they stay visible — never hide silently).
    // A workspace board, not personal — the Agenda tab is range-invariant
    // (Task 6), so this exercises the window on a tab where it still applies.
    stubFetch({
      boards: {
        boards: [
          {
            ...BOARD,
            type: "plan",
            workspaceId: "acme",
            cards: [
              { id: "c1", title: "Write the spec", columnId: "todo", order: 0, updatedAt: "2026-08-10T12:00:00Z" },
              { id: "c2", title: "Fix login", columnId: "doing", order: 0, updatedAt: "2026-01-05T12:00:00Z" },
              { id: "c3", title: "Ship avatars", columnId: "done", order: 0 },
            ],
          },
        ],
        errors: [],
      },
    });
    const { client } = renderBoardStage();
    seedSessionFrame(client, { workspace: "acme" });
    // Wide window first: the DEFAULT (last 14 days, no sprint config here)
    // would already hide the January card on load.
    act(() => useUiStore.getState().setDateRange({ kind: "custom", from: "2026-01-01", to: "2026-12-31" }));
    await screen.findByText("Write the spec");
    expect(screen.getByText("Fix login")).toBeTruthy();
    act(() => useUiStore.getState().setDateRange({ kind: "custom", from: "2026-08-01", to: "2026-08-12" }));
    await waitFor(() => expect(screen.queryByText("Fix login")).toBeNull());
    expect(screen.getByText("Write the spec")).toBeTruthy();
    expect(screen.getByText("Ship avatars")).toBeTruthy();
  });

  it("shows the delegated card's agent badge from the roster", async () => {
    stubFetch();
    renderWithProviders(<BoardStage roster={ROSTER} />);
    await screen.findByText("Ship avatars");
    expect(screen.getByLabelText(/minerva is working on this card/i)).toBeTruthy();
  });

  it("the delegated card's avatar badge has no nested button, so the card stays a single button", async () => {
    stubFetch();
    renderWithProviders(<BoardStage roster={ROSTER} />);
    const title = await screen.findByText("Ship avatars");
    const badge = screen.getByLabelText(/minerva is working on this card/i);
    expect(within(badge).queryByRole("button")).toBeNull();
    const card = title.closest("button.board-card") as HTMLElement;
    expect(card).not.toBeNull();
    expect(within(card).queryAllByRole("button")).toHaveLength(0);
  });

  it("shows a done/total stories chip on the card face, and none when there are no stories", async () => {
    stubFetch({
      boards: {
        boards: [
          {
            ...BOARD,
            cards: [
              ...BOARD.cards,
              {
                id: "c4",
                title: "Ship boards",
                columnId: "done",
                order: 0,
                stories: [
                  { id: "s1", text: "one", done: true },
                  { id: "s2", text: "two", done: true },
                  { id: "s3", text: "three", done: false },
                ],
              },
            ],
          },
        ],
        errors: [],
      },
    });
    renderWithProviders(<BoardStage roster={ROSTER} />);
    await screen.findByText("Ship boards");
    expect(screen.getByText("2/3")).toBeTruthy();
    const noStoriesCard = screen.getByText("Write the spec").closest("button.board-card") as HTMLElement;
    expect(within(noStoriesCard).queryByText(/^\d+\/\d+$/)).toBeNull();
  });

  it("adds a card through the composer", async () => {
    const { calls } = stubFetch();
    renderWithProviders(<BoardStage roster={ROSTER} />);
    await screen.findByText("Todo");
    await userEvent.click(screen.getByRole("button", { name: /add card/i }));
    await userEvent.type(screen.getByPlaceholderText(/card title/i), "New card");
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.includes("/work/boards/alpha/cards"))).toBe(true),
    );
  });

  it("shows a tab per board, personal first, following the session frame's workspace", async () => {
    stubFetch({
      boards: {
        boards: [
          { ...BOARD, id: "acme-plan", name: "Plan", type: "plan", workspaceId: "acme" },
          { ...BOARD, id: "personal", name: "Agenda", type: "personal", workspaceId: undefined },
        ],
        errors: [],
      },
    });
    const { client } = renderBoardStage();
    seedSessionFrame(client, { workspace: "acme" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Plan" })).toBeTruthy());
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Agenda", "Plan"]);
  });

  it("follows the session frame's workspace without any in-stage control", async () => {
    stubFetch({
      boards: {
        boards: [{ ...BOARD, id: "acme-plan", name: "Plan", type: "plan", workspaceId: "acme" }],
        errors: [],
      },
    });
    const { client } = renderBoardStage();
    seedSessionFrame(client, { workspace: "acme" });
    expect(await screen.findByRole("tab", { name: /plan/i })).toBeDefined();
  });

  it("falls back to every workspace, not none, before the session frame has landed", async () => {
    // useSession() is skipToken-driven: `session` is `undefined` until the
    // first WS frame arrives, exactly the state a fresh /#/board load is in.
    // Falling back to an empty Set there would show zero workspace tabs —
    // fewer boards than before Task 3. The safe degenerate case is every
    // workspace, the prior default, not none.
    stubFetch({
      boards: {
        boards: [{ ...BOARD, id: "acme-plan", name: "Plan", type: "plan", workspaceId: "acme" }],
        errors: [],
      },
    });
    renderBoardStage();
    expect(await screen.findByRole("tab", { name: "Plan" })).toBeTruthy();
  });

  it("also falls back to every workspace when the session is confirmed to have none", async () => {
    // HomePage's knownZeroSessions state: the broker answered and confirmed
    // zero sessions, so `session` is a resolved `null`, not merely pending —
    // still no workspace to follow, same fallback applies.
    stubFetch({
      boards: {
        boards: [{ ...BOARD, id: "acme-plan", name: "Plan", type: "plan", workspaceId: "acme" }],
        errors: [],
      },
    });
    const { client } = renderBoardStage();
    client.setQueryData(qk.session, null);
    expect(await screen.findByRole("tab", { name: "Plan" })).toBeTruthy();
  });

  it("clusters cards by workspace under a subheading in the aggregate view", async () => {
    stubFetch({
      boards: {
        boards: [
          {
            ...BOARD,
            id: "acme-plan",
            name: "Plan",
            type: "plan",
            workspaceId: "acme",
            columns: [{ id: "spec", name: "Spec" }],
            cards: [{ id: "a1", title: "Parent portal", columnId: "spec", order: 0 }],
          },
          {
            ...BOARD,
            id: "globex-plan",
            name: "Plan",
            type: "plan",
            workspaceId: "globex",
            columns: [{ id: "spec", name: "Spec" }],
            cards: [{ id: "g1", title: "Billing", columnId: "spec", order: 0 }],
          },
        ],
        errors: [],
      },
    });
    const { client } = renderBoardStage();
    // Start following the session's one workspace: acme's card only, no subheadings.
    seedSessionFrame(client, { workspace: "acme" });
    await waitFor(() => expect(screen.getByText("Parent portal")).toBeTruthy());
    expect(screen.queryByText("Billing")).toBeNull();
    expect(document.querySelector(".board-column__cluster-name")).toBeNull();
    // ...then switch to the aggregate view: both workspaces, each subheaded.
    // No in-stage control does this (Task 3 retired it) — only the toggle a
    // future multiselect surface will drive, exercised here directly.
    act(() => useUiStore.getState().setViewedWorkspaces(ALL_WORKSPACES));
    const column = await waitFor(() => screen.getByText("Spec").closest(".board-column") as HTMLElement);
    expect(within(column).getByText("acme")).toBeTruthy();
    expect(within(column).getByText("globex")).toBeTruthy();
    expect(screen.getByText("Billing")).toBeTruthy();
  });

  it("resets the card composer when the tab or the session's workspace changes", async () => {
    stubFetch({
      boards: {
        boards: [
          { ...BOARD, id: "acme-plan", name: "Plan", type: "plan", workspaceId: "acme" },
          { ...BOARD, id: "beta-plan", name: "Plan", type: "plan", workspaceId: "beta" },
          { ...BOARD, id: "personal", name: "Agenda", type: "personal", workspaceId: undefined },
        ],
        errors: [],
      },
    });
    const { client } = renderBoardStage();
    seedSessionFrame(client, { workspace: "acme" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Agenda" })).toBeTruthy());
    await userEvent.click(screen.getByRole("tab", { name: "Agenda" }));
    await userEvent.click(screen.getByRole("button", { name: /add card/i }));
    await userEvent.type(screen.getByPlaceholderText(/card title/i), "Half-typed");
    // Switching tabs must not carry a half-typed card onto another board.
    await userEvent.click(screen.getByRole("tab", { name: "Plan" }));
    expect(screen.queryByPlaceholderText(/card title/i)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /add card/i }));
    expect((screen.getByPlaceholderText(/card title/i) as HTMLInputElement).value).toBe("");
    // ...and neither must the session moving to a different workspace — the
    // "Plan" tab itself persists across the move (both workspaces have one),
    // only the board behind it changes.
    seedSessionFrame(client, { workspace: "beta" });
    await waitFor(() => expect(screen.queryByPlaceholderText(/card title/i)).toBeNull());
  });

  it("closes an open card sheet when the tab or the session's workspace changes", async () => {
    // `open` names a card in the FULL boards list, not the tab's — without the
    // reset, workspace A's card sheet floats over workspace B's board.
    stubFetch({
      boards: {
        boards: [
          { ...BOARD, id: "acme-plan", name: "Plan", type: "plan", workspaceId: "acme" },
          { ...BOARD, id: "beta-plan", name: "Plan", type: "plan", workspaceId: "beta" },
          { ...BOARD, id: "personal", name: "Agenda", type: "personal", workspaceId: undefined },
        ],
        errors: [],
      },
    });
    const { client } = renderBoardStage();
    seedSessionFrame(client, { workspace: "acme" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Agenda" })).toBeTruthy());
    await userEvent.click(screen.getByRole("tab", { name: "Agenda" }));
    await userEvent.click(screen.getByText("Write the spec"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: "Plan" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    await userEvent.click(screen.getByText("Write the spec"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    // The "Plan" tab persists across this move (acme's and beta's boards both
    // hold that type) — only the board backing it changes, from acme's card
    // to beta's. Without the scope-keyed reset, acme's sheet would float over it.
    seedSessionFrame(client, { workspace: "beta" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("creates a board for the viewed workspace from the add menu", async () => {
    const { calls } = stubFetch({
      boards: {
        boards: [{ ...BOARD, id: "acme-plan", name: "Plan", type: "plan", workspaceId: "acme" }],
        errors: [],
      },
    });
    const { client } = renderBoardStage();
    seedSessionFrame(client, { workspace: "acme" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Plan" })).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: /add board/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Deliver" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/work/boards"))?.body).toEqual({
        type: "deliver",
        workspaceId: "acme",
      }),
    );
  });

  it("hides the add-board control once several workspaces are in view, and does not resurrect the menu already open on returning to one", async () => {
    // "You may look at many, but you may only create in one" — the rail's Plus
    // has the other half of this rule; this is the board's. The round trip
    // matters: the control unmounting and remounting must not resurface a
    // menu left open before the multi-workspace view — same bug class the
    // scope-keyed reset always guarded against, now lifted into BoardStage.
    stubFetch({
      boards: {
        boards: [
          { ...BOARD, id: "acme-plan", name: "Plan", type: "plan", workspaceId: "acme" },
          { ...BOARD, id: "beta-plan", name: "Plan", type: "plan", workspaceId: "beta" },
        ],
        errors: [],
      },
    });
    const { client } = renderBoardStage();
    seedSessionFrame(client, { workspace: "acme" });
    await userEvent.click(await screen.findByRole("button", { name: /add board/i }));
    expect(screen.getByRole("menu")).toBeTruthy();
    act(() => useUiStore.getState().setViewedWorkspaces(new Set(["acme", "beta"])));
    await waitFor(() => expect(screen.queryByRole("button", { name: /add board/i })).toBeNull());
    act(() => useUiStore.getState().setViewedWorkspaces(new Set(["beta"])));
    await screen.findByRole("button", { name: /add board/i });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("BoardStage + socket store wiring", () => {
  /** Minimal WebSocket stand-in — only what socketStore.connect()/onmessage need. */
  class FakeSocket {
    static last: FakeSocket | null = null;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readyState = 0;
    constructor(_url: string) {
      FakeSocket.last = this;
    }
    close() {}
  }

  afterEach(() => {
    cleanup();
    useSocketStore.getState().disconnect();
    FakeSocket.last = null;
    vi.unstubAllGlobals();
  });

  it("a board-updated frame invalidates the boards collection and triggers a real refetch", async () => {
    // This is the mechanism that replaced the deleted lastBoardUpdate seq
    // counter: Task 6's socketStore invalidates qk.boards, and because
    // BoardStage observes that key via useBoards(), the invalidate alone is
    // enough to produce a second GET — no prop, no manual refetch() call.
    vi.stubGlobal("WebSocket", FakeSocket);
    const { calls } = stubFetch();
    const { client } = renderWithProviders(<BoardStage roster={ROSTER} />);
    await screen.findByText("Todo");
    const fetched = () => calls.filter((c) => c.url.endsWith("/work/boards") && c.method === "GET").length;
    const before = fetched();
    const spy = vi.spyOn(client, "invalidateQueries");

    useSocketStore.getState().connect(client);
    await act(async () => {
      FakeSocket.last?.onmessage?.({ data: JSON.stringify({ type: "board-updated", boardId: "alpha" }) });
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: qk.boards });
    await waitFor(() => expect(fetched()).toBe(before + 1));
  });
});

describe("moveCard (optimistic mirror of the server move)", () => {
  const board = () => ({
    ...BOARD,
    cards: [
      { id: "a", title: "a", columnId: "ready", order: 0 },
      { id: "b", title: "b", columnId: "ready", order: 1 },
      { id: "c", title: "c", columnId: "done", order: 0 },
    ],
  });

  it("moves across columns at the target index and renumbers both", () => {
    const next = moveCard(board(), "a", "done", 0);
    const inCol = (col: string) =>
      next.cards
        .filter((c) => c.columnId === col)
        .sort((x, y) => x.order - y.order)
        .map((c) => c.id);
    expect(inCol("done")).toEqual(["a", "c"]);
    expect(inCol("ready")).toEqual(["b"]);
    expect(next.cards.find((c) => c.id === "b")?.order).toBe(0);
  });

  it("reorders within a column", () => {
    const next = moveCard(board(), "b", "ready", 0);
    expect(
      next.cards
        .filter((c) => c.columnId === "ready")
        .sort((x, y) => x.order - y.order)
        .map((c) => c.id),
    ).toEqual(["b", "a"]);
  });

  it("returns a new object and never mutates the input", () => {
    const b = board();
    const snapshot = JSON.stringify(b);
    moveCard(b, "a", "done", 1);
    expect(JSON.stringify(b)).toBe(snapshot);
  });
});

describe("BoardStage drag wiring", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("a cross-column drop PATCHes the moved card with columnId and order and applies optimistically", async () => {
    const { calls } = stubFetch();
    renderWithProviders(<BoardStage roster={ROSTER} />);
    await readyToDrop("Todo");
    // Drag simulation via dnd-kit is brittle in jsdom — call the exported
    // handler contract instead: the component wires handleCardDrop(boardId,
    // cardId, columnId, index) into DndContext. Assert through the module seam.
    const stage = screen.getByLabelText("Work boards");
    expect(stage).toBeTruthy();
    // The drop handler is exercised through moveCard tests above + the PATCH
    // assertion here via the exposed test hook:
    const { fireDrop } = await import("./BoardStage");
    await fireDrop("alpha", "c1", "doing", 0);
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "PATCH" &&
            c.url.includes("/cards/c1") &&
            (c.body as { columnId?: string })?.columnId === "doing",
        ),
      ).toBe(true),
    );
    const patchCall = calls.find((c) => c.method === "PATCH" && c.url.includes("/cards/c1"));
    expect(patchCall?.body).toEqual({ columnId: "doing", order: 0 });
  });

  it("PATCHes the card's own board, not the active tab's first board, in the aggregate view", async () => {
    const { calls } = stubFetch({
      boards: {
        boards: [
          {
            ...BOARD,
            id: "acme-plan",
            name: "Plan",
            type: "plan",
            workspaceId: "acme",
            columns: [
              { id: "spec", name: "Spec" },
              { id: "ready", name: "Ready" },
            ],
            cards: [{ id: "a1", title: "Parent portal", columnId: "spec", order: 0 }],
          },
          {
            ...BOARD,
            id: "globex-plan",
            name: "Plan",
            type: "plan",
            workspaceId: "globex",
            columns: [
              { id: "spec", name: "Spec" },
              { id: "ready", name: "Ready" },
            ],
            cards: [{ id: "g1", title: "Billing", columnId: "spec", order: 0 }],
          },
        ],
        errors: [],
      },
    });
    renderWithProviders(<BoardStage roster={ROSTER} />);
    // No in-stage picker drives this anymore — the aggregate view is now
    // reached only through the explicit multiselect toggle.
    act(() => useUiStore.getState().setViewedWorkspaces(ALL_WORKSPACES));
    await readyToDrop("Billing");
    const { fireDrop } = await import("./BoardStage");
    await fireDrop("globex-plan", "g1", "ready", 0);
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PATCH" && c.url.includes("/work/boards/globex-plan/cards/g1"))).toBe(true),
    );
  });

  it("a same-column reorder PATCHes {order} only, omitting columnId so the swarm's Jira push-on-move never fires", async () => {
    const { calls } = stubFetch();
    renderWithProviders(<BoardStage roster={ROSTER} />);
    await readyToDrop("Todo");
    const { fireDrop } = await import("./BoardStage");
    // c1 is already in "todo" — this is a same-column reorder.
    await fireDrop("alpha", "c1", "todo", 0);
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.url.includes("/cards/c1"))).toBe(true));
    const patchCall = calls.find((c) => c.method === "PATCH" && c.url.includes("/cards/c1"));
    expect(patchCall?.body).toEqual({ order: 0 });
    expect(patchCall?.body).not.toHaveProperty("columnId");
  });

  it("rolls back the optimistic move and surfaces an error when the PATCH fails", async () => {
    const { calls } = stubFetch({ patchStatus: 500 });
    renderWithProviders(<BoardStage roster={ROSTER} />);
    await readyToDrop("Write the spec");
    const { fireDrop } = await import("./BoardStage");
    await fireDrop("alpha", "c1", "doing", 0);
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.url.includes("/cards/c1"))).toBe(true));
    expect(await screen.findByText(/move failed/i)).toBeTruthy();
    // Card c1 is back in Todo, not left dangling in Doing.
    const todoColumn = screen.getByText("Todo").closest(".board-column") as HTMLElement;
    expect(within(todoColumn).queryByText("Write the spec")).toBeTruthy();
  });
});

describe("Agenda tab — pull queue, grab, and the drag branch", () => {
  const PERSONAL_COLUMNS = [
    { id: "plate", name: "My plate" },
    { id: "today", name: "Today" },
    { id: "done", name: "Done" },
    { id: "not-doing", name: "Not Doing" },
  ];
  const TEAM_COLUMNS = [
    { id: "ready", name: "Ready" },
    { id: "in-progress", name: "In progress" },
    { id: "review", name: "Review", gatesHuman: true },
    { id: "verify", name: "Verify" },
    { id: "merged", name: "Merged" },
  ];
  /** Builds the two-board fixture every test in this block needs, with each test supplying only the cards it cares about. */
  function agendaBoards(personalCards: unknown[] = [], teamCards: unknown[] = []) {
    return {
      boards: [
        { id: "personal", name: "Agenda", type: "personal" as const, columns: PERSONAL_COLUMNS, cards: personalCards },
        {
          id: "ws-deliver",
          name: "Deliver",
          type: "deliver" as const,
          workspaceId: "ws",
          columns: TEAM_COLUMNS,
          cards: teamCards,
        },
      ],
      errors: [],
    };
  }
  const HELD_CARD = {
    id: "held1",
    title: "Held team card",
    columnId: "review",
    order: 0,
    agenda: {
      by: "edwin",
      state: "plate" as const,
      since: "2026-08-13T08:00:00.000Z",
      grabbedAt: "2026-08-13T08:00:00.000Z",
    },
  };

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders five lanes: Shared queue, My plate, Today, Done, Not Doing", async () => {
    stubFetch({ boards: agendaBoards() });
    renderWithProviders(<BoardStage roster={ROSTER} />);
    await screen.findByText("Shared queue");
    for (const name of ["My plate", "Today", "Done", "Not Doing"]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
  });

  it("is range-invariant — a long-held card with a stale updatedAt still appears in its lane", async () => {
    // setStepState never re-stamps updatedAt, so a card grabbed weeks ago
    // keeps an old one. The date window (default: last 14 days) would drop
    // it from a normal board view; Agenda must not — that's the exact card
    // it exists to surface (oldest grabbedAt first, an "old" age chip).
    stubFetch({
      boards: agendaBoards([], [{ ...HELD_CARD, updatedAt: "2026-07-01T00:00:00.000Z" }]),
    });
    renderWithProviders(<BoardStage roster={ROSTER} />);
    act(() => useUiStore.getState().setDateRange({ kind: "custom", from: "2026-08-01", to: "2026-08-13" }));
    await screen.findByText("My plate");
    expect(screen.getByText("Held team card")).toBeTruthy();
  });

  it("grab sends the grab action and no columnId", async () => {
    const { calls } = stubFetch({
      boards: agendaBoards([], [{ id: "t1", title: "Unheld team card", columnId: "review", order: 0 }]),
    });
    renderWithProviders(<BoardStage roster={ROSTER} />);
    await readyToDrop("Shared queue");
    await userEvent.click(screen.getByRole("button", { name: /grab/i }));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/cards/"));
      expect(patch?.body).toEqual({ agenda: { action: "grab" } });
    });
  });

  it("release sends null agenda and no columnId", async () => {
    const { calls } = stubFetch({ boards: agendaBoards([], [HELD_CARD]) });
    renderWithProviders(<BoardStage roster={ROSTER} />);
    await readyToDrop("My plate");
    await userEvent.click(screen.getByRole("button", { name: "release" }));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/cards/held1"));
      expect(patch?.body).toEqual({ agenda: null });
    });
    const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/cards/held1"));
    expect(patch?.body).not.toHaveProperty("columnId");
  });

  it("a held team card in My plate is genuinely draggable, not merely reachable via fireDrop", async () => {
    // The Release control must be an ADDITION to the card face, not a
    // replacement of it — a full-face replacement (the shared-queue Grab
    // pattern) drops the card out of SortableContext entirely, which would
    // make the drag-to-Today branch in applyMove unreachable by any real
    // gesture (fireDrop can call it directly, but nothing in the app could).
    // dnd-kit's useSortable stamps aria-roledescription="sortable" on its
    // node — that's the load-bearing assertion here, not just that the title
    // renders. That same sortable wrapper carries dnd-kit's default
    // role="button" with no explicit name, so its OWN computed accessible
    // name rolls up every descendant text node once an action button shares
    // the card face ("Held team card release") — an exact-name query below
    // is what actually distinguishes the real button from that wrapper; a
    // substring/regex match would hit both and throw "multiple elements".
    stubFetch({ boards: agendaBoards([], [HELD_CARD]) });
    renderWithProviders(<BoardStage roster={ROSTER} />);
    await readyToDrop("My plate");
    const title = screen.getByText("Held team card");
    expect(title.closest('[aria-roledescription="sortable"]')).not.toBeNull();
    // And the Release control still sits alongside it, not instead of it.
    expect(screen.getByRole("button", { name: "release" })).toBeTruthy();
  });

  it("does not offer release for a card held by someone else — it never even reaches Edwin's plate", async () => {
    const anasCard = {
      ...HELD_CARD,
      id: "hers1",
      title: "Ana's card",
      agenda: { ...HELD_CARD.agenda, by: "ana" },
    };
    stubFetch({ boards: agendaBoards([], [anasCard]) });
    renderWithProviders(<BoardStage roster={ROSTER} />);
    await readyToDrop("My plate");
    expect(screen.queryByText("Ana's card")).toBeNull();
    expect(screen.queryByRole("button", { name: /release/i })).toBeNull();
  });

  it("also offers release on a card held in the Today lane", async () => {
    const todayHeld = { ...HELD_CARD, agenda: { ...HELD_CARD.agenda, state: "today" as const } };
    stubFetch({ boards: agendaBoards([], [todayHeld]) });
    renderWithProviders(<BoardStage roster={ROSTER} />);
    await readyToDrop("Today");
    expect(screen.getByRole("button", { name: "release" })).toBeTruthy();
  });

  it("does not offer grab on a card the current user already holds", async () => {
    stubFetch({ boards: agendaBoards([], [HELD_CARD]) });
    renderWithProviders(<BoardStage roster={ROSTER} />);
    await readyToDrop("My plate");
    expect(screen.queryByRole("button", { name: /grab/i })).toBeNull();
  });

  it("dragging a TEAM card to plate patches the step state only", async () => {
    const { calls } = stubFetch({
      boards: agendaBoards([], [{ id: "t1", title: "Unheld team card", columnId: "review", order: 0 }]),
    });
    renderWithProviders(<BoardStage roster={ROSTER} />);
    await readyToDrop("My plate");
    const { fireDrop } = await import("./BoardStage");
    await fireDrop("ws-deliver", "t1", "plate", 0);
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/cards/t1"));
      expect(patch?.body).toEqual({ agenda: { state: "plate" } });
    });
    const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/cards/t1"));
    expect(patch?.body).not.toHaveProperty("columnId");
  });

  it("dropping into Today asks what you are doing before writing anything", async () => {
    const { calls } = stubFetch({
      boards: agendaBoards([], [{ id: "t1", title: "Unheld team card", columnId: "review", order: 0 }]),
    });
    renderWithProviders(<BoardStage roster={ROSTER} />);
    await readyToDrop("Today");
    const { fireDrop } = await import("./BoardStage");
    await fireDrop("ws-deliver", "t1", "today", 0);
    expect(await screen.findByLabelText(/what are you doing/i)).toBeDefined();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("cancelling the intent composer leaves the card where it was", async () => {
    const { calls } = stubFetch({
      boards: agendaBoards([], [{ id: "t1", title: "Unheld team card", columnId: "review", order: 0 }]),
    });
    renderWithProviders(<BoardStage roster={ROSTER} />);
    await readyToDrop("Today");
    const { fireDrop } = await import("./BoardStage");
    await fireDrop("ws-deliver", "t1", "today", 0);
    await userEvent.click(await screen.findByRole("button", { name: /cancel/i }));
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    expect(screen.queryByLabelText(/what are you doing/i)).toBeNull();
  });

  it("submitting the intent sends it with the state", async () => {
    const { calls } = stubFetch({
      boards: agendaBoards([], [{ id: "t1", title: "Unheld team card", columnId: "review", order: 0 }]),
    });
    renderWithProviders(<BoardStage roster={ROSTER} />);
    await readyToDrop("Today");
    const { fireDrop } = await import("./BoardStage");
    await fireDrop("ws-deliver", "t1", "today", 0);
    await userEvent.type(await screen.findByLabelText(/what are you doing/i), "chasing the flaky suite");
    await userEvent.click(screen.getByRole("button", { name: /start/i }));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/cards/t1"));
      expect(patch?.body).toEqual({ agenda: { state: "today", intent: "chasing the flaky suite" } });
    });
  });

  it("advancing a HELD card on the team board asks what you did before moving it", async () => {
    const { calls } = stubFetch({ boards: agendaBoards([], [HELD_CARD]) });
    renderWithProviders(<BoardStage roster={ROSTER} />);
    await userEvent.click(await screen.findByRole("tab", { name: "Deliver" }));
    await readyToDrop("Review");
    const { fireDrop } = await import("./BoardStage");
    await fireDrop("ws-deliver", "held1", "verify", 0);
    expect(await screen.findByLabelText(/what did you do/i)).toBeDefined();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("advancing an UNHELD card on the team board moves it straight away", async () => {
    const { calls } = stubFetch({
      boards: agendaBoards([], [{ id: "unheld1", title: "Unheld, moves straight", columnId: "review", order: 0 }]),
    });
    renderWithProviders(<BoardStage roster={ROSTER} />);
    await userEvent.click(await screen.findByRole("tab", { name: "Deliver" }));
    await readyToDrop("Review");
    const { fireDrop } = await import("./BoardStage");
    await fireDrop("ws-deliver", "unheld1", "verify", 0);
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/cards/unheld1"));
      expect(patch?.body).toEqual({ columnId: "verify", order: 0 });
    });
    expect(screen.queryByLabelText(/what did you do/i)).toBeNull();
  });

  it("submitting the close sends the move and the comment in one body", async () => {
    const { calls } = stubFetch({ boards: agendaBoards([], [HELD_CARD]) });
    renderWithProviders(<BoardStage roster={ROSTER} />);
    await userEvent.click(await screen.findByRole("tab", { name: "Deliver" }));
    await readyToDrop("Review");
    const { fireDrop } = await import("./BoardStage");
    await fireDrop("ws-deliver", "held1", "verify", 0);
    await userEvent.type(await screen.findByLabelText(/what did you do/i), "it was the 20s ceiling");
    await userEvent.click(screen.getByRole("button", { name: /done/i }));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/cards/held1"));
      expect(patch?.body).toEqual({ columnId: "verify", order: 0, close: { text: "it was the 20s ceiling" } });
    });
  });

  it("dragging a PERSONAL card patches columnId only, never agenda", async () => {
    const { calls } = stubFetch({
      boards: agendaBoards([{ id: "p1", title: "Personal card", columnId: "plate", order: 0 }], []),
    });
    renderWithProviders(<BoardStage roster={ROSTER} />);
    await readyToDrop("My plate");
    const { fireDrop } = await import("./BoardStage");
    await fireDrop("personal", "p1", "today", 0);
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/cards/p1"));
      expect(patch?.body).toEqual({ columnId: "today", order: 0 });
    });
    const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/cards/p1"));
    expect(patch?.body).not.toHaveProperty("agenda");
  });

  it("dragging a PERSONAL card into Done also asks what you did, mirroring a held team card", async () => {
    const { calls } = stubFetch({
      boards: agendaBoards([{ id: "p1", title: "Personal card", columnId: "plate", order: 0 }], []),
    });
    renderWithProviders(<BoardStage roster={ROSTER} />);
    await readyToDrop("My plate");
    const { fireDrop } = await import("./BoardStage");
    await fireDrop("personal", "p1", "done", 0);
    expect(await screen.findByLabelText(/what did you do/i)).toBeDefined();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });
});

describe("resolveDrop + moveCard composed (direction-aware drop resolution)", () => {
  const seqBoard = (): WorkBoardT => ({
    ...BOARD,
    cards: [
      { id: "a", title: "a", columnId: "ready", order: 0 },
      { id: "b", title: "b", columnId: "ready", order: 1 },
      { id: "c", title: "c", columnId: "ready", order: 2 },
      { id: "d", title: "d", columnId: "ready", order: 3 },
      { id: "g", title: "g", columnId: "done", order: 0 },
      { id: "h", title: "h", columnId: "done", order: 1 },
    ],
  });
  const idsOf = (board: WorkBoardT, columnId: string) =>
    board.cards
      .filter((c) => c.columnId === columnId)
      .sort((x, y) => x.order - y.order)
      .map((c) => c.id);
  const drop = (board: WorkBoardT, activeId: string, overId: string): WorkBoardT => {
    const target = resolveDrop(board, activeId, overId);
    if (!target) throw new Error("expected a resolvable drop target");
    return moveCard(board, activeId, target.columnId, target.order);
  };

  it("forward-adjacent: b onto c lands b right after c", () => {
    const next = drop(seqBoard(), "b", "c");
    expect(idsOf(next, "ready")).toEqual(["a", "c", "b", "d"]);
  });

  it("forward-far: a onto d lands a at the end, after d", () => {
    const next = drop(seqBoard(), "a", "d");
    expect(idsOf(next, "ready")).toEqual(["b", "c", "d", "a"]);
  });

  it("backward: d onto b lands d right before b", () => {
    const next = drop(seqBoard(), "d", "b");
    expect(idsOf(next, "ready")).toEqual(["a", "d", "b", "c"]);
  });

  it("cross-column onto a card lands the active card at that card's index in the target column", () => {
    const next = drop(seqBoard(), "a", "g");
    expect(idsOf(next, "done")).toEqual(["a", "g", "h"]);
    expect(idsOf(next, "ready")).toEqual(["b", "c", "d"]);
  });

  it("drop on column:<id> of an empty column resolves to the end of that column", () => {
    const base = seqBoard();
    const board: WorkBoardT = { ...base, columns: [...base.columns, { id: "empty", name: "Empty" }] };
    const next = drop(board, "a", "column:empty");
    expect(idsOf(next, "empty")).toEqual(["a"]);
    expect(idsOf(next, "ready")).toEqual(["b", "c", "d"]);
  });

  it("self-drop resolves to null (no-op)", () => {
    expect(resolveDrop(seqBoard(), "a", "a")).toBeNull();
  });
});

describe("resolveCrossBoardDrop (the aggregate view's drag fence)", () => {
  const AGG: WorkBoardT[] = [
    {
      ...BOARD,
      id: "acme-plan",
      name: "Plan",
      type: "plan",
      workspaceId: "acme",
      columns: [
        { id: "spec", name: "Spec" },
        { id: "ready", name: "Ready" },
      ],
      cards: [
        { id: "a1", title: "Parent portal", columnId: "spec", order: 0 },
        { id: "a2", title: "Rosters", columnId: "spec", order: 1 },
      ],
    },
    {
      ...BOARD,
      id: "globex-plan",
      name: "Plan",
      type: "plan",
      workspaceId: "globex",
      columns: [
        { id: "spec", name: "Spec" },
        { id: "ready", name: "Ready" },
      ],
      cards: [{ id: "g1", title: "Billing", columnId: "spec", order: 0 }],
    },
  ];

  it("refuses a drop onto a card belonging to another workspace's board", () => {
    expect(resolveCrossBoardDrop(AGG, "a1", "g1")).toEqual({
      error: "Cards can only move within their own workspace",
    });
  });

  it("resolves a same-board drop against the card's own board, not the first board of the tab", () => {
    expect(resolveCrossBoardDrop(AGG, "g1", "column:ready")).toEqual({
      boardId: "globex-plan",
      columnId: "ready",
      order: 0,
    });
  });

  it("resolves a card-onto-card drop within one board", () => {
    expect(resolveCrossBoardDrop(AGG, "a1", "a2")).toEqual({ boardId: "acme-plan", columnId: "spec", order: 1 });
  });

  it("returns null when the dragged card belongs to no loaded board", () => {
    expect(resolveCrossBoardDrop(AGG, "nope", "a1")).toBeNull();
  });
});

describe("CardSheet", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function openSheet(cardTitle: string) {
    renderWithProviders(<BoardStage roster={ROSTER} />);
    await userEvent.click(await screen.findByText(cardTitle));
  }

  it("edits title and notes via PATCH", async () => {
    const { calls } = stubFetch();
    await openSheet("Write the spec");
    const title = screen.getByLabelText(/^title$/i);
    await userEvent.clear(title);
    await userEvent.type(title, "Write the better spec");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "PATCH" &&
            c.url.includes("/cards/c1") &&
            (c.body as { title?: string })?.title === "Write the better spec",
        ),
      ).toBe(true),
    );
  });

  it("surfaces the server's error text on a failed save instead of a generic message (I4)", async () => {
    stubFetch({
      patched: {
        error: "Story count mismatch (2 sent, 1 in the slice) — add/remove stories in the map, cards are toggle-only",
      },
      patchStatus: 400,
    });
    await openSheet("Write the spec");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText(/story count mismatch/i)).toBeTruthy();
  });

  it("falls back to a generic message when the server gives no error body", async () => {
    stubFetch({ patched: null, patchStatus: 500 });
    await openSheet("Write the spec");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText(/update failed/i)).toBeTruthy();
  });

  it("stories: add + toggle are sent wholesale on save, toggle stamps verifiedBy", async () => {
    const { calls } = stubFetch();
    await openSheet("Write the spec");
    await userEvent.type(screen.getByPlaceholderText(/add a story/i), "user can log in{Enter}");
    await userEvent.type(screen.getByPlaceholderText(/add a story/i), "reload keeps session{Enter}");
    await userEvent.click(screen.getAllByRole("checkbox")[0]);
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => {
      const call = calls.find((c) => c.method === "PATCH" && c.url.includes("/cards/c1"));
      const stories = (call?.body as { stories?: Array<{ text: string; done: boolean; verifiedBy?: string }> })
        ?.stories;
      expect(stories?.map((s) => [s.text, s.done])).toEqual([
        ["user can log in", true],
        ["reload keeps session", false],
      ]);
      expect(stories?.[0].verifiedBy).toMatch(/^manual /);
    });
  });

  it("delegates through POST /work/delegate with the card prompt and binds", async () => {
    const { calls } = stubFetch();
    await openSheet("Write the spec");
    await userEvent.click(screen.getByRole("button", { name: /send to agent/i }));
    await userEvent.selectOptions(screen.getByLabelText(/agent/i), "minerva");
    // Labelled "Delegate to workspace" so it never collides with the stage's own
    // "Workspace" scope dropdown, which is a sibling accessible name on the page.
    await userEvent.selectOptions(screen.getByLabelText(/delegate to workspace/i), "acme");
    await userEvent.click(screen.getByRole("button", { name: /^delegate$/i }));
    await waitFor(() => {
      const call = calls.find((c) => c.url.endsWith("/work/delegate"));
      expect(call).toBeTruthy();
      expect(call?.body).toMatchObject({ boardId: "alpha", cardId: "c1", agentId: "minerva", workspace: "acme" });
      expect(String((call?.body as { prompt?: string })?.prompt)).toContain("Write the spec");
    });
  });

  it("busy agents are disabled in the picker with the reason", async () => {
    stubFetch();
    const busyRoster = [{ ...ROSTER[0], status: "busy" as const }];
    renderWithProviders(<BoardStage roster={busyRoster} />);
    await userEvent.click(await screen.findByText("Write the spec"));
    await userEvent.click(screen.getByRole("button", { name: /send to agent/i }));
    const option = screen.getByRole("option", { name: /minerva.*busy/i }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
  });

  it("links a Jira key and shows the import button only on jira-linked boards", async () => {
    const { calls } = stubFetch({
      boards: {
        boards: [{ ...BOARD, jira: { connectorId: "atl-1", siteUrl: "https://a.net", projectKey: "PROJ" } }],
        errors: [],
      },
    });
    await openSheet("Write the spec");
    await userEvent.type(screen.getByPlaceholderText(/proj-123/i), "PROJ-7");
    await userEvent.click(screen.getByRole("button", { name: /link jira/i }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "PATCH" && (c.body as { jira?: { key?: string } })?.jira?.key === "PROJ-7"),
      ).toBe(true),
    );
    await userEvent.click(screen.getByRole("button", { name: /close card/i }));
    expect(screen.getByRole("button", { name: /import from jira/i })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /import from jira/i }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/jira/import"))).toBe(true));
  });

  it("unmounts cleanly when the open card vanishes from its board under a refetch", async () => {
    // Today this needs a WS race (an agent deletes the card while the sheet is
    // open); once route pills move a card off open.boardId it is the normal flow.
    const overrides: Record<string, unknown> = { boards: { boards: [{ ...BOARD }], errors: [] } };
    stubFetch(overrides);
    const { client } = renderWithProviders(<BoardStage roster={ROSTER} />);
    await userEvent.click(await screen.findByText("Write the spec"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    overrides.boards = { boards: [{ ...BOARD, cards: BOARD.cards.filter((c) => c.id !== "c1") }], errors: [] };
    await act(async () => {
      await client.invalidateQueries({ queryKey: qk.boards });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The stage itself survives — the card is gone, not the whole tree.
    expect(screen.getByLabelText("Work boards")).toBeTruthy();
    expect(screen.getByText("Fix login")).toBeTruthy();
  });

  it("deletes a card", async () => {
    const { calls } = stubFetch();
    await openSheet("Write the spec");
    await userEvent.click(screen.getByRole("button", { name: /delete card/i }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/cards/c1"))).toBe(true));
  });

  it("switching cards without closing remounts the sheet — no stale edits saved to the wrong card", async () => {
    const { calls } = stubFetch();
    await openSheet("Write the spec");
    const title = screen.getByLabelText(/^title$/i);
    await userEvent.clear(title);
    await userEvent.type(title, "Stale edit meant for card A");
    // Switch straight to a different card — no close, no save.
    await userEvent.click(screen.getByText("Fix login"));
    const retargeted = screen.getByLabelText(/^title$/i) as HTMLInputElement;
    expect(retargeted.value).toBe("Fix login");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => {
      const call = calls.find((c) => c.method === "PATCH" && c.url.includes("/cards/c2"));
      expect(call).toBeTruthy();
      expect((call?.body as { title?: string })?.title).toBe("Fix login");
    });
    expect(calls.some((c) => c.method === "PATCH" && c.url.includes("/cards/c1"))).toBe(false);
  });
});

describe("board-side capability amendments", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const WS_BOARDS = {
    boards: [
      { ...BOARD },
      {
        ...BOARD,
        id: "skoolscout-plan",
        name: "Plan",
        type: "plan",
        workspaceId: "skoolscout",
        columns: [{ id: "spec", name: "Spec" }],
        cards: [
          {
            id: "cc1",
            title: "tour scheduling v1",
            columnId: "spec",
            order: 0,
            capabilityRef: { capabilityId: "school-feature-set", sliceId: "sl1" },
            stories: [{ id: "s1", text: "create tour time slots", done: false }],
          },
        ],
      },
    ],
    errors: [],
  };

  it("linked cards show a capability chip", async () => {
    stubFetch({ boards: WS_BOARDS });
    const { client } = renderBoardStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    // The personal tab leads and is active by default; the linked card lives on Plan.
    await userEvent.click(await screen.findByRole("tab", { name: "Plan" }));
    await screen.findByText("tour scheduling v1");
    expect(screen.getByTitle(/school-feature-set/i)).toBeTruthy();
  });

  it("linked cards are toggle-only: no add-story input, no remove buttons, toggle still PATCHes", async () => {
    const { calls } = stubFetch({ boards: WS_BOARDS });
    const { client } = renderBoardStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    // The personal tab leads and is active by default; the linked card lives on Plan.
    await userEvent.click(await screen.findByRole("tab", { name: "Plan" }));
    await userEvent.click(await screen.findByText("tour scheduling v1"));
    expect(screen.queryByPlaceholderText(/add a story/i)).toBeNull();
    expect(screen.queryByLabelText(/remove story/i)).toBeNull();
    await userEvent.click(screen.getAllByRole("checkbox")[0]);
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => {
      const call = calls.find((c) => c.method === "PATCH" && c.url.includes("/cards/cc1"));
      const stories = (call?.body as { stories?: Array<{ id: string; done: boolean }> })?.stories;
      expect(stories).toEqual([expect.objectContaining({ id: "s1", done: true })]);
    });
  });
});
