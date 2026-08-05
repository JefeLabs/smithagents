import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountPanel } from "./AccountPanel";

describe("AccountPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("loads the current profile on open and shows saved-credential state without the secret", async () => {
    const getMe = vi.fn(async () => ({ id: "me", name: "Edwin", hasAtlassianToken: true, hasGithubToken: false }));
    render(<AccountPanel open onClose={() => {}} getMe={getMe} updateMe={vi.fn()} verifyGithubToken={vi.fn()} />);
    await waitFor(() => expect(getMe).toHaveBeenCalled());
    expect(await screen.findByDisplayValue("Edwin")).toBeDefined();
    expect(screen.getByText(/atlassian token saved/i)).toBeDefined();
  });

  it("saving a new GitHub token calls updateMe with it, then Test connection calls verifyGithubToken", async () => {
    const updateMe = vi.fn(async () => ({ id: "me", name: "Edwin", hasAtlassianToken: false, hasGithubToken: true }));
    const verifyGithubToken = vi.fn(async () => ({ ok: true, detail: "Authenticated as edwincruz" }));
    render(
      <AccountPanel
        open
        onClose={() => {}}
        getMe={vi.fn(async () => ({ id: "me", name: "Edwin", hasAtlassianToken: false, hasGithubToken: false }))}
        updateMe={updateMe}
        verifyGithubToken={verifyGithubToken}
      />,
    );
    await screen.findByPlaceholderText("GitHub personal access token");
    await userEvent.type(screen.getByPlaceholderText("GitHub personal access token"), "ghp_test");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(updateMe).toHaveBeenCalledWith(expect.objectContaining({ github: { token: "ghp_test" } })),
    );

    await userEvent.click(await screen.findByRole("button", { name: /test connection/i }));
    await waitFor(() => expect(verifyGithubToken).toHaveBeenCalled());
    expect(await screen.findByText(/authenticated as edwincruz/i)).toBeDefined();
  });
});
