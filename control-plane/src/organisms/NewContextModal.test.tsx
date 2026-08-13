import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRecord } from "../api/types";
import { WORKSPACE_PALETTE } from "../lib/workspace-color";
import { NewContextModal } from "./NewContextModal";

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
    saveGroup: vi.fn(async () => ({})),
    workspaces: ["acme", "widgets"],
    groups: [{ name: "core" }],
    listMyConnectors: vi.fn(async () => CONNECTORS),
    onCreated: vi.fn(),
    ...overrides,
  };
}

function renderModal(overrides: Record<string, unknown> = {}) {
  return render(<NewContextModal {...props(overrides)} />);
}

/** Advances the wizard by pressing "next" n times. Each press gates on the
    current step being valid, so callers must fill the fields first. */
async function goToStep(n: number) {
  for (let i = 0; i < n; i++) {
    await userEvent.click(screen.getByRole("button", { name: "next" }));
  }
}

/** Fills the currently-visible repo row with valid data and picks the
    "personal" GitHub connector. Assumes the caller is already on Repos. */
async function fillRepoRow() {
  await userEvent.type(screen.getByLabelText("Repo name"), "web");
  await userEvent.type(screen.getByLabelText("Path"), "/Users/me/code/acme-web");
  await userEvent.type(screen.getByLabelText("GitHub owner"), "acme");
  await userEvent.type(screen.getByLabelText("GitHub repo"), "web");
  await userEvent.click(screen.getByRole("button", { name: /github connector/i }));
  await userEvent.click(await screen.findByRole("option", { name: "personal" }));
}

/** Fills Details (name only), advances through Colour untouched, then fills
    one valid repo row — lands on the final step ready to submit. */
async function fillOneValidRepo() {
  await userEvent.type(screen.getByPlaceholderText("acme"), "My App");
  await goToStep(2);
  await fillRepoRow();
}

