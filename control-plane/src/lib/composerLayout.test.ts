import { describe, expect, it } from "vitest";
import { kindForPath, layoutForPath } from "./composerLayout";

describe("layoutForPath", () => {
  it("/ is the full centerpiece", () => expect(layoutForPath("/")).toBe("full"));
  it("documents, diagrams and maps dock right", () => {
    expect(layoutForPath("/doc/d1")).toBe("dock");
    expect(layoutForPath("/diagram/d1")).toBe("dock");
    expect(layoutForPath("/map")).toBe("dock");
  });
  // /dashboards is `center` in Plan 4; hidden until that stage hosts the dock.
  it("dashboards is hidden until Plan 4 (its mock owns its own compose today)", () =>
    expect(layoutForPath("/dashboards")).toBe("hidden"));
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
