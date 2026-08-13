import { X } from "lucide-react";
import { useState } from "react";
import type { CapActivityT, CapSliceT, CapStoryT } from "../../api/types";

/**
 * The cards the story-map canvas renders. Geometry lives in `layout.ts` and
 * nothing here recomputes it: an activity's width arrives as a prop, and the
 * three pinned heights live in components.css against the constants.
 *
 * This module imports no @xyflow/react. The only thing it owes the canvas is the
 * `nodrag` class, which xyflow reads off the DOM — depending on the package for a
 * string would cost these components their ability to render in a plain test.
 */

/**
 * What every blank card carries. `layoutMap` emits `blank` (blankness is a LAYOUT
 * concern — the model has no draft field) alongside the parent id; MapStage's
 * decorator closes over that parent to build `onCommit`, so the card itself never
 * needs to know which step or activity it belongs to.
 */
export interface BlankNodeData {
  blank: true;
  onCommit: (text: string) => void;
}

/**
 * The trailing card at every level, and the reason there is no "add" control
 * anywhere on the map: the card IS the composer. Typing into it and committing
 * creates the record, after which a fresh blank card appears in the next slot.
 *
 * It holds its own text rather than the stage's form. Node ids are stable across
 * re-seeds (`new:story:<stepId>` is derived, not generated), so React keeps this
 * instance and its text through the re-render every model change causes.
 *
 * EXPORTED, and used off the canvas as well as on it: the capability row in the stage
 * header ends with one of these. It takes its class from the caller and adds `is-blank`,
 * so it carries no assumption about being a node — the `nodrag`/`nopan` classes on its
 * input are inert anywhere xyflow is not reading them. Four levels obey Edwin's rule
 * now, and this is the one implementation of it.
 */
export function BlankCard({
  className,
  placeholder,
  width,
  onCommit,
}: {
  className: string;
  placeholder: string;
  width?: number;
  onCommit: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const commit = () => {
    const value = text.trim();
    // Committing empty is a no-op — Enter or blur on an untouched card leaves it
    // exactly as it was and creates no record.
    if (!value) return;
    setText("");
    onCommit(value);
  };
  return (
    // `pointerEvents` is not decoration and cannot move to the stylesheet. xyflow computes
    // a node wrapper's pointer-events as `isSelectable || isDraggable || <ReactFlow-level
    // mouse handlers>` and writes the answer as an INLINE style; a blank composer is
    // deliberately neither selectable nor draggable, so its wrapper is `none` and
    // everything inside it goes dead — measured, a click at a composer's centre landed on
    // `.react-flow__pane` behind the card and all three creation affordances stopped
    // working. A DESCENDANT setting `auto` is hit-testable again whatever the ancestor
    // says, which a stylesheet rule could also do — except jsdom applies no stylesheets,
    // so the three MapStage tests that type into these inputs would stay red and stop
    // guarding this. Inline is what both the browser and the suite can see.
    <div className={`${className} is-blank`} style={{ width, pointerEvents: "auto" }}>
      <input
        // BOTH classes, and `nopan` is the load-bearing one. They gate different
        // gestures: `nodrag` suppresses the NODE drag, which a blank card never had
        // (layoutMap gives it draggable:false), while `nopan` suppresses the PANE's
        // d3-zoom gesture — and that is the one that competes for a pointerdown in
        // this field. Measured against @xyflow/system 0.0.79, whose zoom filter tests
        // `noPanClassName` and never looks at `nodrag`: without `nopan`, dragging to
        // select text in this input pans the whole canvas instead.
        className="map-blank__input nodrag nopan"
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        onBlur={commit}
      />
    </div>
  );
}

export interface StoryNodeData {
  blank?: false;
  story: CapStoryT;
  sliceOptions: CapSliceT[];
  sliceValue: string;
  onSliceChange: (sliceId: string) => void;
  onRemove: () => void;
  onReveal: () => void;
  /** Commit a point estimate (real-dashboards spec 2026-08-13); undefined clears it. */
  onSetPoints: (points: number | undefined) => void;
  selected: boolean;
  dimmed: boolean;
  /** True while an open slice owns this story — the reveal's positive half. */
  lit?: boolean;
}

/**
 * The points badge with its inline editor — its own component because the
 * edit state is per-story and StoryNode is otherwise stateless. Free small
 * integer (Edwin, 2026-08-13): the input only nudges, the swarm enforces.
 */
function PointsBadge({ story, onSetPoints }: { story: CapStoryT; onSetPoints: (p: number | undefined) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (!editing) {
    return (
      <button
        type="button"
        className="nodrag map-story__points"
        aria-label={`Points for ${story.text}`}
        title="point estimate"
        onClick={() => {
          setDraft(story.points === undefined ? "" : String(story.points));
          setEditing(true);
        }}
      >
        {story.points ?? "—"}
      </button>
    );
  }
  return (
    <input
      className="nodrag map-story__points-input"
      type="number"
      min={0}
      step={1}
      aria-label={`Points for ${story.text}`}
      value={draft}
      // The badge that opened this input has left the DOM — same reasoning as
      // the slice composer's name field.
      // biome-ignore lint/a11y/noAutofocus: focus would otherwise land on body mid-gesture
      autoFocus
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setEditing(false);
          return;
        }
        if (e.key !== "Enter") return;
        const trimmed = draft.trim();
        const parsed = Number.parseInt(trimmed, 10);
        // Blank clears; anything non-numeric or negative just closes without
        // writing — the swarm would refuse it anyway, no point round-tripping.
        onSetPoints(trimmed === "" ? undefined : Number.isInteger(parsed) && parsed >= 0 ? parsed : story.points);
        setEditing(false);
      }}
      onBlur={() => setEditing(false)}
    />
  );
}

