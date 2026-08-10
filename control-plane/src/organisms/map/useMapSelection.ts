import { useCallback, useState } from "react";

/**
 * What the map is currently interrogating.
 *
 * Three kinds, and no fourth: a BLANK card is never selectable. Selecting one
 * would put the map into a state describing a record that does not exist — there
 * is no id to filter edges by, and nothing for a detail view to open.
 */
export type Selection = { kind: "slice" | "story" | "step"; id: string } | null;

/**
 * Which slice/story/step the map is currently interrogating. Selecting the same
 * thing twice clears it, so clicking a slice band toggles its chain.
 */
export function useMapSelection() {
  const [selection, setSelection] = useState<Selection>(null);

  const select = useCallback((next: Selection) => {
    // Toggling is resolved against the CURRENT selection inside the updater
    // rather than against a captured one, so `select` has no dependencies and
    // stays referentially stable — it is handed to every node on the canvas.
    setSelection((current) => {
      if (!next) return null;
      if (current && current.kind === next.kind && current.id === next.id) return null;
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelection(null), []);

  return { selection, select, clear };
}
