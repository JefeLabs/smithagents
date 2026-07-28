import { Plus, X } from "lucide-react";
import { useState } from "react";
import type { SessionSummary } from "../hooks/useBrokerChat";

interface SessionsPanelProps {
  open: boolean;
  sessions: SessionSummary[];
  workspaces: string[];
  onClose: () => void;
  onActivate: (id: string) => void;
  onCreate: (workspace?: string) => void;
  onManage?: () => void;
}

/** Session switcher: every conversation lives inside a workspace. */
export function SessionsPanel({
  open,
  sessions,
  workspaces,
  onClose,
  onActivate,
  onCreate,
  onManage,
}: SessionsPanelProps) {
  const [wsFilter, setWsFilter] = useState<string | null>(null);
  if (!open) return null;
  const visible = wsFilter ? sessions.filter((s) => s.workspace === wsFilter) : sessions;
  return (
    <section className="sessions-panel" aria-label="Sessions">
      <header>
        <span className="sessions-panel__title">sessions</span>
        <button type="button" className="sessions-panel__close" onClick={onClose} aria-label="Close sessions">
          <X size={13} strokeWidth={2} />
        </button>
      </header>
      {workspaces.length > 1 && (
        <div className="sessions-panel__filter">
          {[null, ...workspaces].map((ws) => (
            <button
              key={ws ?? "all"}
              type="button"
              className={`ws-chip${wsFilter === ws ? " ws-chip--on" : ""}`}
              onClick={() => setWsFilter(ws)}
            >
              {ws ?? "all"}
            </button>
          ))}
        </div>
      )}
      <div className="sessions-panel__list">
        {visible.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`session-row${s.active ? " session-row--active" : ""}`}
            onClick={() => {
              if (!s.active) onActivate(s.id);
              onClose();
            }}
          >
            <span className="session-row__title">{s.title}</span>
            <span className="session-row__meta">{s.workspace}</span>
          </button>
        ))}
      </div>
      <footer>
        {(workspaces.length > 0 ? workspaces : [undefined]).map((ws) => (
          <button
            key={ws ?? "default"}
            type="button"
            className="session-row session-row--new"
            onClick={() => {
              onCreate(ws);
              onClose();
            }}
          >
            <Plus size={12} strokeWidth={2.2} /> new session{ws ? ` · ${ws}` : ""}
          </button>
        ))}
        {onManage && (
          <button
            type="button"
            className="session-row session-row--manage"
            onClick={() => {
              onManage();
              onClose();
            }}
          >
            manage workspaces…
          </button>
        )}
      </footer>
    </section>
  );
}
