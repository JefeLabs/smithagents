import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import type { GroupT } from "../api/types";
import { anchorToWeekday, WEEKDAYS, weekdayToAnchor } from "../lib/dateRange";

interface GroupFormValues {
  name: string;
  description: string;
  color: string;
  /** The Sprint Filter toggle — when ON, a start day and a length are REQUIRED. */
  sprintEnabled: boolean;
  sprintWeekday: string; // "" | "1".."7" (ISO Mon..Sun)
  sprintLength: string;
  workspaces: string[];
  groups: string[];
}

const BLANK: GroupFormValues = {
  name: "",
  description: "",
  color: "",
  sprintEnabled: false,
  sprintWeekday: "",
  sprintLength: "",
  workspaces: [],
  groups: [],
};

/**
 * Would adding `candidate` as a member of `self` close a loop? True when
 * `self` is already reachable from the candidate through member groups — the
 * picker simply doesn't offer those (Edwin, 2026-08-12: offer "any group or
 * workspace that it is not in"), instead of letting the server 400.
 */
export function wouldCycleWith(candidate: string, self: string, groups: GroupT[]): boolean {
  const byName = new Map(groups.map((g) => [g.name, g]));
  const visited = new Set<string>();
  const reaches = (n: string): boolean => {
    if (n === self) return true;
    if (visited.has(n)) return false;
    visited.add(n);
    return (byName.get(n)?.groups ?? []).some(reaches);
  };
  return reaches(candidate);
}

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
  /** Open the CREATE form on mount — the "New group…" command's landing (Edwin, 2026-08-12). */
  autoStart?: boolean;
  onAutoStarted?: () => void;
}

/**
 * Groups management inside the workspace manager (spec
 * 2026-08-11-workspace-groups §5): create/edit/delete nested groups. Direct
 * self-membership is prevented here (the picker omits the edited group);
 * transitive cycles are the swarm's call and surface as the inline error.
 */
export function GroupsSection({ groups, workspaces, onSave, onDelete, autoStart, onAutoStarted }: GroupsSectionProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, reset, watch } = useForm<GroupFormValues>({ defaultValues: BLANK });
  const sprintEnabled = watch("sprintEnabled");

  const startNew = () => {
    setSelected(null);
    setError(null);
    reset(BLANK);
    setFormOpen(true);
  };

  const sectionRef = useRef<HTMLElement>(null);

  // Mount-only on purpose: the intent is a one-shot command, not a mode — it
  // must not re-open the form after the user cancels. The scroll matters as
  // much as the open: the section sits below the workspace form, and a form
  // that opened off-screen reads as "the wizard has no pickers" (Edwin,
  // 2026-08-12). scrollIntoView is optional-chained for jsdom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot mount intent
  useEffect(() => {
    if (autoStart) {
      startNew();
      onAutoStarted?.();
      sectionRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    }
  }, []);

  const startEdit = (g: GroupT) => {
    setSelected(g.name);
    setError(null);
    reset({
      name: g.name,
      description: g.description ?? "",
      color: g.color ?? "",
      sprintEnabled: Boolean(g.sprint),
      sprintWeekday: g.sprint ? String(anchorToWeekday(g.sprint.anchor)) : "",
      sprintLength: g.sprint ? String(g.sprint.lengthDays) : "",
      workspaces: g.workspaces,
      groups: g.groups,
    });
    setFormOpen(true);
  };

  const submit = handleSubmit(async (v) => {
    setError(null);
    // Sprint Filter ON requires BOTH fields (Edwin, 2026-08-12) — refuse the
    // save rather than silently dropping a half-configured sprint.
    let sprint: { anchor: string; lengthDays: number } | undefined;
    if (v.sprintEnabled) {
      const weekday = Number.parseInt(v.sprintWeekday, 10);
      const lengthDays = Number.parseInt(v.sprintLength, 10);
      if (!Number.isInteger(weekday) || !Number.isInteger(lengthDays) || lengthDays <= 0) {
        setError("Sprint Filter needs a start day and a length in days");
        return;
      }
      sprint = { anchor: weekdayToAnchor(weekday), lengthDays };
    }
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
    <section ref={sectionRef} className="groups-section" aria-label="Workspace groups">
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
            <label className="groups-section__member">
              <input type="checkbox" aria-label="Sprint Filter" {...register("sprintEnabled")} />
              Sprint Filter
            </label>
            {sprintEnabled && (
              <>
                <label className="groups-section__field">
                  Sprint starts on
                  <select aria-label="Sprint starts on" {...register("sprintWeekday")}>
                    <option value="">pick a day…</option>
                    {WEEKDAYS.map((w) => (
                      <option key={w.iso} value={String(w.iso)}>
                        {w.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="groups-section__field">
                  Sprint length (days)
                  <input type="number" min={1} aria-label="Sprint length (days)" {...register("sprintLength")} />
                </label>
              </>
            )}
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
              .filter((g) => (selected ? !wouldCycleWith(g.name, selected, groups) : true))
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
