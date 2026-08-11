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

  it("a suggestion walks the steps and lands on the board", () => {
    vi.useFakeTimers();
    render(<DashboardsStage />);
    fireEvent.click(screen.getByText(DASH_SUGGESTIONS[1]));
    expect(screen.getByText("reading 24 workspaces in jefelabs")).toBeTruthy();
    act(() => vi.advanceTimersByTime(STEP_MS * 4));
    expect(screen.getByText("save dashboard")).toBeTruthy();
    // The banner echoes the submitted query.
    expect(screen.getByText(DASH_SUGGESTIONS[1])).toBeTruthy();
  });

  it("an empty manual submit falls back to the first suggestion", () => {
    vi.useFakeTimers();
    render(<DashboardsStage />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Dashboard question" }), { key: "Enter" });
    act(() => vi.advanceTimersByTime(STEP_MS * 4));
    expect(screen.getByText(DASH_SUGGESTIONS[0])).toBeTruthy();
  });

  it("new question returns to ask; save appends a JUST SAVED card first", () => {
    vi.useFakeTimers();
    render(<DashboardsStage />);
    const box = screen.getByRole("textbox", { name: "Dashboard question" });
    fireEvent.change(box, { target: { value: "my question" } });
    fireEvent.keyDown(box, { key: "Enter" });
    act(() => vi.advanceTimersByTime(STEP_MS * 4));
    fireEvent.click(screen.getByText("save dashboard"));
    fireEvent.click(screen.getByText("new question"));
    // Back on ask, with the saved card appended (scope was untouched → ALL).
    expect(screen.getByText("what do you want to know?")).toBeTruthy();
    expect(screen.getByText("my question")).toBeTruthy();
    expect(screen.getByText("ALL · JUST SAVED")).toBeTruthy();
  });

  it("a follow-up from the board re-runs the compose walk", () => {
    vi.useFakeTimers();
    render(<DashboardsStage />);
    fireEvent.click(screen.getByText(DASH_SUGGESTIONS[0]));
    act(() => vi.advanceTimersByTime(STEP_MS * 4));
    fireEvent.click(screen.getByRole("button", { name: "compare to last quarter" }));
    expect(screen.getByText("reading 24 workspaces in jefelabs")).toBeTruthy();
    // Two ticks in, it is still composing — the restart began from step 0.
    act(() => vi.advanceTimersByTime(STEP_MS * 2));
    expect(screen.queryByText("save dashboard")).toBeNull();
    act(() => vi.advanceTimersByTime(STEP_MS * 2));
    expect(screen.getAllByText("compare to last quarter")[0]).toBeTruthy();
    expect(screen.getByText("save dashboard")).toBeTruthy();
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
});
