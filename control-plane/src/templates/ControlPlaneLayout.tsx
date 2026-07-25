import type { ReactNode } from "react";

interface ControlPlaneLayoutProps {
  background: ReactNode;
  leftRail: ReactNode;
  rightRail: ReactNode;
  stage: ReactNode;
  hint: ReactNode;
  overlays?: ReactNode;
}

/** Fixed-position composition: canvas underlay, side rails, center stage, bottom hint, floating overlays. */
export function ControlPlaneLayout({
  background,
  leftRail,
  rightRail,
  stage,
  hint,
  overlays,
}: ControlPlaneLayoutProps) {
  return (
    <>
      {background}
      {leftRail}
      {rightRail}
      {stage}
      <div className="subhint">{hint}</div>
      {overlays}
    </>
  );
}
