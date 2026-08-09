import { Background, Controls, MiniMap, type Node, type OnNodeDrag, ReactFlow, useNodesState } from "@xyflow/react";
// Unlayered on purpose. Every selector in this sheet is `.react-flow`-scoped, so
// it cannot reach the card rules components.css contributes to layer(legacy) —
// and being unlayered keeps xyflow's own chrome authoritative over them.
import "@xyflow/react/dist/style.css";
import { Map as MapIcon, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  ARTIFACT_GAP,
  ARTIFACT_PITCH,
  cellAt,
  layoutMap,
  type MapNode,
  SLICE_RAIL_X,
  STEP_W,
  STORIES_Y,
  sliceNodeId,
  stepColumns,
} from "./map/layout";
import { nodeTypes } from "./map/nodeTypes";
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
 * The composers that are still text boxes. Activity, step and story names are NOT
 * here any more: each level's trailing blank CARD is its own composer now, holding
 * its own text and handing it back through `onCommit`. Only the capability name and
 * the slice band's two fields remain, and the records are keyed by slice id.
 */
interface MapComposerValues {
  capName: string;
  sliceName: string;
  planTexts: Record<string, string>;
}

/**
 * The story-map stage — where stories are BORN. Activities → steps → story
 * stacks, with slices carved below. Cards and spec docs are downstream
 * views; every text edit happens here and only here.
 */
