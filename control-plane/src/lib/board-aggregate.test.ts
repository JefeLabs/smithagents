import { describe, expect, it } from "vitest";
import type { WorkBoardT } from "../organisms/BoardStage";
import {
  ALL_WORKSPACES,
  addableTypes,
  BOARD_TYPE_ORDER_UI,
  clusterByWorkspace,
  collectAgendaCards,
  collectCards,
  exitsForUI,
  sharedQueueCards,
  tabsFor,
  WORKSPACE_BOARD_TYPES_UI,
} from "./board-aggregate";

const board = (id: string, type: string, workspaceId?: string, cards: unknown[] = []): WorkBoardT =>
  ({ id, name: id, type, columns: [], cards, workspaceId }) as unknown as WorkBoardT;

const BOARDS = [
  board("acme-ideation", "ideation", "acme", [{ id: "a1", title: "SMS opt-in", columnId: "intake", order: 0 }]),
  board("acme-plan", "plan", "acme", [{ id: "a2", title: "Parent portal", columnId: "spec", order: 0 }]),
  board("globex-plan", "plan", "globex", [{ id: "g1", title: "Billing", columnId: "spec", order: 0 }]),
  board("personal", "personal", undefined, [{ id: "p1", title: "Read spec", columnId: "todo", order: 0 }]),
];

describe("tabsFor", () => {
  it("in workspace scope lists personal first, then that workspace's boards in canonical order", () => {
    const tabs = tabsFor(BOARDS, new Set(["acme"]));
    expect(tabs.map((t) => t.type)).toEqual(["personal", "ideation", "plan"]);
    expect(tabs[0].boardIds).toEqual(["personal"]);
    expect(tabs[1].boardIds).toEqual(["acme-ideation"]);
  });

  it("in all scope collapses to types and unions the board ids", () => {
    const tabs = tabsFor(BOARDS, ALL_WORKSPACES);
    expect(tabs.map((t) => t.type)).toEqual(["personal", "ideation", "plan"]);
    expect(tabs.find((t) => t.type === "plan")?.boardIds).toEqual(["acme-plan", "globex-plan"]);
    expect(tabs.find((t) => t.type === "plan")?.clustered).toBe(true);
    expect(tabs.find((t) => t.type === "personal")?.clustered).toBe(false);
  });

  it("omits the personal tab entirely when no personal board exists", () => {
    expect(tabsFor([BOARDS[0]], new Set(["acme"])).map((t) => t.type)).toEqual(["ideation"]);
  });

  it("a multiselect of two workspaces unions their boards and clusters, same as all scope", () => {
    const tabs = tabsFor(BOARDS, new Set(["acme", "globex"]));
    expect(tabs.map((t) => t.type)).toEqual(["personal", "ideation", "plan"]);
    const plan = tabs.find((t) => t.type === "plan");
    expect(plan?.boardIds).toEqual(["acme-plan", "globex-plan"]);
    expect(plan?.clustered).toBe(true);
    // ideation only has an acme board — a two-workspace selection still only
    // unions what actually exists, it doesn't invent a globex ideation board.
    expect(tabs.find((t) => t.type === "ideation")?.boardIds).toEqual(["acme-ideation"]);
  });
});

describe("WORKSPACE_BOARD_TYPES_UI", () => {
  it("has exactly the six workspace types, in canonical order, never personal", () => {
    expect(WORKSPACE_BOARD_TYPES_UI).toEqual(["ideation", "plan", "deliver", "reactive", "maintenance", "release"]);
    expect(WORKSPACE_BOARD_TYPES_UI).toHaveLength(6);
    expect(WORKSPACE_BOARD_TYPES_UI).not.toContain("personal");
  });

  it("is the same ordering BOARD_TYPE_ORDER_UI states, with personal first", () => {
    // Two hand-written lists of the same thing. Nothing reads both today, so
    // only this assertion stops a seventh type landing in one and not the other.
    expect(BOARD_TYPE_ORDER_UI).toEqual(["personal", ...WORKSPACE_BOARD_TYPES_UI]);
  });
});

describe("addableTypes", () => {
  it("offers the six workspace types not yet present, never personal", () => {
    expect(addableTypes(BOARDS, "acme")).toEqual(["deliver", "reactive", "maintenance", "release"]);
    expect(addableTypes(BOARDS, "globex")).toEqual(["ideation", "deliver", "reactive", "maintenance", "release"]);
    expect(addableTypes(BOARDS, "acme")).not.toContain("personal");
  });
});

