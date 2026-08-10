import { describe, expect, it } from "vitest";
import { DASH_INTAKE, DASH_ROWS, DASH_SHIPPED, DASH_STEPS, DASH_WEEKS, savedMeta, scopeHint } from "./dashboards";

describe("dashboards fake data", () => {
  it("series and axis agree on 12 weeks", () => {
    expect(DASH_SHIPPED).toHaveLength(12);
    expect(DASH_INTAKE).toHaveLength(12);
    expect(DASH_WEEKS).toHaveLength(12);
  });

  it("every group trend is 12 points", () => {
    for (const r of DASH_ROWS) expect(r.trend).toHaveLength(12);
  });

  it("has exactly four composing steps (the stage timer counts on it)", () => {
    expect(DASH_STEPS).toHaveLength(4);
  });

  it("savedMeta folds 'all workspaces' to ALL", () => {
    expect(savedMeta("all workspaces")).toBe("ALL · JUST SAVED");
    expect(savedMeta("release")).toBe("RELEASE · JUST SAVED");
  });

  it("scopeHint uppercases the scope", () => {
    expect(scopeHint("all workspaces")).toBe("SCOPE · ALL WORKSPACES");
  });
});
