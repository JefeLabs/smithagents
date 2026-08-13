import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/broker";
import type { GroupT, SessionSummary } from "../api/types";
import { qk } from "../queries/keys";
import { useUiStore } from "../stores/uiStore";
import { renderWithProviders } from "../test/renderWithProviders";
import { WorkspaceSelector } from "./WorkspaceSelector";

// The real action, captured before any test overrides it — restored in afterEach so
// an override in one case can never leak `setNewWorkspaceOpen` into the next.
const REAL_SET_NEW_WORKSPACE_OPEN = useUiStore.getState().setNewWorkspaceOpen;
const REAL_SET_WORKSPACES_OPEN = useUiStore.getState().setWorkspacesOpen;

afterEach(() => {
  vi.restoreAllMocks();
  useUiStore.setState({
    setNewWorkspaceOpen: REAL_SET_NEW_WORKSPACE_OPEN,
    setWorkspacesOpen: REAL_SET_WORKSPACES_OPEN,
  });
});

interface SessionOpts {
  workspaces?: string[];
  sessions?: SessionSummary[];
  groups?: GroupT[];
  activate?: (id: string) => void;
  setNewWorkspaceOpen?: (open: boolean) => void;
  setWorkspacesOpen?: (open: boolean) => void;
}

/** Seeds the pushed-query cache the way the socket store would, per src/test/renderWithProviders.tsx. */
function renderWithSession(session: { workspace: string }, opts: SessionOpts = {}) {
  const { workspaces = [], sessions = [], groups = [], activate, setNewWorkspaceOpen, setWorkspacesOpen } = opts;
  if (activate) vi.spyOn(api, "activateSession").mockImplementation(async (id) => activate(id));
  if (setNewWorkspaceOpen) useUiStore.setState({ setNewWorkspaceOpen });
  if (setWorkspacesOpen) useUiStore.setState({ setWorkspacesOpen });

  const { client } = renderWithProviders(<WorkspaceSelector />);
  client.setQueryData(qk.session, { id: "s0", title: "t", workspace: session.workspace, runtime: "local-in-process" });
  client.setQueryData(qk.sessions, sessions);
  client.setQueryData(qk.workspaces, workspaces);
  client.setQueryData(qk.groups, groups);
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
        // s2 (newest) sits in the MIDDLE, not first or last — defeats both a "take the
        // first match" bug and a "take the last match" bug; only a real updatedAt
        // comparison picks s2 out of this array.
        sessions: [
          {
            id: "s3",
            workspace: "jefelabs",
            updatedAt: "2026-08-05T00:00:00Z",
            title: "middle-aged",
            active: false,
            runtime: "local-in-process",
            artifacts: [],
          },
          {
            id: "s2",
            workspace: "jefelabs",
            updatedAt: "2026-08-08T00:00:00Z",
            title: "new",
            active: false,
            runtime: "local-in-process",
            artifacts: [],
          },
          {
            id: "s1",
            workspace: "jefelabs",
            updatedAt: "2026-08-01T00:00:00Z",
            title: "old",
            active: false,
            runtime: "local-in-process",
            artifacts: [],
          },
        ],
        activate,
      },
    );
    await userEvent.click(await screen.findByRole("button", { name: /acme/ }));
    await userEvent.click(await screen.findByRole("option", { name: "jefelabs" }));
    expect(activate).toHaveBeenCalledWith("s2"); // most recent by updatedAt, not array position
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

  it("selecting the workspace already active fires no activation", async () => {
    // This isn't guarding a branch in select() — there isn't one. <Select> is
    // controlled (value={current}), and react-stately's useControlledState only
    // calls onChange when the value actually differs (verified against its
    // source: it diffs with Object.is before calling onChange at all), so
    // clicking the already-selected option never reaches select() in the first
    // place. This test documents that observable contract and would catch a
    // regression if a future refactor ever made the Select uncontrolled.
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
            artifacts: [],
          },
        ],
        activate,
      },
    );
    await userEvent.click(await screen.findByRole("button", { name: /acme/ }));
    await userEvent.click(await screen.findByRole("option", { name: "acme" }));
    expect(activate).not.toHaveBeenCalled();
  });

  it("picking a GROUP applies the lens — viewedWorkspaces becomes the expansion, no session activates", async () => {
    const activate = vi.fn();
    renderWithSession(
      { workspace: "acme" },
      {
        workspaces: ["acme", "labs"],
        groups: [{ name: "frontend", workspaces: ["acme", "labs"], groups: [], expansion: ["acme", "labs"] }],
        activate,
      },
    );
    await userEvent.click(await screen.findByRole("button", { name: /acme/ }));
    await userEvent.click(await screen.findByRole("option", { name: "frontend" }));
    expect(useUiStore.getState().activeLens).toEqual({ group: "frontend" });
    expect([...(useUiStore.getState().viewedWorkspaces as ReadonlySet<string>)].sort()).toEqual(["acme", "labs"]);
    expect(activate).not.toHaveBeenCalled();
  });

  it("group options denote containment with a 'group' tag whose hover reveals the members", async () => {
    renderWithSession(
      { workspace: "acme" },
      {
        workspaces: ["acme", "labs"],
        groups: [{ name: "frontend", workspaces: ["labs"], groups: ["inner"], expansion: ["labs", "web", "api"] }],
      },
    );
    await userEvent.click(await screen.findByRole("button", { name: /acme/ }));
    // Exact-name match still resolving proves the tag is aria-hidden — were it
    // in the accessible name, this option would be named "frontend group".
    const group = await screen.findByRole("option", { name: "frontend" });
    expect(group.textContent).toContain("group");
    const workspace = await screen.findByRole("option", { name: "labs" });
    expect(workspace.textContent).toBe("labs");
    // The member reveal rides a hover Tooltip. react-aria's hover detection
    // does not fire under jsdom's synthetic pointers (same class of jsdom
    // blindness as react-flow node children), so the hover path is verified by
    // live smoke; here we pin that members stay unrendered until hover.
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(group.textContent).not.toContain("inner");
  });

  it("picking a workspace clears an active lens and activates as always", async () => {
    const activate = vi.fn();
    renderWithSession(
      { workspace: "acme" },
      {
        workspaces: ["acme", "labs"],
        groups: [{ name: "frontend", workspaces: ["labs"], groups: [], expansion: ["labs"] }],
        sessions: [
          {
            id: "s7",
            workspace: "labs",
            updatedAt: "2026-08-08T00:00:00Z",
            title: "t",
            active: false,
            runtime: "local-in-process",
            artifacts: [],
          },
        ],
        activate,
      },
    );
    await userEvent.click(await screen.findByRole("button", { name: /acme/ }));
    await userEvent.click(await screen.findByRole("option", { name: "frontend" }));
    expect(useUiStore.getState().activeLens).toEqual({ group: "frontend" });
    await userEvent.click(await screen.findByRole("button", { name: /frontend/ }));
    await userEvent.click(await screen.findByRole("option", { name: "labs" }));
    expect(useUiStore.getState().activeLens).toBeNull();
    expect(activate).toHaveBeenCalledWith("s7");
  });

  it("offers ONE creation command — the unified wizard (one-context spec 2026-08-13)", async () => {
    renderWithSession({ workspace: "acme" }, { workspaces: ["acme"] });
    await userEvent.click(await screen.findByRole("button", { name: /acme/ }));
    expect(screen.queryByRole("option", { name: /new group/i })).toBeNull();
    await userEvent.click(await screen.findByRole("option", { name: "New workspace…" }));
    expect(useUiStore.getState().newWorkspaceOpen).toBe(true);
    expect(useUiStore.getState().workspacesOpen).toBe(false);
    expect(useUiStore.getState().composer).toBeNull();
  });

  it("a workspace literally named 'New workspace' is still a real selection, not the create-workspace command", async () => {
    // The command renders as "New workspace…" (with an ellipsis) and is keyed by the
    // NEW_WORKSPACE sentinel id, disjoint from any real workspace's id — so a workspace
    // literally named "New workspace" (no ellipsis) gets its own, separate option and
    // must activate a session like any other workspace.
    const activate = vi.fn();
    const setNewWorkspaceOpen = vi.fn();
    renderWithSession(
      { workspace: "acme" },
      {
        workspaces: ["acme", "New workspace"],
        sessions: [
          {
            id: "s9",
            workspace: "New workspace",
            updatedAt: "2026-08-08T00:00:00Z",
            title: "t",
            active: false,
            runtime: "local-in-process",
            artifacts: [],
          },
        ],
        activate,
        setNewWorkspaceOpen,
      },
    );
    await userEvent.click(await screen.findByRole("button", { name: /acme/ }));
    // Exact match: distinguishes the real workspace's "New workspace" option from the
    // sentinel command's "New workspace…" option, which regex /new workspace/i would not.
    await userEvent.click(await screen.findByRole("option", { name: "New workspace" }));
    expect(activate).toHaveBeenCalledWith("s9");
    expect(setNewWorkspaceOpen).not.toHaveBeenCalled();
  });
});
