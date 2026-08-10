import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SectionCard } from "./SectionCard";

const SECTION = { id: "overview", heading: "What this is", body: "It **does** the thing." };

describe("SectionCard", () => {
  afterEach(() => cleanup());

  it("read mode renders the heading and the body as markdown", () => {
    render(<SectionCard section={SECTION} editing={false} onEdit={vi.fn()} onCancel={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByText("What this is")).toBeTruthy();
    expect(screen.getByText("does").tagName).toBe("STRONG");
  });

  it("an empty body renders the edit affordance, not empty markdown", () => {
    render(
      <SectionCard
        section={{ ...SECTION, body: "" }}
        editing={false}
        onEdit={vi.fn()}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /edit what this is/i })).toBeTruthy();
  });

  it("edit mode renders the body as rich text and commits on blur — no save button", async () => {
    const onSave = vi.fn();
    render(<SectionCard section={SECTION} editing onEdit={vi.fn()} onCancel={vi.fn()} onSave={onSave} />);
    const surface = await screen.findByRole("textbox", { name: /what this is/i });
    // Rendered, not source: the words are there, the asterisks are not.
    expect(surface.textContent).toContain("does");
    expect(surface.textContent).not.toContain("**");
    expect(screen.queryByRole("button", { name: /^save$/i })).toBeNull();
    fireEvent.blur(surface);
    await waitFor(() => expect(onSave).toHaveBeenCalled());
  });

  it("Escape abandons the edit without saving", async () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(<SectionCard section={SECTION} editing onEdit={vi.fn()} onCancel={onCancel} onSave={onSave} />);
    const surface = await screen.findByRole("textbox", { name: /what this is/i });
    fireEvent.keyDown(surface, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
