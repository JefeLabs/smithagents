import { Plus } from "lucide-react";
import { useEffect, useRef } from "react";
import { BOARD_TYPE_LABELS_UI, type BoardTypeT, type TabDescriptor } from "../lib/board-aggregate";

interface BoardTabsProps {
  tabs: TabDescriptor[];
  activeKey: string | null;
  /** Workspace types not yet present in the viewed workspace. Empty hides the add control entirely
   * — either the workspace already holds every type, or zero/several workspaces are in view and
   * there is no single unambiguous board to create into. */
  addable: BoardTypeT[];
  /** Whether the add-board type menu is open. Controlled by the parent — see the comment below. */
  adding: boolean;
  onAddingChange: (adding: boolean) => void;
  onSelect: (key: string) => void;
  onAdd: (type: BoardTypeT) => void;
}

/** The board tab row, plus its own "add a board" menu. */
export function BoardTabs({ tabs, activeKey, addable, adding, onAddingChange, onSelect, onAdd }: BoardTabsProps) {
  const addRef = useRef<HTMLDivElement>(null);

  // `adding` is controlled from BoardStage rather than local state here: the
  // add control unmounts whenever `addable` is empty (zero/several workspaces
  // in view), and BoardStage already resets it scope-keyed for exactly the
  // reason NewWorkspaceModal's open-keyed reset exists — component state
  // would otherwise survive that unmount and resurrect the menu already open.

  useEffect(() => {
    if (!adding) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onAddingChange(false);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [adding, onAddingChange]);

  useEffect(() => {
    if (!adding) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!addRef.current?.contains(e.target as Node)) onAddingChange(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [adding, onAddingChange]);

  return (
    <div className="board-tabs">
      <div className="board-tabs__row" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === activeKey}
            className={`board-tabs__tab${t.type === "personal" ? " board-tabs__tab--planner" : ""}${t.key === activeKey ? " is-active" : ""}`}
            onClick={() => onSelect(t.key)}
          >
            {t.label}
          </button>
        ))}
        {addable.length > 0 && (
          <div className="board-tabs__add" ref={addRef}>
            <button
              type="button"
              className="board-tabs__tab"
              aria-label="Add board"
              onClick={() => onAddingChange(!adding)}
            >
              <Plus size={12} strokeWidth={2} />
            </button>
            {adding && (
              <div className="board-tabs__menu" role="menu">
                {addable.map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onAddingChange(false);
                      onAdd(t);
                    }}
                  >
                    {BOARD_TYPE_LABELS_UI[t]}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
