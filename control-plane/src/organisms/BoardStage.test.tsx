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
    status: "busy" as const,
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
    if (url.includes("/cards") && method === "POST")
      return respond({ id: "new", title: "New card", columnId: "backlog", order: 1 }, 201);
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
    await userEvent.selectOptions(screen.getByLabelText(/template/i), "capability");
    await userEvent.click(screen.getByRole("button", { name: /create board/i }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "POST" &&
            c.url.endsWith("/work/boards") &&
            (c.body as { template?: string })?.template === "capability",
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
