import { describe, expect, it } from "vitest";
import { GRID_DEFAULTS } from "../hooks/useDotGrid";
import { useUiStore } from "./uiStore";

describe("uiStore", () => {
  it("the + button always creates, never edits", () => {
    // No closeAgentModal() in between: the brief's original draft went
    // openEditAgent -> closeAgentModal -> openAddAgent, but closeAgentModal
    // already nulls editingId on its own, so that ordering passes even if
    // openAddAgent itself never touches editingId. Going straight from an
    // open edit target into openAddAgent is what actually pins "+ always
    // creates, never inherits" as openAddAgent's own behavior.
    useUiStore.getState().openEditAgent("manuel");
    useUiStore.getState().openAddAgent();
    expect(useUiStore.getState().editingId).toBeNull();
    expect(useUiStore.getState().modalOpen).toBe(true);
  });

  it("closing the agent modal clears the edit target", () => {
    useUiStore.getState().openEditAgent("manuel");
    useUiStore.getState().closeAgentModal();
    expect(useUiStore.getState().editingId).toBeNull();
    expect(useUiStore.getState().modalOpen).toBe(false);
  });

  it("opening the composer with a locked workspace pins it", () => {
    useUiStore.getState().openComposer("acme");
    expect(useUiStore.getState().composer).toEqual({ locked: "acme" });
  });

  it("resetGrid restores every default", () => {
    // The brief's draft used a "gap" key, which GridParams does not have
    // (distortion/radius/spacing/dotSize/glow/base) — "spacing" is a real one.
    useUiStore.getState().setGridParam("spacing", 999);
    useUiStore.getState().resetGrid();
    expect(useUiStore.getState().gridParams).toEqual(GRID_DEFAULTS);
  });

  it("state does not leak between tests", () => {
    // modalOpen alone doesn't pin this: it happens to end up false anyway
    // from the "closing the agent modal" test's own closeAgentModal() call,
    // coincidentally, with or without the global reset running. composer is
    // the field the preceding test actually leaves dirty ({ locked: "acme" })
    // with nothing else in this file clearing it back down — only
    // registerStoreReset does, so this is what a deletion check must assert.
    expect(useUiStore.getState().composer).toBeNull();
    expect(useUiStore.getState().modalOpen).toBe(false);
  });
});
