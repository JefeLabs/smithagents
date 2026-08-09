import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { describe, expect, it, vi } from "vitest";
import { STEP_W } from "./layout";
import { ActivityNode, ArtifactNode, type BlankNodeData, nodeTypes, SliceNode, StepNode, StoryNode } from "./nodes";

const STORY = { id: "s1", stepId: "st1", order: 0, text: "create slots", done: false };
const STEP = { id: "st1", name: "Define Tour Schedule", order: 0 };
const ACTIVITY = { id: "act1", name: "Manage Candidate Tours", order: 0, steps: [STEP] };

describe("nodeTypes", () => {
  it("registers all five node types", () => {
    expect(Object.keys(nodeTypes).sort()).toEqual(["activity", "artifact", "slice", "step", "story"]);
  });
});

describe("StoryNode", () => {
  const data = {
    story: STORY,
    sliceOptions: [{ id: "sl1", name: "v1", order: 0, storyIds: [] }],
    sliceValue: "backlog",
    onSliceChange: vi.fn(),
    onRemove: vi.fn(),
    dimmed: false,
  };

  it("renders the drag handle carrying the story text", () => {
    const { container } = render(<StoryNode data={data} />);
    const handle = container.querySelector(".map-story__handle");
    expect(handle?.textContent).toBe("create slots");
  });

  it("marks the interactive controls nodrag so xyflow does not steal their pointer", () => {
    const { container } = render(<StoryNode data={data} />);
    expect(container.querySelector("select")?.classList.contains("nodrag")).toBe(true);
    expect(container.querySelector("button")?.classList.contains("nodrag")).toBe(true);
    // The handle is the ONE thing that must not be nodrag — it is the drag target.
    expect(container.querySelector(".map-story__handle")?.classList.contains("nodrag")).toBe(false);
  });

  it("calls onSliceChange when the slice select changes", async () => {
    const onSliceChange = vi.fn();
    render(<StoryNode data={{ ...data, onSliceChange }} />);
    await userEvent.selectOptions(screen.getByLabelText("Slice for create slots"), "sl1");
    expect(onSliceChange).toHaveBeenCalledWith("sl1");
  });
});

describe("StepNode", () => {
  const data = { step: STEP, activity: ACTIVITY, storyCount: 0, onRemove: vi.fn(), dimmed: false };

  it("renders the step name and removes on click", async () => {
    const onRemove = vi.fn();
    render(<StepNode data={{ ...data, onRemove }} />);
    expect(screen.getByText("Define Tour Schedule")).toBeTruthy();
    await userEvent.click(screen.getByLabelText("Remove step: Define Tour Schedule"));
    expect(onRemove).toHaveBeenCalled();
  });

  it("blocks removal while the step still has stories", () => {
    render(<StepNode data={{ ...data, storyCount: 2 }} />);
    expect(screen.getByLabelText("Remove step: Define Tour Schedule")).toBeDisabled();
  });
});

describe("ActivityNode", () => {
  const data = { activity: ACTIVITY, onRemove: vi.fn(), dimmed: false };

  it("applies the width the layout computed rather than assuming one column", () => {
    // The span an activity covers depends on its step count, which the node cannot
    // see — layoutMap computes it and xyflow passes it down. Assuming STEP_W here
    // would collapse every activity onto its first step.
    const { container } = render(<ActivityNode width={2 * STEP_W + 8} data={data} />);
    expect(container.querySelector<HTMLElement>(".map-activity__name")?.style.width).toBe("368px");
  });

  it("blocks removal while the activity still has steps", () => {
    render(<ActivityNode width={STEP_W} data={data} />);
    expect(screen.getByLabelText("Remove activity: Manage Candidate Tours")).toBeDisabled();
  });

  // The pair matters: without an enabled case, `disabled={activity.steps.length > 0}`
  // passes just as well hardcoded to true.
  it("removes on click once the activity has no steps left", async () => {
    const onRemove = vi.fn();
    render(<ActivityNode width={STEP_W} data={{ ...data, activity: { ...ACTIVITY, steps: [] }, onRemove }} />);
    const button = screen.getByLabelText("Remove activity: Manage Candidate Tours");
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(onRemove).toHaveBeenCalled();
  });
});

