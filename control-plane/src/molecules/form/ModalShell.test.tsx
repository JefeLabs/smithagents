import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModalShell } from "./ModalShell";

describe("ModalShell", () => {
  it("renders nothing when closed", () => {
    render(
      <ModalShell open={false} onClose={vi.fn()} title="New workspace">
        <p>body</p>
      </ModalShell>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("exposes an accessible dialog named by its title when open", () => {
    render(
      <ModalShell open onClose={vi.fn()} title="New workspace">
        <p>body</p>
      </ModalShell>,
    );
    expect(screen.getByRole("dialog", { name: "New workspace" })).toBeDefined();
  });

  // Capability the hand-rolled scrim never had. Worth a test because it is the
  // stated reason for adopting the library at all.
  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(
      <ModalShell open onClose={onClose} title="New workspace">
        <p>body</p>
      </ModalShell>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes when the backdrop is clicked", async () => {
    const onClose = vi.fn();
    render(
      <ModalShell open onClose={onClose} title="New workspace">
        <p>body</p>
      </ModalShell>,
    );
    // The one class-based query in this suite: `dialog`'s parentElement is
    // `Modal.Container`, not the backdrop itself, and the backdrop has no
    // accessible role of its own to query by.
    const backdrop = document.querySelector(".modal__backdrop") as HTMLElement;
    await userEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });
});
