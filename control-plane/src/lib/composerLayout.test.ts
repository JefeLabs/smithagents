import { describe, expect, it } from "vitest";
import { isKindSurface, kindForPath, layoutForPath } from "./composerLayout";

describe("layoutForPath", () => {
  it("/ is the full centerpiece", () => expect(layoutForPath("/")).toBe("full"));
  it("documents, diagrams and maps dock right", () => {
    expect(layoutForPath("/doc/d1")).toBe("dock");
    expect(layoutForPath("/diagram/d1")).toBe("dock");
    expect(layoutForPath("/map")).toBe("dock");
    expect(layoutForPath("/dashboard/d1")).toBe("dock"); // a PRESENTED dashboard is a doc canvas
  });
  it("dashboards hosts the center dock — the one chat box there (spec v3)", () =>
    expect(layoutForPath("/dashboards")).toBe("center"));
  it("board and work hide the chat", () => {
    expect(layoutForPath("/board")).toBe("hidden");
    expect(layoutForPath("/work/ignacio")).toBe("hidden");
  });
});

describe("kindForPath", () => {
  it("maps each surface to its kind", () => {
    expect(kindForPath("/")).toBe("chat");
    expect(kindForPath("/doc/d1")).toBe("documents");
    expect(kindForPath("/diagram/d1")).toBe("diagrams");
    expect(kindForPath("/map")).toBe("map");
    expect(kindForPath("/dashboards")).toBe("dashboards");
    expect(kindForPath("/dashboard/d1")).toBe("dashboards");
    expect(kindForPath("/board")).toBe("chat"); // hidden dock still needs a valid default
  });
});

describe("isKindSurface", () => {
  it("is exactly the non-hidden dock surfaces", () => {
    for (const p of ["/", "/dashboards", "/map", "/doc/d1", "/diagram/d2"]) expect(isKindSurface(p)).toBe(true);
    for (const p of ["/board", "/work/ignacio", "/nope"]) expect(isKindSurface(p)).toBe(false);
  });
});
