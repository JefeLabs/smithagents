import { Plus, X } from "lucide-react";
import type { MouseEvent } from "react";
import { useEffect, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import type { ConnectorInstanceRecord, WorkspaceRecord } from "../api/types";
import { WORKSPACE_PALETTE } from "../lib/workspace-color";
import { ConfirmSheet } from "../molecules/ConfirmSheet";

interface WorkspaceManagerModalProps {
  open: boolean;
  onClose: () => void;
  list: () => Promise<WorkspaceRecord[]>;
  save: (ws: WorkspaceRecord, isNew: boolean) => Promise<{ error?: string }>;
  remove: (name: string) => Promise<{ outcome?: string; error?: string }>;
  verifyAtlassian: (name: string) => Promise<{ ok?: boolean; detail?: string; error?: string }>;
  verifyRepoGithub: (name: string, repoName: string) => Promise<{ ok?: boolean; detail?: string; error?: string }>;
  // Optional so HomePage.tsx (wired up in a later task) isn't forced to pass it before
  // it has a real implementation to hand over — defaults to an empty roster below.
  listMyConnectors?: () => Promise<ConnectorInstanceRecord[]>;
}

/**
 * The editable draft. Most fields are plain strings so RHF owns them directly; the
 * record's optional blocks (`atlassian`, a repo's `github`) are rebuilt in `toRecord`
 * at submit, which is where the "half-filled block is not a block" rule already lived.
 *
 * The two Atlassian key lists stay ARRAYS even though the UI exposes a single input
 * each. The input is bound to index 0; entries 1..N are carried through untouched. The
 * schema and the on-disk `.smith/workspaces/*.json` both permit multiple keys, and
 * `PUT /workspaces/:name` replaces the whole `atlassian` block
 * (`swarm/src/server.ts:1477`), so flattening to `[0]` here would silently and
 * permanently drop the tail of a hand-written or externally-produced record on the
 * first unrelated save in this modal.
 */
interface WorkspaceFormValues {
  name: string;
  description: string;
  /** Raw textarea text — kept separate from the record's `links` so a trailing blank line
      while typing isn't immediately collapsed away (same pattern as NewWorkspaceModal). */
  linksText: string;
  /** "" means no colour picked. */
  color: string;
  default: boolean;
  atlassian: {
    siteUrl: string;
    connectorId: string;
    /** Index 0 is the edited one; the rest ride along. */
    jiraProjectKeys: string[];
    confluenceSpaceKeys: string[];
  };
  repos: Array<{
    name: string;
    path: string;
    branch: string;
    owner: string;
    repo: string;
    connectorId: string;
    initGit?: boolean;
  }>;
}

const emptyRepo = () => ({ name: "", path: "", branch: "main", owner: "", repo: "", connectorId: "" });

const noAtlassian = () => ({ siteUrl: "", connectorId: "", jiraProjectKeys: [], confluenceSpaceKeys: [] });

/** Drops blanks (including a cleared index 0) and collapses an empty list to undefined, as the record expects. */
const keyList = (keys: string[]): string[] | undefined => {
  const kept = keys.filter((k) => k.trim());
  return kept.length > 0 ? kept : undefined;
};

/** Non-blank after trimming — the two fields per repo, plus the name, that gate saving. */
const filled = (v: string) => v.trim().length > 0;

/** The "new workspace" starting point — first-ever workspace defaults itself in, mirroring swarm's own rule. */
function blankForm(noWorkspacesYet: boolean): WorkspaceFormValues {
  return {
    name: "",
    description: "",
    linksText: "",
    color: "",
    default: noWorkspacesYet,
    atlassian: noAtlassian(),
    repos: [emptyRepo()],
  };
}

/** A stored record, flattened into the editable draft above. */
function toForm(ws: WorkspaceRecord): WorkspaceFormValues {
  return {
    name: ws.name,
    description: ws.description ?? "",
    linksText: (ws.links ?? []).join("\n"),
    color: ws.color ?? "",
    default: ws.default,
    atlassian: {
      siteUrl: ws.atlassian?.siteUrl ?? "",
      connectorId: ws.atlassian?.connectorId ?? "",
      // Whole arrays, not just [0] — see WorkspaceFormValues.
      jiraProjectKeys: [...(ws.atlassian?.jiraProjectKeys ?? [])],
      confluenceSpaceKeys: [...(ws.atlassian?.confluenceSpaceKeys ?? [])],
    },
    repos: ws.repos.map((r) => ({
      name: r.name,
      path: r.path,
      branch: r.branch,
      owner: r.github?.owner ?? "",
      repo: r.github?.repo ?? "",
      connectorId: r.github?.connectorId ?? "",
      ...(r.initGit ? { initGit: true } : {}),
    })),
  };
}

/**
 * The draft, back into a record to save. A half-filled atlassian/github block
 * (project key typed before site URL, or one of owner/repo left blank) must never
 * be submitted as if it were configured — that normalization happens here rather
 * than in each onChange, so typing in any order never appears to drop a field.
 *
 * NOTE: this is a closed allowlist, unlike the `{...form}` spread it replaced. A field
 * added to `WorkspaceRecord` later will be silently dropped from every save made here
 * until it is listed below. `archived` is the only currently-unrepresented field, and
 * omitting it is safe: `PUT /workspaces/:name` falls back to `existing.archived`
 * (`swarm/src/server.ts:1476`), and this modal only ever lists un-archived workspaces.
 */
function toRecord(v: WorkspaceFormValues): WorkspaceRecord {
  return {
    name: v.name,
    description: v.description,
    default: v.default,
    // PUT reads an absent colour as "keep the existing one", so unpicking
    // has to travel as an empty string to actually clear it. Both routes
    // collapse "" to undefined before saving; the convention is untouched.
    color: v.color,
    links: v.linksText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
    atlassian: v.atlassian.siteUrl.trim()
      ? {
          siteUrl: v.atlassian.siteUrl,
          connectorId: v.atlassian.connectorId || undefined,
          jiraProjectKeys: keyList(v.atlassian.jiraProjectKeys),
          confluenceSpaceKeys: keyList(v.atlassian.confluenceSpaceKeys),
        }
      : undefined,
    repos: v.repos.map((r) => ({
      name: r.name,
      path: r.path,
      branch: r.branch,
      github:
        r.owner.trim() && r.repo.trim()
          ? { owner: r.owner, repo: r.repo, connectorId: r.connectorId || undefined }
          : undefined,
      ...(r.initGit ? { initGit: true } : {}),
    })),
  };
}

/**
 * Create, edit and remove workspaces. Left column lists active workspaces
 * (archived ones are hidden here, not deletable — they're history); the
 * right column is the form, reused for both create and edit.
 */
export function WorkspaceManagerModal({
  open,
  onClose,
  list,
  save,
  remove,
  verifyAtlassian,
  verifyRepoGithub,
  listMyConnectors = async () => [],
}: WorkspaceManagerModalProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [connectors, setConnectors] = useState<ConnectorInstanceRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Workspace name being edited; null means the form is building a new one. */
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ name: string; busy?: boolean; error?: string } | null>(null);
  const [testResult, setTestResult] = useState<{ target: string; ok: boolean; detail: string } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  // mode: "onChange" because the save button gates on isValid — this is the
  // `canSave` rule (name, plus every repo's name and path) expressed as rules.
  const {
    register,
    control,
    handleSubmit,
    reset,
    watch,
    formState: { isValid, isSubmitting },
  } = useForm<WorkspaceFormValues>({ mode: "onChange", defaultValues: blankForm(true) });
  const { fields, append, remove: removeRepoAt } = useFieldArray({ control, name: "repos" });

  const active = workspaces.filter((w) => !w.archived);

  // Owner/repo decide whether a repo row offers its Test button; siteUrl does the same
  // for the Atlassian block. `name` is read back after a save to re-select the record.
  const repoValues = watch("repos");
  const atlassianSiteUrl = watch("atlassian.siteUrl");

  const refresh = async (): Promise<WorkspaceRecord[]> => {
    setLoadError(null);
    const records = await list().catch((err: unknown): WorkspaceRecord[] => {
      setLoadError(`Could not load workspaces — ${String(err)}`);
      return [];
    });
    setWorkspaces(records);
    return records;
  };

  // Reset to a blank "new workspace" form every time the modal opens. Also
  // drops any leftover remove-confirmation from the last time this modal was
  // open — otherwise a stale `removing` could resurface a confirmation for a
  // workspace the user never asked to remove this time around. HomePage keeps
  // this modal mounted and toggles `open`, so useForm's per-mount defaults run
  // only once; the reset here is what actually clears a reopen.
  // Deliberately keyed on `open` only — `list` is a stable-enough prop
  // function and refetching on every parent render would be pointless.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!open) return;
    setRemoving(null);
    void refresh().then((records) => {
      setSelected(null);
      reset(blankForm(records.filter((w) => !w.archived).length === 0));
      setError(null);
    });
  }, [open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: see the existing open-effect above this one for the same reasoning
  useEffect(() => {
    if (!open) return;
    void listMyConnectors().then(setConnectors);
  }, [open]);

  // Escape cancels an open remove-confirmation first; only closes the whole
  // manager once no sheet is in the way, so a stray Escape can't blow past a
  // pending confirmation and dismiss more than the user intended.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (removing) setRemoving(null);
      else onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open, onClose, removing]);

  if (!open) return null;

  const startNew = () => {
    setSelected(null);
    reset(blankForm(active.length === 0));
    setError(null);
    setTestResult(null);
  };

  const selectWorkspace = (ws: WorkspaceRecord) => {
    setSelected(ws.name);
    reset(toForm(ws));
    setError(null);
    setTestResult(null);
  };

  const testAtlassian = async () => {
    if (!selected) return;
    setTesting("atlassian");
    const r = await verifyAtlassian(selected);
    setTesting(null);
    setTestResult({ target: "atlassian", ok: Boolean(r.ok), detail: r.detail ?? r.error ?? "unknown" });
  };

  const testRepoGithub = async (repoName: string) => {
    if (!selected) return;
    setTesting(repoName);
    const r = await verifyRepoGithub(selected, repoName);
    setTesting(null);
    setTestResult({ target: repoName, ok: Boolean(r.ok), detail: r.detail ?? r.error ?? "unknown" });
  };

  const submit = handleSubmit(async (values) => {
    setError(null);
    const isNew = selected === null;
    const result = await save(toRecord(values), isNew).catch((err: unknown): { error?: string } => ({
      error: String(err),
    }));
    if (result.error) {
      setError(result.error);
      return;
    }
    const records = await refresh();
    const saved = records.find((w) => w.name === values.name);
    if (saved) {
      setSelected(saved.name);
      reset(toForm(saved));
    }
  });

  const requestRemoval = (name: string) => setRemoving({ name });

  const confirmRemoval = async () => {
    if (!removing) return;
    const name = removing.name;
    setRemoving((r) => (r ? { ...r, busy: true, error: undefined } : r));
    const result = await remove(name).catch((err: unknown): { outcome?: string; error?: string } => ({
      error: String(err),
    }));
    if (result.error) {
      setRemoving((r) => (r ? { ...r, busy: false, error: result.error } : r));
      return;
    }
    setRemoving(null);
    const records = await refresh();
    if (selected === name) {
      setSelected(null);
      reset(blankForm(records.filter((w) => !w.archived).length === 0));
    }
  };

  const onScrimClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click-outside dismiss; the keyboard path is the Escape handler bound while open */}
      <div
        className="scrim"
        data-open="true"
        role="dialog"
        aria-modal="true"
        aria-label="Manage workspaces"
        onClick={onScrimClick}
      >
        <section className="workspace-manager">
          <header className="workspace-manager__head">
            <h2>workspaces</h2>
            <button
              type="button"
              className="sessions-panel__close"
              onClick={onClose}
              aria-label="Close workspace manager"
            >
              <X size={13} strokeWidth={2} />
            </button>
          </header>
          {loadError && <p className="wizard__error">{loadError}</p>}
          <div className="workspace-manager__body">
            <div className="workspace-manager__list">
              <button
                type="button"
                className="settings-btn settings-btn--primary settings-btn--wide"
                onClick={startNew}
              >
                <Plus size={12} strokeWidth={2.2} /> new workspace
              </button>
              {active.map((ws) => (
                <div key={ws.name} className={`workspace-row${selected === ws.name ? " workspace-row--active" : ""}`}>
                  <button type="button" className="workspace-row__pick" onClick={() => selectWorkspace(ws)}>
                    <span className="workspace-row__name">{ws.name}</span>
                    <span className="workspace-row__meta">
                      {ws.repos.length} repo{ws.repos.length === 1 ? "" : "s"}
                      {ws.default && <span className="chip is-picked">default</span>}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="workspace-row__remove"
                    onClick={() => requestRemoval(ws.name)}
                    aria-label={`Remove ${ws.name}`}
                  >
                    <X size={12} strokeWidth={2} />
                  </button>
                </div>
              ))}
              {active.length === 0 && <p className="wizard__hint">No workspaces yet — create one to get started.</p>}
            </div>

            <div className="workspace-manager__form">
              <label>
                Name
                <input
                  {...register("name", { validate: filled })}
                  disabled={selected !== null}
                  placeholder="acme-web"
                />
              </label>
              <label>
                Description
                <input {...register("description")} placeholder="Marketing site + storefront" />
              </label>
              <label>
                Links <span className="wizard__hint">one per line — docs, dashboards, tickets</span>
                <textarea {...register("linksText")} rows={3} placeholder="https://github.com/acme/web" />
              </label>
              <fieldset className="swatch-row">
                <legend>Colour</legend>
                {/* "None" is a real option, not just the starting state — without
                    it a workspace colour could never be cleared once set. It
                    carries the empty string the PUT reads as "clear this". */}
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
              <label className="check">
                <input type="checkbox" {...register("default")} />
                default workspace — used when a delegation names none
              </label>

              <div className="workspace-manager__atlassian">
                <span className="wizard__hint">Atlassian (Jira / Confluence)</span>
                <input {...register("atlassian.siteUrl")} placeholder="https://acme.atlassian.net" />
                <label htmlFor="atlassian-connector">
                  Atlassian connector
                  <select
                    id="atlassian-connector"
                    aria-label="Atlassian connector"
                    {...register("atlassian.connectorId")}
                  >
                    <option value="">— none picked —</option>
                    {connectors
                      .filter((c) => c.vendorId === "atlassian")
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                  </select>
                </label>
                {/* Bound to index 0; any further stored keys are preserved by toRecord. */}
                <input {...register("atlassian.jiraProjectKeys.0")} placeholder="Jira project key (ACME)" />
                <input {...register("atlassian.confluenceSpaceKeys.0")} placeholder="Confluence space key (DOCS)" />
                {selected && atlassianSiteUrl && (
                  <button
                    type="button"
                    className="settings-btn"
                    onClick={() => void testAtlassian()}
                    disabled={testing === "atlassian"}
                  >
                    {testing === "atlassian" ? "testing…" : "Test connection"}
                  </button>
                )}
                {testResult?.target === "atlassian" && (
                  <p className={testResult.ok ? "wizard__hint" : "wizard__error"}>{testResult.detail}</p>
                )}
              </div>

              <div className="workspace-manager__repos">
                <span className="wizard__hint">Repos</span>
                {fields.map((field, i) => (
                  <div key={field.id} className="repo-row">
                    <input {...register(`repos.${i}.name`, { validate: filled })} placeholder="web" />
                    <input
                      {...register(`repos.${i}.path`, { validate: filled })}
                      placeholder="/Users/me/code/acme-web"
                    />
                    <input {...register(`repos.${i}.branch`)} placeholder="main" />
                    <input {...register(`repos.${i}.owner`)} placeholder="GitHub owner" />
                    <input {...register(`repos.${i}.repo`)} placeholder="GitHub repo" />
                    <select aria-label="GitHub connector" {...register(`repos.${i}.connectorId`)}>
                      <option value="">— none picked —</option>
                      {connectors
                        .filter((c) => c.vendorId === "github")
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}
                          </option>
                        ))}
                    </select>
                    {selected && repoValues[i]?.owner && repoValues[i]?.repo && (
                      <button
                        type="button"
                        className="settings-btn"
                        onClick={() => void testRepoGithub(repoValues[i]?.name ?? "")}
                        disabled={testing === repoValues[i]?.name}
                      >
                        {testing === repoValues[i]?.name ? "testing…" : "Test"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="repo-row__remove"
                      onClick={() => removeRepoAt(i)}
                      disabled={fields.length <= 1}
                      aria-label="Remove repo"
                    >
                      <X size={12} strokeWidth={2} />
                    </button>
                  </div>
                ))}
                <button type="button" className="settings-btn" onClick={() => append(emptyRepo())}>
                  <Plus size={11} strokeWidth={2.2} /> repo
                </button>
              </div>

              {error && <p className="wizard__error">{error}</p>}

              <button
                type="button"
                className="settings-btn settings-btn--primary settings-btn--wide"
                onClick={() => void submit()}
                disabled={isSubmitting || !isValid}
              >
                {isSubmitting ? "saving…" : selected ? "save changes" : "create workspace"}
              </button>
            </div>
          </div>
        </section>
      </div>

      <ConfirmSheet
        open={removing !== null}
        title={`Remove ${removing?.name}?`}
        body="Workspaces that have never hosted a session or task are removed permanently; otherwise this one will be archived and kept for history."
        confirmLabel="remove"
        error={removing?.error}
        busy={removing?.busy}
        onConfirm={() => void confirmRemoval()}
        onCancel={() => setRemoving(null)}
      />
    </>
  );
}
