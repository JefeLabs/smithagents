import { Modal } from "@heroui/react";
import type { ReactNode } from "react";

interface ModalShellProps {
  open: boolean;
  onClose: () => void;
  title: string;
  size?: "sm" | "md" | "lg" | "cover" | "full";
  children: ReactNode;
  /**
   * Forwarded to react-aria's useModalOverlay (via react-aria-components' ModalOverlay,
   * via HeroUI's Modal.Backdrop — confirmed on AriaModalOverlayProps, default false).
   * A caller needs this when it owns a second, nested confirmation surface that must
   * itself get the first crack at Escape: react-aria's overlay handles Escape and calls
   * stopPropagation before any window-level keydown listener the caller might have sees
   * it, so without this, Escape always closes THIS modal first regardless of what else
   * is open on top of it.
   */
  isKeyboardDismissDisabled?: boolean;
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
 * `ModalShell` itself always renders `Modal.Backdrop` — it has no early return of its
 * own; `isOpen={open}` is what react-aria uses to decide whether to mount the portaled
 * dialog. The early return lives in the caller (e.g. WorkspaceManagerModal's `if (!open)
 * return null`, after its hooks), which is what preserves today's behaviour: HomePage
 * keeps these modals permanently mounted and toggles `open`, and their open-keyed
 * `reset()` effects depend on the hooks above that caller-side early return still running
 * on every render, closed or not.
 */
export function ModalShell({
  open,
  onClose,
  title,
  size = "md",
  children,
  isKeyboardDismissDisabled = false,
}: ModalShellProps) {
  return (
    <Modal.Backdrop
      isOpen={open}
      isKeyboardDismissDisabled={isKeyboardDismissDisabled}
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
