import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useMapSelection } from "./useMapSelection";

/**
 * Only the toggle is worth pinning. Reading state back after setting it tests
 * `useState`; that reselecting CLEARS is a decision — it is what makes clicking
 * a slice band a switch rather than a one-way trip, and the whole reason this is
 * a hook and not a bare `useState` in the canvas.
 */
describe("useMapSelection", () => {
  it("clears when the same thing is selected twice", () => {
    const { result } = renderHook(() => useMapSelection());

    act(() => result.current.select({ kind: "slice", id: "sl1" }));
    expect(result.current.selection).toEqual({ kind: "slice", id: "sl1" });

    act(() => result.current.select({ kind: "slice", id: "sl1" }));
    expect(result.current.selection).toBeNull();
  });

  it("clears when handed null directly", () => {
    // `Selection` includes null and `select` takes a `Selection`, so a caller
    // may legitimately pass it — a node handler that computes its target and
    // finds none does exactly that. `clear()` takes the other path
    // (`setSelection(null)`), so its tests say nothing about this branch.
    const { result } = renderHook(() => useMapSelection());

    act(() => result.current.select({ kind: "slice", id: "sl1" }));
    act(() => result.current.select(null));
    expect(result.current.selection).toBeNull();
  });

  it("replaces rather than clears when the kind matches but the id does not", () => {
    // Both halves of the identity have to agree for a reselect. A story and a
    // step can share neither, but two slices differ only by id — comparing kind
    // alone would make clicking the next band down clear the map instead of
    // moving to it.
    const { result } = renderHook(() => useMapSelection());

    act(() => result.current.select({ kind: "slice", id: "sl1" }));
    act(() => result.current.select({ kind: "slice", id: "sl2" }));
    expect(result.current.selection).toEqual({ kind: "slice", id: "sl2" });
  });

  it("replaces when the id matches but the kind does not", () => {
    const { result } = renderHook(() => useMapSelection());

    act(() => result.current.select({ kind: "story", id: "x" }));
    act(() => result.current.select({ kind: "step", id: "x" }));
    expect(result.current.selection).toEqual({ kind: "step", id: "x" });
  });

  it("keeps select and clear stable across renders, since every node holds one", () => {
    const { result, rerender } = renderHook(() => useMapSelection());
    const first = { select: result.current.select, clear: result.current.clear };

    act(() => result.current.select({ kind: "story", id: "s1" }));
    rerender();

    expect(result.current.select).toBe(first.select);
    expect(result.current.clear).toBe(first.clear);
  });

  it("clears from any selection, and is a no-op from none", () => {
    const { result } = renderHook(() => useMapSelection());

    act(() => result.current.clear());
    expect(result.current.selection).toBeNull();

    act(() => result.current.select({ kind: "story", id: "s1" }));
    act(() => result.current.clear());
    expect(result.current.selection).toBeNull();
  });
});
