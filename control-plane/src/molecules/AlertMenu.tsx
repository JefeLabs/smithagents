import { Bell } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
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
  }, [open]);

  const count = alerts.length;

  return (
    <div className="alert-menu" ref={root}>
      <button
        type="button"
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
                const body = (
                  <>
                    <span className="sr-only">{SEVERITY_WORD[severity]}: </span>
                    <span className="alert-menu__text">{text}</span>
                  </>
                );
                return (
                  <li key={id} className={`alert-menu__row alert-menu__row--${severity}`}>
                    {target === undefined ? (
                      <span className="alert-menu__body">{body}</span>
                    ) : (
                      <button
                        type="button"
                        className="alert-menu__body alert-menu__body--pressable"
                        onClick={() => {
                          setOpen(false);
                          onNavigate(target);
                        }}
                      >
                        {body}
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
