import { describe, expect, it } from "vitest";
import { ARTIFACT_KINDS, familyForKind } from "./artifactKinds";

describe("artifact kinds", () => {
  it("lists the five kinds in canonical order with labels", () => {
    expect(ARTIFACT_KINDS.map((k) => k.kind)).toEqual(["chat", "dashboards", "documents", "diagrams", "map"]);
    expect(ARTIFACT_KINDS.find((k) => k.kind === "map")?.label).toBe("User Story Maps");
    expect(ARTIFACT_KINDS.find((k) => k.kind === "chat")?.label).toBe("Chat");
  });
  it("maps only document-creating kinds to a family", () => {
    expect(familyForKind("documents")).toBe("document");
    expect(familyForKind("diagrams")).toBe("diagram");
    expect(familyForKind("chat")).toBeNull();
    expect(familyForKind("dashboards")).toBeNull();
    expect(familyForKind("map")).toBeNull();
  });
});
