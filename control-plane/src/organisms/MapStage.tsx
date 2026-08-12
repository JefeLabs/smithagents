import {
  Background,
  ControlButton,
  Controls,
  MiniMap,
  type Node,
  type OnNodeDrag,
  ReactFlow,
  useNodesState,
} from "@xyflow/react";
// Unlayered on purpose. Every selector in this sheet is `.react-flow`-scoped, so
// it cannot reach the card rules components.css contributes to layer(legacy) —
// and being unlayered keeps xyflow's own chrome authoritative over them.
import "@xyflow/react/dist/style.css";
import { Map as MapIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import type { CapActivityT, CapabilityT, CapSliceT, CapStoryT } from "../api/types";
import { ALL_WORKSPACES } from "../lib/board-aggregate";
import { useSession } from "../queries/pushed";
import {
  useCapabilities,
  useCreateCapability,
  useGenerateSpec,
  usePatchCapability,
  useSendSlice,
} from "../queries/work";
import { useUiStore } from "../stores/uiStore";
import { artifactNodesFor, buildEdges } from "./map/edges";
import {
  activityAt,
  artifactRowStartX,
  artifactRowX,
  artifactRowY,
  CAPABILITY_CARD_MIN_W,
  capabilityCardsThatFit,
  cellAt,
  layoutMap,
  type MapNode,
  sliceNodeId,
  stepAt,
  storyNodeId,
  storyStackPosition,
  unassignedNodeId,
} from "./map/layout";
import { BlankCard } from "./map/nodes";
import { nodeTypes } from "./map/nodeTypes";
import { SliceComposer, SlicePanel } from "./map/SlicePanel";
import { blockedBy, slicesWithoutExclusiveStory, storiesLost } from "./map/slices";
import { useMapSelection } from "./map/useMapSelection";

// Test seam: jsdom cannot synthesize xyflow pointer drags any more than it could
// the pointer sequences of the library this replaced, so the drop handler is
// registered here for tests to invoke the exact code path a real drop takes. It
// reports whether the move survived the server, which is what lets a test tell a
// rejected move from an applied one.
let storyDropHandler: ((storyId: string, stepId: string, order: number) => Promise<boolean>) | null = null;
export async function fireStoryDrop(storyId: string, stepId: string, order: number): Promise<boolean> {
  if (!storyDropHandler) throw new Error("MapStage is not mounted");
  return storyDropHandler(storyId, stepId, order);
}

/**
 * The OTHER half of the drop path, and it needs its own seam because `fireStoryDrop`
 * does not reach it: that one calls `moveStory` directly, so neither re-seed branch
 * in `dropNodeAt` runs in any test that goes through it.
 *
 * This one takes a POSITION, not a cell, because resolving the position is the part
 * under test — `cellAt` deciding the drop is invalid is one of the two branches.
 *
 * It displaces the node before resolving, which is xyflow's contribution to a real
 * gesture (it moves the node while dragging, then fires onNodeDragStop on release).
 * Without the displacement a re-seed would be indistinguishable from doing nothing,
 * since the node would already be sitting at its layout position.
 */
let nodeDragStopHandler: ((nodeId: string, position: { x: number; y: number }) => Promise<void>) | null = null;
export async function fireNodeDragStop(nodeId: string, position: { x: number; y: number }): Promise<void> {
  if (!nodeDragStopHandler) throw new Error("MapStage is not mounted");
  return nodeDragStopHandler(nodeId, position);
}

/**
 * The one composer that is still a text box — the slice band's plan path, and nothing else.
 *
 * All FOUR levels of the map are blank cards now: capability, activity, step and story
 * each end their row or column with one, holding their own text and handing back the
 * trimmed value through `onCommit`. `capName` was the last of those to go, and
 * `sliceName` followed it: a slice named into existence has no stories, so it owns
 * nothing and is invalid the moment it exists. Slices are made from a selection now.
 */
interface MapComposerValues {
  planTexts: Record<string, string>;
}

/**
 * The story-map stage — where stories are BORN. Activities → steps → story
 * stacks, with slices carved below. Cards and spec docs are downstream
 * views; every text edit happens here and only here.
 */
export function MapStage({ shelf }: { shelf?: ReactNode } = {}) {
  const capabilitiesQuery = useCapabilities();
  const capabilities = capabilitiesQuery.data?.capabilities ?? [];
  const capErrors = capabilitiesQuery.data?.errors ?? [];
  const loadError = capabilitiesQuery.isError ? "Could not load capabilities — is the broker running?" : null;

  const createCapMutation = useCreateCapability();
  const patchCapMutation = usePatchCapability();
  const generateSpecMutation = useGenerateSpec();
  const sendSliceMutation = useSendSlice();

  const { data: session } = useSession();
  const viewed = useUiStore((s) => s.viewedWorkspaces);
  // Derived, not stored — same fallback order as BoardStage's `scope`: an
  // untouched (empty) selection follows the active session's one workspace,
  // so a fresh load shows that workspace's map instead of none. Unlike
  // Board, Map renders exactly one capability at a time, so an explicit VIEW
  // only wins when it names exactly one workspace; "*" or several in view
  // have no single map to prefer and fall back to the session too — the same
  // "look at many, act in one" rule BoardStage's singleWorkspace applies to
  // creation. Memoized so its identity is stable across renders where
  // neither input changed, since the activeId-reset effect below is keyed
  // on it.
  const workspace = useMemo(() => {
    if (viewed !== ALL_WORKSPACES && viewed.size === 1) return [...viewed][0];
    return session?.workspace ?? "";
  }, [viewed, session?.workspace]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Pan mode: left-drag pans instead of lassoing — toggled from the zoom
  // controls cluster, where the hand tool lives in every canvas app.
  const [panMode, setPanMode] = useState(false);

  // Each remaining composer is a write-once text box: type, press Enter, it clears.
  // planTexts is keyed by slice id and registered as the bands render, which is why
  // this is one form rather than a `Record<string, string>` state.
  const { register, getValues, setValue } = useForm<MapComposerValues>({
    defaultValues: { planTexts: {} },
  });

  const displayError = error ?? loadError;

  // The active capability must always follow an explicit workspace switch —
  // reset unconditionally rather than only seed, so a stale capability from
  // the PREVIOUS workspace never keeps rendering under the new one's name
  // (I5). This is what the retired workspace picker's onChange handler used
  // to do directly; now that the workspace comes from the session/store
  // instead of a local control, the reset has to live here. Deliberately NOT
  // keyed on capabilitiesQuery.data — an unrelated collection refetch (e.g.
  // F1's cross-workspace capability-updated frame) must be a no-op here;
  // that case belongs to the seeding effect below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: workspace-keyed reset, same pattern as BoardStage's scope-keyed resets
  useEffect(() => {
    const caps = capabilitiesQuery.data?.capabilities;
    if (!caps) return;
    setActiveId(caps.find((c) => c.workspaceId === workspace)?.id ?? null);
  }, [workspace]);

  // Re-derives on every successful load (including a WS-driven background
  // refetch), same as the original's `refetch()` — the `id ??` guard makes
  // this a no-op once something (a prior load, or the reset effect above) has
  // already set activeId; this effect only SEEDS. The `!workspace ||` filter
  // matters once collection-level invalidation is in play: without it, a
  // capability-updated frame for an UNRELATED capability re-runs this effect
  // (capabilitiesQuery.data gets a new reference), and with activeId still
  // null from I5's "workspace has no capabilities" case, `caps[0]?.id` would
  // seed a capability from a DIFFERENT workspace than the one being shown.
  // Filtering by the currently-derived workspace keeps that path a no-op
  // instead. Behaviour-identical on first mount, before `workspace` resolves
  // from the session (still `""`, so the filter is itself a no-op).
  useEffect(() => {
    const caps = capabilitiesQuery.data?.capabilities;
    if (!caps) return;
    setActiveId((id) => id ?? caps.find((c) => !workspace || c.workspaceId === workspace)?.id ?? null);
  }, [capabilitiesQuery.data, workspace]);

  const cap = capabilities.find((c) => c.id === activeId) ?? null;

  // The capabilities the row offers. THE FILTER IS UNCHANGED from the picker it
  // replaces, including the empty-string case: `""` means the session has not resolved
  // a workspace yet and everything shows. That is the seam the navbar work put in, and
  // the seeding effect below relies on the same expression.
  // Sorted by `order`, with a fallback because the field is optional: a capability file
  // written before ordering existed has none, and the broker places those after the
  // ordered ones rather than inventing a value. `sort` is stable, so those keep the
  // sequence the broker sent them in.
  const visibleCapabilities = capabilities
    .filter((c) => !workspace || c.workspaceId === workspace)
    .slice()
    .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));

  /**
   * Reorders the capability row, writing only the capabilities whose order actually
   * changed.
   *
   * ONE PATCH PER MOVED CAPABILITY, which is the cost of each being its own file. The
   * canvas levels renumber a whole array inside one document for a single write; here a
   * dense renumber is a write per capability, so the diff is taken first and untouched
   * ones are left alone. Moving a card one place therefore costs two writes, not N.
   */
  const reorderCapability = async (draggedId: string, targetId: string) => {
    if (draggedId === targetId) return;
    const ordered = [...visibleCapabilities];
    const from = ordered.findIndex((c) => c.id === draggedId);
    const to = ordered.findIndex((c) => c.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = ordered.splice(from, 1);
    ordered.splice(to, 0, moved);
    try {
      await Promise.all(
        ordered
          .map((c, index) => ({ c, index }))
          .filter(({ c, index }) => c.order !== index)
          .map(({ c, index }) => patchCapMutation.mutateAsync({ id: c.id, body: { order: index } })),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reorder failed");
    }
  };

  // MEASURED, never assumed. The stage sits inside a navbar, a rail and a right rail, and
  // its own padding has already turned out once not to be what its rule said — so a
  // breakpoint tuned at one viewport would be a guess that happens to hold there. The
  // observer reports the row's real content box and the pure fit function decides from it.
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [rowWidth, setRowWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === "number") setRowWidth(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // `null` means nobody has measured yet — first paint, and every jsdom test, where the
  // ResizeObserver stub never calls back. Showing everything is the right answer for both:
  // no flash of collapsed cards, and no test silently asserting against a collapsed row.
  const shownCount =
    rowWidth === null ? visibleCapabilities.length : capabilityCardsThatFit(rowWidth, visibleCapabilities.length);
  const shownCapabilities = visibleCapabilities.slice(0, shownCount);
  const hiddenCapabilities = visibleCapabilities.slice(shownCount);
  // The selection can end up inside the menu, and then the row would show no selected card
  // at all. The `+N` control carries the marker instead — cheaper than reordering the row,
  // which would move cards under the cursor every time one was picked.
  const selectionIsHidden = hiddenCapabilities.some((c) => c.id === activeId);

  // What the map is interrogating. TWO SCOPES, TWO SHAPES, deliberately: a slice
  // answers "what is in this release" and gets a horizontal band under the whole map;
  // a story answers "where is THIS story specced and tracked" and gets a vertical
  // stack beside itself. Same records, different question, so they must not look alike.
  const { selection, select } = useMapSelection();

  // EVERY edge the model could draw, computed once per capability. Revealing filters
  // this set rather than rebuilding it — clicking a band must not recompute the
  // graph, which is why `buildEdges` stamps each edge with its `sliceId`.
  const allEdges = useMemo(() => (cap ? buildEdges(cap) : []), [cap]);

  const revealed = selection?.kind === "slice" ? selection.id : null;
  // Resolved against the model rather than trusted from the selection, which is what
  // makes a stale selection harmless: switch capability with a slice revealed and
  // this find simply misses, so the reveal collapses instead of describing a slice
  // that is no longer on screen.
  const revealedSlice = cap?.slices.find((s) => s.id === revealed) ?? null;

  const edges = useMemo(() => allEdges.filter((e) => e.sliceId === revealed), [allEdges, revealed]);

  // The story reveal, resolved the same way and for the same reason: a selection that
  // no longer names a record in `cap` simply misses, and the reveal collapses.
  const [hoveredSliceId, setHoveredSliceId] = useState<string | null>(null);

  /**
   * THE SELECTION LIVES HERE, NOT IN REACT FLOW — and the spec said the opposite.
   *
   * React Flow keeps `selected` on the node objects, and this component rebuilds those
   * wholesale from the model on every reveal, hover, reorder and WS update. Measured in
   * Task 3: select two stories, click a story title to reveal, and the selection goes
   * from two to none. So React Flow REPORTS the gesture and MapStage stores the answer,
   * which `decorate` writes back on each rebuild — the same argument-passed shape the dim
   * set uses, for the same reason.
   */
  const [selectedStoryIds, setSelectedStoryIds] = useState<string[]>([]);
  const selectedIdSet = useMemo(() => new Set(selectedStoryIds), [selectedStoryIds]);

  /**
   * The write-back would otherwise be a loop: `decorate` sets `selected`, React Flow
   * reports that as a selection change, which sets state, which re-seeds. The guard bails
   * when the set has not actually changed.
   *
   * Compared as a SET, not element-wise. React Flow reports selected nodes in node order,
   * which is not the order they were clicked in, so an element-wise comparison would see
   * a difference on every multi-select and churn an extra render before settling.
   */
  const onSelectionChange = useCallback(({ nodes: sel }: { nodes: Node[] }) => {
    const ids = sel.map((n) => n.id);
    setSelectedStoryIds((prev) => (prev.length === ids.length && prev.every((id) => ids.includes(id)) ? prev : ids));
  }, []);

  // Hovering a slice dims every story it does NOT own. Same argument-passed dim set the
  // slice reveal already uses, so there is one dimming mechanism rather than two that can
  // disagree. Keyed on ids, not on positions, so it survives any relayout.
  const hoverDimmed = useMemo(() => {
    if (!hoveredSliceId || !cap) return new Set<string>();
    const owned = new Set(cap.slices.find((s) => s.id === hoveredSliceId)?.storyIds ?? []);
    return new Set(cap.stories.filter((s) => !owned.has(s.id)).map((s) => storyNodeId(s.id)));
  }, [hoveredSliceId, cap]);

  // Grandfathered slices are MARKED, not hidden — jefelabs-school-visits carries two of
  // them, and the panel showing a slice it refuses to explain would be worse than the mark.
  const invalidSliceIds = useMemo(
    () => new Set(slicesWithoutExclusiveStory(cap?.slices ?? []).map((s) => s.id)),
    [cap],
  );

  /**
   * The stories the composer is CURRENTLY OFFERING TO CREATE, frozen when naming begins —
   * and `null` when it is not naming, so the two facts cannot disagree.
   *
   * Naming swaps the button for an input but does not lock the canvas, so the selection
   * can move while the input is open. Everything the panel validated — the count, the
   * blocked check, the message — was computed for the selection as it was when the button
   * was pressed, so that is the selection the write has to carry. Otherwise `+ slice from
   * N selected` is a snapshot that can drift rather than a promise, and the drift is
   * silent: a different-but-valid selection creates a slice with stories the user never
   * agreed to, and nothing errors.
   */
  const [pendingStoryIds, setPendingStoryIds] = useState<string[] | null>(null);

  // The write the button would send, evaluated before it is sent.
  const proposed = useMemo(
    () =>
      cap
        ? [
            ...cap.slices,
            // A real id rather than a sentinel string. It never reaches the server — it only
            // has to be absent from `cap.slices` so the differential reads this as a
            // creation — and a generated one cannot collide with a slice that exists.
            { id: crypto.randomUUID(), name: "", order: cap.slices.length, storyIds: selectedStoryIds },
          ]
        : [],
    [cap, selectedStoryIds],
  );
  const blocked = cap ? blockedBy(cap.slices, proposed) : [];
  // Split, because the two halves answer different questions. ANY blocked slice refuses
  // the write, but only a slice that existed before can be NAMED as having lost something
  // — the new one has no name yet, and putting it in the sentence leaves a hole where a
  // name should be.
  // "Pre-existing" stated directly, as membership in cap.slices, rather than by comparing
  // against the id of the one that is not.
  const existingSliceIds = new Set(cap?.slices.map((s) => s.id) ?? []);
  const victims = blocked.filter((s) => existingSliceIds.has(s.id));
  // The stories the raided slice is LOSING — a second differential, this time over
  // stories. Not a `find` over the selection: that names whichever story happens to come
  // first, which is wrong whenever the selection also takes a story that was already
  // shared. Empty when no pre-existing slice was raided, which is the common case and the
  // reason the message has two forms.
  const lost = victims.length > 0 && cap ? storiesLost(cap.slices, proposed, victims[0]) : [];
  const blockingStory = lost.length > 0 ? (cap?.stories.find((s) => s.id === lost[0])?.text ?? null) : null;

  const createSliceFromSelection = async (name: string) => {
    const storyIds = pendingStoryIds;
    if (!cap || !name || !storyIds || storyIds.length === 0) return;
    const created = await patchCap({
      slices: [...cap.slices, { id: crypto.randomUUID(), name, order: cap.slices.length, storyIds }],
    });
    setPendingStoryIds(null);
    // ONLY on a confirmed success. Clearing after a rejection would cost the user the
    // write and the selection that produced it, leaving nothing to retry from. On success
    // it clears, per Edwin's ruling: left selected, the stories are re-proposed against a
    // world that now contains the slice they went into, so the panel names the slice just
    // created as the victim of the selection that created it.
    if (created) setSelectedStoryIds([]);
  };

  const revealedStoryId = selection?.kind === "story" ? selection.id : null;
  const revealedStory = cap?.stories.find((s) => s.id === revealedStoryId) ?? null;
  // The slice a revealed story belongs to, or null when it is still in the backlog —
  // which is most stories, and the case the reveal has to answer honestly rather than
  // by doing nothing.
  const storySlice = revealedStory ? (cap?.slices.find((s) => s.storyIds.includes(revealedStory.id)) ?? null) : null;

  // Reports whether the write survived. Only the drag path reads it — a rejected
  // move has to re-seed the canvas, because xyflow holds the dragged node's
  // position locally and would otherwise keep showing a move the server refused.
  const patchCap = useCallback(
    async (body: Partial<Pick<CapabilityT, "name" | "order" | "activities" | "stories" | "slices">>) => {
      if (!cap) return false;
      try {
        await patchCapMutation.mutateAsync({ id: cap.id, body });
        setError(null);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Update failed");
        return false;
      }
    },
    [cap, patchCapMutation],
  );

  const moveStory = useCallback(
    async (storyId: string, stepId: string, order: number) => {
      if (!cap) return false;
      const stories = cap.stories.map((s) => ({ ...s }));
      const story = stories.find((s) => s.id === storyId);
      if (!story) return false;
      const from = story.stepId;
      const siblings = stories.filter((s) => s.stepId === stepId && s.id !== storyId).sort((a, b) => a.order - b.order);
      const at = Math.max(0, Math.min(order, siblings.length));
      story.stepId = stepId;
      siblings.splice(at, 0, story);
      siblings.forEach((s, i) => {
        s.order = i;
      });
      if (from !== stepId) {
        stories
          .filter((s) => s.stepId === from)
          .sort((a, b) => a.order - b.order)
          .forEach((s, i) => {
            s.order = i;
          });
      }
      return patchCap({ stories });
    },
    [cap, patchCap],
  );

  useEffect(() => {
    storyDropHandler = moveStory;
    return () => {
      storyDropHandler = null;
    };
  }, [moveStory]);

  /**
   * Takes the name as an argument now, like the other three levels: the blank card owns
   * its own text and hands over the trimmed value, so there is no field to read and none
   * to clear. An empty commit never arrives — BlankCard drops it.
   *
   * The `workspace` guard stays. A capability has to belong somewhere, and until the
   * session resolves one there is nowhere to put it.
   */
  const createCapability = (name: string) => {
    if (!name || !workspace) return;
    void (async () => {
      try {
        const created = await createCapMutation.mutateAsync({ name, workspaceId: workspace });
        setActiveId(created.id);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "unreachable");
      }
    })();
  };

  const storiesFor = (stepId: string) =>
    (cap?.stories ?? []).filter((s) => s.stepId === stepId).sort((a, b) => a.order - b.order);
  const doneFraction = (slice: CapSliceT) => {
    const stories = (cap?.stories ?? []).filter((s) => slice.storyIds.includes(s.id));
    return `${stories.filter((s) => s.done).length}/${stories.length}`;
  };
  const sliceFor = (storyId: string) => cap?.slices.find((s) => s.storyIds.includes(storyId))?.id ?? "backlog";

  // The three creates take their text as an argument now. Each level's trailing
  // blank card owns its own input state and hands the trimmed value over through
  // `onCommit`, so there is no form field left to read or to clear — the card
  // clears itself, and an empty commit never reaches here at all.
  const addActivity = (name: string) => {
    if (!cap || !name) return;
    void patchCap({
      activities: [...cap.activities, { id: crypto.randomUUID(), name, order: cap.activities.length, steps: [] }],
    });
  };
  const addStep = (activityId: string, name: string) => {
    if (!cap || !name) return;
    void patchCap({
      activities: cap.activities.map((a) =>
        a.id === activityId
          ? { ...a, steps: [...a.steps, { id: crypto.randomUUID(), name, order: a.steps.length }] }
          : a,
      ),
    });
  };
  const addStory = (stepId: string, text: string) => {
    if (!cap || !text) return;
    void patchCap({
      stories: [
        ...cap.stories,
        { id: crypto.randomUUID(), stepId, order: storiesFor(stepId).length, text, done: false },
      ],
    });
  };
  const removeStory = (story: CapStoryT) => {
    if (!cap) return;
    void patchCap({
      stories: cap.stories.filter((s) => s.id !== story.id),
      slices: cap.slices.map((s) => ({ ...s, storyIds: s.storyIds.filter((id) => id !== story.id) })),
    });
  };
  const removeStep = (act: CapActivityT, stepId: string) => {
    if (!cap) return;
    void patchCap({
      activities: cap.activities.map((a) =>
        a.id === act.id ? { ...a, steps: a.steps.filter((s) => s.id !== stepId) } : a,
      ),
    });
  };
  const removeActivity = (act: CapActivityT) => {
    if (!cap) return;
    void patchCap({ activities: cap.activities.filter((a) => a.id !== act.id) });
  };
  const assignSlice = (storyId: string, sliceId: string) => {
    if (!cap) return;
    const slices = cap.slices.map((s) => ({ ...s, storyIds: s.storyIds.filter((id) => id !== storyId) }));
    if (sliceId !== "backlog") {
      const target = slices.find((s) => s.id === sliceId);
      target?.storyIds.push(storyId);
    }
    void patchCap({ slices });
  };
  const generateSpec = async (slice: CapSliceT) => {
    if (!cap) return;
    try {
      await generateSpecMutation.mutateAsync({ id: cap.id, sliceId: slice.id });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "unreachable");
    }
  };
  const setPlanPath = (slice: CapSliceT) => {
    const value = (getValues(`planTexts.${slice.id}`) ?? "").trim();
    if (!cap || !value) return;
    void patchCap({ slices: cap.slices.map((s) => (s.id === slice.id ? { ...s, planPath: value } : s)) });
    setValue(`planTexts.${slice.id}`, "");
  };
  const sendSlice = async (slice: CapSliceT, target: "capabilities" | "delivery") => {
    if (!cap) return;
    try {
      await sendSliceMutation.mutateAsync({ id: cap.id, sliceId: slice.id, target });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "unreachable");
    }
  };
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);

  /**
   * Injects handlers and dim state into the pure layout's node data. `layoutMap`
   * cannot do this itself without importing React, which would cost the DOM-free
   * property test that makes `cellAt` trustworthy. Task 5 extends `dimmedIds`
   * rather than adding a second path.
   *
   * BLANK CARDS ARE MATCHED FIRST, and every one of them gets an `onCommit`.
   * `BlankCard` calls `data.onCommit(text)` unguarded while `layoutMap` emits blank
   * data without it, so a blank that fell through to a real-card branch below would
   * not merely lose its handler — it would read `story`/`step`/`activity` off data
   * that has none and throw while rendering. The parent id comes off the blank
   * node's own data, which is why the card never has to learn where it belongs.
   *
   * DIMMING ARRIVES AS AN ARGUMENT, never as a closure, and that is load-bearing for
   * the seeding effect's `biome-ignore` below: it is what keeps `decorate` a function
   * of `cap` alone even though the dim set now comes from a selection that is not.
   * Closing over the selection here instead would make the omitted dependency a real
   * stale closure rather than a documented safe one.
   *
   * ACTIVITY IS MATCHED EXPLICITLY at both levels, not by falling through. It used to
   * be the else-branch, which was safe only while the union was exactly three levels;
   * `"slice"` and `"artifact"` are in it now, so a fallthrough would quietly decorate
   * one as an activity — reading `data.activity` off a node that has none. Neither
   * reaches here today (they are appended after `decorate`, not laid out by
   * `layoutMap`), and that is precisely why the mistake would survive review.
   */
  const decorateNode = (n: MapNode, dimmedIds: Set<string>): Node => {
    {
      const dimmed = dimmedIds.has(n.id);
      if (n.data.blank) {
        if (n.type === "story") {
          const stepId = n.data.stepId as string;
          return { ...n, data: { blank: true, onCommit: (text: string) => addStory(stepId, text) } } as Node;
        }
        if (n.type === "step") {
          const activityId = n.data.activityId as string;
          return { ...n, data: { blank: true, onCommit: (text: string) => addStep(activityId, text) } } as Node;
        }
        if (n.type === "activity") {
          return { ...n, data: { blank: true, onCommit: (text: string) => addActivity(text) } } as Node;
        }
        return n as Node;
      }
      if (n.type === "story") {
        const story = n.data.story as CapStoryT;
        return {
          ...n,
          data: {
            story,
            dimmed,
            selected: story.id === revealedStoryId,
            sliceOptions: [...(cap?.slices ?? [])].sort((a, b) => a.order - b.order),
            sliceValue: sliceFor(story.id),
            onSliceChange: (sliceId: string) => assignSlice(story.id, sliceId),
            onRemove: () => removeStory(story),
            onReveal: () => select({ kind: "story", id: story.id }),
          },
        } as Node;
      }
      if (n.type === "step") {
        const step = n.data.step as { id: string; name: string; order: number };
        const activity = n.data.activity as CapActivityT;
        return {
          ...n,
          data: {
            step,
            activity,
            dimmed,
            storyCount: storiesFor(step.id).length,
            onRemove: () => removeStep(activity, step.id),
          },
        } as Node;
      }
      if (n.type === "activity") {
        const activity = n.data.activity as CapActivityT;
        return { ...n, data: { activity, dimmed, onRemove: () => removeActivity(activity) } } as Node;
      }
      // Slice and artifact nodes need no decoration — they are read-only and carry
      // their whole payload from the emission site. Returning them untouched is the
      // honest default now that the union admits levels this function does not handle.
      return n as Node;
    }
  };

  /**
   * `selected` here is React Flow's NODE-LEVEL flag — not the `data.selected` a story card
   * reads for its reveal outline. Two different things one word apart, so: this one is the
   * lasso/shift-click selection, that one is "this story's chain is open".
   *
   * It is written on EVERY rebuild because MapStage owns the selection and these node
   * objects are thrown away and remade on every model change, reveal and hover. React Flow
   * reports selection gestures; it does not store the selection across a re-seed.
   */
  const decorate = (base: MapNode[], dimmedIds: Set<string>, selectedIds: Set<string>): Node[] =>
    base.map((n) => ({ ...decorateNode(n, dimmedIds), selected: selectedIds.has(n.id) }));

  // Positions are derived, never stored — but xyflow needs local node state for a
  // node to follow the cursor mid-drag, so the model is re-seeded into it whenever
  // it changes.
  //
  // KEYED ON `cap` AND `revealedSlice`, and deliberately NOT on `decorate`.
  //
  // `decorate` is OMITTED because it is rebuilt every render — it closes over the create
  // and remove helpers, which are plain consts — so listing it would re-seed on every
  // render, and since re-seeding sets state that is an infinite update loop, not merely
  // a slow path. Memoizing it instead would not help: memoizing over helpers that are
  // themselves rebuilt each render just moves the fresh identity, it does not remove it.
  //
  // `revealedSlice` IS LISTED, and that is the half worth stating, because this task is
  // where the omission above stopped being self-evidently safe. Task 4 could argue that
  // everything `decorate` injects bottoms out in `cap`; the dim set does not — it comes
  // from a selection. What keeps the argument alive is that dimming reaches `decorate` as
  // an ARGUMENT computed inside this effect, never as a closure over the selection, so
  // `decorate` is still a function of `cap` alone and the effect still re-runs exactly
  // when the reveal changes. Listing `revealedSlice` costs nothing: it is a plain value —
  // an element of `cap.slices` — not a rebuilt function.
  //
  // If anything `decorate` reads ever stops being a function of `cap` or a listed value,
  // this suppression stops documenting a safe omission and starts hiding a stale closure.
  //
  // THAT TRIPWIRE HAS NOW FIRED ONCE, which is why it was worth writing: the story reveal
  // made `decorate` close over `revealedStoryId` and `select`, neither of which is a
  // function of `cap`. Both are listed below — `revealedStoryId` is a string, `select` is
  // referentially stable by construction (`useMapSelection` resolves the toggle inside the
  // updater so the callback has no dependencies) — so the closure is rebuilt exactly when
  // the selection moves, and `is-selected` follows it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: decorate is rebuilt every render, so listing it loops; everything it reads is `cap`, an argument, or a listed value — see above
  useEffect(() => {
    if (!cap) {
      setNodes([]);
      return;
    }
    const base = layoutMap(cap).nodes;

    if (revealedStory) {
      // A STORY'S OWN CHAIN, stacked beside it. NOTHING IS DIMMED here, and that is the
      // difference in scope made visible: the band answers "what is in this release", so
      // it dims everything outside the slice; this answers "where is this one story
      // specced", which is a narrow question that has no business restyling the map. The
      // story's own `is-selected` says which one is asking.
      const at = base.find((n) => n.type === "story" && n.id === revealedStory.id)?.position;
      const decorated = decorate(base, hoverDimmed, selectedIdSet);
      if (!at) {
        // The story is in the model but not on the canvas — its step was removed. There
        // is nowhere to hang a stack, so show the map unchanged rather than guessing.
        setNodes(decorated);
        return;
      }
      const cards: MapNode[] = storySlice
        ? [
            {
              id: sliceNodeId(storySlice.id),
              type: "slice",
              position: storyStackPosition(at, 0),
              data: {
                name: storySlice.name,
                fraction: `${storySlice.storyIds.filter((id) => cap.stories.find((s) => s.id === id)?.done).length}/${
                  storySlice.storyIds.length
                }`,
              },
              draggable: false,
              selectable: false,
            },
            ...artifactNodesFor(storySlice).map((a, i) => ({
              id: a.id,
              type: "artifact" as const,
              position: storyStackPosition(at, i + 1),
              data: { kind: a.kind, label: a.label },
              draggable: false,
              selectable: false,
            })),
          ]
        : [
            // MOST STORIES ARE IN THE BACKLOG, so this is the common answer and not an
            // edge case. Saying so beats a click that silently does nothing — a control
            // that appears broken on most of its targets teaches people not to use it.
            {
              id: unassignedNodeId(revealedStory.id),
              type: "artifact",
              position: storyStackPosition(at, 0),
              data: { kind: "backlog", label: "not in a slice yet" },
              draggable: false,
              selectable: false,
            },
          ];
      setNodes([...decorated, ...cards]);
      return;
    }

    if (!revealedSlice) {
      setNodes(decorate(base, hoverDimmed, selectedIdSet));
      return;
    }

    // Dim every story the revealed slice does not own. `decorate` is the same bridge
    // the plain path uses — revealing only changes which ids land in the dimmed set.
    // Blank story slots match this filter too and it costs nothing: `decorate` handles
    // blanks first and never gives them a `dimmed` field to read.
    const inSlice = new Set(revealedSlice.storyIds);
    // Unioned rather than replaced: a hover while a band is open should not LIGHT a story
    // the open slice does not own. Dim is the safe direction to combine in.
    const dimmedIds = new Set(base.filter((n) => n.type === "story" && !inSlice.has(n.id)).map((n) => n.id));
    const decorated = decorate(base, new Set([...dimmedIds, ...hoverDimmed]), selectedIdSet);

    // One y for the whole row, computed once: it depends on the deepest story stack,
    // which is a property of the model and not of any single artifact.
    const rowY = artifactRowY(cap);
    const rowX = artifactRowStartX(cap, revealedSlice);
    const done = revealedSlice.storyIds.filter((id) => cap.stories.find((s) => s.id === id)?.done).length;

    // Typed MapNode rather than left to xyflow's Node, whose `type` is any string:
    // this is the only thing that holds the two new union members to a level that
    // `nodeTypes` actually registers. A typo here would otherwise render nothing and
    // report nothing, the same silence a wrong node id buys.
    const ephemeral: MapNode[] = [
      {
        // sliceNodeId, NOT a re-derived `slice:${id}`. `buildEdges` names this node as
        // its source through the same helper, and an edge whose endpoint does not
        // exist is silent — xyflow draws nothing and logs nothing about the id.
        id: sliceNodeId(revealedSlice.id),
        type: "slice",
        // THE ANCHOR LEADS THE ROW, at slot 0, with the artifacts following from slot 1.
        // It used to sit off to the left at SLICE_RAIL_X, and since every edge on the
        // canvas originates here, that one position set the length of all of them —
        // moving the artifacts below the map shortened them but could not fix it.
        position: { x: artifactRowX(0, rowX), y: rowY },
        data: { name: revealedSlice.name, fraction: `${done}/${revealedSlice.storyIds.length}` },
        draggable: false,
        selectable: false,
      },
      // `a.id` is already minted by `artifactNodeId` inside `artifactNodesFor` — it is
      // not rebuilt here, for the same reason.
      ...artifactNodesFor(revealedSlice).map((a, i) => ({
        id: a.id,
        type: "artifact" as const,
        // `i + 1`: slot 0 is the anchor's.
        position: { x: artifactRowX(i + 1, rowX), y: rowY },
        data: { kind: a.kind, label: a.label },
        draggable: false,
        selectable: false,
      })),
    ];

    setNodes([...decorated, ...ephemeral]);
    // `hoverDimmed` is listed for the same reason `revealedSlice` is: it is a plain value
    // this effect reads, and leaving it out would show the previous hover's dimming.
  }, [cap, revealedSlice, revealedStory, revealedStoryId, storySlice, select, setNodes, hoverDimmed, selectedIdSet]);

  /**
   * Moves an activity to `index`, renumbering `order` densely.
   *
   * The whole array is renumbered rather than the two ends swapped, because `order` is
   * what every reader sorts by and a sparse or duplicated one is a map that draws in an
   * arbitrary sequence. `layoutMap`'s doc states the dense invariant for stories; this
   * keeps the same promise a level up.
   */
  const moveActivity = async (activityId: string, index: number) => {
    if (!cap) return false;
    const ordered = [...cap.activities].sort((a, b) => a.order - b.order);
    const from = ordered.findIndex((a) => a.id === activityId);
    if (from < 0 || from === index) return true;
    const [moved] = ordered.splice(from, 1);
    ordered.splice(Math.max(0, Math.min(index, ordered.length)), 0, moved);
    return patchCap({ activities: ordered.map((a, i) => ({ ...a, order: i })) });
  };

  /**
   * Moves a step to `index` within `activityId`, which may be the activity it already
   * belongs to or another one.
   *
   * CROSS-ACTIVITY IS A REAL EDIT, not a side effect: a step belongs to an activity, so
   * dropping one under a different heading is the user saying it belongs there instead.
   * Both activities are rewritten because a step lives inside its parent's `steps`
   * array, so the move is a removal and an insertion rather than a reordering.
   */
  const moveStep = async (stepId: string, activityId: string, index: number) => {
    if (!cap) return false;
    const activities = cap.activities.map((a) => ({ ...a, steps: [...a.steps].sort((x, y) => x.order - y.order) }));
    const source = activities.find((a) => a.steps.some((s) => s.id === stepId));
    const target = activities.find((a) => a.id === activityId);
    if (!source || !target) return false;
    const from = source.steps.findIndex((s) => s.id === stepId);
    if (source.id === target.id && from === index) return true;
    const [moved] = source.steps.splice(from, 1);
    target.steps.splice(Math.max(0, Math.min(index, target.steps.length)), 0, moved);
    return patchCap({
      activities: activities.map((a) => ({ ...a, steps: a.steps.map((s, i) => ({ ...s, order: i })) })),
    });
  };

  const dropNodeAt = async (nodeId: string, position: { x: number; y: number }) => {
    if (!cap) return;
    // Invalid drop, or a rejected mutation: re-seed from the model. Without this the
    // node keeps its dropped position and shows a move that never happened — and the
    // seeding effect cannot cover it, because on both paths the model never changed.
    const reseed = () => setNodes(decorate(layoutMap(cap).nodes, new Set(), selectedIdSet));
    // The TYPE comes from the node, never from parsing the id. layout.ts owns those
    // formats and is the only place allowed to take one apart.
    const dragged = nodes.find((n) => n.id === nodeId);

    if (dragged?.type === "activity") {
      const index = activityAt(position, cap);
      const activity = (dragged.data as { activity?: CapActivityT }).activity;
      if (index === null || !activity) return reseed();
      if (!(await moveActivity(activity.id, index))) reseed();
      return;
    }

    if (dragged?.type === "step") {
      const target = stepAt(position, cap);
      const step = (dragged.data as { step?: { id: string } }).step;
      if (!target || !step) return reseed();
      if (!(await moveStep(step.id, target.activityId, target.index))) reseed();
      return;
    }

    // A story node's id IS its story id (layout.ts's one asymmetry), so it needs no
    // unwrapping here.
    const cell = cellAt(position, cap);
    if (!cell) return reseed();
    const ok = await moveStory(nodeId, cell.stepId, cell.order);
    if (!ok) reseed();
  };

  const onNodeDragStop: OnNodeDrag = (_event, node) => void dropNodeAt(node.id, node.position);

  // No dependency array: `dropNodeAt` is a plain const with a fresh identity every
  // render, so the seam is re-pointed after each one. It only assigns a module
  // variable — no state is set, so unlike the seeding effect this cannot loop.
  useEffect(() => {
    nodeDragStopHandler = async (nodeId, position) => {
      // xyflow's half of the gesture, reproduced: the node is already sitting at the
      // drop point by the time onNodeDragStop fires. See fireNodeDragStop.
      setNodes((ns) => ns.map((n) => (n.id === nodeId ? { ...n, position } : n)));
      await dropNodeAt(nodeId, position);
    };
    return () => {
      nodeDragStopHandler = null;
    };
  });

  return (
    <section className="stage map-stage" aria-label="Story map">
      {shelf}
      <header className="map-stage__bar">
        <MapIcon size={14} strokeWidth={2} />
        {/* The FOURTH level of the blank-card rule, and the last one that was still a
            picker plus an "add" button plus a toggle plus a field. Selecting a capability
            is clicking its card, exactly as selecting a slice is clicking its band.

            The cards SCROLL and the blank card sits outside the scroller, so it is
            reachable at any list length — the row still ends with it, it just never
            leaves. Wrapping instead would grow the header and shove the canvas down by a
            variable amount every time someone adds a capability. */}
        <div
          className="map-capability-row"
          ref={rowRef}
          // The card width crosses into CSS as a custom property rather than being written
          // in both places. layout.ts owns the number, the fit calculation counts in it,
          // and every card rule reads it back — so the CSS cannot drift from the maths
          // that decides how many of those cards fit.
          style={{ "--cap-card-w": `${CAPABILITY_CARD_MIN_W}px` } as CSSProperties}
        >
          {shownCapabilities.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`map-capability${c.id === activeId ? " is-selected" : ""}`}
              aria-pressed={c.id === activeId}
              onClick={() => setActiveId(c.id)}
              // NATIVE drag, not the canvas's. These are header buttons rather than
              // xyflow nodes, and the drop target IS a card — so there is no position to
              // invert into an index and nothing for layout.ts to resolve. The canvas
              // needs geometry because a node can be released anywhere on it; here the
              // browser already knows which card was landed on.
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", c.id);
              }}
              onDragOver={(e) => {
                // Without preventDefault the browser refuses the drop outright — this is
                // what marks a card as a valid target at all. The BLANK card has no such
                // handler, which is exactly why nothing can be dropped onto the composer.
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }}
              onDrop={(e) => {
                e.preventDefault();
                void reorderCapability(e.dataTransfer.getData("text/plain"), c.id);
              }}
            >
              {c.name}
            </button>
          ))}
          {hiddenCapabilities.length > 0 && (
            // <details>, so open/close and keyboard both come from the browser rather than
            // from state and a click-outside listener. Selecting closes it — a menu that
            // stays open over the map after you have answered it is just in the way.
            <details className={`map-capability-more${selectionIsHidden ? " is-selected" : ""}`}>
              {/* NAMES THE SELECTION when the selection is one of the collapsed ones.
                  A bare "+2" is what the row degrades to at narrow widths, and measured
                  at 700px that left the header with no capability name on it at all —
                  the single most useful thing it carries. Showing the name is also what
                  makes this a dropdown rather than an overflow bin, which is what was
                  asked for; the count stays beside it so the row still says how much is
                  hidden. */}
              <summary
                aria-label={
                  selectionIsHidden
                    ? `${cap?.name ?? "Selected"} — ${hiddenCapabilities.length} capabilities hidden`
                    : `${hiddenCapabilities.length} more capabilities`
                }
              >
                {selectionIsHidden && <span className="map-capability-more__name">{cap?.name}</span>}
                <span className="map-capability-more__count">+{hiddenCapabilities.length}</span>
              </summary>
              <div className="map-capability-more__menu">
                {hiddenCapabilities.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`map-capability-more__item${c.id === activeId ? " is-selected" : ""}`}
                    aria-pressed={c.id === activeId}
                    onClick={(e) => {
                      setActiveId(c.id);
                      e.currentTarget.closest("details")?.removeAttribute("open");
                    }}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            </details>
          )}
          {/* Same component the three canvas levels use. Committing empty is a no-op and
              the card clears itself, both inside BlankCard — there is nothing to repeat
              here, which is the point of it being one implementation. */}
          <BlankCard className="map-capability" placeholder="Capability name" onCommit={createCapability} />
        </div>
      </header>
      {displayError && <p className="wizard__error">{displayError}</p>}
      {capErrors.length > 0 && (
        <p className="wizard__hint">Some capability files failed to load: {capErrors.map((e) => e.file).join(", ")}</p>
      )}
      {cap && (
        <>
          <div className="map-stage__canvas">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              // No cast any more. `nodeTypes.tsx` adapts the pure cards to xyflow —
              // handles for the edges to land on, and the data narrowing done per
              // level — so what arrives here is already a NodeTypes.
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onNodeDragStop={onNodeDragStop}
              // The PROP, not `useOnSelectionChange`. That hook reads React Flow's store
              // from context, and `<ReactFlow>` creates that provider inside its own
              // render — so a hook called here, in the component that renders it, sits
              // above the provider and has no store. Same SelectionListener either way.
              onSelectionChange={onSelectionChange}
              nodesConnectable={false}
              // Selection is how a slice gets its stories. Which nodes can be picked is
              // decided in layout.ts by `selectable`, not here — these props only turn the
              // gesture on.
              //
              // `elementsSelectable`, NOT `nodesSelectable`: the latter is not a React Flow
              // prop at all. tsc accepts it, and it lands in the component's `...rest` and
              // is spread onto the wrapper div, where React logs "does not recognize the
              // nodesSelectable prop on a DOM element" and nothing gates anything. Selection
              // still worked, because this prop defaults to true — an inert line that looks
              // like the thing switching the feature on.
              elementsSelectable
              // Left-drag lassoes, middle/right-drag pans. Left has to give up panning
              // for the lasso to have a button, and `selectionKeyCode={null}` means the
              // lasso needs no modifier held.
              //
              // Safe for the reorder gestures built earlier: xyflow starts a lasso only
              // when the pointerdown lands on the pane ITSELF (`event.target ===
              // container.current`), so a drag beginning on any card — draggable or not —
              // never becomes a selection rectangle.
              selectionOnDrag={!panMode}
              multiSelectionKeyCode="Shift"
              selectionKeyCode={null}
              panOnDrag={panMode ? true : [1, 2]}
              // Not in the brief, and load-bearing. xyflow defaults this TRUE, which routes
              // node selection through drag start instead of click: measured in the browser,
              // a click selected nothing and a 3px twitch selected the card. That costs both
              // halves of the gesture — shift-click could not add to a selection, and every
              // reorder drag silently added the dragged story to it.
              selectNodesOnDrag={false}
              fitView
            >
              <Background />
              <Controls>
                <ControlButton
                  onClick={() => setPanMode((p) => !p)}
                  aria-pressed={panMode}
                  aria-label="Pan mode"
                  title="pan with left-drag (off: left-drag lassoes)"
                >
                  ✋
                </ControlButton>
              </Controls>
              {/* bottom-left, beside the zoom cluster — bottom-right lives under the docked chat */}
              <MiniMap pannable zoomable position="bottom-left" />
              <SlicePanel
                slices={[...cap.slices].sort((a, b) => a.order - b.order)}
                invalidIds={invalidSliceIds}
                activeSliceId={revealed}
                onHover={setHoveredSliceId}
                // `select`, not a setter: it is the same toggle the bands use, so opening
                // the slice already open closes it and the two controls cannot disagree
                // about what is revealed.
                onOpen={(id) => select({ kind: "slice", id })}
                footer={
                  <SliceComposer
                    // The FROZEN count while naming, so the composer keeps offering what
                    // it validated — and does not unmount mid-name if the canvas selection
                    // is emptied underneath it.
                    count={(pendingStoryIds ?? selectedStoryIds).length}
                    blocked={victims}
                    disabled={blocked.length > 0}
                    blockingStory={blockingStory}
                    naming={pendingStoryIds !== null}
                    onStart={() => setPendingStoryIds(selectedStoryIds)}
                    onName={createSliceFromSelection}
                    onCancel={() => setPendingStoryIds(null)}
                  />
                }
              />
            </ReactFlow>
          </div>
          <div className="map-stage__slices">
            {[...cap.slices]
              .sort((a, b) => a.order - b.order)
              .map((slice) => (
                <div key={slice.id} className="slice-band">
                  {/* The band is the map's one selection control, and .slice-band__name
                      stays on the INNER span: three older tests find this band by that
                      selector, so the click target wraps the name rather than becoming
                      it. Selecting the same slice twice clears it — that toggle lives in
                      useMapSelection, not here. */}
                  <button
                    type="button"
                    className="slice-band__select"
                    aria-pressed={revealed === slice.id}
                    onClick={() => select({ kind: "slice", id: slice.id })}
                  >
                    <span className="slice-band__name">{slice.name}</span>
                  </button>
                  <span className="slice-band__fraction">{doneFraction(slice)}</span>
                  {slice.specPath ? (
                    <span className="slice-band__path" title={slice.specPath}>
                      spec ✓
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Generate spec for ${slice.name}`}
                      onClick={() => void generateSpec(slice)}
                    >
                      generate spec
                    </button>
                  )}
                  {slice.planPath ? (
                    <span className="slice-band__path" title={slice.planPath}>
                      plan ✓
                    </span>
                  ) : (
                    <input
                      placeholder="plan path…"
                      {...register(`planTexts.${slice.id}`)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") setPlanPath(slice);
                      }}
                    />
                  )}
                  <button
                    type="button"
                    disabled={Boolean(slice.capCardRef)}
                    title={slice.capCardRef ? "Already on the capabilities board" : undefined}
                    onClick={() => void sendSlice(slice, "capabilities")}
                  >
                    Send {slice.name} to capabilities
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(slice.deliveryCardRef) || !slice.specPath}
                    title={
                      slice.deliveryCardRef
                        ? "Already on the delivery board"
                        : !slice.specPath
                          ? "Generate the spec first"
                          : undefined
                    }
                    onClick={() => void sendSlice(slice, "delivery")}
                  >
                    Send {slice.name} to delivery
                  </button>
                </div>
              ))}
          </div>
        </>
      )}
    </section>
  );
}
