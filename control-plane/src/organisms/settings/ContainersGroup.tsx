import { useEffect, useState } from "react";

export interface ContainersGroupProps {
  getContainers: () => Promise<{ docker: { enabled: boolean } }>;
  setDockerEnabled: (enabled: boolean) => Promise<{ docker: { enabled: boolean } }>;
  verifyContainers: () => Promise<{ ok: boolean; detail: string }>;
}

/**
 * Container backends, as a provider list — docker is the only row today, future backends are
 * new rows (spec §2). The enable toggle and the Verify probe are deliberately independent:
 * enabling never requires or triggers a passing verify; Verify is a diagnostic button only.
 */
export function ContainersGroup({ getContainers, setDockerEnabled, verifyContainers }: ContainersGroupProps) {
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; detail: string } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once load, same convention as CliToolsGroup
  useEffect(() => {
    void getContainers().then(
      (r) => setEnabled(r.docker.enabled),
      (err: unknown) => setError(`Could not load containers — ${String(err)}`),
    );
  }, []);

  const toggle = async (next: boolean) => {
    if (saving) return; // belt-and-suspenders — the checkbox is also disabled while pending
    setSaving(true);
    setError(null);
    try {
      const r = await setDockerEnabled(next);
      setEnabled(r.docker.enabled);
    } catch (err) {
      setError(`Could not update Docker — ${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const verify = async () => {
    setVerifying(true);
    try {
      const r = await verifyContainers();
      setVerifyResult(r);
    } catch (err) {
      setVerifyResult({ ok: false, detail: `verify failed — broker unreachable (${String(err)})` });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <>
      <h1>containers</h1>
      <p className="wizard__hint">
        Container backends for local-docker execution. Enabling a provider never requires a passing Verify — Verify is a
        diagnostic probe, independent of the toggle.
      </p>
      {error && <p className="wizard__error">{error}</p>}
      <div className="connector-grid">
        <div className="connector-card">
          <div className="connector-card__head">
            <b>Docker</b>
          </div>
          <div className="connector-instance">
            <span
              className={`connector-status ${enabled ? "connector-status--connected" : "connector-status--unconnected"}`}
            >
              {enabled ? "enabled" : "disabled"}
            </span>
            <span>local-docker execution</span>
          </div>
          <div className="settings-panel__options">
            <label className="settings-option">
              <input
                type="checkbox"
                checked={enabled}
                disabled={saving}
                onChange={(e) => void toggle(e.target.checked)}
              />
              <span>Docker</span>
            </label>
          </div>
          <div className="connector-instance">
            <button type="button" className="settings-btn" onClick={() => void verify()} disabled={verifying}>
              {verifying ? "verifying…" : "verify"}
            </button>
          </div>
          {verifyResult && <p className={verifyResult.ok ? "wizard__hint" : "wizard__error"}>{verifyResult.detail}</p>}
        </div>
      </div>
    </>
  );
}
