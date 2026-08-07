import { useEffect, useState } from "react";
import type { ApiKeyListing } from "../../hooks/useBrokerChat";

interface ApiKeysGroupProps {
  listApiKeys: () => Promise<ApiKeyListing[]>;
  saveApiKey: (id: string, key: string) => Promise<ApiKeyListing[] | { error: string }>;
  verifyApiKey: (id: string) => Promise<ApiKeyListing[] | { error: string }>;
  deleteApiKey: (id: string) => Promise<ApiKeyListing[] | { error: string }>;
}

/** Status pill precedence mirrors CliToolsGroup: reality before preference. Exported for tests. */
export function pillForApiKey(l: ApiKeyListing): { label: string; cls: string } {
  if (!l.hasKey) return { label: "no key", cls: "connector-status--unconnected" };
  if (l.verified === false) return { label: "needs valid key", cls: "connector-status--unconnected" };
  if (l.verified === "unknown") return { label: "unverified", cls: "connector-status--unconnected" };
  return { label: "valid", cls: "connector-status--connected" };
}

/** Card grid, one per registry provider — masked key state, save/verify/remove. */
export function ApiKeysGroup({ listApiKeys, saveApiKey, verifyApiKey, deleteApiKey }: ApiKeysGroupProps) {
  const [keys, setKeys] = useState<ApiKeyListing[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once load, same convention as CliToolsGroup
  useEffect(() => {
    void listApiKeys().then(setKeys, (err: unknown) => setError(`Could not load API keys — ${String(err)}`));
  }, []);

  const apply = async (id: string, op: () => Promise<ApiKeyListing[] | { error: string }>) => {
    setBusy(id);
    setError(null);
    const result = await op();
    setBusy(null);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setKeys(result);
  };

  return (
    <>
      <h1>api keys</h1>
      <p className="wizard__hint">
        Provider keys for what subscriptions can’t cover — verified live, stored on this machine only, never shown back.
        Subscription CLIs stay the default for agent work; a Google key here accelerates avatar generation.
      </p>
      {error && <p className="wizard__error">{error}</p>}
      <div className="connector-grid">
        {keys.map((l) => {
          const pill = pillForApiKey(l);
          return (
            <div key={l.id} className="connector-card">
              <div className="connector-card__head">
                <b>{l.label}</b>
                <em>{l.description}</em>
              </div>
              <div className="connector-instance">
                <span className={`connector-status ${pill.cls}`}>{pill.label}</span>
                <span>
                  {l.hasKey ? `•••• ${l.last4}` : "no key on this machine"}
                  {l.detail ? ` — ${l.detail}` : ""}
                </span>
              </div>
              {l.lastCheckedAt && (
                <p className="wizard__hint">last checked {new Date(l.lastCheckedAt).toLocaleString()}</p>
              )}
              <label>
                API key
                <input
                  type="password"
                  value={drafts[l.id] ?? ""}
                  placeholder={l.hasKey ? "paste a new key to replace" : "paste key"}
                  onChange={(e) => setDrafts((d) => ({ ...d, [l.id]: e.target.value }))}
                />
              </label>
              <div className="connector-instance">
                <button
                  type="button"
                  className="settings-btn"
                  disabled={busy !== null || !(drafts[l.id] ?? "").trim()}
                  onClick={() =>
                    void apply(l.id, () => saveApiKey(l.id, (drafts[l.id] ?? "").trim())).then(() =>
                      setDrafts((d) => ({ ...d, [l.id]: "" })),
                    )
                  }
                >
                  {busy === l.id ? "saving…" : "save"}
                </button>
                {l.hasKey && (
                  <>
                    <button
                      type="button"
                      className="settings-btn"
                      disabled={busy !== null}
                      onClick={() => void apply(l.id, () => verifyApiKey(l.id))}
                    >
                      verify
                    </button>
                    <button
                      type="button"
                      className="settings-btn"
                      disabled={busy !== null}
                      onClick={() => void apply(l.id, () => deleteApiKey(l.id))}
                    >
                      remove
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
