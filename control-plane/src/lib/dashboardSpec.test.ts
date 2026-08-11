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

  it("texts round-trip through the fence and validate their shape", () => {
    const spec = composeSpec("q", "all workspaces");
    spec.texts = [{ title: "release risk", body: "one squad is over WIP.", source: "session s12" }];
    const parsed = parseDashSpec(specToFence(spec));
    expect(parsed?.texts).toEqual([{ title: "release risk", body: "one squad is over WIP.", source: "session s12" }]);
  });

  it("a malformed text entry fails the whole parse — all-or-nothing like the rest", () => {
    const body = specToFence(composeSpec("q", "all workspaces")).replace('"kpis"', '"texts": [{ "title": 1 }], "kpis"');
    expect(parseDashSpec(body)).toBeNull();
  });

  it("rejects malformed or mis-shapen bodies", () => {
    expect(parseDashSpec("no json here")).toBeNull();
    expect(parseDashSpec('```json\n{"broken": \n```')).toBeNull();
    expect(parseDashSpec('```json\n{"summary": 3, "kpis": [], "charts": []}\n```')).toBeNull();
    expect(parseDashSpec('```json\n{"summary": "s", "kpis": {}, "charts": []}\n```')).toBeNull();
  });
});
