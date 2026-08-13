import { QueryClient } from "@tanstack/react-query";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocT } from "../api/types";
import { composeSpec, specToFence } from "../lib/dashboardSpec";
import { qk } from "../queries/keys";
import { renderWithProviders } from "../test/renderWithProviders";
import { DashboardDocStage } from "./DashboardDocStage";

const dashDoc = (specBody: string, scope = "all workspaces"): DocT => ({
  id: "d1",
  title: "Delivery health",
  blueprintId: "dashboard",
  workType: "insight",
  sections: [
    { id: "question", heading: "Question", body: `where is delivery slipping?\n\nscope: ${scope}` },
    { id: "spec", heading: "Spec", body: specBody },
  ],
  participants: [],
  status: "drafting",
  createdAt: "t",
  updatedAt: "t",
});

/** A boards payload with one recent card so the live stats have a pulse. */
const BOARDS = {
  boards: [
    {
      id: "acme-deliver",
      name: "deliver",
      type: "deliver",
      workspaceId: "acme",
      columns: [
        { id: "doing", name: "Doing" },
        { id: "done", name: "Done" },
      ],
      cards: [
        {
          id: "c1",
          title: "ship it",
          columnId: "doing",
          order: 0,
          updatedAt: new Date().toISOString(),
          stories: [{ id: "s1", text: "a", done: true, points: 3 }],
        },
      ],
    },
  ],
};

function renderStage(doc: DocT, extra?: Partial<Parameters<typeof DashboardDocStage>[0]>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, enabled: false } },
  });
  client.setQueryData(qk.boards, BOARDS);
  client.setQueryData(qk.groups, [{ name: "core", workspaces: ["acme"], groups: [], expansion: ["acme"] }]);
  return renderWithProviders(<DashboardDocStage doc={doc} {...extra} />, { client });
}

describe("DashboardDocStage (hybrid — real-dashboards spec 2026-08-13)", () => {
  beforeEach(() => {
    // useRangeBounds' records probe would otherwise hit fetch; disabled via
    // the client's enabled:false default, and the seeded caches carry data.
  });
  afterEach(() => cleanup());

  it("stats are LIVE (fence kpis ignored); prose comes from the fence", () => {
    const fence = composeSpec("q", "all workspaces"); // mock kpis like "throughput"
    renderStage(dashDoc(specToFence(fence)));
    expect(screen.getByRole("region", { name: "Dashboard" })).toBeInTheDocument();
    // Prose survives from the fence…
    expect(screen.getByText(fence.summary)).toBeInTheDocument();
    // …but the stats are the computed ones: live KPI labels, not the fence's.
    // "touched" appears as a KPI label AND the line legend's series name.
    expect(screen.getAllByText("touched").length).toBeGreaterThan(0);
    expect(screen.getByText("points done")).toBeInTheDocument();
    expect(screen.queryByText(fence.kpis[0].label)).toBeNull();
    expect(screen.getByText(/where is delivery slipping\?/)).toBeInTheDocument();
  });

  it("live numbers reflect the seeded boards", () => {
    renderStage(dashDoc(specToFence(composeSpec("q", "all workspaces"))));
    // One card touched, 3 points done, 1 WIP (non-terminal deliver column).
    const kpiValues = [...document.querySelectorAll(".dash-kpi")].map((k) => k.textContent);
    expect(kpiValues.find((t) => t?.startsWith("touched"))).toContain("1");
    expect(kpiValues.find((t) => t?.startsWith("points done"))).toContain("3");
    expect(kpiValues.find((t) => t?.startsWith("wip now"))).toContain("1");
  });

  it("an unparseable fence still renders live stats AND calls out its source", () => {
    renderStage(dashDoc("{broken json"));
    expect(screen.getByRole("status")).toHaveTextContent(/didn.t parse/);
    expect(screen.getByText(/\{broken json/)).toBeInTheDocument();
    expect(screen.getAllByText("touched").length).toBeGreaterThan(0); // stats regardless
  });

  it("a group scope resolves through the group's expansion", () => {
    renderStage(dashDoc(specToFence(composeSpec("q", "core")), "core · Current Sprint"));
    const kpiValues = [...document.querySelectorAll(".dash-kpi")].map((k) => k.textContent);
    expect(kpiValues.find((t) => t?.startsWith("touched"))).toContain("1"); // acme via core
  });

  it("rename commits on blur through onRename", async () => {
    const onRename = vi.fn().mockResolvedValue({});
    const { fireEvent } = await import("@testing-library/react");
    renderStage(dashDoc(specToFence(composeSpec("q", "personal"))), { onRename });
    const input = screen.getByRole("textbox", { name: "Dashboard title" });
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.blur(input);
    expect(onRename).toHaveBeenCalledWith("Renamed");
  });
});
