import { Panel } from "@xyflow/react";
import { type ReactNode, useEffect, useState } from "react";
import type { CapSliceT } from "../../api/types";

interface Props {
  slices: CapSliceT[];
  /** Ids of slices owning no exclusive story — grandfathered, marked, not hidden. */
  invalidIds: Set<string>;
  activeSliceId: string | null;
  /** Null on mouse-out. Drives dimming through MapStage's existing decorate seam. */
  onHover: (sliceId: string | null) => void;
  onOpen: (sliceId: string) => void;
  /** Task 5's create control. Rendered below the list, inside the same panel. */
  footer?: ReactNode;
}

/**
 * Slices, floating over the canvas rather than laid out on it.
 *
 * Slices OVERLAP now, so there is no geometry that can show membership: a story
 * in two slices belongs to no single band, and edges from several slices into one
 * node draw a hairball. Hover highlighting sidesteps that — two slices sharing a
 * story are two highlights over the same node, one at a time, no layout conflict.
 *
 * Clicking still opens the band beneath the map. Only one band is open at a time,
 * so a shared story simply appears in whichever slice you opened.
 */
export function SlicePanel({ slices, invalidIds, activeSliceId, onHover, onOpen, footer }: Props) {
  const [open, setOpen] = useState(true);

  // Collapsing UNMOUNTS the list, and an unmounted element fires no onMouseLeave.
  // Without this the map stays dimmed against a slice the user can no longer see,
  // with no way to clear it short of re-expanding and hovering something else.
  //
  // The clear is OUTSIDE the setOpen updater and reads `open` directly. React runs
  // updater functions during the RENDER phase, so calling the parent's setState from
  // inside one is a setState-while-rendering — "Cannot update a component (MapStage)
  // while rendering a different component (SlicePanel)" in the console, and an updater
  // React is free to invoke twice. Both are invisible to jsdom, which is why this
  // survived a green suite. A click is a discrete event, so `open` is current here.
  const toggle = () => {
    if (open) onHover(null);
    setOpen((wasOpen) => !wasOpen);
  };

  return (
    // `nowheel` because the list scrolls. Without it xyflow's zoom handler takes every
    // wheel event over the panel and the canvas zooms while the user is trying to reach
    // a slice further down — the panel would scroll only once it was short enough not to
    // need to.
    <Panel position="top-right" className="slice-panel nowheel">
      <section aria-label="Slices" data-open={open ? "true" : "false"}>
        <header className="slice-panel__head">
          <button
            type="button"
            className="slice-panel__toggle"
            aria-expanded={open}
            aria-label={open ? "Collapse slices" : "Expand slices"}
            onClick={toggle}
          >
            <span className="slice-panel__title">Slices</span>
            <span className="slice-panel__total">{slices.length}</span>
            <span className="slice-panel__chevron" aria-hidden="true">
              {open ? "▾" : "▸"}
            </span>
          </button>
        </header>
        {!open ? null : (
          <ul className="slice-panel__list" onMouseLeave={() => onHover(null)}>
            {slices.map((slice) => (
              <li
                key={slice.id}
                data-invalid={invalidIds.has(slice.id) ? "true" : undefined}
                className={slice.id === activeSliceId ? "is-open" : undefined}
              >
                <button
                  type="button"
                  onMouseEnter={() => onHover(slice.id)}
                  onFocus={() => onHover(slice.id)}
                  onClick={() => onOpen(slice.id)}
                >
                  <span className="slice-panel__name">{slice.name}</span>
                  <span className="slice-panel__count">{slice.storyIds.length}</span>
                  {invalidIds.has(slice.id) && (
                    <span
                      className="slice-panel__warn"
                      title="Every story here belongs to another slice too. Give it one of its own."
                    >
                      ⚠
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {/* OUTSIDE the collapsed branch on purpose. A user who selects three stories with
            the panel shut has a live selection, one way to act on it, and — if this lived
            inside — nothing on screen. The composer is about the SELECTION, not the list,
            so it stays reachable whatever the list is doing. It costs nothing when idle:
            SliceComposer renders null at zero selected, so a collapsed panel with no
            selection is still a single header row. */}
        {footer}
      </section>
    </Panel>
  );
}

interface FooterProps {
  count: number;
  /**
   * PRE-EXISTING slices this selection would strip, named in the message.
   *
   * Deliberately NOT "every blocked slice": the slice being created is blocked more often
   * than any neighbour is, and it has no name yet — including it renders "…is the only
   * story tour scheduling v1,  owns." with a hole where a name should be. Whether the
   * write is refused at all is `disabled`, which is a different question.
   */
  blocked: CapSliceT[];
  /** True when the write would be rejected — including when the only casualty is the new slice. */
  disabled: boolean;
  blockingStory: string | null;
  naming: boolean;
  onStart: () => void;
  onName: (name: string) => void;
  /** Abandons naming. Without it, starting to name a slice is a state with no exit. */
  onCancel: () => void;
}

/**
 * The create control. A SECOND export rather than markup inside SlicePanel, so the panel
 * still knows nothing about selection — MapStage renders this and hands it over as
 * `footer`.
 */
export function SliceComposer({
  count,
  blocked,
  disabled,
  blockingStory,
  naming,
  onStart,
  onName,
  onCancel,
}: FooterProps) {
  // ESCAPE IS BOUND TO THE DOCUMENT, IN THE CAPTURE PHASE, and only while naming.
  //
  // It used to be `onKeyDown` on the input, which works only while focus is in the input —
  // and clicking the canvas to change the selection is exactly what takes focus away. From
  // there Escape reached React Flow instead, whose node wrapper binds it to "unselect this
  // node": the escape hatch was unreachable AND the key quietly did something destructive.
  //
  // Capture on `document` runs before React's root handler, so stopping there is what keeps
  // the keypress from ever becoming a deselect. It acts and it stops the event; it never
  // does both jobs by halves. Enter is untouched — it is still the input's own handler.
  useEffect(() => {
    if (!naming) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      onCancel();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [naming, onCancel]);

  if (count === 0) return null;
  if (naming) {
    return (
      <div className="slice-panel__naming">
        <input
          className="slice-panel__name-input"
          placeholder="Name this slice…"
          // The button that revealed this input has left the DOM, so without autoFocus the
          // focus lands on <body> and the gesture stalls with nowhere to type.
          // biome-ignore lint/a11y/noAutofocus: focus would otherwise land on body mid-gesture
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") onName((e.target as HTMLInputElement).value.trim());
          }}
        />
        {/* The key needs a visible twin: a shortcut nobody is told about is not a way out.
            Both abandon the NAME and leave the stories selected — a cancel that also
            cleared the selection would silently throw away the gathering the user came to
            act on. */}
        <button type="button" className="slice-panel__cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  }
  return (
    <div className="slice-panel__composer">
      <button type="button" disabled={disabled} onClick={onStart}>
        + slice from {count} selected
      </button>
      {disabled && (
        <p className="slice-panel__blocked">
          {/* TWO FORMS, split by whether the blocked slice is the one being created.
              Creating a slice whose every story is already spoken for takes nothing from
              anyone — the neighbours stay healthy and there is no victim to name, so the
              honest sentence is about the selection. That is also the more actionable one:
              the fix is to change what you selected. `storiesLost` returns empty in
              exactly that case, which is what `blockingStory === null` means here. */}
          {blockingStory
            ? `"${blockingStory}" is the only story ${blocked.map((s) => s.name).join(", ")} owns.`
            : "Every story you selected already belongs to another slice — add one that does not."}
        </p>
      )}
    </div>
  );
}
