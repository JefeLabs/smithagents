import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DASH_SAVED, DASH_SUGGESTIONS } from "../../data/dashboards";
import { DashboardAsk } from "./DashboardAsk";

function renderAsk(over: Partial<Parameters<typeof DashboardAsk>[0]> = {}) {
  const props = {
    scope: "all workspaces",
    saved: DASH_SAVED,
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

  it("owns no text input — the shared center dock is the one chat box (spec v3)", () => {
    renderAsk();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("a suggestion submits its own text", () => {
    const { onSubmit } = renderAsk();
    fireEvent.click(screen.getByText(DASH_SUGGESTIONS[2]));
    expect(onSubmit).toHaveBeenCalledWith(DASH_SUGGESTIONS[2]);
  });

  it("a saved card opens its DOCUMENT by id, never re-submits", () => {
    const onOpenSaved = vi.fn();
    const { onSubmit } = renderAsk({
      saved: [{ id: "doc-9", title: "kill-rate watch", meta: "acme · updated today" }],
      onOpenSaved,
    });
    fireEvent.click(screen.getByText("kill-rate watch"));
    expect(onOpenSaved).toHaveBeenCalledExactlyOnceWith("doc-9");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
