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
  const { data: tools = [] } = useCliTools();
  const { data: current } = useResearchEngine();
  const saveEngine = useSaveResearchEngine();
  const [error, setError] = useState<string | null>(null);

  const active = tools.filter((t) => t.active);
  const selected = active.find((t) => t.cli === current?.cli);

  // Same "commit only when the response carries no `error`" contract as VoiceGroup's `save`:
  // a rejected save must never leave the select showing a value the operator didn't choose.
  const choose = async (cli: string, model?: string) => {
    let res: { cli?: string; model?: string; error?: string };
    try {
      res = await saveEngine.mutateAsync({ cli, model });
    } catch (err) {
      setError(String(err));
      return;
    }
    if (res.error) {
      setError(res.error);
      return;
    }
    setError(null);
  };

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
              const tool = active.find((t) => t.cli === e.target.value);
              void choose(e.target.value, tool?.models[0]);
            }}
          >
            <option value="" disabled>
              Choose…
            </option>
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
