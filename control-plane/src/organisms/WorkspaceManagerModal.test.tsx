import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRecord } from "../api/types";
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
    // Re-query inside waitFor rather than holding a reference: the open-effect's reset()
    // regenerates useFieldArray's row keys, so a select captured before the connector
    // roster lands is a detached node that can never gain the options being asserted on.
    await waitFor(() => {
      const repoSelects = screen.getAllByLabelText(/github connector/i);
      expect(repoSelects.length).toBeGreaterThanOrEqual(1);
      const options = Array.from(repoSelects[0]!.querySelectorAll("option")).map((o) => o.textContent);
      expect(options).toEqual(expect.arrayContaining(["acme-corp", "personal"]));
      expect(options).not.toContain("personal (atlassian)"); // no atlassian connector leaks into a github picker
    });
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

  it("save gates on the workspace name plus EVERY repo's name and path — and on nothing else", async () => {
    // canSave moved from a hand-written expression onto RHF's whole-form isValid, so the
    // set of registered rules has to be exactly those three fields per the original: adding
    // a rule to owner/repo/branch/connector would strand the button, dropping one from
    // path/name would let a half-filled repo through.
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
    const create = (await screen.findByRole("button", { name: /create workspace/i })) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await userEvent.type(screen.getByPlaceholderText("acme-web"), "web");
    expect(create.disabled).toBe(true); // repo name + path still blank
    await userEvent.type(screen.getByPlaceholderText("web"), "web");
    expect(create.disabled).toBe(true); // path still blank
    await userEvent.type(screen.getByPlaceholderText(/Users\/me\/code/i), "/tmp/web");
    // Enabled with owner, repo and connector all still empty — those never gated.
    await waitFor(() => expect(create.disabled).toBe(false));

    // A second, empty repo row re-disables it: the rule is every repo, not the first.
    await userEvent.click(screen.getByRole("button", { name: /^\s*repo$/i }));
    await waitFor(() => expect(create.disabled).toBe(true));
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
          // `name` is asserted alongside links because its input is disabled while editing,
          // and a disabled input is exactly the kind of field a form library can quietly drop
          // from the submitted values. Without this the payload could lose its identity and
          // the links assertion would still pass.
          name: "acme",
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

describe("WorkspaceManagerModal — Atlassian key lists", () => {
  afterEach(() => {
    cleanup();
  });

  const TWO_KEYS = {
    name: "acme",
    default: true,
    repos: [],
    atlassian: {
      siteUrl: "https://acme.atlassian.net",
      jiraProjectKeys: ["ACME", "PLATFORM"],
      confluenceSpaceKeys: ["DOCS", "RUNBOOKS"],
    },
  };

  /** Typed so `save.mock.calls[0][0]` is a WorkspaceRecord rather than an untyped tuple. */
  const spySave = () => vi.fn(async (_ws: WorkspaceRecord, _isNew: boolean) => ({}));

  function renderWith(save: ReturnType<typeof spySave>) {
    render(
      <WorkspaceManagerModal
        open
        onClose={() => {}}
        list={vi.fn(async () => [TWO_KEYS])}
        save={save}
        remove={vi.fn()}
        verifyAtlassian={vi.fn()}
        verifyRepoGithub={vi.fn()}
        listMyConnectors={vi.fn(async () => CONNECTORS)}
      />,
    );
  }

  it("an unrelated edit does not truncate a record's 2nd..Nth jira/confluence keys", async () => {
    // Only one input exists per key list, so a flattened form would rebuild these as
    // single-element arrays. PUT /workspaces/:name replaces the whole atlassian block
    // (swarm/src/server.ts:1477), so the dropped entries would be gone from disk
    // permanently, with no error — triggered by an edit that never touched them.
    const save = spySave();
    renderWith(save);
    await userEvent.click(await screen.findByText("acme"));
    await userEvent.type(await screen.findByLabelText(/description/i), "now with a description");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      description: "now with a description",
      atlassian: {
        jiraProjectKeys: ["ACME", "PLATFORM"],
        confluenceSpaceKeys: ["DOCS", "RUNBOOKS"],
      },
    });
  });

  it("editing the visible key replaces only the first entry and keeps the rest", async () => {
    const save = spySave();
    renderWith(save);
    await userEvent.click(await screen.findByText("acme"));
    const jira = await screen.findByPlaceholderText(/jira project key/i);
    expect((jira as HTMLInputElement).value).toBe("ACME"); // the input shows entry 0
    await userEvent.clear(jira);
    await userEvent.type(jira, "RENAMED");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      atlassian: { jiraProjectKeys: ["RENAMED", "PLATFORM"] },
    });
  });

  it("clearing the only key drops the list entirely rather than sending a blank entry", async () => {
    const save = spySave();
    render(
      <WorkspaceManagerModal
        open
        onClose={() => {}}
        list={vi.fn(async () => [
          { ...TWO_KEYS, atlassian: { siteUrl: "https://acme.atlassian.net", jiraProjectKeys: ["ACME"] } },
        ])}
        save={save}
        remove={vi.fn()}
        verifyAtlassian={vi.fn()}
        verifyRepoGithub={vi.fn()}
        listMyConnectors={vi.fn(async () => CONNECTORS)}
      />,
    );
    await userEvent.click(await screen.findByText("acme"));
    await userEvent.clear(await screen.findByPlaceholderText(/jira project key/i));
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]?.[0].atlassian?.jiraProjectKeys).toBeUndefined();
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
