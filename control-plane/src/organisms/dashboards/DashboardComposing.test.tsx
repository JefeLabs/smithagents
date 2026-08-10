import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DashboardComposing } from "./DashboardComposing";

describe("DashboardComposing", () => {
  afterEach(() => cleanup());

  it("echoes the query and the scope hint", () => {
    render(<DashboardComposing query="who is most loaded?" scopeHint="SCOPE · ALL WORKSPACES" step={0} />);
    expect(screen.getByText("who is most loaded?")).toBeTruthy();
    expect(screen.getByText("SCOPE · ALL WORKSPACES")).toBeTruthy();
  });

  it("marks steps done, active and todo around the current index", () => {
    render(<DashboardComposing query="q" scopeHint="SCOPE · ALL WORKSPACES" step={1} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0].className).toContain("dash-composing__step--done");
    expect(items[1].className).toContain("dash-composing__step--active");
    expect(items[2].className).not.toContain("--done");
    expect(items[2].className).not.toContain("--active");
  });

  it("shows an indeterminate progress track", () => {
    render(<DashboardComposing query="q" scopeHint="SCOPE · ALL WORKSPACES" step={0} />);
    expect(screen.getByRole("progressbar", { name: "composing dashboard" })).toBeTruthy();
  });
});
