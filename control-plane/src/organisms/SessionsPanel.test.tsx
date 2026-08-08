import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../api/types";
import { SessionsPanel } from "./SessionsPanel";

const SESSIONS: SessionSummary[] = [
  {
    id: "s1",
    title: "Fix the flaky test",
    workspace: "acme",
    updatedAt: "2026-08-01",
    active: true,
    runtime: "local-in-process",
  },
  {
    id: "s2",
    title: "Draft the README",
    workspace: "widgets",
    updatedAt: "2026-08-02",
    active: false,
    runtime: "local-docker",
  },
];

function props(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    sessions: SESSIONS,
    workspaces: ["acme", "widgets"],
    onClose: vi.fn(),
    onActivate: vi.fn(),
    onCreate: vi.fn(),
    ...overrides,
  };
}

describe("SessionsPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("new-session row calls onCreate with that row's workspace, then closes — no fetch fires from the panel", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onCreate = vi.fn();
    const onClose = vi.fn();
    render(<SessionsPanel {...props({ onCreate, onClose })} />);

    await userEvent.click(screen.getByRole("button", { name: /new session · acme/i }));

    expect(onCreate).toHaveBeenCalledWith("acme");
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("a second workspace's row passes its own workspace, not the first row's", async () => {
    const onCreate = vi.fn();
    render(<SessionsPanel {...props({ onCreate })} />);

    await userEvent.click(screen.getByRole("button", { name: /new session · widgets/i }));

    expect(onCreate).toHaveBeenCalledWith("widgets");
  });

  it("with no workspaces, the sole new-session row calls onCreate with undefined", async () => {
    const onCreate = vi.fn();
    render(<SessionsPanel {...props({ workspaces: [], sessions: [], onCreate })} />);

    await userEvent.click(screen.getByRole("button", { name: /^new session$/i }));

    expect(onCreate).toHaveBeenCalledWith(undefined);
  });

  it("clicking an inactive session activates it and closes; the active session is not re-activated", async () => {
    const onActivate = vi.fn();
    const onClose = vi.fn();
    render(<SessionsPanel {...props({ onActivate, onClose })} />);

    await userEvent.click(screen.getByText("Draft the README"));
    expect(onActivate).toHaveBeenCalledWith("s2");
    expect(onClose).toHaveBeenCalledTimes(1);

    onActivate.mockClear();
    onClose.mockClear();
    await userEvent.click(screen.getByText("Fix the flaky test"));
    expect(onActivate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the workspace filter narrows the visible sessions without touching onCreate's per-row workspace", async () => {
    render(<SessionsPanel {...props()} />);
    expect(screen.getByText("Fix the flaky test")).toBeDefined();
    expect(screen.getByText("Draft the README")).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: "widgets" }));

    expect(screen.queryByText("Fix the flaky test")).toBeNull();
    expect(screen.getByText("Draft the README")).toBeDefined();
  });

  it("onManage fires and closes the panel", async () => {
    const onManage = vi.fn();
    const onClose = vi.fn();
    render(<SessionsPanel {...props({ onManage, onClose })} />);

    await userEvent.click(screen.getByRole("button", { name: /manage workspaces/i }));

    expect(onManage).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows each session's runtime as a human-readable label", () => {
    render(<SessionsPanel {...props()} />);
    expect(screen.getByText("In process")).toBeDefined(); // s1: local-in-process
    expect(screen.getByText("Local Docker")).toBeDefined(); // s2: local-docker
  });

  it("renders nothing when closed", () => {
    const { container } = render(<SessionsPanel {...props({ open: false })} />);
    expect(container.innerHTML).toBe("");
  });
});
