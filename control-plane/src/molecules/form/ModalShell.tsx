import { Modal } from "@heroui/react";
import type { ReactNode } from "react";

interface ModalShellProps {
  open: boolean;
  onClose: () => void;
  title: string;
  size?: "sm" | "md" | "lg" | "cover" | "full";
  children: ReactNode;
}

/**
 * Replaces the hand-rolled `.scrim` both workspace modals carried: a bare div with
 * role="dialog", an onScrimClick comparing target to currentTarget, and two lint
 * suppression comments apologising for the a11y rules that pattern breaks.
 *
 * `Modal.Backdrop` is used WITHOUT a `<Modal>` wrapper on purpose. The wrapper
 * exists to pair a trigger with a dialog; these modals are opened from uiStore,
 * so there is no trigger to pair with and `isOpen`/`onOpenChange` drive it directly.
 * Verified against the docs' own "Controlled State" example, which does the same.
 *
 * Rendering null when closed preserves today's behaviour exactly: HomePage keeps
 * both modals permanently mounted and toggles `open`, and their open-keyed
 * `reset()` effects depend on the hooks above the early return still running.
 */
export function ModalShell({ open, onClose, title, size = "md", children }: ModalShellProps) {
  return (
    <Modal.Backdrop
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Container size={size}>
        {/* `aria-label` AND a visible `Modal.Heading` is deliberate, not an oversight.
            Both read from the same `title` prop so they cannot diverge, and the explicit
            label means the dialog has an accessible name even if a caller later passes
            custom header content. Verified against the docs: Modal.Dialog accepts
            `aria-label`, and Modal.Heading exists. Do not "simplify" one of them away. */}
        <Modal.Dialog aria-label={title}>
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>{title}</Modal.Heading>
          </Modal.Header>
          <Modal.Body>{children}</Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
