import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SectionEditor } from "./SectionEditor";

describe("SectionEditor", () => {
  afterEach(() => cleanup());

  it("shows the section's markdown as rendered text, not as source", async () => {
    render(
      <SectionEditor body="It **does** the thing." ariaLabel="What this is" onCommit={vi.fn()} onAbandon={vi.fn()} />,
    );
    // The words survive; the asterisks do not — that is the whole point.
    const surface = await screen.findByRole("textbox", { name: "What this is" });
    expect(surface.textContent).toContain("does");
    expect(surface.textContent).not.toContain("**");
  });

  it("blur commits markdown", async () => {
    const onCommit = vi.fn();
    render(<SectionEditor body="Words." ariaLabel="What this is" onCommit={onCommit} onAbandon={vi.fn()} />);
    const surface = await screen.findByRole("textbox", { name: "What this is" });
    fireEvent.blur(surface);
    await waitFor(() => expect(onCommit).toHaveBeenCalled());
    expect(typeof onCommit.mock.calls[0][0]).toBe("string");
  });

  it("Escape abandons without committing", async () => {
    const onCommit = vi.fn();
    const onAbandon = vi.fn();
    render(<SectionEditor body="Words." ariaLabel="What this is" onCommit={onCommit} onAbandon={onAbandon} />);
    const surface = await screen.findByRole("textbox", { name: "What this is" });
    fireEvent.keyDown(surface, { key: "Escape" });
    expect(onAbandon).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
