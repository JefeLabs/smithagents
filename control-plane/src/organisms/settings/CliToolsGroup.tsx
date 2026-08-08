import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { CliToolListing } from "../../api/types";

interface CliToolsGroupProps {
  listCliTools: () => Promise<CliToolListing[]>;
  refreshCliTools: (tool?: string) => Promise<CliToolListing[]>;
  setCliToolEnabled: (id: string, enabled: boolean) => Promise<CliToolListing[] | { error: string }>;
}

/** Status pill precedence: reality before preference (spec §6). Exported for tests. */
export function pillFor(t: CliToolListing): { label: string; cls: string } {
  if (!t.status) return { label: "not checked", cls: "connector-status--unconnected" };
  if (!t.status.detected) return { label: "not installed", cls: "connector-status--unconnected" };
  if (t.status.authOk === false) return { label: "needs login", cls: "connector-status--unconnected" };
  if (!t.status.enabled) return { label: "disabled", cls: "connector-status--unconnected" };
  return { label: "active", cls: "connector-status--connected" };
}

/** Card grid, one per catalog engine — machine status, refresh probes, and the opt-out toggle. */
export function CliToolsGroup({ listCliTools, refreshCliTools, setCliToolEnabled }: CliToolsGroupProps) {
  const [tools, setTools] = useState<CliToolListing[]>([]);
  const [busy, setBusy] = useState<string | null>(null); // cli being refreshed, "*" = all
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once load, same convention as IntegrationsGroup
  useEffect(() => {
    void listCliTools().then(setTools, (err: unknown) => setError(`Could not load CLI tools — ${String(err)}`));
  }, []);

  const refresh = async (tool?: string) => {
    setBusy(tool ?? "*");
    setError(null);
    try {
      setTools(await refreshCliTools(tool));
    } catch (err) {
      setError(`Refresh failed — ${String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (t: CliToolListing) => {
    const result = await setCliToolEnabled(t.cli, !(t.status?.enabled ?? true));
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setError(null);
    setTools(result);
  };

  return (
    <>
      <h1>cli tools</h1>
      <p className="wizard__hint">
        Agent CLI tools detected on this machine. Only active tools can be assigned to agents; an agent whose tool goes
        dark is flagged in the rail and blocked from launching.
      </p>
      {error && <p className="wizard__error">{error}</p>}
      <button type="button" className="settings-btn" onClick={() => void refresh()} disabled={busy !== null}>
        <RefreshCw size={12} strokeWidth={2} /> {busy === "*" ? "checking…" : "refresh all"}
      </button>
      <div className="connector-grid">
        {tools.map((t) => {
          const pill = pillFor(t);
          return (
            <div key={t.cli} className="connector-card">
              <div className="connector-card__head">
                <b>{t.label}</b>
                {t.note && <em>{t.note}</em>}
              </div>
              <div className="connector-instance">
                <span className={`connector-status ${pill.cls}`}>{pill.label}</span>
                <span>
                  {t.status?.version ? t.status.version : t.cli}
                  {t.status?.detail ? ` — ${t.status.detail}` : ""}
                </span>
              </div>
              {t.status?.lastCheckedAt && (
                <p className="wizard__hint">last checked {new Date(t.status.lastCheckedAt).toLocaleString()}</p>
              )}
              <div className="connector-instance">
                <button
                  type="button"
                  className="settings-btn"
                  onClick={() => void refresh(t.cli)}
                  disabled={busy !== null}
                >
                  {busy === t.cli ? "checking…" : "refresh"}
                </button>
                {t.status?.detected && (
                  <button type="button" className="settings-btn" onClick={() => void toggle(t)}>
                    {t.status.enabled ? "disable" : "enable"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
