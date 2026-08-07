import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewSessionScreen, type NewSessionScreenProps } from "./NewSessionScreen";

const base: NewSessionScreenProps = {
  workspaces: ["acme", "beta"],
  records: null,
  sessions: [],
  modes: null,
  onSend: vi.fn(async () => undefined),
  onCancel: vi.fn(),
};

describe("NewSessionScreen", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders only available modes — unavailable are absent, not disabled", () => {
    render(
      <NewSessionScreen
        {...base}
        modes={{ "local-in-process": true, "local-docker": true, "remote-in-process": false, "remote-docker": false }}
      />,
    );
    expect(screen.getByText("In process")).toBeInTheDocument();
    expect(screen.getByText("Local Docker")).toBeInTheDocument();
    expect(screen.queryByText("Remote Docker")).toBeNull();
  });

  it("defaults mode to the workspace's most recent session's mode when still available", () => {
    render(
      <NewSessionScreen
        {...base}
        lockedWorkspace="acme"
        modes={{ "local-in-process": true, "local-docker": true, "remote-in-process": false, "remote-docker": false }}
        sessions={[
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
        ]}
      />,
    );
    expect(screen.getByRole("radio", { name: "Local Docker" })).toBeChecked();
  });

  it("locks the workspace picker when lockedWorkspace is set", () => {
    render(<NewSessionScreen {...base} lockedWorkspace="acme" />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("acme")).toBeInTheDocument();
  });

  it("send calls onSend(workspace, mode, prompt) and shows a returned error while keeping the prompt text", async () => {
    const onSend = vi.fn().mockResolvedValue({ error: 'execution mode "local-docker" is not available' });
    render(<NewSessionScreen {...base} lockedWorkspace="acme" onSend={onSend} />);
    await userEvent.type(screen.getByRole("textbox"), "fix the build");
    await userEvent.click(screen.getByRole("button", { name: /send|start/i }));
    expect(onSend).toHaveBeenCalledWith("acme", "local-in-process", "fix the build");
    expect(await screen.findByText(/not available/)).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("fix the build");
  });

  it("shows the workspace description and links as context preview", () => {
    render(
      <NewSessionScreen
        {...base}
        lockedWorkspace="acme"
        records={[
          {
            name: "acme",
            default: true,
            repos: [],
            description: "builds the acme app",
            links: ["https://acme.dev/docs"],
          },
        ]}
      />,
    );
    expect(screen.getByText("builds the acme app")).toBeInTheDocument();
    expect(screen.getByText("https://acme.dev/docs")).toBeInTheDocument();
  });
});
