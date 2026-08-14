import { useState } from "react";
import { useCliTools, useResearchEngine, useSaveResearchEngine } from "../../queries/http";

/**
 * Settings → Research engine: which CLI engine (spec 2026-08-14
 * broker-research-engine) runs the broker's tool-free "research" calls —
 * session titles, dictation polish, and the like. Filtered to engines the
 * registry currently reports active. No `kind` check needed: `CliToolListing`
 * (api/types.ts) has no such field, and `/cli-tools` only ever returns CLI
 * engines in the first place.
 */
export function ResearchEngineGroup() {
  const { data: tools } = useCliTools();
  const { data: current } = useResearchEngine();
  const saveEngine = useSaveResearchEngine();
  const [error, setError] = useState<string | null>(null);

  // Same "commit only when the response carries no `error`" contract as VoiceGroup's `save`:
  // a rejected save must never leave the select showing a value the operator didn't choose.
  // `cli: null` is a distinct request from `cli: ""` — it's what clears the setting and
  // returns the broker to its built-in Anthropic fallback (buildResearchEngineUpdate treats
  // a `null` body as "clear", never as an unknown-engine rejection).
  const choose = async (cli: string | null, model?: string) => {
    // A successful CLEAR resolves to a literal `null` body, not `{}` — never assume `res` is an
    // object once the fetch itself has succeeded.
    let res: { cli?: string; model?: string; error?: string } | null;
    try {
      res = await saveEngine.mutateAsync(cli ? { cli, model } : null);
    } catch (err) {
      setError(String(err));
      return;
    }
    if (res?.error) {
      setError(res.error);
      return;
    }
    setError(null);
  };

  if (!tools) {
    return (
      <>
        <h1>research engine</h1>
        <p className="wizard__hint">Loading…</p>
      </>
    );
  }

  const active = tools.filter((t) => t.active);
  const selected = active.find((t) => t.cli === current?.cli);

  if (active.length === 0) {
    return (
      <>
        <h1>research engine</h1>
        <p className="wizard__hint">No CLI tools are ready. Enable one in CLI Tools first.</p>
      </>
    );
  }

  return (
    <>
      <h1>research engine</h1>
      <p className="wizard__hint">
        Pick which CLI engine runs the broker's tool-free research calls — session titles, dictation polish, and
        similar. Falls back to Anthropic when unset or unavailable.
      </p>
      {error && <p className="wizard__error">{error}</p>}
      <div className="account-panel__form">
        <label>
          Research engine
          <select
            value={current?.cli ?? ""}
            onChange={(e) => {
              if (!e.target.value) {
                void choose(null);
                return;
              }
              const tool = active.find((t) => t.cli === e.target.value);
              void choose(e.target.value, tool?.models[0]);
            }}
          >
            <option value="">Off (Anthropic fallback)</option>
            {active.map((t) => (
              <option key={t.cli} value={t.cli}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        {selected && (
          <label>
            Model
            <select
              value={current?.model ?? selected.models[0]}
              onChange={(e) => void choose(selected.cli, e.target.value)}
            >
              {selected.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </>
  );
}
