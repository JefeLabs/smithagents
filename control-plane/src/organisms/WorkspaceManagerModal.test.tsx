import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_PALETTE } from "../lib/workspace-color";
import { WorkspaceManagerModal } from "./WorkspaceManagerModal";

const CONNECTORS = [
  { id: "conn-a", vendorId: "atlassian", label: "personal", fields: {} },
  { id: "conn-b", vendorId: "github", label: "acme-corp", fields: {} },
  { id: "conn-c", vendorId: "github", label: "personal", fields: {} },
];

describe("WorkspaceManagerModal — connector pickers", () => {
  afterEach(() => {
    cleanup();
  });

  it("the Atlassian fieldset's connector dropdown lists only atlassian-vendor connectors, by label", async () => {
    render(
      <WorkspaceManagerModal
        open
        onClose={() => {}}
        list={vi.fn(async () => [])}
        save={vi.fn()}
        remove={vi.fn()}
        verifyAtlassian={vi.fn()}
        verifyRepoGithub={vi.fn()}
        listMyConnectors={vi.fn(async () => CONNECTORS)}
      />,
    );
    const atlassianSelect = await screen.findByLabelText(/atlassian connector/i);
    const options = Array.from(atlassianSelect.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toContain("personal");
    expect(options).not.toContain("acme-corp"); // that's a github-vendor connector, must not appear here
  });

  it("each repo row's connector dropdown lists only github-vendor connectors, and two repos can pick different ones", async () => {
    render(
      <WorkspaceManagerModal
        open
        onClose={() => {}}
        list={vi.fn(async () => [])}
        save={vi.fn()}
        remove={vi.fn()}
        verifyAtlassian={vi.fn()}
        verifyRepoGithub={vi.fn()}
        listMyConnectors={vi.fn(async () => CONNECTORS)}
      />,
    );
    const repoSelects = await screen.findAllByLabelText(/github connector/i);
    expect(repoSelects.length).toBeGreaterThanOrEqual(1);
    const options = Array.from(repoSelects[0]!.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(["acme-corp", "personal"]));
    expect(options).not.toContain("personal (atlassian)"); // no atlassian connector leaks into a github picker
  });

  it("picking a connector for a repo and saving includes that repo's connectorId in the saved payload", async () => {
    const save = vi.fn(async () => ({}));
    render(
      <WorkspaceManagerModal
        open
        onClose={() => {}}
        list={vi.fn(async () => [])}
        save={save}
        remove={vi.fn()}
        verifyAtlassian={vi.fn()}
        verifyRepoGithub={vi.fn()}
        listMyConnectors={vi.fn(async () => CONNECTORS)}
      />,
    );
    await userEvent.type(screen.getByPlaceholderText("acme-web"), "web");
    await userEvent.type(screen.getByPlaceholderText("web"), "web");
    await userEvent.type(screen.getByPlaceholderText(/Users\/me\/code/i), "/tmp/web");
    await userEvent.type(screen.getByPlaceholderText("GitHub owner"), "acme");
    await userEvent.type(screen.getByPlaceholderText("GitHub repo"), "web");
    const repoSelect = (await screen.findAllByLabelText(/github connector/i))[0]!;
    await userEvent.selectOptions(repoSelect, "conn-b");
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          repos: [expect.objectContaining({ github: expect.objectContaining({ connectorId: "conn-b" }) })],
        }),
        true,
      ),
    );
  });

  it("editing saves links", async () => {
    const save = vi.fn(async () => ({}));
    const existing = {
      name: "acme",
      default: true,
      repos: [],
      links: ["https://github.com/acme/web"],
    };
    render(
      <WorkspaceManagerModal
        open
        onClose={() => {}}
        list={vi.fn(async () => [existing])}
        save={save}
        remove={vi.fn()}
        verifyAtlassian={vi.fn()}
        verifyRepoGithub={vi.fn()}
        listMyConnectors={vi.fn(async () => CONNECTORS)}
      />,
    );
    await userEvent.click(await screen.findByText("acme"));
    const linksField = (await screen.findByLabelText(/links/i)) as HTMLTextAreaElement;
    expect(linksField.value).toBe("https://github.com/acme/web");
    await userEvent.type(linksField, "\nhttps://acme.atlassian.net");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          links: ["https://github.com/acme/web", "https://acme.atlassian.net"],
        }),
        false,
      ),
    );
  });

  it("editing owner/repo after picking a connector does not wipe the picked connectorId", async () => {
    const save = vi.fn(async () => ({}));
    render(
      <WorkspaceManagerModal
        open
        onClose={() => {}}
        list={vi.fn(async () => [])}
        save={save}
        remove={vi.fn()}
        verifyAtlassian={vi.fn()}
        verifyRepoGithub={vi.fn()}
        listMyConnectors={vi.fn(async () => CONNECTORS)}
      />,
    );
    await userEvent.type(screen.getByPlaceholderText("acme-web"), "web");
    await userEvent.type(screen.getByPlaceholderText("web"), "web");
    await userEvent.type(screen.getByPlaceholderText(/Users\/me\/code/i), "/tmp/web");
    await userEvent.type(screen.getByPlaceholderText("GitHub owner"), "acme");
    await userEvent.type(screen.getByPlaceholderText("GitHub repo"), "web");
    const repoSelect = (await screen.findAllByLabelText(/github connector/i))[0]!;
    await userEvent.selectOptions(repoSelect, "conn-b");
    // Edit owner AFTER the connector is already picked — this must not wipe connectorId.
    await userEvent.type(screen.getByPlaceholderText("GitHub owner"), "2");
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          repos: [
            expect.objectContaining({
              github: expect.objectContaining({ owner: "acme2", connectorId: "conn-b" }),
            }),
          ],
        }),
        true,
      ),
    );
  });
});

