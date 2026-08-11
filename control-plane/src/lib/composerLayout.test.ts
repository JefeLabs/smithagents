import { describe, expect, it } from "vitest";
import { kindForPath, layoutForPath } from "./composerLayout";

describe("layoutForPath", () => {
  it("/ is the full centerpiece", () => expect(layoutForPath("/")).toBe("full"));
  it("documents, diagrams and maps dock right", () => {
    expect(layoutForPath("/doc/d1")).toBe("dock");
    expect(layoutForPath("/diagram/d1")).toBe("dock");
    expect(layoutForPath("/map")).toBe("dock");
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
    expect(kindForPath("/board")).toBe("chat"); // hidden dock still needs a valid default
  });
});
