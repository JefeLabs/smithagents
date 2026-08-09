import { type CSSProperties, type ReactNode, useEffect, useState } from "react";

interface AvatarProps {
  initial: string;
  label: string;
  ring?: string;
  /** Full portrait URL; the initial is the automatic fallback when absent or broken. */
  image?: string;
  style?: CSSProperties;
  onClick?: () => void;
  children?: ReactNode;
  /**
   * Activity the ring animates: "listening" pulses while they are addressed,
   * "working" spins a dotted ring while they are on a task. Rendered as a data
   * attribute so the animation is pure CSS with no per-frame React work.
   */
  state?: "listening" | "working";
  /**
   * False renders a plain, unfocusable <span> instead of a <button> — for badges
   * nested inside another interactive control (e.g. a kanban card), where a real
   * button would be invalid HTML and a phantom tab-stop. Default true: every
   * existing caller is unaffected.
   */
  interactive?: boolean;
}

/** Circular identity button; ring color arrives via the --ring custom property. */
export function Avatar({
  initial,
  label,
  ring,
  image,
  style,
  onClick,
  children,
  state,
  interactive = true,
}: AvatarProps) {
  const [broken, setBroken] = useState(false);
  // A reroll or edit swaps the URL under us — give the new image a fresh chance.
  // biome-ignore lint/correctness/useExhaustiveDependencies: image is a prop, must be tracked
  useEffect(() => setBroken(false), [image]);
  const ringStyle = { ...(ring ? { "--ring": ring } : {}), ...style } as CSSProperties;
  const face =
    image && !broken ? <img className="sm-avatar__img" src={image} alt="" onError={() => setBroken(true)} /> : initial;
  if (!interactive) {
    return (
      <span className="sm-avatar" role="img" data-state={state} style={ringStyle} title={label} aria-label={label}>
        {face}
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="sm-avatar"
      data-state={state}
      style={ringStyle}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {face}
      {children}
    </button>
  );
}
