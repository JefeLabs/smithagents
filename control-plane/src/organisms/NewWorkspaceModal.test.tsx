import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRecord } from "../hooks/useBrokerChat";
import { WORKSPACE_PALETTE } from "../lib/workspace-color";
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

  it("create posts required connector and hands the server-slugged name to onCreated", async () => {
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

  it("submits description and newline-split links", async () => {
    const save = vi.fn(async () => ({ name: "acme" }));
    render(<NewWorkspaceModal {...props({ save })} />);
    await fillOneValidRepo();
    await userEvent.type(screen.getByLabelText(/description/i), "Marketing site");
    await userEvent.type(
      screen.getByLabelText(/links/i),
      "https://github.com/acme/web\nhttps://acme.atlassian.net\n\n",
    );
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Marketing site",
          links: ["https://github.com/acme/web", "https://acme.atlassian.net"],
        }),
        true,
      ),
    );
  });

  it("no execution mode control renders", async () => {
    render(<NewWorkspaceModal {...props()} />);
    await screen.findByPlaceholderText("acme");
    expect(screen.queryByText(/execution mode/i)).toBeNull();
    expect(screen.queryByRole("tab", { name: "Local Docker" })).toBeNull();
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

  it("new-folder mode with a native picker: Browse fills the path and submit carries initGit", async () => {
    const save = vi.fn(async () => ({ name: "fresh" }));
    const pickFolder = vi.fn(async () => "/Users/me/dev/fresh");
    render(<NewWorkspaceModal {...props({ save, pickFolder })} />);
    await userEvent.click(screen.getByRole("tab", { name: "New folder" }));
    await userEvent.click(await screen.findByRole("button", { name: /browse/i }));
    await waitFor(() =>
      expect((screen.getByPlaceholderText(/new-project/) as HTMLInputElement).value).toBe("/Users/me/dev/fresh"),
    );
    await userEvent.type(screen.getByPlaceholderText("acme"), "Fresh");
    await userEvent.type(screen.getByPlaceholderText("web"), "app");
    await userEvent.type(screen.getByPlaceholderText("GitHub owner"), "me");
    await userEvent.type(screen.getByPlaceholderText("GitHub repo"), "fresh");
    await userEvent.selectOptions(await screen.findByLabelText(/github connector/i), "gh-1");
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          repos: [expect.objectContaining({ path: "/Users/me/dev/fresh", initGit: true })],
        }),
        true,
      ),
    );
  });

  it("existing-repo mode never sends initGit", async () => {
    const save = vi.fn(async (_ws: WorkspaceRecord, _isNew: boolean) => ({ name: "acme" }));
    render(<NewWorkspaceModal {...props({ save })} />);
    await fillOneValidRepo();
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    // biome-ignore lint/style/noNonNullAssertion: save was called per waitFor above
    const submitted = (save.mock.calls[0]![0] as { repos: Array<Record<string, unknown>> }).repos[0]!;
    expect("initGit" in submitted).toBe(false);
  });

  it("without a native picker the Browse button is absent; a typed path still works in new-folder mode", async () => {
    render(<NewWorkspaceModal {...props()} />);
    await userEvent.click(screen.getByRole("tab", { name: "New folder" }));
    expect(screen.queryByRole("button", { name: /browse/i })).toBeNull();
    await userEvent.type(screen.getByPlaceholderText(/new-project/), "/Users/me/dev/typed");
    expect((screen.getByPlaceholderText(/new-project/) as HTMLInputElement).value).toBe("/Users/me/dev/typed");
  });

  it("sends the chosen colour with the workspace", async () => {
    const p = props();
    render(<NewWorkspaceModal {...p} />);
    await fillOneValidRepo();
    await userEvent.click(screen.getByLabelText("Colour 3"));
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    await waitFor(() => expect(p.save).toHaveBeenCalled());
    expect((p.save as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      color: WORKSPACE_PALETTE[2],
    });
  });

  it("omits colour entirely when no swatch is picked, so the derived default applies", async () => {
    const p = props();
    render(<NewWorkspaceModal {...p} />);
    await fillOneValidRepo();
    expect((screen.getByLabelText("No colour") as HTMLInputElement).checked).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    await waitFor(() => expect(p.save).toHaveBeenCalled());
    expect((p.save as ReturnType<typeof vi.fn>).mock.calls[0][0].color).toBeUndefined();
  });

  it("the None swatch unpicks a chosen colour", async () => {
    const p = props();
    render(<NewWorkspaceModal {...p} />);
    await fillOneValidRepo();
    await userEvent.click(screen.getByLabelText("Colour 3"));
    await userEvent.click(screen.getByLabelText("No colour"));
    expect((screen.getByLabelText("Colour 3") as HTMLInputElement).checked).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    await waitFor(() => expect(p.save).toHaveBeenCalled());
    expect((p.save as ReturnType<typeof vi.fn>).mock.calls[0][0].color).toBeUndefined();
  });
});
