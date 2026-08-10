import { render } from "@testing-library/react";
import { ReactFlow } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { nodeTypes } from "./nodeTypes";

describe("nodeTypes", () => {
  it("registers all five node types", () => {
    expect(Object.keys(nodeTypes).sort()).toEqual(["activity", "artifact", "slice", "step", "story"]);
  });
});

/**
 * The regression these guard is invisible by construction. An edge whose endpoint has
 * no handle is not an error anywhere: `getEdgePosition` returns null, xyflow draws no
 * path and logs a console WARNING, and the page still reports zero errors. The whole
 * reveal shipped its edge set to `<ReactFlow>` and drew nothing.
 *
 * jsdom lays nothing out, so there is no point asserting where an edge goes — but
 * whether the handle EXISTS in the node's DOM needs no layout, and that is precisely
 * what was missing.
 */
describe("every node level anchors an edge", () => {
  const DATA: Record<string, Record<string, unknown>> = {
    activity: { activity: { id: "a1", name: "Manage Tours", order: 0, steps: [] }, onRemove: () => {}, dimmed: false },
    step: {
      step: { id: "st1", name: "Define Schedule", order: 0 },
      activity: { id: "a1", name: "Manage Tours", order: 0, steps: [] },
      storyCount: 0,
      onRemove: () => {},
      dimmed: false,
    },
    story: {
      story: { id: "s1", stepId: "st1", order: 0, text: "create slots", done: false },
      sliceOptions: [],
      sliceValue: "backlog",
      onSliceChange: () => {},
      onRemove: () => {},
      dimmed: false,
    },
    slice: { name: "tour scheduling v1", fraction: "1/2" },
    artifact: { kind: "spec", label: "docs/x.md" },
  };

  it.each(Object.keys(DATA))("%s carries both a source and a target handle", (type) => {
    const { container } = render(
      <ReactFlow
        nodes={[{ id: "n1", type, position: { x: 0, y: 0 }, data: DATA[type] }]}
        edges={[]}
        nodeTypes={nodeTypes}
      />,
    );
    const node = container.querySelector(".react-flow__node");
    expect(node).not.toBeNull();
    // `.source` / `.target` are the class names xyflow's own getHandleBounds queries
    // for — asserting the BEM class instead would pass while the measurement it feeds
    // still found nothing.
    expect(node?.querySelector(".react-flow__handle.source")).not.toBeNull();
    expect(node?.querySelector(".react-flow__handle.target")).not.toBeNull();
  });

  it("keeps the card itself rendering — the handles wrap it, they do not replace it", () => {
    const { container, getByText } = render(
      <ReactFlow
        nodes={[{ id: "n1", type: "artifact", position: { x: 0, y: 0 }, data: DATA.artifact }]}
        edges={[]}
        nodeTypes={nodeTypes}
      />,
    );
    expect(getByText("docs/x.md")).toBeTruthy();
    expect(container.querySelector(".map-artifact--spec")).not.toBeNull();
  });
});
