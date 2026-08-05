import { Plus, X } from "lucide-react";
import type { MouseEvent } from "react";
import { useEffect, useState } from "react";
import type { WorkspaceRecord } from "../hooks/useBrokerChat";
import { ConfirmSheet } from "../molecules/ConfirmSheet";

interface WorkspaceManagerModalProps {
  open: boolean;
  onClose: () => void;
  list: () => Promise<WorkspaceRecord[]>;
  save: (ws: WorkspaceRecord, isNew: boolean) => Promise<{ error?: string }>;
  remove: (name: string) => Promise<{ outcome?: string; error?: string }>;
  verifyAtlassian: (name: string) => Promise<{ ok?: boolean; detail?: string; error?: string }>;
  verifyRepoGithub: (name: string, repoName: string) => Promise<{ ok?: boolean; detail?: string; error?: string }>;
}

const emptyRepo = () => ({
  name: "",
  path: "",
  branch: "main",
  github: undefined as { owner: string; repo: string } | undefined,
});

/** The "new workspace" starting point — first-ever workspace defaults itself in, mirroring swarm's own rule. */
function blankForm(noWorkspacesYet: boolean): WorkspaceRecord {
  return { name: "", default: noWorkspacesYet, repos: [emptyRepo()] };
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
}: WorkspaceManagerModalProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Workspace name being edited; null means the form is building a new one. */
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<WorkspaceRecord>(blankForm(true));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ name: string; busy?: boolean; error?: string } | null>(null);
  const [testResult, setTestResult] = useState<{ target: string; ok: boolean; detail: string } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const active = workspaces.filter((w) => !w.archived);

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
  // workspace the user never asked to remove this time around.
  // Deliberately keyed on `open` only — `list` is a stable-enough prop
  // function and refetching on every parent render would be pointless.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!open) return;
    setRemoving(null);
    void refresh().then((records) => {
      setSelected(null);
      setForm(blankForm(records.filter((w) => !w.archived).length === 0));
      setError(null);
    });
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
    setForm(blankForm(active.length === 0));
    setError(null);
    setTestResult(null);
  };

  const selectWorkspace = (ws: WorkspaceRecord) => {
    setSelected(ws.name);
    setForm({ ...ws, repos: ws.repos.map((r) => ({ ...r })) });
    setError(null);
    setTestResult(null);
  };

  const updateRepo = (index: number, patch: Partial<WorkspaceRecord["repos"][number]>) => {
    setForm((f) => ({ ...f, repos: f.repos.map((r, i) => (i === index ? { ...r, ...patch } : r)) }));
  };
  const addRepo = () => setForm((f) => ({ ...f, repos: [...f.repos, emptyRepo()] }));
  const removeRepo = (index: number) => setForm((f) => ({ ...f, repos: f.repos.filter((_, i) => i !== index) }));

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

  const submit = async () => {
    setBusy(true);
    setError(null);
    const isNew = selected === null;
    // A half-filled atlassian/github block (project key typed before site URL,
    // or one of owner/repo left blank) must never be submitted as if it were
    // configured — normalize to undefined here rather than fighting each
    // onChange handler, so typing in any order never appears to drop a field.
    const normalized: WorkspaceRecord = {
      ...form,
      atlassian: form.atlassian?.siteUrl?.trim() ? form.atlassian : undefined,
      repos: form.repos.map((r) => ({
        ...r,
        github: r.github?.owner?.trim() && r.github?.repo?.trim() ? r.github : undefined,
      })),
    };
    const result = await save(normalized, isNew).catch((err: unknown): { error?: string } => ({ error: String(err) }));
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    const records = await refresh();
    const saved = records.find((w) => w.name === form.name);
    if (saved) {
      setSelected(saved.name);
      setForm({ ...saved, repos: saved.repos.map((r) => ({ ...r })) });
    }
  };

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
      setForm(blankForm(records.filter((w) => !w.archived).length === 0));
    }
  };

  const canSave = form.name.trim().length > 0 && form.repos.every((r) => r.name.trim() && r.path.trim());

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
                  value={form.name}
                  disabled={selected !== null}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="acme-web"
                />
              </label>
              <label>
                Description
                <input
                  value={form.description ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="Marketing site + storefront"
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={form.default}
                  onChange={(e) => setForm((f) => ({ ...f, default: e.target.checked }))}
                />
                default workspace — used when a delegation names none
              </label>

              <div className="workspace-manager__atlassian">
                <span className="wizard__hint">Atlassian (Jira / Confluence)</span>
                <input
                  value={form.atlassian?.siteUrl ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, atlassian: { ...f.atlassian, siteUrl: e.target.value } }))}
                  placeholder="https://acme.atlassian.net"
                />
                <input
                  value={form.atlassian?.jiraProjectKeys?.[0] ?? ""}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      atlassian: {
                        siteUrl: f.atlassian?.siteUrl ?? "",
                        ...f.atlassian,
                        jiraProjectKeys: e.target.value ? [e.target.value] : undefined,
                      },
                    }))
                  }
                  placeholder="Jira project key (ACME)"
                />
                <input
                  value={form.atlassian?.confluenceSpaceKeys?.[0] ?? ""}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      atlassian: {
                        siteUrl: f.atlassian?.siteUrl ?? "",
                        ...f.atlassian,
                        confluenceSpaceKeys: e.target.value ? [e.target.value] : undefined,
                      },
                    }))
                  }
                  placeholder="Confluence space key (DOCS)"
                />
                {selected && form.atlassian?.siteUrl && (
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
                {form.repos.map((repo, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until saved; only appended/removed at the ends
                  <div key={i} className="repo-row">
                    <input
                      value={repo.name}
                      onChange={(e) => updateRepo(i, { name: e.target.value })}
                      placeholder="web"
                    />
                    <input
                      value={repo.path}
                      onChange={(e) => updateRepo(i, { path: e.target.value })}
                      placeholder="/Users/me/code/acme-web"
                    />
                    <input
                      value={repo.branch}
                      onChange={(e) => updateRepo(i, { branch: e.target.value })}
                      placeholder="main"
                    />
                    <input
                      value={repo.github?.owner ?? ""}
                      onChange={(e) =>
                        updateRepo(i, { github: { owner: e.target.value, repo: repo.github?.repo ?? "" } })
                      }
                      placeholder="GitHub owner"
                    />
                    <input
                      value={repo.github?.repo ?? ""}
                      onChange={(e) =>
                        updateRepo(i, { github: { owner: repo.github?.owner ?? "", repo: e.target.value } })
                      }
                      placeholder="GitHub repo"
                    />
                    {selected && repo.github?.owner && repo.github?.repo && (
                      <button
                        type="button"
                        className="settings-btn"
                        onClick={() => void testRepoGithub(repo.name)}
                        disabled={testing === repo.name}
                      >
                        {testing === repo.name ? "testing…" : "Test"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="repo-row__remove"
                      onClick={() => removeRepo(i)}
                      disabled={form.repos.length <= 1}
                      aria-label="Remove repo"
                    >
                      <X size={12} strokeWidth={2} />
                    </button>
                  </div>
                ))}
                <button type="button" className="settings-btn" onClick={addRepo}>
                  <Plus size={11} strokeWidth={2.2} /> repo
                </button>
              </div>

              {error && <p className="wizard__error">{error}</p>}

              <button
                type="button"
                className="settings-btn settings-btn--primary settings-btn--wide"
                onClick={() => void submit()}
                disabled={busy || !canSave}
              >
                {busy ? "saving…" : selected ? "save changes" : "create workspace"}
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
