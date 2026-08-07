import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkBoardT } from "./BoardStage";
import { BoardStage, moveCard, resolveDrop } from "./BoardStage";

const BOARD = {
  id: "alpha",
  name: "Alpha",
  columns: [
    { id: "backlog", name: "Backlog" },
    { id: "ready", name: "Ready" },
    { id: "in-progress", name: "In Progress" },
    { id: "in-review", name: "In Review" },
    { id: "done", name: "Done" },
  ],
  cards: [
    { id: "c1", title: "Write the spec", columnId: "backlog", order: 0 },
    {
      id: "c2",
      title: "Fix login",
      columnId: "ready",
      order: 0,
      jira: { key: "PROJ-1", url: "https://a/browse/PROJ-1" },
    },
    {
      id: "c3",
      title: "Ship avatars",
      columnId: "in-progress",
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

describe("BoardStage", () => {
  beforeEach(() => stubFetch());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders columns and cards of the first board", async () => {
    stubFetch();
    render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
    expect(await screen.findByText("Backlog")).toBeTruthy();
    expect(screen.getByText("Write the spec")).toBeTruthy();
    expect(screen.getByText("PROJ-1")).toBeTruthy();
  });

  it("shows the delegated card's agent badge from the roster", async () => {
    stubFetch();
    render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Ship avatars");
    expect(screen.getByLabelText(/minerva is working on this card/i)).toBeTruthy();
  });

  it("the delegated card's avatar badge has no nested button, so the card stays a single button", async () => {
    stubFetch();
    render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
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
    render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Ship boards");
    expect(screen.getByText("2/3")).toBeTruthy();
    const noStoriesCard = screen.getByText("Write the spec").closest("button.board-card") as HTMLElement;
    expect(within(noStoriesCard).queryByText(/^\d+\/\d+$/)).toBeNull();
  });

  it("adds a card through the composer", async () => {
    const { calls } = stubFetch();
    render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Backlog");
    await userEvent.click(screen.getByRole("button", { name: /add card/i }));
    await userEvent.type(screen.getByPlaceholderText(/card title/i), "New card");
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.includes("/work/boards/alpha/cards"))).toBe(true),
    );
  });

  it("creates a board from a template via the switcher", async () => {
    const { calls } = stubFetch();
    render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Backlog");
    await userEvent.click(screen.getByRole("button", { name: /new board/i }));
    await userEvent.type(screen.getByPlaceholderText(/board name/i), "Beta");
    await userEvent.selectOptions(screen.getByLabelText(/template/i), "capabilities");
    await userEvent.click(screen.getByRole("button", { name: /create board/i }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "POST" &&
            c.url.endsWith("/work/boards") &&
            (c.body as { template?: string })?.template === "capabilities",
        ),
      ).toBe(true),
    );
  });

  it("refetches when lastBoardUpdate names the open board", async () => {
    const { calls } = stubFetch();
    const { rerender } = render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Backlog");
    const before = calls.filter((c) => c.url.endsWith("/work/boards")).length;
    rerender(<BoardStage open roster={ROSTER} lastBoardUpdate={{ boardId: "alpha", seq: 1 }} onClose={vi.fn()} />);
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/work/boards")).length).toBeGreaterThan(before));
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
    render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Backlog");
    // Drag simulation via dnd-kit is brittle in jsdom — call the exported
    // handler contract instead: the component wires handleCardDrop(cardId,
    // columnId, index) into DndContext. Assert through the module seam.
    const stage = screen.getByLabelText("Work boards");
    expect(stage).toBeTruthy();
    // The drop handler is exercised through moveCard tests above + the PATCH
    // assertion here via the exposed test hook:
    const { fireDrop } = await import("./BoardStage");
    await fireDrop("c1", "ready", 0);
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "PATCH" &&
            c.url.includes("/cards/c1") &&
            (c.body as { columnId?: string })?.columnId === "ready",
        ),
      ).toBe(true),
    );
    const patchCall = calls.find((c) => c.method === "PATCH" && c.url.includes("/cards/c1"));
    expect(patchCall?.body).toEqual({ columnId: "ready", order: 0 });
  });

  it("a same-column reorder PATCHes {order} only, omitting columnId so the swarm's Jira push-on-move never fires", async () => {
    const { calls } = stubFetch();
    render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Backlog");
    const { fireDrop } = await import("./BoardStage");
    // c1 is already in "backlog" — this is a same-column reorder.
    await fireDrop("c1", "backlog", 0);
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.url.includes("/cards/c1"))).toBe(true));
    const patchCall = calls.find((c) => c.method === "PATCH" && c.url.includes("/cards/c1"));
    expect(patchCall?.body).toEqual({ order: 0 });
    expect(patchCall?.body).not.toHaveProperty("columnId");
  });

  it("rolls back the optimistic move and surfaces an error when the PATCH fails", async () => {
    const { calls } = stubFetch({ patchStatus: 500 });
    render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Write the spec");
    const { fireDrop } = await import("./BoardStage");
    await fireDrop("c1", "ready", 0);
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.url.includes("/cards/c1"))).toBe(true));
    expect(await screen.findByText(/move failed/i)).toBeTruthy();
    // Card c1 is back in Backlog, not left dangling in Ready.
    const backlogHeading = screen.getByText("Backlog");
    const backlogColumn = backlogHeading.closest(".board-column") as HTMLElement;
    expect(within(backlogColumn).queryByText("Write the spec")).toBeTruthy();
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

describe("CardSheet", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function openSheet(cardTitle: string) {
    render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
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
    await userEvent.selectOptions(screen.getByLabelText(/workspace/i), "acme");
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
    render(<BoardStage open roster={busyRoster} lastBoardUpdate={null} onClose={vi.fn()} />);
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
        id: "skoolscout-capabilities",
        name: "skoolscout Capabilities",
        workspaceId: "skoolscout",
        cards: [
          {
            id: "cc1",
            title: "tour scheduling v1",
            columnId: "backlog",
            order: 0,
            capabilityRef: { capabilityId: "school-feature-set", sliceId: "sl1" },
            stories: [{ id: "s1", text: "create tour time slots", done: false }],
          },
        ],
      },
    ],
    errors: [],
  };

  it("groups the switcher by workspace with personal boards first", async () => {
    stubFetch({ boards: WS_BOARDS });
    render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Backlog");
    const select = screen.getByLabelText(/^board$/i);
    const groups = within(select).getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("label"))).toEqual(["Personal", "skoolscout"]);
  });

  it("offers all five templates in the new-board composer", async () => {
    stubFetch();
    render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Backlog");
    await userEvent.click(screen.getByRole("button", { name: /new board/i }));
    const options = (screen.getByLabelText(/template/i) as HTMLSelectElement).options;
    expect(Array.from(options).map((o) => o.value)).toEqual([
      "personal",
      "capabilities",
      "delivery",
      "maintenance",
      "support",
    ]);
  });

  it("linked cards show a capability chip", async () => {
    stubFetch({ boards: WS_BOARDS });
    render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Backlog");
    await userEvent.selectOptions(screen.getByLabelText(/^board$/i), "skoolscout-capabilities");
    await screen.findByText("tour scheduling v1");
    expect(screen.getByTitle(/school-feature-set/i)).toBeTruthy();
  });

  it("linked cards are toggle-only: no add-story input, no remove buttons, toggle still PATCHes", async () => {
    const { calls } = stubFetch({ boards: WS_BOARDS });
    render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Backlog");
    await userEvent.selectOptions(screen.getByLabelText(/^board$/i), "skoolscout-capabilities");
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