/**
 * One story: a title row over a controls row. The handle is the drag target (layout
 * sets `dragHandle: ".map-story__handle"`); the select and remove button carry
 * `nodrag` so xyflow leaves their pointer events alone. The handle deliberately does
 * not.
 *
 * THE CONTROLS ARE WRAPPED, and that wrapper is the whole point of the two-row card.
 * They used to sit on one row beside the title, and a native `<select>` sizes to its
 * widest OPTION rather than its value — measured, it took 123.5px of a 180px card and
 * left the title 12.5px, about two characters, on every story. Moving the controls to
 * their own row is what gives the title the card's full width; the second line is what
 * it does with it.
 *
 * THE TITLE IS ALSO THE SELECT TARGET — clicking it reveals where this story is specced
 * and tracked. It is deliberately the title and not the card: the card contains a
 * `<select>`, and opening a dropdown must not also reveal a chain. Scoping the handler
 * to the title is the same reasoning that puts `nodrag` on the controls, applied to a
 * different gesture, and it costs nothing to state twice because the two mechanisms are
 * unrelated — xyflow reads `nodrag` off the DOM, this is a plain React handler.
 *
 * It doubles as the DRAG handle, which is safe rather than lucky: a drag is a
 * pointerdown plus movement past xyflow's threshold, and a click is one without it, so
 * the browser only fires `click` when no drag happened.
 */
