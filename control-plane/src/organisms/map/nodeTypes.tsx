import { Handle, type NodeProps, type NodeTypes, Position } from "@xyflow/react";
import type { ComponentType } from "react";
import { ActivityNode, ArtifactNode, SliceNode, StepNode, StoryNode } from "./nodes";

/**
 * The xyflow adapter for the map's cards — the ONLY module that knows both the pure
 * components in `nodes.tsx` and `@xyflow/react`.
 *
 * It exists because an edge needs somewhere to land. xyflow resolves an endpoint by
 * measuring a `<Handle>` in the node's own DOM: with none, `getEdgePosition` returns
 * null, the path is never drawn, and the only trace is a console WARNING (error008) on
 * a page that still reports zero errors. So the whole reveal computed its edge set,
 * handed it to `<ReactFlow>`, and silently drew nothing.
 *
 * The handle could not go in `nodes.tsx`. `Handle` calls `useStoreApi` and `useStore`,
 * which throw outside a ReactFlow provider — that would cost every plain
 * `render(<StoryNode …>)` in nodes.test.tsx, and with them the property Tasks 2-4 paid
 * for: the cards render, and are asserted, without the canvas. Wrapping here keeps
 * that intact. `nodes.tsx` still imports nothing from xyflow.
 *
 * NOT the node-object `handles` field, which looks like the no-DOM answer and is not:
 * `parseHandles` honours it, then the ResizeObserver pass overwrites
 * `internals.handleBounds` with DOM-derived values, and `getHandleBounds` returns null
 * when the element has no `.source`/`.target` descendant. It works until the node is
 * first measured — the worst possible failure shape.
 */

/**
 * Invisible, not absent. The bounds are what xyflow MEASURES, so the handle has to keep
 * its box, and `opacity` is the one property that hides it without moving it.
 *
 * `display: none` is the trap, and not for the obvious reason. It does NOT reproduce the
 * missing-handle bug: `querySelectorAll` is not display-aware, so `getHandleBounds` still
 * finds the element, takes a 0x0 rect at the viewport origin, and returns bounds. No
 * error008 is logged at all. Measured: seven edges still render, every path carries
 * geometry, and every one starts from a coordinate with no relation to its node — they
 * draw, and they drift as you pan. That is QUIETER than the original failure, which at
 * least announced itself in the console.
 *
 * Inline rather than a rule in components.css — but not because a rule would lose. A
 * cascade layer is only outranked on the properties the unlayered rule DECLARES
 * (components.css:184 states this correctly), and xyflow's `.react-flow__handle` sets
 * position, pointer-events, size, background, border and radius — no `opacity`. A
 * `layer(legacy)` rule would have applied unopposed. Inline is still preferred: it keeps
 * the concealment beside the handle that needs it, where the next person to touch this
 * adapter will see it, instead of in a stylesheet 3,000 lines away whose safety depends
 * on xyflow never adding an `opacity` of its own.
 *
 * Module scope: a fresh object identity every render would defeat memoization.
 */
const HIDDEN = { opacity: 0 } as const;

/**
 * Left target, right source, on every level. Uniform rather than per-level, because
 * only slices currently originate an edge and only stories and artifacts receive one —
 * encoding that here would be a second place for the edge model to be stated, and
 * wrong the day a step gets an edge. The handles are inert either way: they carry no
 * pointer events (xyflow's own rule), and `nodesConnectable` is false on the canvas.
 *
 * Left/right rather than top/bottom because the reveal reads horizontally: the anchor
 * sits at SLICE_RAIL_X, left of the grid, and artifacts a column past its right edge.
 */
function withHandles<D>(Card: ComponentType<{ data: D; width?: number }>): ComponentType<NodeProps> {
  return function NodeWithHandles({ data, width }: NodeProps) {
    return (
      <>
        <Handle type="target" position={Position.Left} isConnectable={false} style={HIDDEN} />
        {/*
          The one cast, and it is now in one place. xyflow types `data` as
          Record<string, unknown> while each card takes a narrower shape — that
          narrowing is exactly what makes the cards testable without xyflow. This used
          to be `nodeTypes as unknown as NodeTypes` at the mount site, which cast away
          the whole map at once; here it is per-level and the export is honestly typed.
        */}
        <Card data={data as D} width={width} />
        <Handle type="source" position={Position.Right} isConnectable={false} style={HIDDEN} />
      </>
    );
  };
}

/**
 * Module scope on purpose. A fresh object identity each render makes xyflow remount
 * every node on every render.
 */
export const nodeTypes: NodeTypes = {
  activity: withHandles(ActivityNode),
  step: withHandles(StepNode),
  story: withHandles(StoryNode),
  slice: withHandles(SliceNode),
  artifact: withHandles(ArtifactNode),
};
