import type { CSSProperties, ReactNode } from "react";

interface AvatarProps {
  initial: string;
  label: string;
  ring?: string;
  style?: CSSProperties;
  onClick?: () => void;
  children?: ReactNode;
}

/** Circular identity button; ring color arrives via the --ring custom property. */
export function Avatar({ initial, label, ring, style, onClick, children }: AvatarProps) {
  const ringStyle = { ...(ring ? { "--ring": ring } : {}), ...style } as CSSProperties;
  return (
    <button type="button" className="avatar" style={ringStyle} title={label} aria-label={label} onClick={onClick}>
      {initial}
      {children}
    </button>
  );
}
