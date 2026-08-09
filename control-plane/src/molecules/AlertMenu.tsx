import { Bell } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Alert, useAlerts } from "../queries/alerts";

interface AlertMenuProps {
  /**
   * Called with the alert's `target` — a FLAT router path ("/board",
   * "/work/ana"), never a route pattern. `/work/ana` resolves against the
   * declared `/work/$agentId` route with `agentId` populated, so the caller can
   * hand it straight to `navigate({ to })`; AlertMenu.test.tsx pins that by
   * asserting the router's pathname after a press, not just that this fired.
   */
  onNavigate: (target: string) => void;
}

/** Severity is a colour on screen; it has to be a word for anyone not reading colours. */
const SEVERITY_WORD: Record<Alert["severity"], string> = { warn: "Warning", error: "Error" };

/**
 * The count belongs in the accessible NAME, not only in the badge. A badge is a
 * decorative <span> no screen reader announces, so a static "Alerts" label would
 * leave the one fact this control exists to carry unreadable.
 */
function triggerLabel(count: number): string {
  if (count === 0) return "No alerts";
  return count === 1 ? "1 alert" : `${count} alerts`;
}

/**
 * The navbar's alert control: a bell that names its own state, and a panel
 * listing what is currently wrong.
 *
 * It reads `useAlerts` and holds only open/closed — the list is derived from
 * queries that already exist, so there is nothing to fetch and no refresh path.
 *
 * The panel is a `dialog` rather than a `menu` deliberately: a `menu` requires
 * every child to be a `menuitem`, and an alert with no `target` has nowhere to
 * send a click — it must render as text, not as a control that does nothing.
 */
export function AlertMenu({ onNavigate }: AlertMenuProps) {
  const alerts = useAlerts();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  /**
   * Closing while a ROW holds focus unmounts the focused element underneath the
   * user, dropping focus to <body> and losing their place in the tab order
   * entirely. Every close path that the keyboard can reach therefore hands focus
   * back to the trigger, which always survives. Outside-click is deliberately
   * NOT one of them: there the user is already moving somewhere else, and
   * pulling focus back would fight them.
   */
  // useCallback so the keydown effect below can depend on it honestly. Both
  // `setOpen` and the ref are stable, so the empty dep list is the real answer,
  // not a silenced one — and the listener stops being torn down every render.
  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAndRestoreFocus();
    };
    // mousedown, not click: the press that OPENED the panel has already fired
    // its mousedown by the time this effect runs, so the panel cannot close
    // itself on the very interaction that opened it.
    const onPointerDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener("keydown", onKey);
    addEventListener("mousedown", onPointerDown);
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("mousedown", onPointerDown);
    };
  }, [open, closeAndRestoreFocus]);

  const count = alerts.length;

  return (
    <div className="alert-menu" ref={root}>
      <button
        type="button"
        ref={trigger}
        className="alert-menu__trigger"
        aria-label={triggerLabel(count)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Bell size={18} aria-hidden="true" />
        {count > 0 && (
          <span className="alert-menu__badge" aria-hidden="true">
            {count}
          </span>
        )}
      </button>
      {open && (
        <div className="alert-menu__popover" role="dialog" aria-label="Alerts">
          {count === 0 ? (
            <p className="note alert-menu__empty">Nothing to report</p>
          ) : (
            <ul className="alert-menu__list">
              {alerts.map(({ id, severity, text, target }) => {
                return (
                  <li key={id} className={`alert-menu__row alert-menu__row--${severity}`}>
                    {target === undefined ? (
                      // No accessible NAME to carry the severity here — a plain span
                      // has none — so it rides the reading order as its own text node.
                      <span className="alert-menu__body">
                        <span className="sr-only">{SEVERITY_WORD[severity]}: </span>
                        <span className="alert-menu__text">{text}</span>
                      </span>
                    ) : (
                      <button
                        type="button"
                        // An explicit label, NOT a visually-hidden prefix span. The
                        // accessible-name algorithm trims each text node before
                        // concatenating, so "Error: " + "could not load boards"
                        // computes as "Error:could not load boards" — the separating
                        // space is discarded and the words run together. Naming the
                        // button outright is the only way to control the string.
                        aria-label={`${SEVERITY_WORD[severity]}: ${text}`}
                        className="alert-menu__body alert-menu__body--pressable"
                        onClick={() => {
                          // Same unmount-under-focus problem as Escape: the row
                          // pressed is the element about to disappear, and the
                          // route it navigates to claims no focus of its own.
                          closeAndRestoreFocus();
                          onNavigate(target);
                        }}
                      >
                        <span className="alert-menu__text">{text}</span>
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