describe("NewContextModal", () => {
  afterEach(() => {
    cleanup();
  });

  it("connector select lists only github-vendor connectors and offers no pickable empty option", async () => {
    renderModal();
    await userEvent.type(screen.getByPlaceholderText("acme"), "My App");
    await goToStep(2);
    await userEvent.click(screen.getByRole("button", { name: /github connector/i }));
    // Exactly the two github connectors — atl-1 excluded, and no synthetic
    // "none picked" option is ever added to the list (FormSelect renders
    // only what `options` contains; the empty state is the placeholder).
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["personal", "acme-corp"]);
  });

  it("create stays disabled until repo fields and the connector are all present", async () => {
    renderModal();
    // Reaching the Repos step at all requires the name gate on Details —
    // that half of the old title now lives in "starts on Details..." below.
    await userEvent.type(screen.getByPlaceholderText("acme"), "My App");
    await goToStep(2);
    const create = (await screen.findByRole("button", { name: /create workspace/i })) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Repo name"), "web");
    await userEvent.type(screen.getByLabelText("Path"), "/Users/me/code/acme-web");
    await userEvent.type(screen.getByLabelText("GitHub owner"), "acme");
    await userEvent.type(screen.getByLabelText("GitHub repo"), "web");
    expect(create.disabled).toBe(true); // connector still unpicked — the required gate
    await userEvent.click(screen.getByRole("button", { name: /github connector/i }));
    await userEvent.click(await screen.findByRole("option", { name: "personal" }));
    expect(create.disabled).toBe(false);
  });

  it("create posts required connector and hands the server-slugged name to onCreated", async () => {
    const save = vi.fn(async () => ({ name: "my-app" }));
    const onCreated = vi.fn();
    const onClose = vi.fn();
    renderModal({ save, onCreated, onClose });
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
    renderModal({ save });
    // Description and Links live on Details — fill them before leaving the step.
    await userEvent.type(screen.getByPlaceholderText("acme"), "My App");
    await userEvent.type(screen.getByLabelText(/description/i), "Marketing site");
    await userEvent.type(
      screen.getByLabelText(/links/i),
      "https://github.com/acme/web\nhttps://acme.atlassian.net\n\n",
    );
    await goToStep(2);
    await fillRepoRow();
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
    renderModal();
    await screen.findByPlaceholderText("acme");
    expect(screen.queryByText(/execution mode/i)).toBeNull();
    expect(screen.queryByRole("tab", { name: "Local Docker" })).toBeNull();
  });

  it("a save error is shown inline and onCreated never fires", async () => {
    const save = vi.fn(async () => ({ error: 'Repo "web": /nope is not a git repository' }));
    const onCreated = vi.fn();
    renderModal({ save, onCreated });
    await fillOneValidRepo();
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    expect(await screen.findByText(/is not a git repository/)).toBeDefined();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("new-folder mode with a native picker: Browse fills the path and submit carries initGit", async () => {
    const save = vi.fn(async () => ({ name: "fresh" }));
    const pickFolder = vi.fn(async () => "/Users/me/dev/fresh");
    renderModal({ save, pickFolder });
    await userEvent.type(screen.getByPlaceholderText("acme"), "Fresh");
    await goToStep(2);
    await userEvent.click(screen.getByRole("radio", { name: "New folder" }));
    await userEvent.click(await screen.findByRole("button", { name: /browse/i }));
    await waitFor(() => expect((screen.getByLabelText("Path") as HTMLInputElement).value).toBe("/Users/me/dev/fresh"));
    await userEvent.type(screen.getByLabelText("Repo name"), "app");
    await userEvent.type(screen.getByLabelText("GitHub owner"), "me");
    await userEvent.type(screen.getByLabelText("GitHub repo"), "fresh");
    await userEvent.click(screen.getByRole("button", { name: /github connector/i }));
    await userEvent.click(await screen.findByRole("option", { name: "personal" }));
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
    renderModal({ save });
    await fillOneValidRepo();
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const submitted = (save.mock.calls[0]![0] as { repos: Array<Record<string, unknown>> }).repos[0]!;
    expect("initGit" in submitted).toBe(false);
  });

  it("without a native picker the Browse button is absent; a typed path still works in new-folder mode", async () => {
    renderModal();
    // Reaching Repos requires the name gate — the old test skipped this
    // because the segmented control was reachable with no gate at all.
    await userEvent.type(screen.getByPlaceholderText("acme"), "Fresh");
    await goToStep(2);
    await userEvent.click(screen.getByRole("radio", { name: "New folder" }));
    expect(screen.queryByRole("button", { name: /browse/i })).toBeNull();
    await userEvent.type(screen.getByLabelText("Path"), "/Users/me/dev/typed");
    expect((screen.getByLabelText("Path") as HTMLInputElement).value).toBe("/Users/me/dev/typed");
  });

  it("sends the chosen colour with the workspace", async () => {
    const p = props();
    renderModal(p);
    await userEvent.type(screen.getByPlaceholderText("acme"), "My App");
    await goToStep(1); // -> Colour
    await userEvent.click(screen.getByRole("option", { name: "Colour 3" }));
    await goToStep(1); // -> Repos
    await fillRepoRow();
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    await waitFor(() => expect(p.save).toHaveBeenCalled());
    expect((p.save as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      color: WORKSPACE_PALETTE[2],
    });
  });

  it("omits colour entirely when no swatch is picked, so the derived default applies", async () => {
    const p = props();
    renderModal(p);
    await userEvent.type(screen.getByPlaceholderText("acme"), "My App");
    await goToStep(1); // -> Colour
    // The listbox/option pattern marks selection with aria-selected, not
    // aria-checked — .toBeChecked() only recognizes the latter and throws.
    expect(screen.getByRole("option", { name: "No colour" })).toHaveAttribute("aria-selected", "true");
    await goToStep(1); // -> Repos
    await fillRepoRow();
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    await waitFor(() => expect(p.save).toHaveBeenCalled());
    expect((p.save as ReturnType<typeof vi.fn>).mock.calls[0][0].color).toBeUndefined();
  });

  it("the None swatch unpicks a chosen colour", async () => {
    const p = props();
    renderModal(p);
    await userEvent.type(screen.getByPlaceholderText("acme"), "My App");
    await goToStep(1); // -> Colour
    await userEvent.click(screen.getByRole("option", { name: "Colour 3" }));
    await userEvent.click(screen.getByRole("option", { name: "No colour" }));
    expect(screen.getByRole("option", { name: "Colour 3" })).toHaveAttribute("aria-selected", "false");
    await goToStep(1); // -> Repos
    await fillRepoRow();
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    await waitFor(() => expect(p.save).toHaveBeenCalled());
    expect((p.save as ReturnType<typeof vi.fn>).mock.calls[0][0].color).toBeUndefined();
  });

  it("starts on Details with next disabled until the name is filled", async () => {
    renderModal();
    expect(screen.getByRole("button", { name: "next" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Workspace name"), "acme");
    expect(screen.getByRole("button", { name: "next" })).toBeEnabled();
  });

  it("back returns to the previous step without losing what was typed", async () => {
    renderModal();
    await userEvent.type(screen.getByLabelText("Workspace name"), "acme");
    await goToStep(1);
    await userEvent.click(screen.getByRole("button", { name: "back" }));
    expect(screen.getByLabelText("Workspace name")).toHaveValue("acme");
  });

  // `back` uses the native `disabled` attribute (isDisabled -> disabled, not
  // aria-disabled). Landing on step 0 disables the very button that just received
  // focus from the click. In a real browser that blurs it to <body>, escaping the
  // dialog's focus trap and silently killing ESC — caught only by manual smoke
  // against a live browser. jsdom does not model that blur (verified directly: a
  // focused element's activeElement survives `.disabled = true` unchanged), so a
  // test asserting the dialog still *contains* activeElement can never fail here —
  // the disabled button never actually leaves the DOM subtree it started in. Assert
  // the fix's actual mechanism instead: focus moves to the new step's first control.
  // That assertion is false without the fix (nothing moves focus, so it stays on the
  // now-disabled back button) and true with it — confirmed red before green.
  it("back moves focus to the new step's first control, not the now-disabled button", async () => {
    renderModal();
    await userEvent.type(screen.getByLabelText("Workspace name"), "acme");
    await userEvent.click(screen.getByRole("button", { name: "next" }));
    await userEvent.click(screen.getByRole("button", { name: "back" }));
    // The step's FIRST control is now the containment radio (one-context
    // spec 2026-08-13) — the invariant is "focus enters the step", not
    // "focus lands on the name".
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Repositories" }));
  });

  // The submit button exists only on the last step; a stepper that let Enter
  // submit from step 0 would POST a half-filled workspace.
  it("does not offer create until the final step", async () => {
    renderModal();
    expect(screen.queryByRole("button", { name: /create workspace/i })).toBeNull();
  });
});

describe("NewContextModal — the members fork (one-context spec 2026-08-13)", () => {
  it("switching containment to members swaps step 3, hides links, and relabels", async () => {
    renderModal();
    await userEvent.click(screen.getByRole("radio", { name: /workspaces & groups/i }));
    expect(screen.getByLabelText("Group name")).toBeInTheDocument();
    expect(screen.getByLabelText("Links")).not.toBeVisible();
    await userEvent.type(screen.getByLabelText("Group name"), "platform");
    await goToStep(2);
    expect(screen.getByText("Member workspaces")).toBeVisible();
    expect(screen.getByLabelText("Repo name")).not.toBeVisible();
    expect(screen.getByRole("button", { name: "create group" })).toBeInTheDocument();
  });

  it("a group submit posts through saveGroup — never save/onCreated — and create enables despite empty repo rows", async () => {
    const saveGroup = vi.fn(async () => ({}));
    const save = vi.fn(async () => ({ name: "x" }));
    const onCreated = vi.fn();
    const onClose = vi.fn();
    renderModal({ saveGroup, save, onCreated, onClose });
    await userEvent.click(screen.getByRole("radio", { name: /workspaces & groups/i }));
    await userEvent.type(screen.getByLabelText("Group name"), "platform");
    await goToStep(2);
    await userEvent.click(screen.getByRole("checkbox", { name: "acme" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "core" }));
    const create = screen.getByRole("button", { name: "create group" }) as HTMLButtonElement;
    await waitFor(() => expect(create.disabled).toBe(false)); // empty repo rows must not gate
    await userEvent.click(create);
    await waitFor(() => expect(saveGroup).toHaveBeenCalledTimes(1));
    expect(saveGroup.mock.calls[0][0]).toMatchObject({
      name: "platform",
      workspaces: ["acme"],
      groups: ["core"],
    });
    expect(saveGroup.mock.calls[0][1]).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("the sprint half-config refusal fires in group mode too", async () => {
    const saveGroup = vi.fn(async () => ({}));
    renderModal({ saveGroup });
    await userEvent.click(screen.getByRole("radio", { name: /workspaces & groups/i }));
    await userEvent.type(screen.getByLabelText("Group name"), "platform");
    await userEvent.click(screen.getByRole("checkbox", { name: "Sprint Filter" }));
    await goToStep(2);
    await userEvent.click(screen.getByRole("button", { name: "create group" }));
    expect(await screen.findByText(/Sprint Filter needs a start day/)).toBeInTheDocument();
    expect(saveGroup).not.toHaveBeenCalled();
  });
});
