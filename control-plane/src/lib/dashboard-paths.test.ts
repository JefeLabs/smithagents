// control-plane/src/lib/dashboard-paths.test.ts
import { describe, expect, it } from "vitest";
import { seriesPath, sparkPath } from "./dashboard-paths";

describe("seriesPath", () => {
  it("maps values into the padded band", () => {
    // h=100 pad=30 → drawable band is 70px tall, centred: y ∈ [15, 85]
    expect(seriesPath([0, 50], { w: 100, h: 100, max: 50 })).toBe("M0.0 85.0 L100.0 15.0");
  });

  it("closes to the baseline for area fills", () => {
    expect(seriesPath([0, 50], { w: 100, h: 100, max: 50, close: true })).toBe(
      "M0.0 85.0 L100.0 15.0 L100 100 L0 100 Z",
    );
  });

  it("an empty series draws nothing", () => {
    expect(seriesPath([], { w: 100, h: 100, max: 50 })).toBe("");
  });
});

describe("sparkPath", () => {
  it("normalizes to its own min and max in a 100×22 box", () => {
    expect(sparkPath([0, 10])).toBe("M0.0 20.0 L100.0 3.0");
  });

  it("a flat series draws a baseline, not NaN", () => {
    expect(sparkPath([5, 5, 5])).toBe("M0.0 20.0 L50.0 20.0 L100.0 20.0");
  });

  it("an empty series draws nothing", () => {
    expect(sparkPath([])).toBe("");
  });
});
