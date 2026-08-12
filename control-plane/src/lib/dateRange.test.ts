import { describe, expect, it } from "vitest";
import { formatBounds, inDateRange, rangeLabel, resolveDateRange, sprintConfigFor, withRange } from "./dateRange";

// Wednesday, mid-quarter, mid-month — nothing about NOW is an edge unless a test makes it one.
const NOW = new Date(2026, 7, 12, 15, 30); // Aug 12 2026, local

describe("resolveDateRange: week", () => {
  it("spans ISO Monday–Sunday containing now", () => {
    const b = resolveDateRange({ kind: "week" }, NOW);
    expect(b?.from.getDay()).toBe(1); // Monday
    expect(b?.from.getDate()).toBe(10); // Mon Aug 10
    expect(b?.to.getDay()).toBe(0); // Sunday
    expect(b?.to.getDate()).toBe(16);
  });
  it("year wrap: Wed Dec 31 2025 belongs to the week of Mon Dec 29", () => {
    const b = resolveDateRange({ kind: "week" }, new Date(2025, 11, 31));
    expect(b?.from.getFullYear()).toBe(2025);
    expect(b?.from.getMonth()).toBe(11);
    expect(b?.from.getDate()).toBe(29);
    expect(b?.to.getFullYear()).toBe(2026);
    expect(b?.to.getDate()).toBe(4);
  });
  it("a Sunday belongs to the week that STARTED the previous Monday", () => {
    const b = resolveDateRange({ kind: "week" }, new Date(2026, 7, 16)); // Sun Aug 16
    expect(b?.from.getDate()).toBe(10);
  });
});

describe("resolveDateRange: month and quarter", () => {
  it("month spans the calendar month", () => {
    const b = resolveDateRange({ kind: "month" }, NOW);
    expect(b?.from.getDate()).toBe(1);
    expect(b?.from.getMonth()).toBe(7);
    expect(b?.to.getMonth()).toBe(7);
    expect(b?.to.getDate()).toBe(31);
  });
  it("quarter borders: Mar 31 is Q1, Apr 1 is Q2", () => {
    const q1 = resolveDateRange({ kind: "quarter" }, new Date(2026, 2, 31));
    expect(q1?.from.getMonth()).toBe(0);
    expect(q1?.to.getMonth()).toBe(2);
    const q2 = resolveDateRange({ kind: "quarter" }, new Date(2026, 3, 1));
    expect(q2?.from.getMonth()).toBe(3);
    expect(q2?.to.getMonth()).toBe(5);
  });
});

describe("resolveDateRange: sprint (opt-in)", () => {
  const sprint = { anchor: "2026-08-03", lengthDays: 14 }; // Mon Aug 3
  it("k=0: now inside the first window", () => {
    const b = resolveDateRange({ kind: "sprint" }, NOW, sprint);
    expect(b?.from.getDate()).toBe(3);
    expect(b?.to.getDate()).toBe(16); // 14 days: Aug 3–16 inclusive
  });
  it("k>0: a later window resolves from the same anchor", () => {
    const b = resolveDateRange({ kind: "sprint" }, new Date(2026, 7, 20), sprint);
    expect(b?.from.getDate()).toBe(17);
    expect(b?.to.getDate()).toBe(30);
  });
  it("now exactly on a boundary starts the NEXT window", () => {
    const b = resolveDateRange({ kind: "sprint" }, new Date(2026, 7, 17, 0, 0), sprint);
    expect(b?.from.getDate()).toBe(17);
  });
  it("a future anchor still resolves the containing window (negative k)", () => {
    const b = resolveDateRange({ kind: "sprint" }, NOW, { anchor: "2026-08-31", lengthDays: 14 });
    expect(b?.from.getDate()).toBe(3); // Aug 31 minus 2×14 = Aug 3
  });
  it("without config resolves to null — All time, never an approximation", () => {
    expect(resolveDateRange({ kind: "sprint" }, NOW)).toBeNull();
  });
});

describe("resolveDateRange: custom", () => {
  it("is inclusive of both end dates", () => {
    const b = resolveDateRange({ kind: "custom", from: "2026-08-01", to: "2026-08-12" }, NOW);
    expect(inDateRange(new Date(2026, 7, 1, 0, 0, 1).toISOString(), b)).toBe(true);
    expect(inDateRange(new Date(2026, 7, 12, 23, 59).toISOString(), b)).toBe(true);
    expect(inDateRange(new Date(2026, 6, 31, 23, 59).toISOString(), b)).toBe(false);
    expect(inDateRange(new Date(2026, 7, 13, 0, 1).toISOString(), b)).toBe(false);
  });
});

describe("inDateRange", () => {
  it("null bounds (All time) admits everything", () => {
    expect(inDateRange("2001-01-01T00:00:00Z", null)).toBe(true);
  });
  it("bounds admit inside, reject outside", () => {
    const b = resolveDateRange({ kind: "week" }, NOW);
    expect(inDateRange(new Date(2026, 7, 11).toISOString(), b)).toBe(true);
    expect(inDateRange(new Date(2026, 7, 3).toISOString(), b)).toBe(false);
  });
});

describe("rangeLabel", () => {
  it("covers every kind", () => {
    expect(rangeLabel(null)).toBe("All time");
    expect(rangeLabel({ kind: "week" })).toBe("Current Week");
    expect(rangeLabel({ kind: "sprint" })).toBe("Current Sprint");
    expect(rangeLabel({ kind: "month" })).toBe("Current Month");
    expect(rangeLabel({ kind: "quarter" })).toBe("Current Quarter");
    expect(rangeLabel({ kind: "custom", from: "2026-08-01", to: "2026-08-12" })).toContain("2026-08-01");
  });
});

describe("formatBounds", () => {
  it("renders short inline dates, adding the year only when it differs", () => {
    const b = resolveDateRange({ kind: "week" }, NOW);
    expect(formatBounds(b!, NOW)).toMatch(/Aug 10 – Aug 16/);
    const wrap = resolveDateRange({ kind: "week" }, new Date(2025, 11, 31));
    expect(formatBounds(wrap!, new Date(2025, 11, 31))).toMatch(/Dec 29 – Jan 4, 2026/);
  });
});

describe("withRange", () => {
  it("suffixes the scope with the range label; All time leaves it alone", () => {
    expect(withRange("core", { kind: "week" })).toBe("core · Current Week");
    expect(withRange("core", null)).toBe("core");
  });
});

describe("sprintConfigFor", () => {
  const g = { sprint: { anchor: "2026-01-05", lengthDays: 14 } };
  const w = { sprint: { anchor: "2026-02-02", lengthDays: 7 } };
  it("group lens wins, then workspace, then nothing", () => {
    expect(sprintConfigFor(g, w)?.anchor).toBe("2026-01-05");
    expect(sprintConfigFor(undefined, w)?.anchor).toBe("2026-02-02");
    expect(sprintConfigFor({ sprint: undefined }, { sprint: undefined })).toBeUndefined();
    expect(sprintConfigFor(undefined, undefined)).toBeUndefined();
  });
});