describe("collectCards + clusterByWorkspace", () => {
  it("tags each card with its source board and workspace", () => {
    const plans = BOARDS.filter((b) => b.type === "plan");
    const cards = collectCards(plans, "spec");
    expect(cards.map((c) => [c.id, c.boardId, c.workspaceId])).toEqual([
      ["a2", "acme-plan", "acme"],
      ["g1", "globex-plan", "globex"],
    ]);
  });

  it("groups into one labelled cluster per workspace when clustered", () => {
    const cards = collectCards(
      BOARDS.filter((b) => b.type === "plan"),
      "spec",
    );
    const clusters = clusterByWorkspace(cards, true);
    expect(clusters.map((c) => [c.label, c.cards.length])).toEqual([
      ["acme", 1],
      ["globex", 1],
    ]);
  });

  it("returns a single unlabelled cluster when not clustered, preserving order", () => {
    const cards = collectCards([BOARDS[1]], "spec");
    const clusters = clusterByWorkspace(cards, false);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].label).toBeNull();
    expect(clusters[0].cards.map((c) => c.id)).toEqual(["a2"]);
  });

  it("sorts within a cluster by order", () => {
    const b = board("acme-plan", "plan", "acme", [
      { id: "x", title: "x", columnId: "spec", order: 2 },
      { id: "y", title: "y", columnId: "spec", order: 0 },
    ]);
    expect(clusterByWorkspace(collectCards([b], "spec"), false)[0].cards.map((c) => c.id)).toEqual(["y", "x"]);
  });
});

describe("exitsForUI", () => {
  it("maintenance and reactive triage offer the escalate exit to the personal queue", () => {
    expect(exitsForUI("maintenance", "triage").map((e) => e.toColumn)).toEqual(["queue"]);
    expect(exitsForUI("reactive", "triage").map((e) => e.toType)).toEqual(["maintenance", "ideation", "personal"]);
    expect(exitsForUI("maintenance", "doing")).toEqual([]);
  });
});

describe("agenda lanes", () => {
  const personal = {
    id: "personal",
    name: "Agenda",
    type: "personal" as const,
    columns: [{ id: "plate", name: "My plate" }],
    cards: [
      { id: "p1", title: "call bank", columnId: "plate", order: 1 },
      { id: "p0", title: "pay invoice", columnId: "plate", order: 0 },
    ],
  };
  const deliver = {
    id: "ws-deliver",
    name: "Deliver",
    type: "deliver" as const,
    workspaceId: "ws",
    columns: [{ id: "review", name: "Review", gatesHuman: true }],
    cards: [
      { id: "pool", title: "unheld", columnId: "review", order: 0 },
      {
        id: "t-old",
        title: "older",
        columnId: "review",
        order: 1,
        agenda: {
          by: "edwin",
          state: "plate" as const,
          since: "2026-08-13T08:00:00.000Z",
          grabbedAt: "2026-08-13T08:00:00.000Z",
        },
      },
      {
        id: "t-new",
        title: "newer",
        columnId: "review",
        order: 2,
        agenda: {
          by: "edwin",
          state: "plate" as const,
          since: "2026-08-13T12:00:00.000Z",
          grabbedAt: "2026-08-13T12:00:00.000Z",
        },
      },
      {
        id: "t-hers",
        title: "ana's",
        columnId: "review",
        order: 3,
        agenda: {
          by: "ana",
          state: "plate" as const,
          since: "2026-08-13T08:00:00.000Z",
          grabbedAt: "2026-08-13T08:00:00.000Z",
        },
      },
    ],
  };

  it("pools only unheld cards from source boards", () => {
    expect(sharedQueueCards([personal, deliver]).map((c) => c.id)).toEqual(["pool"]);
  });

  it("puts personal cards first by order, then team cards by grabbedAt", () => {
    expect(collectAgendaCards([personal, deliver], "edwin", "plate").map((c) => c.id)).toEqual([
      "p0",
      "p1",
      "t-old",
      "t-new",
    ]);
  });

  it("orders by grabbedAt, not since — a swept card must not jump to the front", () => {
    const swept = {
      ...deliver,
      cards: [
        {
          id: "held-longest",
          title: "held longest",
          columnId: "review",
          order: 0,
          agenda: {
            by: "edwin",
            state: "plate" as const,
            since: "2026-08-14T00:00:00.000Z", // re-stamped by this morning's sweep
            grabbedAt: "2026-08-01T09:00:00.000Z",
          },
        },
        {
          id: "grabbed-today",
          title: "grabbed today",
          columnId: "review",
          order: 1,
          agenda: {
            by: "edwin",
            state: "plate" as const,
            since: "2026-08-13T09:00:00.000Z",
            grabbedAt: "2026-08-13T09:00:00.000Z",
          },
        },
      ],
    };
    expect(collectAgendaCards([swept], "edwin", "plate").map((c) => c.id)).toEqual(["held-longest", "grabbed-today"]);
  });

  it("excludes other holders", () => {
    expect(collectAgendaCards([personal, deliver], "edwin", "plate").map((c) => c.id)).not.toContain("t-hers");
  });

  it("never matches team cards in a lane that is not a step state", () => {
    const withDone = { ...personal, cards: [{ id: "p-done", title: "done", columnId: "done", order: 0 }] };
    expect(collectAgendaCards([withDone, deliver], "edwin", "done").map((c) => c.id)).toEqual(["p-done"]);
  });
});
