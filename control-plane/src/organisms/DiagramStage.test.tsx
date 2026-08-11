import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../molecules/MermaidBlock", () => ({
  MermaidBlock: ({ code }: { code: string }) => <div data-testid="mermaid">{code}</div>,
}));

import { DiagramStage } from "./DiagramStage";

const DOC = {
  id: "d1",
  title: "ER",
  blueprintId: "er",
  workType: "feature",
  status: "drafting" as const,
  participants: [],
  createdAt: "",
  updatedAt: "",
  artifacts: [],
  sections: [{ id: "diagram", heading: "Diagram", body: "erDiagram\n A ||--o{ B : has" }],
};
const BPS = [
  { id: "er", name: "Database design", family: "diagram" as const, workTypes: ["feature"] },
  { id: "sequence", name: "Sequence diagram", family: "diagram" as const, workTypes: ["feature"] },
];
afterEach(() => vi.clearAllMocks());

describe("DiagramStage", () => {
  it("renders the section body through MermaidBlock", () => {
    render(<DiagramStage doc={DOC} blueprints={BPS} onSaveSection={vi.fn().mockResolvedValue({})} />);
    expect(screen.getByTestId("mermaid")).toHaveTextContent("erDiagram");
  });
  it("editing the source saves the section body", async () => {
    const onSave = vi.fn().mockResolvedValue({});
    render(<DiagramStage doc={DOC} blueprints={BPS} onSaveSection={onSave} />);
    const src = screen.getByRole("textbox", { name: /mermaid source/i });
    await userEvent.clear(src);
    await userEvent.type(src, "sequenceDiagram");
    await userEvent.tab(); // blur commits
    expect(onSave).toHaveBeenCalledWith("diagram", "sequenceDiagram");
  });
  it("the type switch lists only diagram blueprints", () => {
    render(<DiagramStage doc={DOC} blueprints={BPS} onChangeBlueprint={vi.fn()} onSaveSection={vi.fn()} />);
    const group = screen.getByRole("group", { name: /diagram type/i });
    expect(within(group).getByRole("button", { name: "Database design" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Sequence diagram" })).toBeInTheDocument();
  });
});
