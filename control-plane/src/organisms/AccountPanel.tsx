import { X } from "lucide-react";
import type { MouseEvent } from "react";
import { useEffect, useState } from "react";
import type { MeRecord } from "../hooks/useBrokerChat";

interface AccountPanelProps {
  open: boolean;
  onClose: () => void;
  getMe: () => Promise<MeRecord>;
  updateMe: (body: { name?: string }) => Promise<MeRecord & { error?: string }>;
  verifyGithubToken?: () => Promise<{ ok?: boolean; detail?: string; error?: string }>;
}

/** Your own credentials — not workspace config. Site URLs and project/space keys live on the workspace form instead. */
export function AccountPanel({ open, onClose, getMe, updateMe }: AccountPanelProps) {
  const [name, setName] = useState("");
  const [atlassianEmail, setAtlassianEmail] = useState("");
  const [atlassianToken, setAtlassianToken] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-fetch when the panel opens
  useEffect(() => {
    if (!open) return;
    setError(null);
    void getMe().then((record) => {
      setName(record.name);
      setAtlassianEmail("");
      setAtlassianToken("");
      setGithubToken("");
    });
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const result = await updateMe({
      name,
    }).catch((err: unknown): { error?: string } => ({ error: String(err) }));
    setBusy(false);
    if ("error" in result && result.error) {
      setError(result.error);
      return;
    }
    setAtlassianToken("");
    setGithubToken("");
  };

  const onScrimClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click-outside dismiss, same pattern as WorkspaceManagerModal
    <div
      className="scrim"
      data-open="true"
      role="dialog"
      aria-modal="true"
      aria-label="Your account"
      onClick={onScrimClick}
    >
      <section className="account-panel">
        <header className="workspace-manager__head">
          <h2>account</h2>
          <button type="button" className="sessions-panel__close" onClick={onClose} aria-label="Close account panel">
            <X size={13} strokeWidth={2} />
          </button>
        </header>
        <div className="account-panel__form">
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          <span className="wizard__hint">Atlassian — credentials managed in Integrations</span>
          <input
            disabled
            value={atlassianEmail}
            onChange={(e) => setAtlassianEmail(e.target.value)}
            placeholder="Atlassian account email"
          />
          <input
            disabled
            type="password"
            value={atlassianToken}
            onChange={(e) => setAtlassianToken(e.target.value)}
            placeholder="Atlassian API token"
          />

          <span className="wizard__hint">GitHub — credentials managed in Integrations</span>
          <input
            disabled
            type="password"
            value={githubToken}
            onChange={(e) => setGithubToken(e.target.value)}
            placeholder="GitHub personal access token"
          />

          {error && <p className="wizard__error">{error}</p>}

          <button
            type="button"
            className="settings-btn settings-btn--primary settings-btn--wide"
            onClick={() => void submit()}
            disabled={busy}
          >
            {busy ? "saving…" : "save"}
          </button>
        </div>
      </section>
    </div>
  );
}
