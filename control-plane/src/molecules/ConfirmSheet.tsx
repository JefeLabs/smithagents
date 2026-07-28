interface ConfirmSheetProps {
  open: boolean;
  title: string;
  body: string;
  /** Omit to hide the confirm action — e.g. while the outcome couldn't be determined. */
  confirmLabel?: string;
  /** Inline failure text from the last preview or confirm attempt. */
  error?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Minimal centered confirm dialog — outcome-stating copy and error text are the caller's job. */
export function ConfirmSheet({ open, title, body, confirmLabel, error, busy, onConfirm, onCancel }: ConfirmSheetProps) {
  if (!open) return null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss; the keyboard path is the section's cancel button
    <div className="confirm-sheet__backdrop" role="presentation" onClick={onCancel}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stops the backdrop's dismiss click from bubbling, not itself a keyboard-operable control */}
      <section className="confirm-sheet" role="alertdialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <p>{body}</p>
        {error && <p className="confirm-sheet__error">{error}</p>}
        <footer>
          <button type="button" onClick={onCancel} disabled={busy}>
            cancel
          </button>
          {confirmLabel && (
            <button type="button" className="confirm-sheet__danger" onClick={onConfirm} disabled={busy}>
              {busy ? "working…" : confirmLabel}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
