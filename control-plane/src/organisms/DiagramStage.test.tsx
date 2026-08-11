import { fireEvent, render, screen, within } from "@testing-library/react";
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
  it("the canvas view is canvas ONLY — the source lives on the Markdown tab", async () => {
    const onSave = vi.fn().mockResolvedValue({});
    render(<DiagramStage doc={DOC} blueprints={BPS} onSaveSection={onSave} />);
    expect(screen.queryByRole("textbox", { name: /mermaid source/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
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

  it("toggles to an editable markdown view with one-click fenced copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const onSave = vi.fn().mockResolvedValue({});
    render(<DiagramStage doc={DOC} blueprints={BPS} onSaveSection={onSave} />);
    // Canvas is the default: no copy affordance there.
    expect(screen.queryByRole("button", { name: /copy mermaid markdown/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    // Still the editor: typing + blur commits.
    const box = screen.getByRole("textbox", { name: "Mermaid source" });
    fireEvent.change(box, { target: { value: "erDiagram\n  A ||--o{ B : has" } });
    fireEvent.blur(box);
    expect(onSave).toHaveBeenCalledWith(DOC.sections[0].id, "erDiagram\n  A ||--o{ B : has");
    fireEvent.click(screen.getByRole("button", { name: /copy mermaid markdown/i }));
    expect(writeText).toHaveBeenCalledWith("```mermaid\nerDiagram\n  A ||--o{ B : has\n```");
    expect(await screen.findByText("copied")).toBeInTheDocument();
    // Back on Canvas the editor goes away — the canvas stands alone.
    fireEvent.click(screen.getByRole("button", { name: "Canvas" }));
    expect(screen.queryByRole("textbox", { name: "Mermaid source" })).toBeNull();
    expect(screen.getByTestId("mermaid")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("renders the shelf slot inside the stage when provided", () => {
    render(
      <DiagramStage
        doc={DOC}
        blueprints={BPS}
        onSaveSection={vi.fn().mockResolvedValue({})}
        shelf={<aside aria-label="session documents" />}
      />,
    );
    expect(screen.getByRole("complementary", { name: "session documents" })).toBeTruthy();
  });
});
