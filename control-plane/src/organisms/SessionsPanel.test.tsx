import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    artifacts: [],
  },
  {
    id: "s2",
    title: "Draft the README",
    workspace: "widgets",
    updatedAt: "2026-08-02",
    active: false,
    runtime: "local-docker",
    artifacts: [],
  },
];

function props(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    sessions: SESSIONS,
    workspaces: ["acme", "widgets"],
    onClose: vi.fn(),
    onActivate: vi.fn(),
    onOpenArtifact: vi.fn(),
    onCreate: vi.fn(),
    ...overrides,
  };
}

// Its own lean defaults, not `props()`'s: the shared fixture's "acme" workspace shows up
// in a session row's meta, which would make `getByText("acme")` ambiguous for
// a test that's only asserting on the header anchor.
function renderPanel(overrides: Record<string, unknown> = {}) {
  return render(
    <SessionsPanel
      {...{
        open: true,
        sessions: [],
        workspaces: [],
        onClose: vi.fn(),
        onActivate: vi.fn(),
        onOpenArtifact: vi.fn(),
        onCreate: vi.fn(),
        ...overrides,
      }}
    />,
  );
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

  it("the context window hides out-of-range sessions but NEVER the active one", async () => {
    render(
      <SessionsPanel
        {...props({
          rangeBounds: { from: new Date(2026, 7, 1), to: new Date(2026, 7, 12, 23, 59, 59) },
          sessions: [
            {
              id: "s1",
              title: "fresh",
              workspace: "acme",
              updatedAt: "2026-08-10T00:00:00Z",
              active: false,
              runtime: "local-in-process",
              artifacts: [],
            },
            {
              id: "s2",
              title: "ancient",
              workspace: "acme",
              updatedAt: "2026-01-01T00:00:00Z",
              active: false,
              runtime: "local-in-process",
              artifacts: [],
            },
            {
              id: "s3",
              title: "old but active",
              workspace: "acme",
              updatedAt: "2026-01-02T00:00:00Z",
              active: true,
              runtime: "local-in-process",
              artifacts: [],
            },
          ],
        })}
      />,
    );
    expect(await screen.findByText("fresh")).toBeTruthy();
    expect(screen.queryByText("ancient")).toBeNull();
    expect(screen.getByText("old but active")).toBeTruthy();
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

  it("contextWorkspaces scopes the list to the current workspace/group — but NEVER hides the active session", () => {
    // s1 (acme) is active, s2 (widgets) is not; scoping to acme drops s2,
    // scoping to widgets keeps BOTH (s1 rides its active status).
    const { unmount } = render(<SessionsPanel {...props({ contextWorkspaces: ["acme"] })} />);
    expect(screen.getByText("Fix the flaky test")).toBeDefined();
    expect(screen.queryByText("Draft the README")).toBeNull();
    unmount();

    render(<SessionsPanel {...props({ contextWorkspaces: ["widgets"] })} />);
    expect(screen.getByText("Fix the flaky test")).toBeDefined();
    expect(screen.getByText("Draft the README")).toBeDefined();
  });

  it("new-session rows follow the context scope", () => {
    render(<SessionsPanel {...props({ contextWorkspaces: ["widgets"] })} />);
    expect(screen.getByRole("button", { name: /new session · widgets/i })).toBeDefined();
    expect(screen.queryByRole("button", { name: /new session · acme/i })).toBeNull();
  });

  it("a context scope matching no workspace still offers the bare new-session row", async () => {
    const onCreate = vi.fn();
    render(<SessionsPanel {...props({ contextWorkspaces: ["ghost"], onCreate })} />);
    await userEvent.click(screen.getByRole("button", { name: /^new session$/i }));
    expect(onCreate).toHaveBeenCalledWith(undefined);
  });

  it("renders the caller's context droplists at the top of the panel", () => {
    render(<SessionsPanel {...props({ contextSlot: <span data-testid="ctx-slot">the pair</span> })} />);
    expect(screen.getByTestId("ctx-slot")).toBeDefined();
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

  it("the header anchors the active workspace", () => {
    renderPanel({ activeWorkspace: "acme" });
    expect(screen.getByText("acme")).toBeTruthy();
  });

  it("a session's artifacts each get a chip that opens them", () => {
    const onOpenArtifact = vi.fn();
    renderPanel({
      onOpenArtifact,
      sessions: [
        {
          id: "s1",
          title: "Council",
          workspace: "acme",
          updatedAt: "t",
          active: true,
          runtime: "local-in-process",
          artifacts: ["d1", "d2"],
        },
      ],
    });
    const chips = screen.getAllByRole("button", { name: /open document/i });
    expect(chips).toHaveLength(2);
    fireEvent.click(chips[1]);
    expect(onOpenArtifact).toHaveBeenCalledWith("s1", "d2");
  });

  it("a session with no artifacts has no chips and still activates", () => {
    const onActivate = vi.fn();
    renderPanel({
      onActivate,
      sessions: [
        {
          id: "s2",
          title: "Plain",
          workspace: "acme",
          updatedAt: "t",
          active: false,
          runtime: "local-in-process",
          artifacts: [],
        },
      ],
    });
    expect(screen.queryByRole("button", { name: /open document/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /plain/i }));
    expect(onActivate).toHaveBeenCalledWith("s2");
  });
});

describe("deleting a session", () => {
  it("asks before deleting, names the session, and promises the documents survive", async () => {
    const onDelete = vi.fn().mockResolvedValue(null);
    render(<SessionsPanel {...props({ onDelete })} />);

    await userEvent.click(screen.getByRole("button", { name: 'delete session "Draft the README"' }));

    // Nothing is gone yet — a destructive action states its outcome first.
    expect(onDelete).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Draft the README");
    expect(dialog).toHaveTextContent(/document/i);
  });

  it("deletes on confirm and closes the dialog", async () => {
    const onDelete = vi.fn().mockResolvedValue(null);
    render(<SessionsPanel {...props({ onDelete })} />);

    await userEvent.click(screen.getByRole("button", { name: 'delete session "Draft the README"' }));
    await userEvent.click(screen.getByRole("button", { name: "delete session" }));

    expect(onDelete).toHaveBeenCalledWith("s2");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("cancelling deletes nothing", async () => {
    const onDelete = vi.fn().mockResolvedValue(null);
    render(<SessionsPanel {...props({ onDelete })} />);

    await userEvent.click(screen.getByRole("button", { name: 'delete session "Fix the flaky test"' }));
    await userEvent.click(screen.getByRole("button", { name: "cancel" }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("keeps the dialog open and shows why when the broker refuses", async () => {
    const onDelete = vi.fn().mockResolvedValue("broker unreachable");
    render(<SessionsPanel {...props({ onDelete })} />);

    await userEvent.click(screen.getByRole("button", { name: 'delete session "Draft the README"' }));
    await userEvent.click(screen.getByRole("button", { name: "delete session" }));

    // The row must not vanish on a failed delete — the session still exists.
    expect(screen.getByRole("alertdialog")).toHaveTextContent("broker unreachable");
  });

  it("offers no delete affordance at all when the caller supplies no handler", () => {
    render(<SessionsPanel {...props()} />);
    expect(screen.queryByRole("button", { name: /^delete session/ })).toBeNull();
  });
});
