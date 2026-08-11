import type { ArtifactKind } from "./artifactKinds";

/** How the one persistent chat box is positioned on the current surface. */
export type ComposerVariant = "full" | "dock" | "center" | "hidden";

/**
 * The chat box repositions by route — the URL is the single source of truth, so
 * back/forward and deep links place it correctly with no stored state to drift.
 */
export function layoutForPath(pathname: string): ComposerVariant {
  if (pathname === "/") return "full";
  if (pathname.startsWith("/doc/") || pathname.startsWith("/diagram/") || pathname === "/map") return "dock";
  // The dashboards stage no longer owns a compose box (spec v3) — the shared
  // dock's center variant is the one chat box there.
  if (pathname === "/dashboards") return "center";
  return "hidden"; // /board, /work/$agent, unrouted
}

/** Which artifact kind the dock highlights on each surface. */
export function kindForPath(pathname: string): ArtifactKind {
  if (pathname.startsWith("/doc/")) return "documents";
  if (pathname.startsWith("/diagram/")) return "diagrams";
  if (pathname === "/map") return "map";
  if (pathname === "/dashboards") return "dashboards";
  return "chat";
}
