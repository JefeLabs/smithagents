import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocT } from "../api/types";
import { composeSpec, specToFence } from "../lib/dashboardSpec";
import { DashboardDocStage } from "./DashboardDocStage";

const dashDoc = (specBody: string): DocT => ({
  id: "d1",
  title: "Delivery health",
  blueprintId: "dashboard",
  workType: "insight",
  sections: [
    { id: "question", heading: "Question", body: "where is delivery slipping?\n\nscope: all workspaces" },
    { id: "spec", heading: "Spec", body: specBody },
  ],
  participants: [],
  status: "drafting",
  createdAt: "t",
  updatedAt: "t",
});

describe("DashboardDocStage", () => {
  afterEach(() => cleanup());

  it("renders the parsed spec through the dashboard presentation, question as subheader", () => {
    const spec = composeSpec("q", "all workspaces");
    render(
      <DashboardDocStage doc={dashDoc(specToFence(spec))} pinControl={<button type="button">Pin to acme</button>} />,
    );
    expect(screen.getByRole("region", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByText(spec.summary)).toBeInTheDocument();
    expect(screen.getByText(spec.kpis[0].label)).toBeInTheDocument();
    expect(screen.getByText(/where is delivery slipping\?/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pin to acme" })).toBeInTheDocument();
  });

  it("an unparseable spec shows its raw source and says so — never blank", () => {
    render(<DashboardDocStage doc={dashDoc("{broken json")} />);
    expect(screen.getByRole("status")).toHaveTextContent(/didn.t parse/);
    expect(screen.getByText(/\{broken json/)).toBeInTheDocument();
  });

  it("rename commits on blur through onRename", async () => {
    const onRename = vi.fn().mockResolvedValue({});
    const { fireEvent } = await import("@testing-library/react");
    render(<DashboardDocStage doc={dashDoc(specToFence(composeSpec("q", "personal")))} onRename={onRename} />);
    const input = screen.getByRole("textbox", { name: "Dashboard title" });
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.blur(input);
    expect(onRename).toHaveBeenCalledWith("Renamed");
  });
});
