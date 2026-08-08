import { describe, expect, it } from "vitest";
import { derivedColor, WORKSPACE_PALETTE, workspaceColor } from "./workspace-color";

describe("workspace-color", () => {
  it("derives a palette colour that is stable for a given name", () => {
    expect(derivedColor("acme")).toBe(derivedColor("acme"));
    expect(WORKSPACE_PALETTE).toContain(derivedColor("acme"));
    expect(WORKSPACE_PALETTE).toHaveLength(8);
  });

  it("spreads a handful of names across more than one hue", () => {
    const hues = new Set(["acme", "globex", "initech", "umbrella", "soylent"].map(derivedColor));
    expect(hues.size).toBeGreaterThan(1);
  });

  it("prefers an explicit colour over the derived default", () => {
    expect(workspaceColor({ name: "acme", color: "#ff0000" })).toBe("#ff0000");
    expect(workspaceColor({ name: "acme" })).toBe(derivedColor("acme"));
    expect(workspaceColor({ name: "acme", color: "  " })).toBe(derivedColor("acme"));
  });
});
