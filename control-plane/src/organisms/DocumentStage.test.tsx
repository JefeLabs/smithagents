import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  it("renders the title and every section (document-only; chat is the shell's)", () => {
    render(<DocumentStage doc={DOC} onSaveSection={vi.fn()} />);
    expect(screen.getByRole("region", { name: "Document" })).toBeInTheDocument();
    expect(screen.getByText("Login spec")).toBeTruthy();
    expect(screen.getByText("What this is")).toBeTruthy();
    expect(screen.getByText("Non-goals")).toBeTruthy();
  });

  it("one section edits at a time and save round-trips", async () => {
    const onSaveSection = vi.fn().mockResolvedValue({});
    render(<DocumentStage doc={DOC} onSaveSection={onSaveSection} />);
    fireEvent.click(screen.getByRole("button", { name: /edit what this is/i }));
    // entering one section's edit mode leaves the other read-only
    expect(screen.queryByRole("button", { name: /edit what this is/i })).toBeNull();
    expect(screen.getByRole("button", { name: /edit non-goals/i })).toBeTruthy();
    // The editing surface is a contenteditable, so typing is not simulated here
    // (SectionEditor's own tests cover the editor); what this test owns is that
    // blur commits THIS section's id and leaves edit mode.
    const surface = await screen.findByRole("textbox", { name: /what this is/i });
    fireEvent.blur(surface); // blur commits — a document has no save button
    await waitFor(() => expect(onSaveSection).toHaveBeenCalledWith("overview", expect.any(String)));
    // back to read mode after a successful save
    await screen.findByRole("button", { name: /edit what this is/i });
  });

  it("a failed save keeps edit mode and shows the error", async () => {
    const onSaveSection = vi.fn().mockResolvedValue({ error: "broker unreachable" });
    render(<DocumentStage doc={DOC} onSaveSection={onSaveSection} />);
    fireEvent.click(screen.getByRole("button", { name: /edit non-goals/i }));
    const surface = await screen.findByRole("textbox", { name: /non-goals/i });
    fireEvent.blur(surface);
    expect(await screen.findByText(/broker unreachable/)).toBeTruthy();
    // Still editing: a failed save must not throw the author back to read mode.
    expect(screen.getByRole("textbox", { name: /non-goals/i })).toBeTruthy();
  });
  const BPS = [
    { id: "spec", name: "Design Spec", family: "document" as const, workTypes: ["feature"] },
    { id: "implementation-plan", name: "Implementation Plan", family: "document" as const, workTypes: ["feature"] },
  ];

  it("the type switch re-casts an empty document", async () => {
    const onChangeBlueprint = vi.fn().mockResolvedValue({});
    const empty = { ...DOC, sections: DOC.sections.map((s) => ({ ...s, body: "" })) };
    render(
      <DocumentStage doc={empty} onSaveSection={vi.fn()} blueprints={BPS} onChangeBlueprint={onChangeBlueprint} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /implementation plan/i }));
    await waitFor(() => expect(onChangeBlueprint).toHaveBeenCalledWith("implementation-plan"));
  });

  // The blueprints share no section ids — re-casting written work would destroy it.
  it("the type switch locks once the document has content", () => {
    const onChangeBlueprint = vi.fn();
    render(<DocumentStage doc={DOC} onSaveSection={vi.fn()} blueprints={BPS} onChangeBlueprint={onChangeBlueprint} />);
    const other = screen.getByRole("button", { name: /implementation plan/i });
    expect(other).toBeDisabled();
    fireEvent.click(other);
    expect(onChangeBlueprint).not.toHaveBeenCalled();
  });

  it("renders the shelf slot inside the stage when provided", () => {
    render(<DocumentStage doc={DOC} onSaveSection={vi.fn()} shelf={<aside aria-label="session documents" />} />);
    expect(screen.getByRole("complementary", { name: "session documents" })).toBeTruthy();
  });

  it("open proposals render as sticky notes under their section; decided ones don't; accept/dismiss call through", async () => {
    const onAcceptProposal = vi.fn().mockResolvedValue(null);
    const onRejectProposal = vi.fn().mockResolvedValue(null);
    const doc: DocT = {
      ...DOC,
      proposals: [
        {
          id: "p1",
          sectionId: DOC.sections[0].id,
          agentId: "Osvaldo",
          newBody: "A tighter overview.",
          rationale: "shorter",
          state: "open",
          createdAt: "t",
        },
        {
          id: "p2",
          sectionId: DOC.sections[0].id,
          agentId: "Beta",
          newBody: "x",
          rationale: "r",
          state: "rejected",
          createdAt: "t",
        },
      ],
    };
    render(
      <DocumentStage
        doc={doc}
        onSaveSection={vi.fn()}
        onAcceptProposal={onAcceptProposal}
        onRejectProposal={onRejectProposal}
      />,
    );
    const note = screen.getByRole("note", { name: /suggestion from Osvaldo/i });
    expect(note).toHaveTextContent("shorter");
    expect(note).toHaveTextContent(/tighter overview/i);
    expect(screen.queryByRole("note", { name: /suggestion from Beta/i })).toBeNull(); // decided
    fireEvent.click(within(note).getByRole("button", { name: "Accept" }));
    expect(onAcceptProposal).toHaveBeenCalledWith("p1");
    fireEvent.click(within(note).getByRole("button", { name: "Dismiss" }));
    expect(onRejectProposal).toHaveBeenCalledWith("p1");
  });

  it("aim buttons render per section and report id + heading; absent when unwired", () => {
    const onAimSection = vi.fn();
    render(<DocumentStage doc={DOC} onSaveSection={vi.fn()} onAimSection={onAimSection} />);
    fireEvent.click(screen.getByRole("button", { name: `Target ${DOC.sections[0].heading}` }));
    expect(onAimSection).toHaveBeenCalledWith(DOC.sections[0].id, DOC.sections[0].heading);
    cleanup();
    render(<DocumentStage doc={DOC} onSaveSection={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /^Target / })).toBeNull();
  });
});
