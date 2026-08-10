import { Sheet } from "@heroui-pro/react";
import { FileText, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { SessionSummary } from "../api/types";
import { MODE_LABELS } from "./NewSessionScreen";

interface SessionsPanelProps {
  open: boolean;
  sessions: SessionSummary[];
  workspaces: string[];
  onClose: () => void;
  onActivate: (id: string) => void;
  /** Open one of a session's documents: activate the session, then go to the doc. */
  onOpenArtifact: (sessionId: string, docId: string) => void;
  onCreate: (workspace?: string) => void;
  onManage?: () => void;
  /** The workspace the currently active session belongs to — anchors the panel's header. */
  activeWorkspace?: string;
}

/** Session switcher: every conversation lives inside a workspace. */
export function SessionsPanel({
  open,
  sessions,
  workspaces,
  onClose,
  onActivate,
  onOpenArtifact,
  onCreate,
  onManage,
  activeWorkspace,
}: SessionsPanelProps) {
  const [wsFilter, setWsFilter] = useState<string | null>(null);
  // The panel stays mounted across close/reopen, so a filter left pointed at a
  // workspace that just got archived/removed would silently keep scoping the
  // list (and if it was the last non-"all" chip, the whole row disappears
  // with no way to clear it) — drop back to "all" the moment that happens.
  useEffect(() => {
    if (wsFilter && !workspaces.includes(wsFilter)) setWsFilter(null);
  }, [wsFilter, workspaces]);
  const visible = wsFilter ? sessions.filter((s) => s.workspace === wsFilter) : sessions;
  return (
    <Sheet
      isOpen={open}
      placement="left"
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {/* transparent: the panel used to float with no scrim at all — a dimmed backdrop
          would be a bigger visual jump than this migration is asking for. isOpen/onOpenChange
          still get real click-outside + Escape dismissal from Sheet, just without the dim. */}
      <Sheet.Backdrop variant="transparent">
        <Sheet.Content className="w-[230px]">
          <Sheet.Dialog>
            <Sheet.CloseTrigger aria-label="Close sessions" />
            <Sheet.Header>
              <Sheet.Heading>Sessions</Sheet.Heading>
              {activeWorkspace && <span className="sessions-panel__ws">{activeWorkspace}</span>}
            </Sheet.Header>
            <Sheet.Body>
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
                  // A row is a container, not a button: its artifacts are their own
                  // entries, and a button inside a button is invalid.
                  <div key={s.id} className={`session-row${s.active ? " session-row--active" : ""}`}>
                    <button
                      type="button"
                      className="session-row__main"
                      onClick={() => {
                        if (!s.active) onActivate(s.id);
                        onClose();
                      }}
                    >
                      <span className="session-row__title">{s.title}</span>
                      <span className="session-row__meta">
                        {s.workspace}
                        <span className="session-row__runtime">{MODE_LABELS[s.runtime]}</span>
                      </span>
                    </button>
                    {(s.artifacts ?? []).map((docId) => (
                      <button
                        key={docId}
                        type="button"
                        className="session-row__artifact"
                        aria-label={`open document ${docId}`}
                        onClick={() => {
                          onOpenArtifact(s.id, docId);
                          onClose();
                        }}
                      >
                        <FileText size={12} />
                      </button>
                    ))}
                  </div>
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
            </Sheet.Body>
          </Sheet.Dialog>
        </Sheet.Content>
      </Sheet.Backdrop>
    </Sheet>
  );
}
