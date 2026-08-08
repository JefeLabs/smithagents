import { Plus, X } from "lucide-react";
import { type MouseEvent, useEffect, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import type { ConnectorInstanceRecord, WorkspaceRecord } from "../api/types";
import { SegmentedControl } from "../atoms/SegmentedControl";
import { WORKSPACE_PALETTE } from "../lib/workspace-color";

interface DraftRepo {
  /** Both modes converge on `path`; only the source of the value differs (design §4). */
  mode: "existing" | "new";
  name: string;
  path: string;
  owner: string;
  repo: string;
  connectorId: string;
}

interface NewWorkspaceFormValues {
  name: string;
  description: string;
  linksText: string;
  color: string;
  repos: DraftRepo[];
}

const emptyRepo = (): DraftRepo => ({ mode: "existing", name: "", path: "", owner: "", repo: "", connectorId: "" });

const blankForm = (): NewWorkspaceFormValues => ({
  name: "",
  description: "",
  linksText: "",
  color: "",
  repos: [emptyRepo()],
});

/** Non-blank after trimming — every gate in this form is that same check. */
const filled = (v: string) => v.trim().length > 0;

interface NewWorkspaceModalProps {
  open: boolean;
  onClose: () => void;
  /** POST /workspaces via the broker proxy — same function WorkspaceManagerModal uses. */
  save: (ws: WorkspaceRecord, isNew: boolean) => Promise<{ error?: string; name?: string }>;
  listMyConnectors: () => Promise<ConnectorInstanceRecord[]>;
  /** The session's current workspace name, if any. */
  activeWorkspace?: string;
  /** Native folder picker — absent outside the Tauri shell (Task 7 renders Browse only when provided). */
  pickFolder?: () => Promise<string | null>;
  /** Called with the created (server-slugged) workspace name — the caller creates + activates the first session. */
  onCreated: (name: string) => void;
}

export function NewWorkspaceModal({
  open,
  onClose,
  save,
  listMyConnectors,
  pickFolder,
  onCreated,
}: NewWorkspaceModalProps) {
  const [connectors, setConnectors] = useState<ConnectorInstanceRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  // mode: "onChange" because the create button gates on isValid; under the default
  // onSubmit mode isValid would stay false until a submit that can never happen.
  const {
    register,
    control,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { isValid, isSubmitting },
  } = useForm<NewWorkspaceFormValues>({ mode: "onChange", defaultValues: blankForm() });
  const { fields, append, remove } = useFieldArray({ control, name: "repos" });

  // HomePage keeps this modal mounted and toggles `open`, so useForm's per-mount
  // defaults only ever run once — reopening has to reset explicitly.
  // biome-ignore lint/correctness/useExhaustiveDependencies: open-keyed reset, same pattern as WorkspaceManagerModal
  useEffect(() => {
    if (!open) return;
    reset(blankForm());
    setError(null);
    void listMyConnectors().then(setConnectors);
  }, [open]);

  const githubConnectors = connectors.filter((c) => c.vendorId === "github");

  // Only the repo `mode` needs watching for render: it swaps the path placeholder and
  // the Browse button. Everything else is uncontrolled and read at submit.
  const repoModes = watch("repos");

  const browse = async (index: number) => {
    if (!pickFolder) return;
    const picked = await pickFolder();
    if (picked) setValue(`repos.${index}.path`, picked, { shouldValidate: true });
  };

  const submit = handleSubmit(async (values) => {
    setError(null);
    const record: WorkspaceRecord = {
      name: values.name.trim(),
      default: false, // the first-ever workspace defaults itself server-side
      description: values.description.trim(),
      color: values.color || undefined,
      links: values.linksText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
      repos: values.repos.map((r) => ({
        name: r.name.trim(),
        path: r.path.trim(),
        branch: "main",
        github: { owner: r.owner.trim(), repo: r.repo.trim(), connectorId: r.connectorId },
        ...(r.mode === "new" ? { initGit: true } : {}),
      })),
    };
    const result = await save(record, true).catch((err: unknown): { error?: string; name?: string } => ({
      error: String(err),
    }));
    if (result.error) {
      setError(result.error);
      return;
    }
    // The server slugs the name ("My App" -> "my-app") — the first session must target the saved name.
    onCreated(result.name ?? record.name);
    onClose();
  });

  const onScrimClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  if (!open) return null;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click-outside dismiss, same pattern as WorkspaceManagerModal
    <div
      className="scrim"
      data-open="true"
      role="dialog"
      aria-modal="true"
      aria-label="New workspace"
      onClick={onScrimClick}
    >
      <section className="new-workspace">
        <header className="workspace-manager__head">
          <h3>New workspace</h3>
          <button type="button" className="settings-btn" onClick={onClose}>
            close
          </button>
        </header>
        <div className="account-panel__form">
          <label htmlFor="nw-name">Workspace name</label>
          <input id="nw-name" {...register("name", { validate: filled })} placeholder="acme" />
          <label htmlFor="nw-description">Description</label>
          <input id="nw-description" {...register("description")} placeholder="Marketing site + storefront" />
          <label htmlFor="nw-links">
            Links <span className="wizard__hint">one per line — docs, dashboards, tickets</span>
          </label>
          <textarea id="nw-links" {...register("linksText")} rows={3} />
        </div>
        <fieldset className="swatch-row">
          <legend>Colour</legend>
          {/* "None" is a real option, not just the starting state — without it
              a picked swatch could never be unpicked. It carries the empty
              string so the radio group has a real value to land on. */}
          <label className="swatch swatch--none">
            <input type="radio" {...register("color")} value="" aria-label="No colour" />
            <span />
          </label>
          {WORKSPACE_PALETTE.map((c, i) => (
            <label key={c} className="swatch">
              <input type="radio" {...register("color")} value={c} aria-label={`Colour ${i + 1}`} />
              <span style={{ background: c }} />
            </label>
          ))}
        </fieldset>
        <p className="wizard__hint">Repos — every repo needs a GitHub connector before create enables.</p>
        {githubConnectors.length === 0 && (
          <p className="wizard__hint">No GitHub connectors yet — add one in Settings → Integrations first.</p>
        )}
        {fields.map((field, i) => (
          <div key={field.id} className="nw-repo-row">
            <SegmentedControl
              ariaLabel={`Repo ${i + 1} source`}
              options={[
                { id: "existing", label: "Existing repo" },
                { id: "new", label: "New folder" },
              ]}
              selected={repoModes[i]?.mode ?? "existing"}
              onSelect={(id) => setValue(`repos.${i}.mode`, id as DraftRepo["mode"])}
            />
            <input {...register(`repos.${i}.name`, { validate: filled })} placeholder="web" />
            <input
              {...register(`repos.${i}.path`, { validate: filled })}
              placeholder={repoModes[i]?.mode === "new" ? "/Users/me/code/new-project" : "/Users/me/code/acme-web"}
            />
            {repoModes[i]?.mode === "new" && pickFolder && (
              <button type="button" className="settings-btn" onClick={() => void browse(i)}>
                Browse…
              </button>
            )}
            <input {...register(`repos.${i}.owner`, { validate: filled })} placeholder="GitHub owner" />
            <input {...register(`repos.${i}.repo`, { validate: filled })} placeholder="GitHub repo" />
            <select aria-label="GitHub connector" {...register(`repos.${i}.connectorId`, { required: true })}>
              <option value="" disabled>
                pick a connector…
              </option>
              {githubConnectors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="repo-row__remove"
              onClick={() => remove(i)}
              disabled={fields.length <= 1}
              aria-label="Remove repo"
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        ))}
        <button type="button" className="settings-btn" onClick={() => append(emptyRepo())}>
          <Plus size={11} strokeWidth={2.2} /> add another
        </button>
        {error && <p className="wizard__error">{error}</p>}
        <button
          type="button"
          className="settings-btn settings-btn--primary settings-btn--wide"
          onClick={() => void submit()}
          disabled={isSubmitting || !isValid}
        >
          {isSubmitting ? "creating…" : "create workspace"}
        </button>
      </section>
    </div>
  );
}
