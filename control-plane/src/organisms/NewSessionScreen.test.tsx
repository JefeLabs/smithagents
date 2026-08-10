import "@testing-library/jest-dom/vitest";
import { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionMode, SessionSummary, WorkspaceRecord } from "../api/types";
import { qk } from "../queries/keys";
import { renderWithProviders } from "../test/renderWithProviders";
import { NewSessionScreen, type NewSessionScreenProps } from "./NewSessionScreen";

/**
 * A live broker really is listening on 127.0.0.1:7790 on dev machines — `useWorkspaceRecords`
 * and `useExecutionModes` are fetch-backed, so every test needs this stubbed even when its
 * scenario never touches those two keys.
 */
function stubNoNetwork() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("no network in this test");
    }),
  );
}

const ALL_MODES: Record<ExecutionMode, boolean> = {
  "local-in-process": true,
  "local-docker": true,
  "remote-in-process": false,
  "remote-docker": false,
};

/**
 * Seeds the four queries the screen now reads itself, in place of the old prop object.
 * `staleTime: Infinity` keeps a seeded value from racing a background refetch — the
 * stubbed-to-throw fetch above is the safety net for whichever keys a given test leaves
 * unseeded (matching the old `records: null` / `modes: null` / `sessions: []` defaults).
 */
function renderScreen(
  props: Partial<NewSessionScreenProps> = {},
  seed: {
    workspaces?: string[];
    records?: WorkspaceRecord[];
    sessions?: SessionSummary[];
    modes?: Record<ExecutionMode, boolean>;
  } = {},
) {
  stubNoNetwork();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } } });
  client.setQueryData(qk.workspaces, seed.workspaces ?? ["acme", "beta"]);
  client.setQueryData(qk.sessions, seed.sessions ?? []);
  if (seed.records !== undefined) client.setQueryData(qk.workspaceRecords, seed.records);
  if (seed.modes !== undefined) client.setQueryData(qk.executionModes, seed.modes);
  return renderWithProviders(<NewSessionScreen onSend={vi.fn(async () => undefined)} onCancel={vi.fn()} {...props} />, {
    client,
  });
}

