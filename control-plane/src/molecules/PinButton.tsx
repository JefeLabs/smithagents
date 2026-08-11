import { useState } from "react";

interface PinButtonProps {
  /** The doc's current pin targets. */
  pins?: string[];
  /** The active session's workspace — the pin target. Absent = no button (nothing to pin to). */
  workspace?: string;
  /** Resolve to the broker's refusal text, or null on success. */
  onPin: (target: string) => Promise<string | null>;
  onUnpin: (target: string) => Promise<string | null>;
}

/**
 * Pin any document to the active workspace (spec: dashboards-as-documents,
 * pin model v2): pinned docs are that workspace's standing context — every
 * new session there opens with them attached.
 */
export function PinButton({ pins, workspace, onPin, onUnpin }: PinButtonProps) {
  const [error, setError] = useState<string | null>(null);
  if (!workspace) return null;
  const pinned = pins?.includes(workspace) ?? false;
  return (
    <>
      <button
        type="button"
        className={`pin-button${pinned ? " pin-button--on" : ""}`}
        aria-pressed={pinned}
        aria-label={pinned ? `Pinned to ${workspace}` : `Pin to ${workspace}`}
        title={
          pinned
            ? `pinned — new ${workspace} sessions open with this doc`
            : `pin to ${workspace} — new sessions there will open with this doc`
        }
        onClick={() => {
          setError(null);
          void (pinned ? onUnpin(workspace) : onPin(workspace)).then((e) => e && setError(e));
        }}
      >
        📌{pinned ? ` ${workspace}` : ""}
      </button>
      {error && (
        <span className="pin-button__error" role="status">
          {error}
        </span>
      )}
    </>
  );
}
