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
import { useCallback, useEffect, useState } from "react";

const BASE = "127.0.0.1:7790";

export interface CapStoryT {
  id: string;
  stepId: string;
  order: number;
  text: string;
  done: boolean;
  verifiedBy?: string;
}
export interface CapActivityT {
  id: string;
  name: string;
  order: number;
  steps: Array<{ id: string; name: string; order: number }>;
}
export interface CapSliceT {
  id: string;
  name: string;
  order: number;
  storyIds: string[];
  specPath?: string;
  planPath?: string;
  capCardRef?: { boardId: string; cardId: string };
  deliveryCardRef?: { boardId: string; cardId: string };
}
export interface CapabilityT {
  id: string;
  name: string;
  workspaceId: string;
  activities: CapActivityT[];
  stories: CapStoryT[];
  slices: CapSliceT[];
}

interface MapStageProps {
  open: boolean;
  lastCapabilityUpdate: { capabilityId: string; seq: number } | null;
  onClose: () => void;
}

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

/**
 * The story-map stage — where stories are BORN. Activities → steps → story
 * stacks, with slices carved below. Cards and spec docs are downstream
 * views; every text edit happens here and only here.
 */
export function MapStage({ open, lastCapabilityUpdate, onClose }: MapStageProps) {
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [workspace, setWorkspace] = useState("");
  const [capabilities, setCapabilities] = useState<CapabilityT[]>([]);
  const [capErrors, setCapErrors] = useState<Array<{ file: string; error: string }>>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [capName, setCapName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [activityName, setActivityName] = useState("");
  const [stepNames, setStepNames] = useState<Record<string, string>>({});
  const [storyTexts, setStoryTexts] = useState<Record<string, string>>({});
  const [planTexts, setPlanTexts] = useState<Record<string, string>>({});
  const [sliceName, setSliceName] = useState("");

  const refetch = useCallback(async () => {
    try {
      const res = (await fetch(`http://${BASE}/work/capabilities`).then((r) => r.json())) as {
        capabilities?: CapabilityT[];
        errors?: Array<{ file: string; error: string }>;
        error?: string;
      };
      if (res.error) throw new Error(res.error);
      setCapabilities(res.capabilities ?? []);
      setCapErrors(res.errors ?? []);
      setError(null);
      setActiveId((id) => id ?? res.capabilities?.[0]?.id ?? null);
      setWorkspace((w) => w || res.capabilities?.[0]?.workspaceId || "");
    } catch {
      setError("Could not load capabilities — is the broker running?");
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refetch();
    void fetch(`http://${BASE}/workspaces`)
      .then((r) => r.json())
      .then((res: { workspaces?: Array<{ name: string }> }) => {
        const names = (res.workspaces ?? []).map((w) => w.name);
        setWorkspaces(names);
        setWorkspace((w) => w || names[0] || "");
      })
      .catch(() => {});
  }, [open, refetch]);

  useEffect(() => {
    if (open && lastCapabilityUpdate && lastCapabilityUpdate.capabilityId === activeId) void refetch();
  }, [open, lastCapabilityUpdate, activeId, refetch]);

  const cap = capabilities.find((c) => c.id === activeId) ?? null;

  const patchCap = useCallback(
    async (body: Partial<Pick<CapabilityT, "name" | "activities" | "stories" | "slices">>) => {
      if (!cap) return;
      const res = await fetch(`http://${BASE}/work/capabilities/${encodeURIComponent(cap.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => null);
      if (!res?.ok) {
        const payload = (await res?.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? "Update failed");
        return;
      }
      setError(null);
      void refetch();
    },
    [cap, refetch],
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

  if (!open) return null;

  const createCapability = async () => {
    if (!capName.trim() || !workspace) return;
    const res = (await fetch(`http://${BASE}/work/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: capName.trim(), workspaceId: workspace }),
    })
      .then((r) => r.json())
      .catch(() => ({ error: "unreachable" }))) as CapabilityT & { error?: string };
    if (res.error) {
      setError(res.error);
      return;
    }
    setCreating(false);
    setCapName("");
    setActiveId(res.id);
    void refetch();
  };

  const storiesFor = (stepId: string) =>
    (cap?.stories ?? []).filter((s) => s.stepId === stepId).sort((a, b) => a.order - b.order);
  const doneFraction = (slice: CapSliceT) => {
    const stories = (cap?.stories ?? []).filter((s) => slice.storyIds.includes(s.id));
    return `${stories.filter((s) => s.done).length}/${stories.length}`;
  };
  const sliceFor = (storyId: string) => cap?.slices.find((s) => s.storyIds.includes(storyId))?.id ?? "backlog";

  const addActivity = () => {
    if (!cap || !activityName.trim()) return;
    void patchCap({
      activities: [
        ...cap.activities,
        { id: crypto.randomUUID(), name: activityName.trim(), order: cap.activities.length, steps: [] },
      ],
    });
    setActivityName("");
  };
  const addStep = (act: CapActivityT) => {
    const name = (stepNames[act.id] ?? "").trim();
    if (!cap || !name) return;
    void patchCap({
      activities: cap.activities.map((a) =>
        a.id === act.id ? { ...a, steps: [...a.steps, { id: crypto.randomUUID(), name, order: a.steps.length }] } : a,
      ),
    });
    setStepNames((m) => ({ ...m, [act.id]: "" }));
  };
  const addStory = (stepId: string) => {
    const text = (storyTexts[stepId] ?? "").trim();
    if (!cap || !text) return;
    void patchCap({
      stories: [
        ...cap.stories,
        { id: crypto.randomUUID(), stepId, order: storiesFor(stepId).length, text, done: false },
      ],
    });
    setStoryTexts((m) => ({ ...m, [stepId]: "" }));
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
    const res = (await fetch(
      `http://${BASE}/work/capabilities/${encodeURIComponent(cap.id)}/slices/${encodeURIComponent(slice.id)}/spec`,
      {
        method: "POST",
      },
    )
      .then((r) => r.json())
      .catch(() => ({ error: "unreachable" }))) as { error?: string };
    if (res.error) {
      setError(res.error);
      return;
    }
    setError(null);
    void refetch();
  };
  const setPlanPath = (slice: CapSliceT) => {
    const value = (planTexts[slice.id] ?? "").trim();
    if (!cap || !value) return;
    void patchCap({ slices: cap.slices.map((s) => (s.id === slice.id ? { ...s, planPath: value } : s)) });
    setPlanTexts((m) => ({ ...m, [slice.id]: "" }));
  };
  const sendSlice = async (slice: CapSliceT, target: "capabilities" | "delivery") => {
    if (!cap) return;
    const res = (await fetch(
      `http://${BASE}/work/capabilities/${encodeURIComponent(cap.id)}/slices/${encodeURIComponent(slice.id)}/send`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target }),
      },
    )
      .then((r) => r.json())
      .catch(() => ({ error: "unreachable" }))) as { error?: string };
    if (res.error) {
      setError(res.error);
      return;
    }
    setError(null);
    void refetch();
  };
  const addSlice = () => {
    if (!cap || !sliceName.trim()) return;
    void patchCap({
      slices: [
        ...cap.slices,
        { id: crypto.randomUUID(), name: sliceName.trim(), order: cap.slices.length, storyIds: [] },
      ],
    });
    setSliceName("");
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
    <section className="map-stage" aria-label="Story map">
      <header className="map-stage__bar">
        <MapIcon size={14} strokeWidth={2} />
        <select
          aria-label="Workspace"
          value={workspace}
          onChange={(e) => {
            const next = e.target.value;
            setWorkspace(next);
            // Otherwise the capability picker and grid keep showing whatever
            // was active in the previous workspace (I5).
            setActiveId(capabilities.find((c) => c.workspaceId === next)?.id ?? null);
          }}
        >
          {workspaces.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
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
        <span className="spacer" />
        <button type="button" className="settings-btn" onClick={onClose} aria-label="Close map">
          <X size={12} strokeWidth={2} />
        </button>
      </header>
      {creating && (
        <div className="map-stage__composer">
          <input placeholder="Capability name" value={capName} onChange={(e) => setCapName(e.target.value)} />
          <button type="button" className="settings-btn settings-btn--primary" onClick={() => void createCapability()}>
            create capability
          </button>
        </div>
      )}
      {error && <p className="wizard__error">{error}</p>}
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
                              value={storyTexts[step.id] ?? ""}
                              onChange={(e) => setStoryTexts((m) => ({ ...m, [step.id]: e.target.value }))}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") addStory(step.id);
                              }}
                            />
                          </div>
                        ))}
                      <div className="map-step map-step--composer">
                        <input
                          placeholder="Add a step…"
                          value={stepNames[act.id] ?? ""}
                          onChange={(e) => setStepNames((m) => ({ ...m, [act.id]: e.target.value }))}
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
                  value={activityName}
                  onChange={(e) => setActivityName(e.target.value)}
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
                      value={planTexts[slice.id] ?? ""}
                      onChange={(e) => setPlanTexts((m) => ({ ...m, [slice.id]: e.target.value }))}
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
                value={sliceName}
                onChange={(e) => setSliceName(e.target.value)}
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