describe("NewSessionScreen", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders only available modes — unavailable are absent, not disabled", () => {
    renderScreen({}, { modes: ALL_MODES });
    expect(screen.getByText("In process")).toBeInTheDocument();
    expect(screen.getByText("Local Docker")).toBeInTheDocument();
    expect(screen.queryByText("Remote Docker")).toBeNull();
  });

  it("defaults mode to the workspace's most recent session's mode when still available", () => {
    renderScreen(
      { lockedWorkspace: "acme" },
      {
        modes: ALL_MODES,
        sessions: [
          {
            id: "s1",
            title: "old",
            workspace: "acme",
            updatedAt: "2026-08-01T00:00:00Z",
            active: false,
            runtime: "local-in-process",
          },
          {
            id: "s2",
            title: "new",
            workspace: "acme",
            updatedAt: "2026-08-07T00:00:00Z",
            active: false,
            runtime: "local-docker",
          },
        ],
      },
    );
    expect(screen.getByRole("radio", { name: "Local Docker" })).toBeChecked();
  });

  it("re-derives the default once the capability probe resolves (modes: null → loaded)", async () => {
    const sessions: SessionSummary[] = [
      {
        id: "s1",
        title: "recent",
        workspace: "acme",
        updatedAt: "2026-08-07T00:00:00Z",
        active: false,
        runtime: "local-docker",
      },
    ];
    // `modes` deliberately left unseeded — same "probe still in flight" state `modes: null` used to model.
    const { client } = renderScreen({ lockedWorkspace: "acme" }, { sessions });
    // While the probe is in flight, "In process" is the only mode that can render at all.
    expect(screen.getByRole("radio", { name: "In process" })).toBeChecked();

    client.setQueryData(qk.executionModes, ALL_MODES);

    await waitFor(() => expect(screen.getByRole("radio", { name: "Local Docker" })).toBeChecked());
  });

  it("a user's manual mode pick survives modes resolving from null", async () => {
    const sessions: SessionSummary[] = [
      {
        id: "s1",
        title: "recent",
        workspace: "acme",
        updatedAt: "2026-08-07T00:00:00Z",
        active: false,
        runtime: "local-docker",
      },
    ];
    const { client } = renderScreen({ lockedWorkspace: "acme" }, { sessions });
    // Only "In process" renders while the probe is in flight, and it's already checked —
    // clicking it is still a deliberate interaction with the radio group (a native radio
    // never fires `change` re-selecting its own value, which is exactly why the pick is
    // tracked on click, not change — see NewSessionScreen's onClick comment).
    await userEvent.click(screen.getByRole("radio", { name: "In process" }));

    client.setQueryData(qk.executionModes, ALL_MODES);

    await waitFor(() => expect(screen.getByRole("radio", { name: "In process" })).toBeChecked());
    expect(screen.getByRole("radio", { name: "Local Docker" })).not.toBeChecked();
  });

  it("a change-event-driven mode pick (no pointer event, as a keyboard pick fires) survives modes re-resolving", async () => {
    const sessions: SessionSummary[] = [
      {
        id: "s1",
        title: "recent",
        workspace: "acme",
        updatedAt: "2026-08-07T00:00:00Z",
        active: false,
        runtime: "local-docker",
      },
    ];
    const { client } = renderScreen({ lockedWorkspace: "acme" }, { sessions });
    expect(screen.getByRole("radio", { name: "In process" })).toBeChecked();

    // First resolution derives "Local Docker" from session history — nobody has picked yet.
    client.setQueryData(qk.executionModes, ALL_MODES);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Local Docker" })).toBeChecked());

    // fireEvent.click dispatches only a "click" event — unlike userEvent.click it never sends
    // pointerdown/pointerup, so this exercises RadioButtonGroup's onChange (the underlying
    // radio input's native change handler) in isolation from onPointerUp, the same isolation
    // a real keyboard-driven pick (arrow key / native radio-group nav) would have.
    fireEvent.click(screen.getByRole("radio", { name: "In process" }));
    expect(screen.getByRole("radio", { name: "In process" })).toBeChecked();

    // A second probe transition (e.g. the broker reconnecting and re-probing capabilities)
    // must not clobber the onChange-driven pick back to the session-derived default.
    client.setQueryData(qk.executionModes, null);
    await waitFor(() => expect(screen.queryByRole("radio", { name: "Local Docker" })).toBeNull());
    client.setQueryData(qk.executionModes, ALL_MODES);

    await waitFor(() => expect(screen.getByRole("radio", { name: "In process" })).toBeChecked());
    expect(screen.getByRole("radio", { name: "Local Docker" })).not.toBeChecked();
  });

  it("locks the workspace picker when lockedWorkspace is set", () => {
    renderScreen({ lockedWorkspace: "acme" });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("acme")).toBeInTheDocument();
  });

  it("send calls onSend(workspace, mode, prompt) and shows a returned error while keeping the prompt text", async () => {
    const onSend = vi.fn().mockResolvedValue({ error: 'execution mode "local-docker" is not available' });
    renderScreen({ lockedWorkspace: "acme", onSend });
    await userEvent.type(screen.getByRole("textbox"), "fix the build");
    await userEvent.click(screen.getByRole("button", { name: /send|start/i }));
    expect(onSend).toHaveBeenCalledWith("acme", "local-in-process", "fix the build");
    expect(await screen.findByText(/not available/)).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("fix the build");
  });

  it("shows the workspace description and links as context preview", () => {
    renderScreen(
      { lockedWorkspace: "acme" },
      {
        records: [
          {
            name: "acme",
            default: true,
            repos: [],
            description: "builds the acme app",
            links: ["https://acme.dev/docs"],
          },
        ],
      },
    );
    expect(screen.getByText("builds the acme app")).toBeInTheDocument();
    expect(screen.getByText("https://acme.dev/docs")).toBeInTheDocument();
  });
});