export function StoryNode({ data }: { data: StoryNodeData | BlankNodeData }) {
  if (data.blank) return <BlankCard className="map-story" placeholder="Add a story…" onCommit={data.onCommit} />;
  const { story, sliceOptions, sliceValue, onSliceChange, onRemove, onReveal, onSetPoints, selected, dimmed, lit } =
    data;
  return (
    <div
      className={`map-story${story.done ? " is-done" : ""}${dimmed ? " is-dimmed" : ""}${lit ? " is-lit" : ""}${
        selected ? " is-selected" : ""
      }`}
      title={story.verifiedBy}
    >
      {/* A real <button>, not a span with a handler — the same choice `.slice-band__select`
          made for the other reveal. It costs a CSS reset and buys keyboard access to the
          reveal for free, where a span would have needed role, tabIndex and a key handler
          to reach the same place. It is still the drag handle: xyflow matches
          `dragHandle` against the DOM and does not care what element it finds. */}
      <button
        type="button"
        className="map-story__handle"
        onClick={(e) => {
          // Shift is the add-to-selection modifier, so the title must DECLINE it and let
          // the event reach React Flow. Without this the 44% of the card that reveals
          // would be shift-click-dead, and a user sweeping up a selection would silently
          // open a band instead.
          if (e.shiftKey) return;
          // A plain click reveals and must NOT also change the selection: React Flow
          // selects a node on click, which would clear a selection being assembled every
          // time the user inspected a story. Stopping here is what keeps the two gestures
          // on the same pixels without either eating the other.
          e.stopPropagation();
          onReveal();
        }}
      >
        {story.text}
      </button>
      <div className="map-story__meta">
        <select
          className="nodrag"
          aria-label={`Slice for ${story.text}`}
          value={sliceValue}
          onChange={(e) => onSliceChange(e.target.value)}
        >
          <option value="backlog">backlog</option>
          {sliceOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <PointsBadge story={story} onSetPoints={onSetPoints} />
        <button className="nodrag" type="button" aria-label={`Remove story: ${story.text}`} onClick={onRemove}>
          <X size={10} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

export interface StepNodeData {
  blank?: false;
  step: { id: string; name: string; order: number };
  activity: CapActivityT;
  storyCount: number;
  onRemove: () => void;
  dimmed: boolean;
}

/**
 * A step's head, and only its head: its stories are sibling nodes on the canvas,
 * not children of this card. That is why the card's height is STEP_HEAD_H rather
 * than a whole column's.
 */
export function StepNode({ data }: { data: StepNodeData | BlankNodeData }) {
  if (data.blank) return <BlankCard className="map-step__name" placeholder="Add a step…" onCommit={data.onCommit} />;
  const { step, storyCount, onRemove, dimmed } = data;
  return (
    <div className={`map-step__name${dimmed ? " is-dimmed" : ""}`}>
      <span className="map-card__text" title={step.name}>
        {step.name}
      </span>
      <button
        className="nodrag"
        type="button"
        aria-label={`Remove step: ${step.name}`}
        disabled={storyCount > 0}
        title={storyCount > 0 ? "Remove its stories first" : undefined}
        onClick={onRemove}
      >
        <X size={10} strokeWidth={2} />
      </button>
    </div>
  );
}

export interface ActivityNodeData {
  blank?: false;
  activity: CapActivityT;
  onRemove: () => void;
  dimmed: boolean;
}

/**
 * An activity spans its whole step group plus that group's trailing blank. The span
 * depends on the step count and on STEP_W/STEP_GAP, so `layoutMap` computes it and
 * xyflow hands it down as `width` — deriving it here would put geometry in two
 * places and let them disagree.
 */
export function ActivityNode({ width, data }: { width?: number; data: ActivityNodeData | BlankNodeData }) {
  if (data.blank)
    return (
      <BlankCard className="map-activity__name" placeholder="Add an activity…" width={width} onCommit={data.onCommit} />
    );
  const { activity, onRemove, dimmed } = data;
  return (
    <div className={`map-activity__name${dimmed ? " is-dimmed" : ""}`} style={{ width }}>
      <span className="map-card__text" title={activity.name}>
        {activity.name}
      </span>
      <button
        className="nodrag"
        type="button"
        aria-label={`Remove activity: ${activity.name}`}
        disabled={activity.steps.length > 0}
        title={activity.steps.length > 0 ? "Remove its stories first" : undefined}
        onClick={onRemove}
      >
        <X size={10} strokeWidth={2} />
      </button>
    </div>
  );
}

/**
 * Read-only anchor for a selected slice. The interactive slice band stays in the DOM
 * below the canvas — this exists only so edges have a source endpoint.
 */
export function SliceNode({ data }: { data: { name: string; fraction: string } }) {
  return (
    <div className="map-slice-anchor">
      <span className="map-slice-anchor__name">{data.name}</span>
      <span className="map-slice-anchor__fraction">{data.fraction}</span>
    </div>
  );
}

export function ArtifactNode({ data }: { data: { kind: string; label: string } }) {
  return (
    // Same reason as BlankCard: an artifact is neither selectable nor draggable, so its
    // wrapper carries `pointer-events: none` and the `title` tooltip below never fires.
    <div className={`map-artifact map-artifact--${data.kind}`} style={{ pointerEvents: "auto" }}>
      <span className="map-artifact__kind">{data.kind}</span>
      {/* The label is a PATH, ellipsised into 160px — a 76-character spec path shows
          perhaps a third of itself, and the tail is the part that identifies it. Every
          other truncating card here (.map-story, .map-card__text) carries the same
          hover fallback. */}
      <span className="map-artifact__label" title={data.label}>
        {data.label}
      </span>
    </div>
  );
}

/*
 * `nodeTypes` used to live here and now lives in `nodeTypes.tsx`, which wraps each of
 * these in the `<Handle>` pair xyflow needs to land an edge. It could not stay: `Handle`
 * reads the ReactFlow store, so importing it here would throw in every plain render
 * below — and this module's whole point is that these cards render without the canvas.
 */
