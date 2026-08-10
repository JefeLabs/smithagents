import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocT } from "../api/types";
import { DocumentStage } from "./DocumentStage";

const DOC: DocT = {
  id: "d1",
  title: "Login spec",
  blueprintId: "spec",
  workType: "feature",
  sections: [
    { id: "overview", heading: "What this is", body: "Words." },
    { id: "non-goals", heading: "Non-goals", body: "" },
  ],
  participants: [],
  status: "drafting",
  createdAt: "t",
  updatedAt: "t",
};

describe("DocumentStage", () => {
  afterEach(() => cleanup());

  it("renders the title, every section, and the docked chat", () => {
    render(<DocumentStage doc={DOC} onSaveSection={vi.fn()} chat={<div data-testid="dock" />} />);
    expect(screen.getByText("Login spec")).toBeTruthy();
    expect(screen.getByText("What this is")).toBeTruthy();
    expect(screen.getByText("Non-goals")).toBeTruthy();
    expect(screen.getByTestId("dock")).toBeTruthy();
  });

  it("one section edits at a time and save round-trips", async () => {
    const onSaveSection = vi.fn().mockResolvedValue({});
    render(<DocumentStage doc={DOC} onSaveSection={onSaveSection} chat={null} />);
    fireEvent.click(screen.getByRole("button", { name: /edit what this is/i }));
    // entering one section's edit mode leaves the other read-only
    expect(screen.queryByRole("button", { name: /edit what this is/i })).toBeNull();
    expect(screen.getByRole("button", { name: /edit non-goals/i })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: /what this is/i }), { target: { value: "New." } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(onSaveSection).toHaveBeenCalledWith("overview", "New."));
    // back to read mode after a successful save
    await screen.findByRole("button", { name: /edit what this is/i });
  });

  it("a failed save keeps edit mode and shows the error", async () => {
    const onSaveSection = vi.fn().mockResolvedValue({ error: "broker unreachable" });
    render(<DocumentStage doc={DOC} onSaveSection={onSaveSection} chat={null} />);
    fireEvent.click(screen.getByRole("button", { name: /edit non-goals/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /non-goals/i }), { target: { value: "Draft kept" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByText(/broker unreachable/)).toBeTruthy();
    expect((screen.getByRole("textbox", { name: /non-goals/i }) as HTMLTextAreaElement).value).toBe("Draft kept");
  });
});
