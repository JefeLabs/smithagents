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
 * SIDES ARE PER LEVEL, and they have to be. An edge leaves the first SOURCE handle of
 * its source node and enters the first TARGET handle of its target node — xyflow picks
 * `bounds[0]` when an edge names no handle id — so the side a level puts its handle on
 * is the direction its edges leave and arrive from. One pair for everything was right
 * only while the anchor sat off to the left of the whole map, where every target was to
 * its right.
 *
 * The anchor now leads a band UNDERNEATH the stories it owns, and it has two families
 * of edge going opposite ways: up to its stories, and sideways along the band to its
 * artifacts. Measured with a right-facing source and left-facing targets — the previous
 * arrangement — an edge to a story sitting directly ABOVE the anchor left the anchor's
 * right edge, looped 284px out and came back to enter the story from the left. Two of
 * those crossed the empty middle of the map.
 *
 * So: the anchor sources from its TOP, stories receive on their BOTTOM, and artifacts
 * receive on their LEFT. That is one handle per node per direction — no edge has to
 * name a handle id, and `MapEdge` needs no new field. Activities and steps keep the
 * old pair; nothing draws an edge to either, and giving them a considered side would
 * state an edge model that does not exist.
 *
 * The handles stay inert throughout: no pointer events (xyflow's own rule), and
 * `nodesConnectable` is false on the canvas.
 */
function withHandles<D>(
  Card: ComponentType<{ data: D; width?: number }>,
  sides: { source: Position; target: Position },
): ComponentType<NodeProps> {
  return function NodeWithHandles({ data, width }: NodeProps) {
    return (
      <>
        <Handle type="target" position={sides.target} isConnectable={false} style={HIDDEN} />
        {/*
          The one cast, and it is now in one place. xyflow types `data` as
          Record<string, unknown> while each card takes a narrower shape — that
          narrowing is exactly what makes the cards testable without xyflow. This used
          to be `nodeTypes as unknown as NodeTypes` at the mount site, which cast away
          the whole map at once; here it is per-level and the export is honestly typed.
        */}
        <Card data={data as D} width={width} />
        <Handle type="source" position={sides.source} isConnectable={false} style={HIDDEN} />
      </>
    );
  };
}

/** The side a level's edges leave from and arrive at — see `withHandles`. */
const SIDEWAYS = { source: Position.Right, target: Position.Left } as const;

/**
 * Module scope on purpose. A fresh object identity each render makes xyflow remount
 * every node on every render.
 */
export const nodeTypes: NodeTypes = {
  activity: withHandles(ActivityNode, SIDEWAYS),
  step: withHandles(StepNode, SIDEWAYS),
  // Receives from the band below it.
  story: withHandles(StoryNode, { source: Position.Right, target: Position.Bottom }),
  // Sources upward to its stories; its artifacts are the ones that reach sideways.
  slice: withHandles(SliceNode, { source: Position.Top, target: Position.Left }),
  artifact: withHandles(ArtifactNode, SIDEWAYS),
};
