import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountPanel } from "./AccountPanel";

describe("AccountPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("loads the current profile on open and shows saved-credential state without the secret", async () => {
    const getMe = vi.fn(async () => ({ id: "me", name: "Edwin", connectors: [] }));
    render(<AccountPanel open onClose={() => {}} getMe={getMe} updateMe={vi.fn()} />);
    await waitFor(() => expect(getMe).toHaveBeenCalled());
    expect(await screen.findByDisplayValue("Edwin")).toBeDefined();
    expect(screen.getByText(/atlassian.*credentials managed in integrations/i)).toBeDefined();
  });

  it("saves the name and shows disabled fields for credentials managed in Integrations", async () => {
    const updateMe = vi.fn(async () => ({ id: "me", name: "Edwin Jr", connectors: [] }));
    render(
      <AccountPanel
        open
        onClose={() => {}}
        getMe={vi.fn(async () => ({ id: "me", name: "Edwin", connectors: [] }))}
        updateMe={updateMe}
      />,
    );
    const nameInput = await screen.findByDisplayValue("Edwin");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Edwin Jr");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(updateMe).toHaveBeenCalledWith({ name: "Edwin Jr" }));
  });
});
