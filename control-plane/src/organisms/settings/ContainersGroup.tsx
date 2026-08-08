import { useState } from "react";
import { useContainers, useSetDockerEnabled, useVerifyContainers } from "../../queries/http";

/**
 * Container backends, as a provider list — docker is the only row today, future backends are
 * new rows (spec §2). The enable toggle and the Verify probe are deliberately independent:
 * enabling never requires or triggers a passing verify; Verify is a diagnostic button only.
 */
export function ContainersGroup() {
  const { data, error: loadError } = useContainers();
  const enabled = data?.docker.enabled ?? false;
  const setDocker = useSetDockerEnabled();
  const verifyContainers = useVerifyContainers();
  const [error, setError] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; detail: string } | null>(null);

  const displayError = error ?? (loadError ? `Could not load containers — ${String(loadError)}` : null);

  const toggle = async (next: boolean) => {
    if (setDocker.isPending) return; // belt-and-suspenders — the checkbox is also disabled while pending
    setError(null);
    try {
      await setDocker.mutateAsync(next);
    } catch (err) {
      setError(`Could not update Docker — ${String(err)}`);
    }
  };

  const verify = async () => {
    try {
      const r = await verifyContainers.mutateAsync();
      setVerifyResult(r);
    } catch (err) {
      setVerifyResult({ ok: false, detail: `verify failed — broker unreachable (${String(err)})` });
    }
  };

  return (
    <>
      <h1>containers</h1>
      <p className="wizard__hint">
        Container backends for local-docker execution. Enabling a provider never requires a passing Verify — Verify is a
        diagnostic probe, independent of the toggle.
      </p>
      {displayError && <p className="wizard__error">{displayError}</p>}
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
                disabled={setDocker.isPending}
                onChange={(e) => void toggle(e.target.checked)}
              />
              <span>Docker</span>
            </label>
          </div>
          <div className="connector-instance">
            <button
              type="button"
              className="settings-btn"
              onClick={() => void verify()}
              disabled={verifyContainers.isPending}
            >
              {verifyContainers.isPending ? "verifying…" : "verify"}
            </button>
          </div>
          {verifyResult && <p className={verifyResult.ok ? "wizard__hint" : "wizard__error"}>{verifyResult.detail}</p>}
        </div>
      </div>
    </>
  );
}
