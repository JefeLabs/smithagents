import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocT } from "../api/types";
import { ArtifactShelf, isSpotlit, shelfDocsFor } from "./ArtifactShelf";

const DOC = (id: string, title: string): DocT => ({
  id,
  title,
  blueprintId: "spec",
  workType: "feature",
  sections: [],
  participants: [],
  status: "drafting",
  createdAt: "t",
  updatedAt: "t",
});

describe("ArtifactShelf", () => {
  afterEach(() => cleanup());

  it("renders nothing when the session has no documents", () => {
    const { container } = render(<ArtifactShelf docs={[]} onOpen={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("stacks a card per document and opens the one pressed", () => {
    const onOpen = vi.fn();
    render(<ArtifactShelf docs={[DOC("d1", "Login spec"), DOC("d2", "Login plan")]} onOpen={onOpen} />);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /login plan/i }));
    expect(onOpen).toHaveBeenCalledWith("d2");
  });

  // The shelf overlays the chat: an unbounded stack would eventually cover it.
  it("renders every document — the shelf scrolls instead of capping", () => {
    const docs = ["a", "b", "c", "d", "e", "f"].map((id, i) => DOC(id, `Doc ${i + 1}`));
    render(<ArtifactShelf docs={docs} onOpen={vi.fn()} />);
    expect(screen.getAllByRole("button")).toHaveLength(6);
    expect(screen.queryByText(/^\+\d+$/)).toBeNull();
    expect(screen.getByRole("button", { name: /doc 6/i })).toBeInTheDocument();
  });

  it("pinned docs carry the marker class; unpinned don't", () => {
    const docs = [{ ...DOC("d1", "Pinned one"), pins: ["acme"] }, DOC("d2", "Plain one")];
    render(<ArtifactShelf docs={docs} onOpen={vi.fn()} />);
    expect(screen.getByRole("button", { name: /pinned one/i }).className).toContain("artifact-shelf__card--pinned");
    expect(screen.getByRole("button", { name: /plain one/i }).className).not.toContain("artifact-shelf__card--pinned");
  });

  it("a revealed slice spotlights the tiles that look associated (Edwin, 2026-08-12)", () => {
    render(
      <ArtifactShelf
        docs={[DOC("d1", "school visits spec"), DOC("d2", "unrelated notes")]}
        onOpen={vi.fn()}
        spotlight={{ name: "school visits", paths: [] }}
      />,
    );
    const cards = document.querySelectorAll(".artifact-shelf__card");
    expect(cards[0]?.className).toContain("artifact-shelf__card--spotlit");
    expect(cards[1]?.className).not.toContain("artifact-shelf__card--spotlit");
  });

  it("isSpotlit: name containment either way, or the title inside an artifact path; never without a spotlight", () => {
    expect(isSpotlit({ title: "school visits spec" }, { name: "school visits", paths: [] })).toBe(true);
    expect(isSpotlit({ title: "tours" }, { name: "school tours plan", paths: [] })).toBe(true);
    expect(isSpotlit({ title: "auth-flow" }, { name: "payments", paths: ["docs/specs/auth-flow.md"] })).toBe(true);
    expect(isSpotlit({ title: "unrelated" }, { name: "payments", paths: ["docs/specs/auth-flow.md"] })).toBe(false);
    expect(isSpotlit({ title: "anything" }, null)).toBe(false);
    expect(isSpotlit({ title: "  " }, { name: "payments", paths: [] })).toBe(false);
  });

  it("shelfDocsFor keeps the session's own artifact order and drops unknown ids", () => {
    const docs = [DOC("d1", "Login spec"), DOC("d2", "Login plan"), DOC("d3", "Old draft")];
    expect(shelfDocsFor({ artifacts: ["d2", "ghost", "d1"] }, docs).map((d) => d.id)).toEqual(["d2", "d1"]);
  });

  it("shelfDocsFor is empty for a null session or one without artifacts", () => {
    expect(shelfDocsFor(null, [DOC("d1", "x")])).toEqual([]);
    expect(shelfDocsFor({}, [DOC("d1", "x")])).toEqual([]);
  });
});
