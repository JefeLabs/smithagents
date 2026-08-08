import { describe, expect, it } from "vitest";
import type { WorkBoardT } from "../organisms/BoardStage";
import { ALL_WORKSPACES, addableTypes, clusterByWorkspace, collectCards, tabsFor } from "./board-aggregate";

const board = (id: string, type: string, workspaceId?: string, cards: unknown[] = []): WorkBoardT =>
  ({ id, name: id, type, columns: [], cards, workspaceId }) as unknown as WorkBoardT;

const BOARDS = [
  board("acme-ideation", "ideation", "acme", [{ id: "a1", title: "SMS opt-in", columnId: "intake", order: 0 }]),
  board("acme-plan", "plan", "acme", [{ id: "a2", title: "Parent portal", columnId: "spec", order: 0 }]),
  board("globex-plan", "plan", "globex", [{ id: "g1", title: "Billing", columnId: "spec", order: 0 }]),
  board("personal", "personal", undefined, [{ id: "p1", title: "Read spec", columnId: "todo", order: 0 }]),
];

describe("tabsFor", () => {
  it("in workspace scope lists that workspace's boards in canonical order, personal last", () => {
    const tabs = tabsFor(BOARDS, "acme");
    expect(tabs.map((t) => t.type)).toEqual(["ideation", "plan", "personal"]);
    expect(tabs[0].boardIds).toEqual(["acme-ideation"]);
    expect(tabs[2].boardIds).toEqual(["personal"]);
  });

  it("in all scope collapses to types and unions the board ids", () => {
    const tabs = tabsFor(BOARDS, ALL_WORKSPACES);
    expect(tabs.map((t) => t.type)).toEqual(["ideation", "plan", "personal"]);
    expect(tabs.find((t) => t.type === "plan")?.boardIds).toEqual(["acme-plan", "globex-plan"]);
    expect(tabs.find((t) => t.type === "plan")?.clustered).toBe(true);
    expect(tabs.find((t) => t.type === "personal")?.clustered).toBe(false);
  });

  it("omits the personal tab entirely when no personal board exists", () => {
    expect(tabsFor([BOARDS[0]], "acme").map((t) => t.type)).toEqual(["ideation"]);
  });
});

describe("addableTypes", () => {
  it("offers the six workspace types not yet present, never personal", () => {
    expect(addableTypes(BOARDS, "acme")).toEqual(["deliver", "release", "reactive", "maintenance"]);
    expect(addableTypes(BOARDS, "globex")).toEqual(["ideation", "deliver", "release", "reactive", "maintenance"]);
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
