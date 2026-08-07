import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ExecutionMode, SessionSummary, WorkspaceRecord } from "../hooks/useBrokerChat";

export interface NewSessionScreenProps {
  workspaces: string[];
  /** Full workspace records — used only for the description + links context preview. */
  records: WorkspaceRecord[] | null;
  /** All sessions across workspaces — used only to derive the default mode. */
  sessions: SessionSummary[];
  /** null = capability probe still in flight; only "local-in-process" renders until it resolves. */
  modes: Record<ExecutionMode, boolean> | null;
  /** Set when the caller already knows the target workspace (spec §3) — the picker becomes static text. */
  lockedWorkspace?: string;
  /** Zero-session boot: this screen is the only thing on screen, so it hides the cancel affordance. */
  forced?: boolean;
  onSend: (workspace: string, runtime: ExecutionMode, prompt: string) => Promise<{ error?: string } | undefined>;
  onCancel: () => void;
}

export const MODE_LABELS: Record<ExecutionMode, string> = {
  "local-in-process": "In process",
  "local-docker": "Local Docker",
  "remote-in-process": "Remote",
  "remote-docker": "Remote Docker",
};

const MODE_ORDER = Object.keys(MODE_LABELS) as ExecutionMode[];

/** modes === null means the capability probe hasn't resolved — the only mode every machine can always run. */
function availableModes(modes: Record<ExecutionMode, boolean> | null): ExecutionMode[] {
  return modes === null ? ["local-in-process"] : MODE_ORDER.filter((m) => modes[m]);
}

/** Most recent session in `ws` whose runtime is still available, else the universal fallback. */
function defaultMode(ws: string, sessions: SessionSummary[], available: ExecutionMode[]): ExecutionMode {
  const recent = sessions
    .filter((s) => s.workspace === ws)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .find((s) => available.includes(s.runtime));
  return recent?.runtime ?? "local-in-process";
}

/** Calm, centered "start a session" screen — not a modal (spec §3). */
export function NewSessionScreen({
  workspaces,
  records,
  sessions,
  modes,
  lockedWorkspace,
  forced,
  onSend,
  onCancel,
}: NewSessionScreenProps) {
  const [pickedWs, setPickedWs] = useState(lockedWorkspace ?? workspaces[0] ?? "");
  const ws = lockedWorkspace ?? pickedWs;
  const available = availableModes(modes);
  const [mode, setMode] = useState<ExecutionMode>(() => defaultMode(ws, sessions, available));
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Recompute the default mode only when the target workspace changes — a manual pick within the
  // same workspace must stick, so `sessions`/`available` are deliberately excluded from the deps.
  // biome-ignore lint/correctness/useExhaustiveDependencies: workspace-keyed recompute, see comment above
  useEffect(() => {
    setMode(defaultMode(ws, sessions, available));
  }, [ws]);

  useEffect(() => {
    if (forced) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [forced, onCancel]);

  const record = records?.find((r) => r.name === ws) ?? null;
  const links = record?.links ?? [];
  const hasContext = Boolean(record?.description || links.length > 0);

  const submit = async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    const result = await onSend(ws, mode, text);
    setBusy(false);
    if (result?.error) setError(result.error);
  };

  return (
    <section className="new-session-screen" aria-label="New session">
      <div className="new-session-screen__card">
        {!forced && (
          <button
            type="button"
            className="new-session-screen__cancel"
            onClick={onCancel}
            aria-label="Cancel new session"
          >
            <X size={13} strokeWidth={2} />
          </button>
        )}
        <h2 className="new-session-screen__title">Start a session</h2>
        <div className="new-session-screen__workspace">
          {lockedWorkspace ? (
            <span className="new-session-screen__workspace-static">{lockedWorkspace}</span>
          ) : (
            <select aria-label="Workspace" value={pickedWs} onChange={(e) => setPickedWs(e.target.value)}>
              {workspaces.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="new-session-screen__modes" role="radiogroup" aria-label="Execution mode">
          {available.map((m) => (
            <label key={m} className="new-session-screen__mode">
              <input type="radio" name="new-session-mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
              {MODE_LABELS[m]}
            </label>
          ))}
        </div>
        {hasContext && (
          <div className="new-session-screen__context">
            {record?.description && <p className="new-session-screen__description">{record.description}</p>}
            {links.length > 0 && (
              <ul className="new-session-screen__links">
                {links.map((link) => (
                  <li key={link}>{link}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <textarea
          className="new-session-screen__prompt"
          aria-label="Describe the task"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should this session work on?"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {error && <p className="new-session-screen__error">{error}</p>}
        <button
          type="button"
          className="new-session-screen__send"
          onClick={() => void submit()}
          disabled={busy || !prompt.trim()}
        >
          {busy ? "starting…" : "start session"}
        </button>
      </div>
    </section>
  );
}
