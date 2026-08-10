/**
 * SVG path builders for the dashboards mock — ported from the source design
 * (claude.ai/design "Agentic dashboard left rail", Dashboards Rail.dc.html).
 * Pure string math, no DOM.
 */

export interface SeriesPathOpts {
  w: number;
  h: number;
  /** Y-scale ceiling — every series on one chart MUST share it (one axis). */
  max: number;
  /** Vertical inset so the line never kisses the panel edges. */
  pad?: number;
  /** Close the path down to the baseline for an area fill. */
  close?: boolean;
}

export function seriesPath(vals: number[], { w, h, max, pad = 30, close = false }: SeriesPathOpts): string {
  const n = vals.length;
  if (n === 0) return "";
  const pts = vals.map((v, i) => [n === 1 ? 0 : (i * w) / (n - 1), h - (v / max) * (h - pad) - pad / 2]);
  let d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  if (close) d += ` L${w} ${h} L0 ${h} Z`;
  return d;
}

/** 100×22 sparkline normalized to its own min/max; a flat series draws its baseline. */
export function sparkPath(vals: number[]): string {
  const n = vals.length;
  if (n === 0) return "";
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const range = max - min || 1;
  return vals
    .map((v, i) => {
      const x = n === 1 ? 0 : (i * 100) / (n - 1);
      const y = 20 - ((v - min) / range) * 17;
      return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}
