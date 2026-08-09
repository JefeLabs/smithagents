/**
 * Workspace identity colour. Derived from the name by default so colours are
 * stable with zero configuration; an explicit `color` overrides it so a rename
 * does not shift a workspace's hue out from under the user.
 */
export const WORKSPACE_PALETTE = [
  "#5fd0b0", // teal
  "#e0a458", // amber
  "#8b7fd4", // violet
  "#d97a8e", // rose
  "#6fb3e0", // sky
  "#9dc95f", // lime
  "#e08a5f", // orange
  "#7f8bd4", // indigo
];

export function derivedColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return WORKSPACE_PALETTE[h % WORKSPACE_PALETTE.length];
}

export function workspaceColor(ws: { name: string; color?: string }): string {
  return ws.color?.trim() || derivedColor(ws.name);
}

/**
 * The "no colour" swatch. Fully transparent 8-digit hex, because react-aria's
 * ColorSwatchPicker is controlled by a `Color` object and `parseColor("")` throws —
 * there is no null colour. `FormColorSwatch` maps this to and from the empty string
 * at the seam, so `WorkspaceRecord.color` never carries it and `toRecord` is unchanged.
 *
 * Deliberately NOT a member of WORKSPACE_PALETTE: `derivedColor()` picks from that
 * array by hash, and a transparent entry would make one workspace in eight invisible.
 */
export const NO_COLOR_SENTINEL = "#00000000";
