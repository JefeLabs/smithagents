import { Sheet } from "@heroui-pro/react";
import { FileText, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { SessionSummary } from "../api/types";
import { inDateRange, type RangeBounds } from "../lib/dateRange";
import { ConfirmSheet } from "../molecules/ConfirmSheet";
import { MODE_LABELS } from "./NewSessionScreen";

interface SessionsPanelProps {
  open: boolean;
  sessions: SessionSummary[];
  /** The context window's WHEN (date-range spec 2026-08-12); null/absent = All time. */
  rangeBounds?: RangeBounds | null;
  /**
   * The context window's WHERE: workspace names the current workspace/group
   * selection expands to (Edwin, 2026-08-12: "current workspace/group and
   * date should affect what shows"). Sessions outside it leave the list —
   * except the ACTIVE one. null/absent = unscoped.
   */
  contextWorkspaces?: readonly string[] | null;
  /**
   * The navbar's context pair (workspace/group + date range droplists),
   * re-hosted at the top of the panel so the scope is visible AND switchable
   * where it takes effect. A slot, not an import: the panel stays free of
   * query providers for tests.
   */
  contextSlot?: ReactNode;
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
  rangeBounds,
  contextWorkspaces,
  contextSlot,
  workspaces,
  onClose,
  onActivate,
  onOpenArtifact,
  onCreate,
  onManage,
  activeWorkspace,
  onDelete,
}: SessionsPanelProps) {
  // The session awaiting confirmation. Holds the title too, so the dialog can
  // keep naming it even if the list re-renders underneath.
  const [doomed, setDoomed] = useState<{ id: string; title: string; error?: string; busy?: boolean } | null>(null);
  // The context window scopes BOTH axes (Edwin, 2026-08-12): WHERE — only the
  // current workspace/group's sessions; WHEN — only sessions active in the
  // picked range. The ACTIVE session always stays; never hide the ground you
  // stand on. Reaching another context's sessions is what the droplists at
  // the top of the panel are for.
  const wsVisible = contextWorkspaces
    ? sessions.filter((s) => s.active || contextWorkspaces.includes(s.workspace))
    : sessions;
  const visible = rangeBounds ? wsVisible.filter((s) => s.active || inDateRange(s.updatedAt, rangeBounds)) : wsVisible;
  // New-session rows follow the same scope — creating a session in a
  // workspace you are not looking at belongs behind a context switch.
  const creatable = contextWorkspaces ? workspaces.filter((ws) => contextWorkspaces.includes(ws)) : workspaces;
  return (
    <Sheet
      isOpen={open}
      placement="left"
      onOpenChange={(next) => {
        // The context droplists portal their popovers to <body>, OUTSIDE the
        // Sheet's DOM — so react-aria reads a click on an option as an
        // outside interaction and asks to dismiss the whole panel
        // (smoke-caught 2026-08-12). While any listbox is up, the user is
        // mid-pick, not leaving: swallow the dismissal. Plain outside clicks
        // (no popover open) still close the panel as before.
        if (!next) {
          if (document.querySelector('[role="listbox"]')) return;
          onClose();
        }
      }}
    >
      {/* transparent: the panel used to float with no scrim at all — a dimmed backdrop
          would be a bigger visual jump than this migration is asking for. isOpen/onOpenChange
          still get real click-outside + Escape dismissal from Sheet, just without the dim. */}
      <Sheet.Backdrop variant="transparent">
        <Sheet.Content className="w-[260px]">
          <Sheet.Dialog>
            <Sheet.CloseTrigger aria-label="Close sessions" />
            <Sheet.Header>
              <Sheet.Heading>Sessions</Sheet.Heading>
              {activeWorkspace && <span className="sessions-panel__ws">{activeWorkspace}</span>}
            </Sheet.Header>
            <Sheet.Body>
              {contextSlot && <div className="sessions-panel__context">{contextSlot}</div>}
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
                    {onDelete && (
                      // Hover/focus-revealed (CSS): a permanent trash icon on every
                      // row invites the one click nobody can take back. Sits on the
                      // title row (top-right); the artifacts wrap onto their own line.
                      <button
                        type="button"
                        className="session-row__delete"
                        aria-label={`delete session "${s.title}"`}
                        onClick={() => setDoomed({ id: s.id, title: s.title })}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                    {(s.artifacts ?? []).length > 0 && (
                      // Their own full-width wrapping row under the title — a session
                      // with several documents flows onto extra lines instead of
                      // overflowing the 260px panel and overlapping the title.
                      <div className="session-row__artifacts">
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
                    )}
                  </div>
                ))}
              </div>
              <footer>
                {(creatable.length > 0 ? creatable : [undefined]).map((ws) => (
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
