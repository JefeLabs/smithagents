import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DASH_SAVED, DASH_SUGGESTIONS } from "../../data/dashboards";
import { DashboardAsk } from "./DashboardAsk";

function renderAsk(over: Partial<Parameters<typeof DashboardAsk>[0]> = {}) {
  const props = {
    scope: "all workspaces",
    saved: DASH_SAVED,
    scopeHint: "SCOPE · ALL WORKSPACES",
    onScope: vi.fn(),
    onSubmit: vi.fn(),
    ...over,
  };
  render(<DashboardAsk {...props} />);
  return props;
}

describe("DashboardAsk", () => {
  afterEach(() => cleanup());

  it("scope chips reflect the selection and report a pick", () => {
    const { onScope } = renderAsk();
    expect(screen.getByRole("radio", { name: "all workspaces" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "release" }));
    expect(onScope).toHaveBeenCalledWith("release");
  });

  it("Enter submits the trimmed draft; Shift+Enter does not", () => {
    const { onSubmit } = renderAsk();
    const box = screen.getByRole("textbox", { name: "Dashboard question" });
    fireEvent.change(box, { target: { value: "  where is delivery slipping?  " } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("where is delivery slipping?");
  });

  it("the compose button submits the draft", () => {
    const { onSubmit } = renderAsk();
    fireEvent.change(screen.getByRole("textbox", { name: "Dashboard question" }), { target: { value: "q1" } });
    fireEvent.click(screen.getByRole("button", { name: /compose/i }));
    expect(onSubmit).toHaveBeenCalledWith("q1");
  });

  it("a suggestion submits its own text", () => {
    const { onSubmit } = renderAsk();
    fireEvent.click(screen.getByText(DASH_SUGGESTIONS[2]));
    expect(onSubmit).toHaveBeenCalledWith(DASH_SUGGESTIONS[2]);
  });

  it("a saved card submits its title", () => {
    const { onSubmit } = renderAsk();
    fireEvent.click(screen.getByText("kill-rate watch"));
    expect(onSubmit).toHaveBeenCalledWith("kill-rate watch");
  });
});
