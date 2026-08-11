import { Sheet } from "@heroui-pro/react";
import { FileText, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { SessionSummary } from "../api/types";
import { ConfirmSheet } from "../molecules/ConfirmSheet";
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
  /**
   * Delete a session for good. Resolves to an error string the confirm dialog
   * shows, or null on success. Omit it and no delete affordance renders at all
   * — the panel never offers an action the caller can't perform.
   */
  onDelete?: (id: string) => Promise<string | null>;
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
  onDelete,
}: SessionsPanelProps) {
  const [wsFilter, setWsFilter] = useState<string | null>(null);
  // The session awaiting confirmation. Holds the title too, so the dialog can
  // keep naming it even if the list re-renders underneath.
  const [doomed, setDoomed] = useState<{ id: string; title: string; error?: string; busy?: boolean } | null>(null);
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
                    {onDelete && (
                      // Hover/focus-revealed (CSS): a permanent trash icon on every
                      // row invites the one click nobody can take back.
                      <button
                        type="button"
                        className="session-row__delete"
                        aria-label={`delete session "${s.title}"`}
                        onClick={() => setDoomed({ id: s.id, title: s.title })}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
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
            {/* Inside the dialog on purpose. The Sheet is a react-aria modal, so
                it marks everything outside itself aria-hidden — a confirm
                rendered as the Sheet's sibling is invisible to screen readers
                (and to getByRole) even though it paints on screen. */}
            <ConfirmSheet
              open={doomed !== null}
              title={`Delete "${doomed?.title}"?`}
              body="This conversation and its transcript are erased for good. Documents it produced are kept."
              confirmLabel="delete session"
              error={doomed?.error}
              busy={doomed?.busy}
              onCancel={() => setDoomed(null)}
              onConfirm={() => {
                if (!doomed || !onDelete) return;
                setDoomed({ ...doomed, busy: true, error: undefined });
                void onDelete(doomed.id).then((error) => {
                  // A refused delete keeps the dialog up with the reason: the
                  // row is still there, and silently closing would imply it
                  // worked.
                  setDoomed((current) => (current && error ? { ...current, busy: false, error } : null));
                });
              }}
            />
          </Sheet.Dialog>
        </Sheet.Content>
      </Sheet.Backdrop>
    </Sheet>
  );
}
