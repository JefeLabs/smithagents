import { useState } from "react";
import type { ApiKeyListing } from "../../api/types";
import { ConnectorCard } from "../../molecules/ConnectorCard";
import { useApiKeys, useDeleteApiKey, useSaveApiKey, useVerifyApiKey } from "../../queries/http";

/** Status pill precedence mirrors CliToolsGroup: reality before preference. Exported for tests. */
export function pillForApiKey(l: ApiKeyListing): { label: string; cls: string } {
  if (!l.hasKey) return { label: "no key", cls: "connector-status--unconnected" };
  if (l.verified === false) return { label: "needs valid key", cls: "connector-status--unconnected" };
  if (l.verified === "unknown") return { label: "unverified", cls: "connector-status--unconnected" };
  return { label: "valid", cls: "connector-status--connected" };
}

export interface ApiKeysGroupProps {
  /** Same contract as `CliToolsGroupProps["headingLevel"]` — see there for why. */
  headingLevel?: "h1" | "h2";
  /**
   * Registry ids to show, in place of every registered provider.
   *
   * Settings passes nothing and keeps the whole registry — a key someone
   * pasted for a future consumer still belongs on the permanent screen. The
   * wizard's sources step passes `["anthropic", "google"]`, because a wizard
   * that offers a provider nothing in this codebase consumes is collecting a
   * credential that cannot do anything (the user's ruling on Plan 2). An id
   * that isn't in the registry simply matches nothing rather than rendering
   * an empty card.
   */
  only?: readonly string[];
  /**
   * The heading and the line beneath it, for a surrounding screen that speaks
   * in a different voice.
   *
   * The same shape of contextual treatment as `headingLevel` above, added for
   * the same kind of reason. Settings passes neither and keeps its own copy —
   * lowercase "api keys" to match its ten sibling groups, and a blurb that
   * names avatar generation, which is a Settings concern. Inside the wizard
   * that is the system talking in the middle of a screen where Anderson is
   * asking, about a consumer the wizard has never mentioned.
   *
   * Contextual props rather than a wizard-only fork: this component owns
   * save/verify/remove and the error surfacing for all three, and a second
   * implementation would drift from it on the first change to any of them.
   * Copy is the only thing that differs by context, so copy is the only thing
   * a context passes.
   */
  title?: string;
  blurb?: string;
}

/** Card grid, one per registry provider — masked key state, save/verify/remove. */
export function ApiKeysGroup({
  headingLevel: Heading = "h1",
  only,
  title = "api keys",
  blurb = "Provider keys for what subscriptions can\u2019t cover \u2014 verified live, stored on this machine only, never shown back. Subscription CLIs stay the default for agent work; a Google key here accelerates avatar generation.",
}: ApiKeysGroupProps = {}) {
  const { data: allKeys = [], error: loadError } = useApiKeys();
  const keys = only ? allKeys.filter((l) => only.includes(l.id)) : allKeys;
  const save = useSaveApiKey();
  const verify = useVerifyApiKey();
  const remove = useDeleteApiKey();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const displayError = error ?? (loadError ? `Could not load API keys — ${String(loadError)}` : null);

  /** Returns whether the op succeeded, so callers can decide what to do only on success (e.g. clear a draft). */
  const apply = async (id: string, op: () => Promise<ApiKeyListing[] | { error: string }>): Promise<boolean> => {
    setBusy(id);
    setError(null);
    const result = await op();
    setBusy(null);
    if ("error" in result) {
      setError(result.error);
      return false;
    }
    return true;
  };

  return (
    <>
      <Heading className="settings-group__title">{title}</Heading>
      <p className="wizard__hint">{blurb}</p>
      {displayError && <p className="wizard__error">{displayError}</p>}
      <div className="connector-grid">
        {keys.map((l) => (
          <ConnectorCard
            key={l.id}
            label={l.label}
            note={l.description}
            pill={pillForApiKey(l)}
            line={`${l.hasKey ? `•••• ${l.last4}` : "no key on this machine"}${l.detail ? ` — ${l.detail}` : ""}`}
            lastCheckedAt={l.lastCheckedAt}
          >
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
                  void apply(l.id, () => save.mutateAsync({ id: l.id, key: (drafts[l.id] ?? "").trim() })).then(
                    (ok) => {
                      if (ok) setDrafts((d) => ({ ...d, [l.id]: "" }));
                    },
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
                    onClick={() => void apply(l.id, () => verify.mutateAsync(l.id))}
                  >
                    verify
                  </button>
                  <button
                    type="button"
                    className="settings-btn"
                    disabled={busy !== null}
                    onClick={() => void apply(l.id, () => remove.mutateAsync(l.id))}
                  >
                    remove
                  </button>
                </>
              )}
            </div>
          </ConnectorCard>
        ))}
      </div>
    </>
  );
}
