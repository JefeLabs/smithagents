import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardStage } from "./BoardStage";

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
    if (method === "PATCH") return respond(overrides.patched ?? {});
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