/**
 * The trailing card at every level. These three cases are the whole of Edwin's
 * blank-card ruling — the card IS the composer, so there is no separate "add"
 * control on the map and the affordance must survive at each level identically.
 */
const BLANK_LEVELS: Array<{
  level: string;
  Node: ComponentType<{ data: BlankNodeData }>;
  placeholder: string;
  card: string;
}> = [
  { level: "activity", Node: ActivityNode, placeholder: "Add an activity…", card: ".map-activity__name" },
  { level: "step", Node: StepNode, placeholder: "Add a step…", card: ".map-step__name" },
  { level: "story", Node: StoryNode, placeholder: "Add a story…", card: ".map-story" },
];

describe.each(BLANK_LEVELS)("blank $level card", ({ Node, placeholder, card }) => {
  it("renders an input in place of the card's text", () => {
    const { container } = render(<Node data={{ blank: true, onCommit: vi.fn() }} />);
    expect(screen.getByPlaceholderText(placeholder)).toBeTruthy();
    expect(container.querySelector(card)?.classList.contains("is-blank")).toBe(true);
  });

  it("marks that input BOTH nodrag and nopan — they gate different gestures", () => {
    render(<Node data={{ blank: true, onCommit: vi.fn() }} />);
    const input = screen.getByPlaceholderText(placeholder);
    expect(input.classList.contains("nodrag")).toBe(true);
    // `nopan` is the one that matters here, and it was missing until Task 4 mounted
    // the canvas and could measure it. xyflow's zoom filter tests noPanClassName and
    // never looks at nodrag, so without this the pane's d3-zoom gesture claims the
    // pointerdown and dragging to select text pans the map. Losing it also puts an
    // unhandled d3 error into the suite, which fails the run while every test passes.
    expect(input.classList.contains("nopan")).toBe(true);
  });

  it("commits the trimmed text on Enter and clears itself for the next one", async () => {
    const onCommit = vi.fn();
    render(<Node data={{ blank: true, onCommit }} />);
    const input = screen.getByPlaceholderText(placeholder);
    await userEvent.type(input, "  Manage tours  {Enter}");
    expect(onCommit).toHaveBeenCalledWith("Manage tours");
    expect(input).toHaveValue("");
  });
});

describe("blank cards, at the story level", () => {
  it("commits on blur with text, so a click away is not a lost edit", async () => {
    const onCommit = vi.fn();
    render(<StoryNode data={{ blank: true, onCommit }} />);
    await userEvent.type(screen.getByPlaceholderText("Add a story…"), "edit tour slots");
    await userEvent.tab();
    expect(onCommit).toHaveBeenCalledWith("edit tour slots");
  });

  it("creates nothing when Enter is pressed on an empty card", async () => {
    const onCommit = vi.fn();
    render(<StoryNode data={{ blank: true, onCommit }} />);
    await userEvent.type(screen.getByPlaceholderText("Add a story…"), "   {Enter}");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("creates nothing when an empty card is blurred", async () => {
    const onCommit = vi.fn();
    render(<StoryNode data={{ blank: true, onCommit }} />);
    await userEvent.click(screen.getByPlaceholderText("Add a story…"));
    await userEvent.tab();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe("SliceNode", () => {
  it("is read-only: name and fraction, no controls", () => {
    const { container } = render(<SliceNode data={{ name: "tour scheduling v1", fraction: "1/2" }} />);
    expect(screen.getByText("tour scheduling v1")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
  });
});

describe("ArtifactNode", () => {
  it("renders its label and kind", () => {
    render(<ArtifactNode data={{ kind: "spec", label: "x.md" }} />);
    expect(screen.getByText("x.md")).toBeTruthy();
    expect(screen.getByText("spec")).toBeTruthy();
  });
});
