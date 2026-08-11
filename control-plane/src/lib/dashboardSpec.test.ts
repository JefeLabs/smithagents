import { describe, expect, it } from "vitest";
import { composeSpec, parseDashSpec, specToFence } from "./dashboardSpec";

describe("dashboardSpec", () => {
  it("compose → fence → parse round-trips", () => {
    const spec = composeSpec("where is delivery slipping?", "all workspaces");
    expect(parseDashSpec(specToFence(spec))).toEqual(spec);
    expect(spec.kpis.length).toBeGreaterThan(0);
    expect(spec.table?.rows.length).toBeGreaterThan(0);
  });

  it("extracts the fence out of surrounding prose", () => {
    const spec = composeSpec("q", "personal");
    const body = `Here is the dashboard:\n\n${specToFence(spec)}\n\nEnjoy.`;
    expect(parseDashSpec(body)?.summary).toBe(spec.summary);
  });

  it("rejects malformed or mis-shapen bodies", () => {
    expect(parseDashSpec("no json here")).toBeNull();
    expect(parseDashSpec('```json\n{"broken": \n```')).toBeNull();
    expect(parseDashSpec('```json\n{"summary": 3, "kpis": [], "charts": []}\n```')).toBeNull();
    expect(parseDashSpec('```json\n{"summary": "s", "kpis": {}, "charts": []}\n```')).toBeNull();
  });
});
