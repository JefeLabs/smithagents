import { X } from "lucide-react";
import type { MouseEvent } from "react";
import { useEffect, useState } from "react";
import type { MeRecord } from "../hooks/useBrokerChat";

interface AccountPanelProps {
  open: boolean;
  onClose: () => void;
  getMe: () => Promise<MeRecord>;
  updateMe: (body: {
    name?: string;
    atlassian?: { email: string; apiToken: string };
    github?: { token: string };
  }) => Promise<MeRecord & { error?: string }>;
  verifyGithubToken: () => Promise<{ ok?: boolean; detail?: string; error?: string }>;
}

/** Your own credentials — not workspace config. Site URLs and project/space keys live on the workspace form instead. */
export function AccountPanel({ open, onClose, getMe, updateMe, verifyGithubToken }: AccountPanelProps) {
  const [me, setMe] = useState<MeRecord | null>(null);
  const [name, setName] = useState("");
  const [atlassianEmail, setAtlassianEmail] = useState("");
  const [atlassianToken, setAtlassianToken] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [testing, setTesting] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-fetch when the panel opens
  useEffect(() => {
    if (!open) return;
    setError(null);
    setTestResult(null);
    void getMe().then((record) => {
      setMe(record);
      setName(record.name);
      setAtlassianEmail(record.atlassianEmail ?? "");
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
      atlassian: atlassianToken.trim() ? { email: atlassianEmail.trim(), apiToken: atlassianToken.trim() } : undefined,
      github: githubToken.trim() ? { token: githubToken.trim() } : undefined,
    }).catch((err: unknown): { error?: string } => ({ error: String(err) }));
    setBusy(false);
    if ("error" in result && result.error) {
      setError(result.error);
      return;
    }
    setMe(result as MeRecord);
    setAtlassianToken("");
    setGithubToken("");
  };

  const testGithub = async () => {
    setTesting(true);
    const r = await verifyGithubToken();
    setTesting(false);
    setTestResult({ ok: Boolean(r.ok), detail: r.detail ?? r.error ?? "unknown" });
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

          <span className="wizard__hint">Atlassian {me?.hasAtlassianToken ? "token saved" : "— not connected"}</span>
          <input
            value={atlassianEmail}
            onChange={(e) => setAtlassianEmail(e.target.value)}
            placeholder="Atlassian account email"
          />
          <input
            type="password"
            value={atlassianToken}
            onChange={(e) => setAtlassianToken(e.target.value)}
            placeholder="Atlassian API token"
          />

          <span className="wizard__hint">GitHub {me?.hasGithubToken ? "— token saved" : "— not connected"}</span>
          <input
            type="password"
            value={githubToken}
            onChange={(e) => setGithubToken(e.target.value)}
            placeholder="GitHub personal access token"
          />
          {me?.hasGithubToken && (
            <button type="button" className="settings-btn" onClick={() => void testGithub()} disabled={testing}>
              {testing ? "testing…" : "Test connection"}
            </button>
          )}
          {testResult && <p className={testResult.ok ? "wizard__hint" : "wizard__error"}>{testResult.detail}</p>}

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
