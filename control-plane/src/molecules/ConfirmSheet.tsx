interface ConfirmSheetProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Minimal centered confirm dialog — outcome-stating copy is the caller's job. */
export function ConfirmSheet({ open, title, body, confirmLabel, onConfirm, onCancel }: ConfirmSheetProps) {
  if (!open) return null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss; the keyboard path is the section's cancel button
    <div className="confirm-sheet__backdrop" role="presentation" onClick={onCancel}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stops the backdrop's dismiss click from bubbling, not itself a keyboard-operable control */}
      <section className="confirm-sheet" role="alertdialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <p>{body}</p>
        <footer>
          <button type="button" onClick={onCancel}>
            cancel
          </button>
          <button type="button" className="confirm-sheet__danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}