export function MapStage() {
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
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each remaining composer is a write-once text box: type, press Enter, it clears.
  // planTexts is keyed by slice id and registered as the bands render, which is why
  // this is one form rather than a `Record<string, string>` state.
  const { register, getValues, setValue } = useForm<MapComposerValues>({
    defaultValues: { capName: "", sliceName: "", planTexts: {} },
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

  // What the map is interrogating. Only the slice kind reveals anything today; the
  // hook's other two exist for the detail views that come later.
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

  // Reports whether the write survived. Only the drag path reads it — a rejected
  // move has to re-seed the canvas, because xyflow holds the dragged node's
  // position locally and would otherwise keep showing a move the server refused.
  const patchCap = useCallback(
    async (body: Partial<Pick<CapabilityT, "name" | "activities" | "stories" | "slices">>) => {
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

  const createCapability = async () => {
    const capName = getValues("capName").trim();
    if (!capName || !workspace) return;
    try {
      const created = await createCapMutation.mutateAsync({ name: capName, workspaceId: workspace });
      setCreating(false);
      setValue("capName", "");
      setActiveId(created.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "unreachable");
    }
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
  const addSlice = () => {
    const sliceName = getValues("sliceName").trim();
    if (!cap || !sliceName) return;
    void patchCap({
      slices: [...cap.slices, { id: crypto.randomUUID(), name: sliceName, order: cap.slices.length, storyIds: [] }],
    });
    setValue("sliceName", "");
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
   */
  const decorate = (base: MapNode[], dimmedIds: Set<string>): Node[] =>
    base.map((n) => {
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
        return { ...n, data: { blank: true, onCommit: (text: string) => addActivity(text) } } as Node;
      }
      if (n.type === "story") {
        const story = n.data.story as CapStoryT;
        return {
          ...n,
          data: {
            story,
            dimmed,
            sliceOptions: [...(cap?.slices ?? [])].sort((a, b) => a.order - b.order),
            sliceValue: sliceFor(story.id),
            onSliceChange: (sliceId: string) => assignSlice(story.id, sliceId),
            onRemove: () => removeStory(story),
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
      const activity = n.data.activity as CapActivityT;
      return { ...n, data: { activity, dimmed, onRemove: () => removeActivity(activity) } } as Node;
    });

  // Positions are derived, never stored — but xyflow needs local node state for a
  // node to follow the cursor mid-drag, so the model is re-seeded into it whenever
  // it changes.
  //
  // KEYED ON `cap` AND `revealedSlice`, and deliberately NOT on `decorate`. `decorate`
  // closes over the create and remove helpers, which are plain consts rebuilt on every
  // render, so it has a fresh identity every render; depending on it here would re-seed
  // every render, and because re-seeding sets state that is an infinite update loop,
  // not merely a slow path. Every handler it injects is a function of `cap` and nothing
  // else, so `cap` is the real dependency. `revealedSlice` is safe to depend on for the
  // opposite reason: it is an element OF `cap.slices`, so its identity only changes when
  // the model or the selection does.
  // biome-ignore lint/correctness/useExhaustiveDependencies: decorate is unstable by construction — see above
  useEffect(() => {
    if (!cap) {
      setNodes([]);
      return;
    }
    const base = layoutMap(cap).nodes;
    if (!revealedSlice) {
      setNodes(decorate(base, new Set()));
      return;
    }

    // Dim every story the revealed slice does not own. `decorate` is the same bridge
    // the plain path uses — revealing only changes which ids land in the dimmed set.
    // Blank story slots match this filter too and it costs nothing: `decorate` handles
    // blanks first and never gives them a `dimmed` field to read.
    const inSlice = new Set(revealedSlice.storyIds);
    const dimmedIds = new Set(base.filter((n) => n.type === "story" && !inSlice.has(n.id)).map((n) => n.id));
    const decorated = decorate(base, dimmedIds);

    const cols = stepColumns(cap.activities);
    const rightEdge = cols.length > 0 ? cols[cols.length - 1].x + STEP_W : 0;
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
        position: { x: SLICE_RAIL_X, y: STORIES_Y },
        data: { name: revealedSlice.name, fraction: `${done}/${revealedSlice.storyIds.length}` },
        draggable: false,
      },
      // `a.id` is already minted by `artifactNodeId` inside `artifactNodesFor` — it is
      // not rebuilt here, for the same reason.
      ...artifactNodesFor(revealedSlice).map((a, i) => ({
        id: a.id,
        type: "artifact" as const,
        position: { x: rightEdge + ARTIFACT_GAP, y: STORIES_Y + i * ARTIFACT_PITCH },
        data: { kind: a.kind, label: a.label },
        draggable: false,
      })),
    ];

    setNodes([...decorated, ...ephemeral]);
  }, [cap, revealedSlice, setNodes]);

  const onNodeDragStop: OnNodeDrag = async (_event, node) => {
    if (!cap) return;
    // A story node's id IS its story id (layout.ts's one asymmetry), so it needs no
    // unwrapping here. Only stories are draggable, so nothing else reaches this.
    const cell = cellAt(node.position, cap);
    // Invalid drop, or a rejected mutation: re-seed from the model. Without this the
    // node keeps its dropped position and shows a move that never happened — and the
    // seeding effect cannot cover it, because on both paths the model never changed.
    if (!cell) {
      setNodes(decorate(layoutMap(cap).nodes, new Set()));
      return;
    }
    const ok = await moveStory(node.id, cell.stepId, cell.order);
    if (!ok) setNodes(decorate(layoutMap(cap).nodes, new Set()));
  };

  return (
    <section className="stage map-stage" aria-label="Story map">
      <header className="map-stage__bar">
        <MapIcon size={14} strokeWidth={2} />
        <select aria-label="Capability" value={activeId ?? ""} onChange={(e) => setActiveId(e.target.value)}>
          {capabilities
            .filter((c) => !workspace || c.workspaceId === workspace)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
        <button type="button" className="settings-btn" onClick={() => setCreating((v) => !v)}>
          <Plus size={12} strokeWidth={2} /> new capability
        </button>
      </header>
      {creating && (
        <div className="map-stage__composer">
          <input placeholder="Capability name" {...register("capName")} />
          <button type="button" className="settings-btn settings-btn--primary" onClick={() => void createCapability()}>
            create capability
          </button>
        </div>
      )}
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
              nodesConnectable={false}
              fitView
            >
              <Background />
              <Controls />
              <MiniMap pannable zoomable />
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
            <div className="slice-band slice-band--composer">
              <input
                placeholder="New slice name…"
                {...register("sliceName")}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addSlice();
                }}
              />
            </div>
          </div>
        </>
      )}
    </section>
  );
}
