import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewWorkspaceModal } from "./NewWorkspaceModal";

const CONNECTORS = [
  { id: "gh-1", vendorId: "github", label: "personal", fields: {} },
  { id: "gh-2", vendorId: "github", label: "acme-corp", fields: {} },
  { id: "atl-1", vendorId: "atlassian", label: "personal", fields: {} },
];

function props(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    save: vi.fn(async () => ({ name: "acme" })),
    list: vi.fn(async () => []),
    listMyConnectors: vi.fn(async () => CONNECTORS),
    onCreated: vi.fn(),
    ...overrides,
  };
}

async function fillOneValidRepo() {
  await userEvent.type(screen.getByPlaceholderText("acme"), "My App");
  await userEvent.type(screen.getByPlaceholderText("web"), "web");
  await userEvent.type(screen.getByPlaceholderText(/acme-web/), "/Users/me/code/acme-web");
  await userEvent.type(screen.getByPlaceholderText("GitHub owner"), "acme");
  await userEvent.type(screen.getByPlaceholderText("GitHub repo"), "web");
  await userEvent.selectOptions(await screen.findByLabelText(/github connector/i), "gh-1");
}

describe("NewWorkspaceModal", () => {
  afterEach(() => {
    cleanup();
  });

  it("connector select lists only github-vendor connectors and offers no pickable empty option", async () => {
    render(<NewWorkspaceModal {...props()} />);
    const select = await screen.findByLabelText(/github connector/i);
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toContain("personal");
    expect(options).toContain("acme-corp");
    expect(options).not.toContain("— none picked —");
    expect(select.querySelector<HTMLOptionElement>('option[value=""]')?.disabled).toBe(true);
  });

  it("create stays disabled until name, repo fields, and the connector are all present", async () => {
    render(<NewWorkspaceModal {...props()} />);
    const create = (await screen.findByRole("button", { name: /create workspace/i })) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await userEvent.type(screen.getByPlaceholderText("acme"), "My App");
    await userEvent.type(screen.getByPlaceholderText("web"), "web");
    await userEvent.type(screen.getByPlaceholderText(/acme-web/), "/Users/me/code/acme-web");
    await userEvent.type(screen.getByPlaceholderText("GitHub owner"), "acme");
    await userEvent.type(screen.getByPlaceholderText("GitHub repo"), "web");
    expect(create.disabled).toBe(true); // connector still unpicked — the required gate
    await userEvent.selectOptions(await screen.findByLabelText(/github connector/i), "gh-1");
    expect(create.disabled).toBe(false);
  });

  it("create posts runtime + required connector and hands the server-slugged name to onCreated", async () => {
    const save = vi.fn(async () => ({ name: "my-app" }));
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<NewWorkspaceModal {...props({ save, onCreated, onClose })} />);
    await fillOneValidRepo();
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "My App",
          runtime: "tmux",
          repos: [
            expect.objectContaining({
              name: "web",
              path: "/Users/me/code/acme-web",
              github: expect.objectContaining({ owner: "acme", repo: "web", connectorId: "gh-1" }),
            }),
          ],
        }),
        true,
      ),
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("my-app"));
    expect(onClose).toHaveBeenCalled();
  });

  it("defaults execution mode to the active workspace's runtime", async () => {
    const list = vi.fn(async () => [{ name: "acme", default: true, repos: [], runtime: "docker" }]);
    render(<NewWorkspaceModal {...props({ list, activeWorkspace: "acme" })} />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    const dockerTab = await screen.findByRole("tab", { name: "Local Docker" });
    await waitFor(() => expect(dockerTab.getAttribute("aria-selected")).toBe("true"));
  });

  it("a save error is shown inline and onCreated never fires", async () => {
    const save = vi.fn(async () => ({ error: 'Repo "web": /nope is not a git repository' }));
    const onCreated = vi.fn();
    render(<NewWorkspaceModal {...props({ save, onCreated })} />);
    await fillOneValidRepo();
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    expect(await screen.findByText(/is not a git repository/)).toBeDefined();
    expect(onCreated).not.toHaveBeenCalled();
  });
});
