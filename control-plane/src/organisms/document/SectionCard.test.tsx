import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  it("edit mode shows a textarea seeded with the raw body; save passes the new text", () => {
    const onSave = vi.fn();
    render(<SectionCard section={SECTION} editing onEdit={vi.fn()} onCancel={vi.fn()} onSave={onSave} />);
    const box = screen.getByRole("textbox", { name: /what this is/i });
    expect((box as HTMLTextAreaElement).value).toBe("It **does** the thing.");
    fireEvent.change(box, { target: { value: "New text" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith("New text");
  });

  it("cancel discards without saving", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(<SectionCard section={SECTION} editing onEdit={vi.fn()} onCancel={onCancel} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
