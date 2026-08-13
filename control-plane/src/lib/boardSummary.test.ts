import { describe, expect, it } from "vitest";
import type { WorkBoardT } from "../organisms/BoardStage";
import { summarizeBoards } from "./boardSummary";

const NOW = new Date(2026, 7, 13); // Aug 13
const BOUNDS = { from: new Date(2026, 7, 3), to: new Date(2026, 7, 16, 23, 59, 59) };

const board = (over: Partial<WorkBoardT>): WorkBoardT =>
  ({
    id: "b",
    name: "board",
    type: "deliver",
    workspaceId: "acme",
    columns: [
      { id: "queue", name: "Queue" },
      { id: "doing", name: "Doing" },
      { id: "done", name: "Done" },
    ],
    cards: [],
    ...over,
  }) as WorkBoardT;

const card = (over: Record<string, unknown>) =>
  ({ id: crypto.randomUUID(), title: "c", columnId: "doing", order: 0, ...over }) as WorkBoardT["cards"][number];

describe("summarizeBoards", () => {
  it("scope excludes other workspaces and always the personal board", () => {
    const boards = [
      board({ id: "a1", cards: [card({ updatedAt: "2026-08-10T00:00:00Z" })] }),
      board({ id: "w2", workspaceId: "widgets", cards: [card({ updatedAt: "2026-08-10T00:00:00Z" })] }),
      board({
        id: "p",
        workspaceId: undefined,
        type: "personal",
        cards: [card({ updatedAt: "2026-08-10T00:00:00Z" })],
      }),
    ];
    const s = summarizeBoards(boards, ["acme"], BOUNDS, NOW);
    expect(s.kpis.find((k) => k.label === "touched")?.value).toBe("1");
    // null scope = every workspace, still no personal.
    const all = summarizeBoards(boards, null, BOUNDS, NOW);
    expect(all.kpis.find((k) => k.label === "touched")?.value).toBe("2");
  });

  it("the window drops old cards but keeps undated ones", () => {
    const boards = [
      board({
        cards: [
          card({ updatedAt: "2026-08-10T00:00:00Z" }),
          card({ updatedAt: "2026-01-01T00:00:00Z" }),
          card({}), // undated — always counts
        ],
      }),
    ];
    const s = summarizeBoards(boards, ["acme"], BOUNDS, NOW);
    expect(s.kpis.find((k) => k.label === "touched")?.value).toBe("2");
  });

  it("WIP counts non-terminal Deliver columns only, ignoring the window", () => {
    const boards = [
      board({
        cards: [
          card({ columnId: "doing", updatedAt: "2020-01-01T00:00:00Z" }), // old but still WIP
          card({ columnId: "done", updatedAt: "2026-08-10T00:00:00Z" }), // terminal — not WIP
        ],
      }),
      board({ id: "r", type: "release", cards: [card({ columnId: "doing", updatedAt: "2026-08-10T00:00:00Z" })] }),
    ];
    const s = summarizeBoards(boards, ["acme"], BOUNDS, NOW);
    expect(s.kpis.find((k) => k.label === "wip now")?.value).toBe("1");
    expect(s.kpis.find((k) => k.label === "released")?.value).toBe("1");
  });

  it("points done sums done stories and treats unset points as 0", () => {
    const boards = [
      board({
        cards: [
          card({
            updatedAt: "2026-08-10T00:00:00Z",
            stories: [
              { id: "s1", text: "a", done: true, points: 3 },
              { id: "s2", text: "b", done: true }, // unset -> 0
              { id: "s3", text: "c", done: false, points: 8 }, // not done -> 0
            ],
          }),
        ],
      }),
    ];
    const s = summarizeBoards(boards, ["acme"], BOUNDS, NOW);
    expect(s.kpis.find((k) => k.label === "points done")?.value).toBe("3");
  });

  it("bars use the fixed board-type order with zeroes for absent types", () => {
    const boards = [board({ type: "plan", cards: [card({ updatedAt: "2026-08-10T00:00:00Z" })] })];
    const s = summarizeBoards(boards, ["acme"], BOUNDS, NOW);
    expect(s.bars.map((b) => b.label)).toEqual(["IDEATE", "PLAN", "DELIVER", "REACT", "MAINTAIN", "RELEASE"]);
    expect(s.bars.find((b) => b.label === "PLAN")?.value).toBe(1);
    expect(s.bars.find((b) => b.label === "DELIVER")?.value).toBe(0);
  });

  it("line buckets cards on their calendar day across the whole window", () => {
    const boards = [
      board({
        cards: [
          card({ updatedAt: "2026-08-03T09:00:00" }),
          card({ updatedAt: "2026-08-03T21:00:00" }),
          card({ updatedAt: "2026-08-16T12:00:00" }),
        ],
      }),
    ];
    const s = summarizeBoards(boards, ["acme"], BOUNDS, NOW);
    expect(s.line.labels[0]).toBe("8/3");
    expect(s.line.labels[s.line.labels.length - 1]).toBe("8/16");
    expect(s.line.labels).toHaveLength(14);
    expect(s.line.values[0]).toBe(2);
    expect(s.line.values[13]).toBe(1);
  });

  it("a month-boundary window buckets into the right days", () => {
    const bounds = { from: new Date(2026, 6, 30), to: new Date(2026, 7, 2, 23, 59, 59) }; // Jul 30 – Aug 2
    const boards = [board({ cards: [card({ updatedAt: "2026-08-01T10:00:00" })] })];
    const s = summarizeBoards(boards, ["acme"], bounds, NOW);
    expect(s.line.labels).toEqual(["7/30", "7/31", "8/1", "8/2"]);
    expect(s.line.values).toEqual([0, 0, 1, 0]);
  });

  it("multi-workspace scope pivots the table by workspace; single scope by board", () => {
    const boards = [
      board({ id: "a1", cards: [card({ updatedAt: "2026-08-10T00:00:00Z" })] }),
      board({
        id: "w1",
        workspaceId: "widgets",
        type: "release",
        cards: [card({ updatedAt: "2026-08-10T00:00:00Z" })],
      }),
    ];
    const multi = summarizeBoards(boards, ["acme", "widgets"], BOUNDS, NOW);
    expect(multi.table.title).toBe("workspaces");
    expect(multi.table.rows.map((r) => r[0])).toEqual(["acme", "widgets"]);
    expect(multi.table.rows[1][4]).toBe("1"); // widgets released
    const single = summarizeBoards(boards, ["acme"], BOUNDS, NOW);
    expect(single.table.title).toBe("boards");
    expect(single.table.rows.map((r) => r[0])).toEqual(["board"]);
  });
});
