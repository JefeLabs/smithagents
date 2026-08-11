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

  it("savedMeta lists pin targets with the group: namespace stripped", () => {
    const meta = savedMeta(["jefelabs", "group:core"], "2026-08-11T00:00:00Z");
    expect(meta).toContain("jefelabs, core");
    expect(meta).not.toContain("group:core");
  });

  it("scopeHint uppercases the scope", () => {
    expect(scopeHint("all workspaces")).toBe("SCOPE · ALL WORKSPACES");
  });
});
