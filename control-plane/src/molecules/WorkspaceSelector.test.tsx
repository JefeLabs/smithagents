import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/broker";
import type { SessionSummary } from "../api/types";
import { qk } from "../queries/keys";
import { useUiStore } from "../stores/uiStore";
import { renderWithProviders } from "../test/renderWithProviders";
import { WorkspaceSelector } from "./WorkspaceSelector";

// The real action, captured before any test overrides it — restored in afterEach so
// an override in one case can never leak `setNewWorkspaceOpen` into the next.
const REAL_SET_NEW_WORKSPACE_OPEN = useUiStore.getState().setNewWorkspaceOpen;

afterEach(() => {
  vi.restoreAllMocks();
  useUiStore.setState({ setNewWorkspaceOpen: REAL_SET_NEW_WORKSPACE_OPEN });
});

interface SessionOpts {
  workspaces?: string[];
  sessions?: SessionSummary[];
  activate?: (id: string) => void;
  setNewWorkspaceOpen?: (open: boolean) => void;
}

/** Seeds the pushed-query cache the way the socket store would, per src/test/renderWithProviders.tsx. */
function renderWithSession(session: { workspace: string }, opts: SessionOpts = {}) {
  const { workspaces = [], sessions = [], activate, setNewWorkspaceOpen } = opts;
  if (activate) vi.spyOn(api, "activateSession").mockImplementation(async (id) => activate(id));
  if (setNewWorkspaceOpen) useUiStore.setState({ setNewWorkspaceOpen });

  const { client } = renderWithProviders(<WorkspaceSelector />);
  client.setQueryData(qk.session, { id: "s0", title: "t", workspace: session.workspace, runtime: "local-in-process" });
  client.setQueryData(qk.sessions, sessions);
  client.setQueryData(qk.workspaces, workspaces);
  return { client };
}

describe("WorkspaceSelector", () => {
  it("shows the active session's workspace without any client-side workspace state", async () => {
    renderWithSession({ workspace: "acme" }, { workspaces: ["acme", "jefelabs"] });
    expect(await screen.findByRole("button", { name: /acme/ })).toBeDefined();
  });

  it("selecting a workspace activates that workspace's most recent session", async () => {
    const activate = vi.fn();
    renderWithSession(
      { workspace: "acme" },
      {
        workspaces: ["acme", "jefelabs"],
        sessions: [
          {
            id: "s1",
            workspace: "jefelabs",
            updatedAt: "2026-08-01T00:00:00Z",
            title: "old",
            active: false,
            runtime: "local-in-process",
          },
          {
            id: "s2",
            workspace: "jefelabs",
            updatedAt: "2026-08-08T00:00:00Z",
            title: "new",
            active: false,
            runtime: "local-in-process",
          },
        ],
        activate,
      },
    );
    await userEvent.click(await screen.findByRole("button", { name: /acme/ }));
    await userEvent.click(await screen.findByRole("option", { name: "jefelabs" }));
    expect(activate).toHaveBeenCalledWith("s2"); // most recent by updatedAt, not first in the array
  });

  it("selecting a workspace with no sessions opens the composer locked to it and activates nothing", async () => {
    const activate = vi.fn();
    renderWithSession({ workspace: "acme" }, { workspaces: ["acme", "empty"], sessions: [], activate });
    await userEvent.click(await screen.findByRole("button", { name: /acme/ }));
    await userEvent.click(await screen.findByRole("option", { name: "empty" }));
    expect(useUiStore.getState().composer).toEqual({ locked: "empty" });
    expect(activate).not.toHaveBeenCalled();
  });

  it("offers New workspace as the last item, opening the create flow", async () => {
    const setNewWorkspaceOpen = vi.fn();
    renderWithSession({ workspace: "acme" }, { workspaces: ["acme"], setNewWorkspaceOpen });
    await userEvent.click(await screen.findByRole("button", { name: /acme/ }));
    await userEvent.click(await screen.findByRole("option", { name: /new workspace/i }));
    expect(setNewWorkspaceOpen).toHaveBeenCalledWith(true);
    // It is a command, not a workspace — it must never be treated as a selection.
    expect(useUiStore.getState().composer).toBeNull();
  });

  it("selecting the workspace already active is a no-op", async () => {
    const activate = vi.fn();
    renderWithSession(
      { workspace: "acme" },
      {
        workspaces: ["acme"],
        sessions: [
          {
            id: "s1",
            workspace: "acme",
            updatedAt: "2026-08-08T00:00:00Z",
            title: "t",
            active: true,
            runtime: "local-in-process",
          },
        ],
        activate,
      },
    );
    await userEvent.click(await screen.findByRole("button", { name: /acme/ }));
    await userEvent.click(await screen.findByRole("option", { name: "acme" }));
    expect(activate).not.toHaveBeenCalled();
  });
});
