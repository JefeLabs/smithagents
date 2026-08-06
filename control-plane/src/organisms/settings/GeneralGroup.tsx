import { AlertTriangle } from "lucide-react";
import { useState } from "react";

export interface ResetScope {
  runtime: boolean;
  conversations: boolean;
  worktrees: boolean;
  agents: boolean;
}

interface GeneralGroupProps {
  onReset: (scope: ResetScope) => Promise<{ ok?: boolean; error?: string; swarm?: unknown }>;
}

const OPTIONS: Array<{ key: keyof ResetScope; label: string; detail: string; danger?: boolean }> = [
  {
    key: "runtime",
    label: "Kill running instances",
    detail:
      "Stops every local session and task — warm sessions, running CLIs, the queue. Remote workers are never touched.",
  },
  {
    key: "conversations",
    label: "Clear conversations",
    detail: "Deletes all sessions (transcripts + agent memory) and resets squad arrangements to the configured roster.",
  },
  {
    key: "worktrees",
    label: "Prune worktrees",
    detail: "Removes orphaned task worktrees. Branches and pull requests are kept — committed work is never destroyed.",
  },
  {
    key: "agents",
    label: "Remove all agents & squads",
    detail:
      "Empties the roster completely. Persona and squad files are archived on disk (not deleted) — restore by moving them back.",
    danger: true,
  },
];

/** General: the reset surface. Tiered, explicit, and confirmed before it fires. Unchanged behavior from the old SettingsPanel popover — just its own group now. */
export function GeneralGroup({ onReset }: GeneralGroupProps) {
  const [scope, setScope] = useState<ResetScope>({
    runtime: true,
    conversations: true,
    worktrees: false,
    agents: false,
  });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const chosen = OPTIONS.filter((o) => scope[o.key]);

  const run = async () => {
    setBusy(true);
    const report = await onReset(scope).catch((err: unknown) => ({ error: String(err) }));
    setBusy(false);
    setConfirming(false);
    setResult(
      report.error
        ? `Reset failed: ${report.error}`
        : `Reset complete — ${chosen.map((o) => o.label.toLowerCase()).join(", ")}.`,
    );
  };

  return (
    <>
      <h1>general</h1>
      <div className="settings-panel__options">
        {OPTIONS.map((option) => (
          <label key={option.key} className={`settings-option${option.danger ? " settings-option--danger" : ""}`}>
            <input
              type="checkbox"
              checked={scope[option.key]}
              onChange={(e) => {
                setScope((s) => ({ ...s, [option.key]: e.target.checked }));
                setConfirming(false);
                setResult(null);
              }}
            />
            <span>
              <b>{option.label}</b>
              <em>{option.detail}</em>
            </span>
          </label>
        ))}
      </div>
      {result && <div className="settings-panel__result">{result}</div>}
      {confirming ? (
        <div className="settings-panel__confirm">
          <AlertTriangle size={13} strokeWidth={2} />
          <span>This cannot be undone. Proceed?</span>
          <button
            type="button"
            className="settings-btn settings-btn--danger"
            onClick={() => void run()}
            disabled={busy}
          >
            {busy ? "resetting…" : "yes, reset"}
          </button>
          <button type="button" className="settings-btn" onClick={() => setConfirming(false)} disabled={busy}>
            cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="settings-btn settings-btn--danger settings-btn--wide"
          onClick={() => setConfirming(true)}
          disabled={chosen.length === 0}
        >
          reset {chosen.length > 0 ? `(${chosen.length} selected)` : "— nothing selected"}
        </button>
      )}
      <footer className="settings-panel__note">
        Remote workers, git branches, and pull requests always survive a reset.
      </footer>
    </>
  );
}
