import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DASH_SUGGESTIONS } from "../data/dashboards";
import { DashboardsStage } from "./DashboardsStage";

const STEP_MS = 620;

describe("DashboardsStage", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("a suggestion walks the steps, then hands off via onPresent and returns to ask", () => {
    vi.useFakeTimers();
    const onPresent = vi.fn();
    render(<DashboardsStage onPresent={onPresent} />);
    fireEvent.click(screen.getByText(DASH_SUGGESTIONS[1]));
    expect(screen.getByText("reading 24 workspaces in jefelabs")).toBeTruthy();
    expect(onPresent).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(STEP_MS * 4));
    // The walk's product is a DOCUMENT — the route creates and navigates; the
    // stage itself never shows a board, it just resets for the next ask.
    expect(onPresent).toHaveBeenCalledExactlyOnceWith(DASH_SUGGESTIONS[1], "all workspaces");
    expect(screen.getByText("what do you want to know?")).toBeTruthy();
  });

  it("onPresent carries the picked GROUP scope", () => {
    vi.useFakeTimers();
    const onPresent = vi.fn();
    render(<DashboardsStage onPresent={onPresent} scopes={["all workspaces", "frontend"]} />);
    fireEvent.click(screen.getByRole("radio", { name: "frontend" }));
    fireEvent.click(screen.getByText(DASH_SUGGESTIONS[0]));
    act(() => vi.advanceTimersByTime(STEP_MS * 4));
    expect(onPresent).toHaveBeenCalledExactlyOnceWith(DASH_SUGGESTIONS[0], "frontend");
  });

  it("without a scopes prop only 'all workspaces' offers", () => {
    render(<DashboardsStage />);
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["all workspaces"]);
  });

  it("presents exactly once — the completed walk's timer is stopped, not left ticking", () => {
    vi.useFakeTimers();
    const onPresent = vi.fn();
    render(<DashboardsStage onPresent={onPresent} />);
    fireEvent.click(screen.getByText(DASH_SUGGESTIONS[0]));
    act(() => vi.advanceTimersByTime(STEP_MS * 2));
    // Still composing — nothing presented yet.
    expect(onPresent).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(STEP_MS * 10));
    expect(onPresent).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unmounting mid-compose leaks no timer", () => {
    vi.useFakeTimers();
    const { unmount } = render(<DashboardsStage />);
    fireEvent.click(screen.getByText(DASH_SUGGESTIONS[0]));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders the shelf slot inside the stage when provided", () => {
    render(<DashboardsStage shelf={<aside aria-label="session documents" />} />);
    expect(screen.getByRole("complementary", { name: "session documents" })).toBeTruthy();
  });

  it("SAVED lists the pinned docs and opens one by id", () => {
    const onOpenSaved = vi.fn();
    render(
      <DashboardsStage
        savedDocs={[{ id: "d7", title: "weekly delivery health", meta: "acme · updated today" }]}
        onOpenSaved={onOpenSaved}
      />,
    );
    fireEvent.click(screen.getByText("weekly delivery health"));
    expect(onOpenSaved).toHaveBeenCalledExactlyOnceWith("d7");
  });
});
