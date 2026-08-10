import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DASH_FOLLOWUPS } from "../../data/dashboards";
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
});
