import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Map as MapIcon, Plus, X } from "lucide-react";
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

/**
 * Resolves a raw dnd-kit drop target (`over.id`) into the step + insertion
 * index moveStory expects. Mirrors BoardStage's resolveDrop: moveStory's
 * `order` always indexes into the target step's siblings with the active
 * story already excluded, so a same-step forward drag (active story started
 * before the target) must land one slot AFTER the target's position in that
 * excluded list — landing AT it is a no-op, since that's exactly where the
 * active story already sits once excluded. A backward drag (or a
 * cross-step drop) lands AT the target's position, i.e. right before it.
 */
function resolveStoryDrop(
  stories: CapStoryT[],
  activeStoryId: string,
  overId: string,
): { stepId: string; order: number } | null {
  if (overId === activeStoryId) return null;
  const active = stories.find((s) => s.id === activeStoryId);
  if (!active) return null;

  if (overId.startsWith("step:")) {
    const stepId = overId.slice("step:".length);
    const order = stories.filter((s) => s.stepId === stepId && s.id !== activeStoryId).length;
    return { stepId, order };
  }

  const overStory = stories.find((s) => s.id === overId);
  if (!overStory) return null;
  const stepId = overStory.stepId;
  const siblings = stories
    .filter((s) => s.stepId === stepId && s.id !== activeStoryId)
    .sort((a, b) => a.order - b.order);
  const idx = siblings.findIndex((s) => s.id === overId);
  if (idx < 0) return null;

  const forward = active.stepId === stepId && active.order < overStory.order;
  return { stepId, order: forward ? idx + 1 : idx };
}

// Test seam: jsdom cannot synthesize dnd-kit pointer sequences; the drop
// handler is registered here so tests can invoke the exact code path a real
// drop takes.
let storyDropHandler: ((storyId: string, stepId: string, order: number) => Promise<void>) | null = null;
export async function fireStoryDrop(storyId: string, stepId: string, order: number): Promise<void> {
  if (!storyDropHandler) throw new Error("MapStage is not mounted");
  await storyDropHandler(storyId, stepId, order);
}

/** One sortable story chip — the drag handle is the whole chip. */
function SortableStory({
  story,
  sliceOptions,
  sliceValue,
  onSliceChange,
  onRemove,
}: {
  story: CapStoryT;
  sliceOptions: CapSliceT[];
  sliceValue: string;
  onSliceChange: (id: string) => void;
  onRemove: () => void;
}) {
  const sortable = useSortable({ id: story.id });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={`map-story${story.done ? " is-done" : ""}${sortable.isDragging ? " is-dragging" : ""}`}
      title={story.verifiedBy}
    >
      <span className="map-story__handle" {...sortable.attributes} {...sortable.listeners}>
        {story.text}
      </span>
      <select aria-label={`Slice for ${story.text}`} value={sliceValue} onChange={(e) => onSliceChange(e.target.value)}>
        <option value="backlog">backlog</option>
        {sliceOptions.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <button type="button" aria-label={`Remove story: ${story.text}`} onClick={onRemove}>
        <X size={10} strokeWidth={2} />
      </button>
    </div>
  );
}

