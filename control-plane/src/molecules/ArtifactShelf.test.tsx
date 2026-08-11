import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocT } from "../api/types";
import { ArtifactShelf, shelfDocsFor } from "./ArtifactShelf";

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
  it("caps the stack and counts the rest", () => {
    const docs = ["a", "b", "c", "d", "e", "f"].map((id, i) => DOC(id, `Doc ${i + 1}`));
    render(<ArtifactShelf docs={docs} onOpen={vi.fn()} />);
    expect(screen.getAllByRole("button")).toHaveLength(4);
    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /doc 5/i })).toBeNull();
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
