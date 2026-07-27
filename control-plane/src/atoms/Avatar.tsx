import type { CSSProperties, ReactNode } from "react";

interface AvatarProps {
  initial: string;
  label: string;
  ring?: string;
  style?: CSSProperties;
  onClick?: () => void;
  children?: ReactNode;
  /**
   * Activity the ring animates: "listening" pulses while they are addressed,
   * "working" spins a dotted ring while they are on a task. Rendered as a data
   * attribute so the animation is pure CSS with no per-frame React work.
   */
  state?: "listening" | "working";
}

/** Circular identity button; ring color arrives via the --ring custom property. */
export function Avatar({ initial, label, ring, style, onClick, children, state }: AvatarProps) {
  const ringStyle = { ...(ring ? { "--ring": ring } : {}), ...style } as CSSProperties;
  return (
    <button
      type="button"
      className="avatar"
      data-state={state}
      style={ringStyle}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {initial}
      {children}
    </button>
  );
}
