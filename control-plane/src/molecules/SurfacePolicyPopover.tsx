import { useEffect } from "react";
import { SegmentedControl } from "../atoms/SegmentedControl";
import { joinNowVisible, SURFACES, type SurfaceMode, useSurfacePolicy } from "../hooks/useSurfacePolicy";

const MODE_OPTIONS: Array<{ id: SurfaceMode; label: string }> = [
  { id: "autojoin", label: "Autojoin" },
  { id: "on-request", label: "On request" },
  { id: "disabled", label: "Disabled" },
];

interface SurfacePolicyPopoverProps {
  agentId: string;
  name: string;
  onClose: () => void;
  /** Passed straight through to the root element — lets the anchor keep the popover open while the pointer is over it. */
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

/** Per-agent surface policy — one row per SURFACES entry, live presence, mode picker, Join now. */
export function SurfacePolicyPopover({
  agentId,
  name,
  onClose,
  onMouseEnter,
  onMouseLeave,
}: SurfacePolicyPopoverProps) {
  const { loading, modes, presence, discord, errors, setMode, joinNow } = useSurfacePolicy(agentId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="surface-popover"
      role="dialog"
      aria-label={`${name} — surfaces`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="surface-popover__header">{name} — surfaces</div>
      {loading ? (
        <p className="note">Loading…</p>
      ) : (
        SURFACES.map((surface) => {
          // Both Discord surfaces go inert together when the broker has no Discord identity configured.
          const grayed = !discord.configured;
          const mode = modes[surface.key] ?? "disabled";
          const present = presence[surface.key] ?? false;
          return (
            <div
              key={surface.key}
              className={grayed ? "surface-popover__row surface-popover__row--disabled" : "surface-popover__row"}
            >
              <div className="surface-popover__row-head">
                <span
                  className={present ? "surface-popover__dot surface-popover__dot--live" : "surface-popover__dot"}
                  aria-hidden="true"
                />
                <span className="surface-popover__label">{surface.label}</span>
                {!grayed && joinNowVisible(mode, present) && (
                  <button type="button" className="surface-popover__join" onClick={() => joinNow(surface.key)}>
                    Join now
                  </button>
                )}
              </div>
              {!grayed && (
                <SegmentedControl
                  ariaLabel={`${surface.label} mode`}
                  options={MODE_OPTIONS}
                  selected={mode}
                  onSelect={(id) => setMode(surface.key, id as SurfaceMode)}
                />
              )}
              {errors[surface.key] && <p className="surface-popover__error">{errors[surface.key]}</p>}
            </div>
          );
        })
      )}
      {!loading && !discord.configured && (
        <p className="note surface-popover__discord-note">Discord is not configured on the broker</p>
      )}
    </div>
  );
}
