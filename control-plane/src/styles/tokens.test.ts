import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Read from disk, not via Vite's `?raw`: the Tailwind plugin transforms .css on the
// way through, so `?raw` yields compiled output with the source selectors gone.
// The package is ESM, so __dirname does not exist either.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "tokens.css"), "utf8");

/**
 * The identity bridge: HeroUI variables we deliberately drive from smithagents'
 * palette, because leaving them to HeroUI's defaults would stop the app looking like
 * itself. Each maps to a token that every theme block already defines.
 */
const BRIDGE: Array<[string, string]> = [
  ["--background", "--ground"],
  ["--foreground", "--text"],
  ["--surface", "--ground-2"],
  ["--overlay", "--ground-2"],
  ["--muted", "--text-2"],
  ["--border", "--pill-br"],
  ["--separator", "--rail-br"],
];

/**
 * Deliberately NOT bridged — these come from HeroUI's default theme. Defining them
 * here would be re-deriving a design system we chose to adopt. If one of these ever
 * needs overriding, add it to BRIDGE with a reason rather than sprinkling it in.
 */
const INHERITED = [
  "--radius",
  "--success",
  "--warning",
  "--danger",
  "--field-background",
  "--field-foreground",
  "--segment",
  "--scrollbar",
  "--disabled-opacity",
  "--ring-offset-width",
  "--backdrop",
];

describe("token bridge", () => {
  it.each(BRIDGE)("defines %s from %s", (heroVar, sourceToken) => {
    expect(css).toMatch(new RegExp(`${heroVar}:\\s*var\\(${sourceToken}\\)`));
  });

  /**
   * Every theme block targets the SAME element (:root), so a var() reference written
   * once re-resolves against whichever block is active. Declaring the bridge per-theme
   * would be duplication that can drift.
   */
  it("declares each bridged variable exactly once", () => {
    for (const [heroVar] of BRIDGE) {
      const hits = css.match(new RegExp(`^\\s*${heroVar}:`, "gm")) ?? [];
      expect({ [heroVar]: hits.length }).toEqual({ [heroVar]: 1 });
    }
  });

  it.each(INHERITED)("leaves %s to HeroUI's default theme", (heroVar) => {
    expect(css).not.toMatch(new RegExp(`^\\s*${heroVar}:`, "m"));
  });

  /** Guards the source tokens the bridge depends on. */
  it.each([
    [":root {"],
    [':root[data-theme="light"] {'],
    [':root[data-theme="midnight"] {'],
    [':root[data-theme="sand"] {'],
  ])("theme block %s defines every token the bridge reads", (selector) => {
    const start = css.indexOf(selector);
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf("\n}", start));
    const missing = [...new Set(BRIDGE.map(([, src]) => src))].filter((t) => !block.includes(`${t}:`));
    expect(missing).toEqual([]);
  });
});