describe("WorkspaceManagerModal — colour", () => {
  afterEach(() => {
    cleanup();
  });

  const withColour = (color?: string) => ({
    open: true as const,
    onClose: () => {},
    list: vi.fn(async () => [{ name: "acme", default: true, repos: [], color }]),
    save: vi.fn(async () => ({})),
    remove: vi.fn(),
    verifyAtlassian: vi.fn(),
    verifyRepoGithub: vi.fn(),
    listMyConnectors: vi.fn(async () => CONNECTORS),
  });

  it("seeds the swatch row from the edited workspace's stored colour", async () => {
    const p = withColour(WORKSPACE_PALETTE[2]);
    render(<WorkspaceManagerModal {...p} />);
    await userEvent.click(await screen.findByText("acme"));
    expect((screen.getByLabelText("Colour 3") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("No colour") as HTMLInputElement).checked).toBe(false);
  });

  it("saves a changed colour", async () => {
    const p = withColour(WORKSPACE_PALETTE[2]);
    render(<WorkspaceManagerModal {...p} />);
    await userEvent.click(await screen.findByText("acme"));
    await userEvent.click(screen.getByLabelText("Colour 5"));
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() =>
      expect(p.save).toHaveBeenCalledWith(expect.objectContaining({ color: WORKSPACE_PALETTE[4] }), false),
    );
  });

  it("clears a colour through the None swatch — an empty string, since PUT reads undefined as keep-existing", async () => {
    const p = withColour(WORKSPACE_PALETTE[2]);
    render(<WorkspaceManagerModal {...p} />);
    await userEvent.click(await screen.findByText("acme"));
    await userEvent.click(screen.getByLabelText("No colour"));
    expect((screen.getByLabelText("Colour 3") as HTMLInputElement).checked).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(p.save).toHaveBeenCalledWith(expect.objectContaining({ color: "" }), false));
  });

  it("defaults an uncoloured workspace to None and still sends the clearing empty string", async () => {
    const p = withColour(undefined);
    render(<WorkspaceManagerModal {...p} />);
    await userEvent.click(await screen.findByText("acme"));
    expect((screen.getByLabelText("No colour") as HTMLInputElement).checked).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(p.save).toHaveBeenCalledWith(expect.objectContaining({ color: "" }), false));
  });
});
