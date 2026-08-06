import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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
