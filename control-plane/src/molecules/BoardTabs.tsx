import { Plus } from "lucide-react";
import { useState } from "react";
import { ALL_WORKSPACES, BOARD_TYPE_LABELS_UI, type BoardTypeT, type TabDescriptor } from "../lib/board-aggregate";

interface BoardTabsProps {
  /** ALL_WORKSPACES or a workspace name. */
  scope: string;
  workspaces: string[];
  tabs: TabDescriptor[];
  activeKey: string | null;
  /** Workspace types not yet present in the scoped workspace. Ignored in aggregate scope. */
  addable: BoardTypeT[];
  onScope: (scope: string) => void;
  onSelect: (key: string) => void;
  onAdd: (type: BoardTypeT) => void;
}

/** Workspace context dropdown above the board tab row. */
export function BoardTabs({ scope, workspaces, tabs, activeKey, addable, onScope, onSelect, onAdd }: BoardTabsProps) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="board-tabs">
      <select
        className="board-tabs__scope"
        aria-label="Workspace"
        value={scope}
        onChange={(e) => onScope(e.target.value)}
      >
        <option value={ALL_WORKSPACES}>All workspaces</option>
        {workspaces.map((w) => (
          <option key={w} value={w}>
            {w}
          </option>
        ))}
      </select>
      <div className="board-tabs__row" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === activeKey}
            className={`board-tabs__tab${t.key === activeKey ? " is-active" : ""}`}
            onClick={() => onSelect(t.key)}
          >
            {t.label}
          </button>
        ))}
        {scope !== ALL_WORKSPACES && addable.length > 0 && (
          <div className="board-tabs__add">
            <button
              type="button"
              className="board-tabs__tab"
              aria-label="Add board"
              onClick={() => setAdding((v) => !v)}
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
                      setAdding(false);
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
