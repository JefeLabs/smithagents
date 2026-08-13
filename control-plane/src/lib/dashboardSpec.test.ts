import { describe, expect, it } from "vitest";
import { composeSpec, parseDashSpec, parseScopeName, specToFence } from "./dashboardSpec";

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

describe("chart data (real-dashboards spec 2026-08-13)", () => {
  const base = '{"summary": "s", "kpis": [], "charts": [%s]}';
  it("accepts a well-formed data block and returns it", () => {
    const chart =
      '{"kind": "line", "title": "t", "data": {"labels": ["8/1"], "series": [{"name": "touched", "values": [2]}]}}';
    const spec = parseDashSpec(`\`\`\`json\n${base.replace("%s", chart)}\n\`\`\``);
    expect(spec?.charts[0].data?.series[0].values).toEqual([2]);
  });
  it("a malformed data block fails the whole parse", () => {
    const bad = '{"kind": "line", "title": "t", "data": {"labels": [1], "series": []}}';
    expect(parseDashSpec(`\`\`\`json\n${base.replace("%s", bad)}\n\`\`\``)).toBeNull();
    const badSeries =
      '{"kind": "line", "title": "t", "data": {"labels": ["a"], "series": [{"name": "x", "values": ["nope"]}]}}';
    expect(parseDashSpec(`\`\`\`json\n${base.replace("%s", badSeries)}\n\`\`\``)).toBeNull();
  });
});

describe("parseScopeName", () => {
  it("reads the name off the composer's scope line, range suffix and all", () => {
    expect(parseScopeName("q\n\nscope: core · Current Sprint")).toBe("core");
    expect(parseScopeName("q\n\nscope: skoolscout")).toBe("skoolscout");
  });
  it("the LAST scope line wins; all-workspaces and absence are null", () => {
    expect(parseScopeName("scope: core\nmore words\nscope: widgets · Last 14 days")).toBe("widgets");
    expect(parseScopeName("q\n\nscope: all workspaces · Current Week")).toBeNull();
    expect(parseScopeName("no scope here")).toBeNull();
  });
});
