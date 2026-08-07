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

  if (!open) return null;
  const cap = capabilities.find((c) => c.id === activeId) ?? null;

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
    cap?.stories.filter((s) => s.stepId === stepId).sort((a, b) => a.order - b.order) ?? [];
  const doneFraction = (slice: CapSliceT) => {
    const stories = (cap?.stories ?? []).filter((s) => slice.storyIds.includes(s.id));
    return `${stories.filter((s) => s.done).length}/${stories.length}`;
  };

  return (
    <section className="map-stage" aria-label="Story map">
      <header className="map-stage__bar">
        <MapIcon size={14} strokeWidth={2} />
        <select aria-label="Workspace" value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
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
          <div className="map-stage__grid">
            {cap.activities
              .sort((a, b) => a.order - b.order)
              .map((act) => (
                <div key={act.id} className="map-activity">
                  <div className="map-activity__name">{act.name}</div>
                  <div className="map-activity__steps">
                    {act.steps
                      .sort((a, b) => a.order - b.order)
                      .map((step) => (
                        <div key={step.id} className="map-step">
                          <div className="map-step__name">{step.name}</div>
                          <div className="map-step__stories">
                            {storiesFor(step.id).map((story) => (
                              <div
                                key={story.id}
                                className={`map-story${story.done ? " is-done" : ""}`}
                                title={story.verifiedBy}
                              >
                                {story.text}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              ))}
          </div>
          <div className="map-stage__slices">
            {cap.slices
              .sort((a, b) => a.order - b.order)
              .map((slice) => (
                <div key={slice.id} className="slice-band">
                  <span className="slice-band__name">{slice.name}</span>
                  <span className="slice-band__fraction">{doneFraction(slice)}</span>
                </div>
              ))}
          </div>
        </>
      )}
    </section>
  );
}