/** One step's story stack: a droppable zone (for empty-step drops) containing a sortable story list. */
function MapStepStories({
  stepId,
  stories,
  sliceOptions,
  sliceFor,
  onSliceChange,
  onRemove,
}: {
  stepId: string;
  stories: CapStoryT[];
  sliceOptions: CapSliceT[];
  sliceFor: (storyId: string) => string;
  onSliceChange: (storyId: string, sliceId: string) => void;
  onRemove: (story: CapStoryT) => void;
}) {
  const droppable = useDroppable({ id: `step:${stepId}` });
  // `stories` is already sorted (storiesFor sorts before passing it down).
  const sorted = stories;
  return (
    <div ref={droppable.setNodeRef} className={`map-step__stories${droppable.isOver ? " is-over" : ""}`}>
      <SortableContext items={sorted.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        {sorted.map((story) => (
          <SortableStory
            key={story.id}
            story={story}
            sliceOptions={sliceOptions}
            sliceValue={sliceFor(story.id)}
            onSliceChange={(sliceId) => onSliceChange(story.id, sliceId)}
            onRemove={() => onRemove(story)}
          />
        ))}
      </SortableContext>
    </div>
  );
}

/** Every composer input on the stage. The three records are keyed by activity / step / slice id. */
interface MapComposerValues {
  capName: string;
  activityName: string;
  sliceName: string;
  stepNames: Record<string, string>;
  storyTexts: Record<string, string>;
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

  // Every composer on this stage is a write-once text box: type, press Enter, it clears.
  // The three records are keyed by activity/step/slice id and registered as they render,
  // which is why they're one form rather than three `Record<string, string>` states.
  const { register, getValues, setValue } = useForm<MapComposerValues>({
    defaultValues: { capName: "", activityName: "", sliceName: "", stepNames: {}, storyTexts: {}, planTexts: {} },
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

  const patchCap = useCallback(
    async (body: Partial<Pick<CapabilityT, "name" | "activities" | "stories" | "slices">>) => {
      if (!cap) return;
      try {
        await patchCapMutation.mutateAsync({ id: cap.id, body });
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Update failed");
      }
    },
    [cap, patchCapMutation],
  );

  const moveStory = useCallback(
    async (storyId: string, stepId: string, order: number) => {
      if (!cap) return;
      const stories = cap.stories.map((s) => ({ ...s }));
      const story = stories.find((s) => s.id === storyId);
      if (!story) return;
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
      await patchCap({ stories });
    },
    [cap, patchCap],
  );

  useEffect(() => {
    storyDropHandler = moveStory;
    return () => {
      storyDropHandler = null;
    };
  }, [moveStory]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

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

  const addActivity = () => {
    const activityName = getValues("activityName").trim();
    if (!cap || !activityName) return;
    void patchCap({
      activities: [
        ...cap.activities,
        { id: crypto.randomUUID(), name: activityName, order: cap.activities.length, steps: [] },
      ],
    });
    setValue("activityName", "");
  };
  const addStep = (act: CapActivityT) => {
    const name = (getValues(`stepNames.${act.id}`) ?? "").trim();
    if (!cap || !name) return;
    void patchCap({
      activities: cap.activities.map((a) =>
        a.id === act.id ? { ...a, steps: [...a.steps, { id: crypto.randomUUID(), name, order: a.steps.length }] } : a,
      ),
    });
    setValue(`stepNames.${act.id}`, "");
  };
  const addStory = (stepId: string) => {
    const text = (getValues(`storyTexts.${stepId}`) ?? "").trim();
    if (!cap || !text) return;
    void patchCap({
      stories: [
        ...cap.stories,
        { id: crypto.randomUUID(), stepId, order: storiesFor(stepId).length, text, done: false },
      ],
    });
    setValue(`storyTexts.${stepId}`, "");
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

  const handleDragEnd = (e: DragEndEvent) => {
    if (!cap || !e.over) return;
    const storyId = String(e.active.id);
    const overId = String(e.over.id);
    const target = resolveStoryDrop(cap.stories, storyId, overId);
    if (!target) return;
    void moveStory(storyId, target.stepId, target.order);
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
          <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={handleDragEnd}>
            <div className="map-stage__grid">
              {[...cap.activities]
                .sort((a, b) => a.order - b.order)
                .map((act) => (
                  <div key={act.id} className="map-activity">
                    <div className="map-activity__name">
                      {act.name}
                      <button
                        type="button"
                        aria-label={`Remove activity: ${act.name}`}
                        disabled={act.steps.length > 0}
                        title={act.steps.length > 0 ? "Remove its stories first" : undefined}
                        onClick={() => removeActivity(act)}
                      >
                        <X size={10} strokeWidth={2} />
                      </button>
                    </div>
                    <div className="map-activity__steps">
                      {[...act.steps]
                        .sort((a, b) => a.order - b.order)
                        .map((step) => (
                          <div key={step.id} className="map-step">
                            <div className="map-step__name">
                              {step.name}
                              <button
                                type="button"
                                aria-label={`Remove step: ${step.name}`}
                                disabled={storiesFor(step.id).length > 0}
                                title={storiesFor(step.id).length > 0 ? "Remove its stories first" : undefined}
                                onClick={() => removeStep(act, step.id)}
                              >
                                <X size={10} strokeWidth={2} />
                              </button>
                            </div>
                            <MapStepStories
                              stepId={step.id}
                              stories={storiesFor(step.id)}
                              sliceOptions={[...cap.slices].sort((a, b) => a.order - b.order)}
                              sliceFor={sliceFor}
                              onSliceChange={assignSlice}
                              onRemove={removeStory}
                            />
                            <input
                              placeholder="Add a story…"
                              {...register(`storyTexts.${step.id}`)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") addStory(step.id);
                              }}
                            />
                          </div>
                        ))}
                      <div className="map-step map-step--composer">
                        <input
                          placeholder="Add a step…"
                          {...register(`stepNames.${act.id}`)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") addStep(act);
                          }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              <div className="map-activity map-activity--composer">
                <input
                  placeholder="Add an activity…"
                  {...register("activityName")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addActivity();
                  }}
                />
              </div>
            </div>
          </DndContext>
          <div className="map-stage__slices">
            {[...cap.slices]
              .sort((a, b) => a.order - b.order)
              .map((slice) => (
                <div key={slice.id} className="slice-band">
                  <span className="slice-band__name">{slice.name}</span>
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
