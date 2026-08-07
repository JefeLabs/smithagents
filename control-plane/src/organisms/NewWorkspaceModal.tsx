import { Plus, X } from "lucide-react";
import { type MouseEvent, useEffect, useState } from "react";
import { SegmentedControl } from "../atoms/SegmentedControl";
import type { ConnectorInstanceRecord, WorkspaceRecord } from "../hooks/useBrokerChat";

interface DraftRepo {
  /** Both modes converge on `path`; only the source of the value differs (design §4). */
  mode: "existing" | "new";
  name: string;
  path: string;
  owner: string;
  repo: string;
  connectorId: string;
}

const emptyRepo = (): DraftRepo => ({ mode: "existing", name: "", path: "", owner: "", repo: "", connectorId: "" });

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
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [linksText, setLinksText] = useState("");
  const [repos, setRepos] = useState<DraftRepo[]>([emptyRepo()]);
  const [connectors, setConnectors] = useState<ConnectorInstanceRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: open-keyed reset, same pattern as WorkspaceManagerModal
  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setLinksText("");
    setRepos([emptyRepo()]);
    setBusy(false);
    setError(null);
    void listMyConnectors().then(setConnectors);
  }, [open]);

  const githubConnectors = connectors.filter((c) => c.vendorId === "github");

  const updateRepo = (index: number, patch: Partial<DraftRepo>) => {
    setRepos((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const browse = async (index: number) => {
    if (!pickFolder) return;
    const picked = await pickFolder();
    if (picked) updateRepo(index, { path: picked });
  };

  const canCreate =
    name.trim().length > 0 &&
    repos.every((r) => r.name.trim() && r.path.trim() && r.owner.trim() && r.repo.trim() && r.connectorId);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const record: WorkspaceRecord = {
      name: name.trim(),
      default: false, // the first-ever workspace defaults itself server-side
      description: description.trim(),
      links: linksText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
      repos: repos.map((r) => ({
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
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    // The server slugs the name ("My App" -> "my-app") — the first session must target the saved name.
    onCreated(result.name ?? record.name);
    onClose();
  };

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
          <input id="nw-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="acme" />
          <label htmlFor="nw-description">Description</label>
          <input
            id="nw-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Marketing site + storefront"
          />
          <label htmlFor="nw-links">
            Links <span className="wizard__hint">one per line — docs, dashboards, tickets</span>
          </label>
          <textarea id="nw-links" value={linksText} onChange={(e) => setLinksText(e.target.value)} rows={3} />
        </div>
        <p className="wizard__hint">Repos — every repo needs a GitHub connector before create enables.</p>
        {githubConnectors.length === 0 && (
          <p className="wizard__hint">No GitHub connectors yet — add one in Settings → Integrations first.</p>
        )}
        {repos.map((repo, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until saved; only appended/removed at the ends
          <div key={i} className="nw-repo-row">
            <SegmentedControl
              ariaLabel={`Repo ${i + 1} source`}
              options={[
                { id: "existing", label: "Existing repo" },
                { id: "new", label: "New folder" },
              ]}
              selected={repo.mode}
              onSelect={(id) => updateRepo(i, { mode: id as DraftRepo["mode"] })}
            />
            <input value={repo.name} onChange={(e) => updateRepo(i, { name: e.target.value })} placeholder="web" />
            <input
              value={repo.path}
              onChange={(e) => updateRepo(i, { path: e.target.value })}
              placeholder={repo.mode === "new" ? "/Users/me/code/new-project" : "/Users/me/code/acme-web"}
            />
            {repo.mode === "new" && pickFolder && (
              <button type="button" className="settings-btn" onClick={() => void browse(i)}>
                Browse…
              </button>
            )}
            <input
              value={repo.owner}
              onChange={(e) => updateRepo(i, { owner: e.target.value })}
              placeholder="GitHub owner"
            />
            <input
              value={repo.repo}
              onChange={(e) => updateRepo(i, { repo: e.target.value })}
              placeholder="GitHub repo"
            />
            <select
              aria-label="GitHub connector"
              value={repo.connectorId}
              onChange={(e) => updateRepo(i, { connectorId: e.target.value })}
            >
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
              onClick={() => setRepos((rs) => rs.filter((_, j) => j !== i))}
              disabled={repos.length <= 1}
              aria-label="Remove repo"
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        ))}
        <button type="button" className="settings-btn" onClick={() => setRepos((rs) => [...rs, emptyRepo()])}>
          <Plus size={11} strokeWidth={2.2} /> add another
        </button>
        {error && <p className="wizard__error">{error}</p>}
        <button
          type="button"
          className="settings-btn settings-btn--primary settings-btn--wide"
          onClick={() => void submit()}
          disabled={busy || !canCreate}
        >
          {busy ? "creating…" : "create workspace"}
        </button>
      </section>
    </div>
  );
}
