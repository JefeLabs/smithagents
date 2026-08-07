import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRail } from "./ToolRail";

describe("ToolRail", () => {
  afterEach(() => {
    cleanup();
  });

  it("New workspace tool fires onNewWorkspace", async () => {
    const onNewWorkspace = vi.fn();
    render(<ToolRail onNewWorkspace={onNewWorkspace} />);
    expect(screen.queryByRole("button", { name: /new session/i })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /new workspace/i }));
    expect(onNewWorkspace).toHaveBeenCalledTimes(1);
  });

  it("sessions tool fires onSessions", async () => {
    const onSessions = vi.fn();
    render(<ToolRail onSessions={onSessions} />);
    await userEvent.click(screen.getByRole("button", { name: /sessions/i }));
    expect(onSessions).toHaveBeenCalledTimes(1);
  });

  it("board tool fires onBoard", async () => {
    const onBoard = vi.fn();
    render(<ToolRail onBoard={onBoard} />);
    await userEvent.click(screen.getByRole("button", { name: /^board$/i }));
    expect(onBoard).toHaveBeenCalledTimes(1);
  });

  it("map tool fires onMap", async () => {
    const onMap = vi.fn();
    render(<ToolRail onMap={onMap} />);
    await userEvent.click(screen.getByRole("button", { name: /^map$/i }));
    expect(onMap).toHaveBeenCalledTimes(1);
  });

  it("settings button still fires onSettings", async () => {
    const onSettings = vi.fn();
    render(<ToolRail onSettings={onSettings} />);
    await userEvent.click(screen.getByRole("button", { name: /settings/i }));
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it("board tool is highlighted only when activeRoute is /board", () => {
    render(<ToolRail activeRoute="/board" />);
    expect(screen.getByRole("button", { name: /^board$/i }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: /^map$/i }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("button", { name: /new workspace/i }).getAttribute("aria-current")).toBeNull();
  });

  it("nothing is highlighted at the home route", () => {
    render(<ToolRail activeRoute="/" />);
    expect(screen.getByRole("button", { name: /^board$/i }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("button", { name: /^map$/i }).getAttribute("aria-current")).toBeNull();
  });

  it("logo fires onHome", async () => {
    const onHome = vi.fn();
    render(<ToolRail onHome={onHome} />);
    await userEvent.click(screen.getByRole("button", { name: /home/i }));
    expect(onHome).toHaveBeenCalledTimes(1);
  });
});
