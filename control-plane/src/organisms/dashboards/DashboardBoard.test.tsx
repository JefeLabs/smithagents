import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DASH_FOLLOWUPS } from "../../data/dashboards";
import { composeSpec } from "../../lib/dashboardSpec";
import { DashboardBoard } from "./DashboardBoard";

function renderBoard(onFollowup = vi.fn()) {
  const r = render(
    <DashboardBoard query="where is delivery slipping?" scopeHint="SCOPE · ALL WORKSPACES" onFollowup={onFollowup} />,
  );
  return { ...r, onFollowup };
}

describe("DashboardBoard", () => {
  afterEach(() => cleanup());

  it("banner echoes the question, the answer and the scope hint", () => {
    renderBoard();
    expect(screen.getByText("where is delivery slipping?")).toBeTruthy();
    expect(screen.getByText(/shipped volume is up 24%/)).toBeTruthy();
    expect(screen.getByText("SCOPE · ALL WORKSPACES")).toBeTruthy();
  });

  it("renders four KPI tiles and six group rows", () => {
    const { container } = renderBoard();
    expect(container.querySelectorAll(".dash-kpi")).toHaveLength(4);
    // 6 data rows + 1 header row
    expect(screen.getAllByRole("row")).toHaveLength(7);
    expect(screen.getByText("release")).toBeTruthy();
  });

  it("hovering a week band shows the crosshair tooltip with both values", () => {
    const { container } = renderBoard();
    const hits = container.querySelectorAll(".dash-chart__hit");
    expect(hits).toHaveLength(12);
    fireEvent.mouseEnter(hits[2]);
    // DASH_WEEKS[2]=W25, DASH_SHIPPED[2]=19, DASH_INTAKE[2]=25
    const tip = container.querySelector(".dash-chart__tip");
    expect(tip?.textContent).toContain("W25");
    expect(tip?.textContent).toContain("shipped 19 · intake 25");
  });

  it("a follow-up chip reports its own text", () => {
    const { onFollowup } = renderBoard();
    fireEvent.click(screen.getByText(DASH_FOLLOWUPS[1]));
    expect(onFollowup).toHaveBeenCalledWith(DASH_FOLLOWUPS[1]);
  });

  it("renders from a DashSpec when given — spec KPIs and titles, not the fixtures", () => {
    const spec = {
      summary: "custom summary line",
      kpis: [
        { label: "SPEC KPI ONE", value: "7", delta: "+1", tone: "ok" as const },
        { label: "SPEC KPI TWO", value: "9%", tone: "high" as const },
      ],
      charts: [
        { kind: "line" as const, title: "custom line title" },
        { kind: "bars" as const, title: "custom bars title" },
      ],
      table: { title: "custom table", columns: ["group", "risk"], rows: [["release", "high"]] },
    };
    render(<DashboardBoard spec={spec} query="q" scopeHint="SCOPE" onFollowup={vi.fn()} />);
    expect(screen.getByText("custom summary line")).toBeInTheDocument();
    expect(screen.getByText("SPEC KPI ONE")).toBeInTheDocument();
    expect(screen.getByText("SPEC KPI TWO")).toBeInTheDocument();
    expect(screen.queryByText("ACTIVE WORKSPACES")).toBeNull(); // fixture-only KPI
    expect(screen.getByText("custom line title")).toBeInTheDocument();
    expect(screen.getByText("custom bars title")).toBeInTheDocument();
    expect(screen.getByText("custom table")).toBeInTheDocument();
  });
  it("renders text answer cards from the spec, with their source label", () => {
    const spec = composeSpec("q", "all workspaces");
    spec.texts = [{ title: "release risk", body: "one squad is over WIP.", source: "doc d34" }];
    render(<DashboardBoard query="q" scopeHint="SCOPE · ALL" onFollowup={() => {}} spec={spec} />);
    expect(screen.getByText("release risk")).toBeTruthy();
    expect(screen.getByText("one squad is over WIP.")).toBeTruthy();
    expect(screen.getByText("doc d34")).toBeTruthy();
  });

  it("no texts in the spec — no text-card section renders", () => {
    render(
      <DashboardBoard query="q" scopeHint="SCOPE · ALL" onFollowup={() => {}} spec={composeSpec("q", "all")} />,
    );
    expect(document.querySelector(".dash-text-card")).toBeNull();
  });

});
