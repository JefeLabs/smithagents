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

  it("settings button still fires onSettings", async () => {
    const onSettings = vi.fn();
    render(<ToolRail onSettings={onSettings} />);
    await userEvent.click(screen.getByRole("button", { name: /settings/i }));
    expect(onSettings).toHaveBeenCalledTimes(1);
  });
});
