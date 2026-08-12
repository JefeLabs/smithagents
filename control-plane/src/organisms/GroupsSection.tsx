import { Plus, X } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import type { GroupT } from "../api/types";

interface GroupFormValues {
  name: string;
  description: string;
  color: string;
  sprintAnchor: string;
  sprintLength: string;
  workspaces: string[];
  groups: string[];
}

const BLANK: GroupFormValues = {
  name: "",
  description: "",
  color: "",
  sprintAnchor: "",
  sprintLength: "",
  workspaces: [],
  groups: [],
};

interface GroupsSectionProps {
  groups: GroupT[];
  /** Active workspace names — the member-workspace checkboxes. */
  workspaces: string[];
  /** Resolves { error } (e.g. "group would contain itself") rather than throwing. */
  onSave: (
    body: {
      name: string;
      description?: string;
      color?: string;
      workspaces: string[];
      groups: string[];
      sprint?: { anchor: string; lengthDays: number };
    },
    isNew: boolean,
  ) => Promise<{ error?: string }>;
  onDelete: (name: string) => Promise<{ error?: string }>;
}

/**
 * Groups management inside the workspace manager (spec
 * 2026-08-11-workspace-groups §5): create/edit/delete nested groups. Direct
 * self-membership is prevented here (the picker omits the edited group);
 * transitive cycles are the swarm's call and surface as the inline error.
 */
export function GroupsSection({ groups, workspaces, onSave, onDelete }: GroupsSectionProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, reset } = useForm<GroupFormValues>({ defaultValues: BLANK });

  const startNew = () => {
    setSelected(null);
    setError(null);
    reset(BLANK);
    setFormOpen(true);
  };

  const startEdit = (g: GroupT) => {
    setSelected(g.name);
    setError(null);
    reset({
      name: g.name,
      description: g.description ?? "",
      color: g.color ?? "",
      sprintAnchor: g.sprint?.anchor ?? "",
      sprintLength: g.sprint ? String(g.sprint.lengthDays) : "",
      workspaces: g.workspaces,
      groups: g.groups,
    });
    setFormOpen(true);
  };

  const submit = handleSubmit(async (v) => {
    setError(null);
    // Half-filled sprint (anchor XOR length) is not a sprint — opt-in means
    // both or absent, mirroring the workspace form's block rule.
    const anchor = v.sprintAnchor.trim();
    const lengthDays = Number.parseInt(v.sprintLength, 10);
    const sprint = anchor && Number.isInteger(lengthDays) && lengthDays > 0 ? { anchor, lengthDays } : undefined;
    const r = await onSave(
      {
        name: v.name.trim(),
        description: v.description.trim() || undefined,
        color: v.color.trim() || undefined,
        sprint,
        // RHF yields false (not []) when every checkbox of a group is unchecked.
        workspaces: Array.isArray(v.workspaces) ? v.workspaces : [],
        groups: Array.isArray(v.groups) ? v.groups : [],
      },
      selected === null,
    );
    if (r.error) {
      setError(r.error);
      return;
    }
    setFormOpen(false);
    setSelected(null);
  });

  const remove = async (name: string) => {
    setError(null);
    const r = await onDelete(name);
    if (r.error) setError(r.error);
    if (selected === name) {
      setFormOpen(false);
      setSelected(null);
    }
  };

  return (
    <section className="groups-section" aria-label="Workspace groups">
      <div className="groups-section__bar">
        <h3 className="groups-section__title">groups</h3>
        <button type="button" className="settings-btn settings-btn--primary" onClick={startNew}>
          <Plus size={12} strokeWidth={2.2} /> new group
        </button>
      </div>
      <div className="groups-section__list">
        {groups.map((g) => (
          <div key={g.name} className={`workspace-row${selected === g.name ? " workspace-row--active" : ""}`}>
            <button
              type="button"
              className="workspace-row__pick"
              aria-label={`Edit ${g.name}`}
              onClick={() => startEdit(g)}
            >
              <span className="workspace-row__name">{g.name}</span>
              <span className="workspace-row__meta">
                {g.expansion.length} workspace{g.expansion.length === 1 ? "" : "s"}
              </span>
            </button>
            <button
              type="button"
              className="workspace-row__remove"
              onClick={() => void remove(g.name)}
              aria-label={`Remove ${g.name}`}
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        ))}
        {groups.length === 0 && (
          <p className="wizard__hint">No groups yet — group workspaces to give docs a shared context.</p>
        )}
      </div>
      {formOpen && (
        <form className="groups-section__form" onSubmit={submit}>
          <label className="groups-section__field">
            Group name
            <input type="text" aria-label="Group name" disabled={selected !== null} {...register("name")} />
          </label>
          <label className="groups-section__field">
            Description
            <input type="text" aria-label="Description" {...register("description")} />
          </label>
          <label className="groups-section__field">
            Color
            <input type="text" aria-label="Color" placeholder="#7aa2ff" {...register("color")} />
          </label>
          <div className="groups-section__sprint">
            <label className="groups-section__field">
              Sprint anchor
              <input type="date" aria-label="Sprint anchor" {...register("sprintAnchor")} />
            </label>
            <label className="groups-section__field">
              Sprint length (days)
              <input type="number" min={1} aria-label="Sprint length (days)" {...register("sprintLength")} />
            </label>
          </div>
          <fieldset className="groups-section__members">
            <legend>Member workspaces</legend>
            {workspaces.map((ws) => (
              <label key={ws} className="groups-section__member">
                <input type="checkbox" value={ws} {...register("workspaces")} />
                {ws}
              </label>
            ))}
          </fieldset>
          <fieldset className="groups-section__members">
            <legend>Member groups</legend>
            {groups
              .filter((g) => g.name !== selected)
              .map((g) => (
                <label key={g.name} className="groups-section__member">
                  <input type="checkbox" value={g.name} {...register("groups")} />
                  {g.name}
                </label>
              ))}
          </fieldset>
          {error && <p className="wizard__error">{error}</p>}
          <div className="groups-section__actions">
            <button type="submit" className="settings-btn settings-btn--primary">
              save group
            </button>
            <button type="button" className="settings-btn" onClick={() => setFormOpen(false)}>
              cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
