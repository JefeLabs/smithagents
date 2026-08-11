import { useRef, useState } from "react";

const GROUP_PIN_PREFIX = "group:";

interface PinButtonProps {
  /** The doc's current pin targets — bare workspace names and group:<name> entries. */
  pins?: string[];
  /** The active session's workspace. Absent = no button (nothing to pin to). */
  workspace?: string;
  /** Every group's name — each is a pin target row. */
  groups?: string[];
  /** Resolve to the broker's refusal text, or null on success. */
  onPin: (target: string) => Promise<string | null>;
  onUnpin: (target: string) => Promise<string | null>;
}

/**
 * "Pin to…" — pin a document to the active workspace or any group (spec
 * 2026-08-11-workspace-groups). Pinned docs are that target's standing
 * context: new sessions in the workspace, or in any of the group's member
 * workspaces (down-only), open with the doc attached.
 *
 * Deliberately NOT listed: other workspaces' pins — "user will have to go to
 * specific workspace to see those pinned shelf items" (decision 5). Only a
 * group: pin naming a deleted group shows here (as stale, unpin-only).
 */
export function PinButton({ pins, workspace, groups, onPin, onUnpin }: PinButtonProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  if (!workspace) return null;

  const pinSet = new Set(pins ?? []);
  const groupNames = groups ?? [];
  const known = new Set(groupNames);
  const stale = [...pinSet].filter(
    (p) => p.startsWith(GROUP_PIN_PREFIX) && !known.has(p.slice(GROUP_PIN_PREFIX.length)),
  );
  const count = pinSet.size;

  const toggle = (target: string) => {
    setError(null);
    void (pinSet.has(target) ? onUnpin(target) : onPin(target)).then((e) => e && setError(e));
  };

  const row = (label: string, target: string) => (
    <button
      key={target}
      type="button"
      role="menuitemcheckbox"
      aria-checked={pinSet.has(target)}
      className={`pin-popover__row${pinSet.has(target) ? " pin-popover__row--on" : ""}`}
      onClick={() => toggle(target)}
    >
      {label}
    </button>
  );

  return (
    <span className="pin-button__wrap">
      <button
        type="button"
        className={`pin-button${count > 0 ? " pin-button--on" : ""}`}
        aria-label="Pin to…"
        aria-expanded={open}
        title="pin — the targets' new sessions open with this doc"
        onClick={() => setOpen((o) => !o)}
      >
        📌{count > 0 ? ` ${count}` : ""}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Pin targets"
          className="pin-popover"
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
        >
          {row(workspace, workspace)}
          {groupNames.map((g) => row(g, GROUP_PIN_PREFIX + g))}
          {stale.map((target) => row(`${target.slice(GROUP_PIN_PREFIX.length)} (gone)`, target))}
        </div>
      )}
      {error && (
        <span className="pin-button__error" role="status">
          {error}
        </span>
      )}
    </span>
  );
}
