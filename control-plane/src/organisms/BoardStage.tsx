import { Plus, SquareKanban, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { RosterAgent } from "../hooks/useBrokerChat";
import { BoardCard } from "../molecules/BoardCard";

const BASE = "127.0.0.1:7790";

export interface WorkColumn {
  id: string;
  name: string;
  jiraStatus?: string;
}
export interface WorkCardT {
  id: string;
  title: string;
  notes?: string;
  columnId: string;
  order: number;
  jira?: { key: string; url: string; lastPushError?: string };
  delegation?: { agentId: string; taskId: string; state: "working" | "completed" | "failed"; prUrl?: string };
  stories?: Array<{ id: string; text: string; done: boolean; verifiedBy?: string }>;
}
export interface WorkBoardT {
  id: string;
  name: string;
  columns: WorkColumn[];
  cards: WorkCardT[];
  jira?: { connectorId: string; siteUrl: string; projectKey: string; jql?: string };
}

interface BoardStageProps {
  open: boolean;
  roster: RosterAgent[];
  lastBoardUpdate: { boardId: string; seq: number } | null;
  onClose: () => void;
}

/**
 * The kanban stage — the user's boards. Drag (Task 6) only ever changes the
 * user's own status; delegation state is badges on cards, never movement.
 */
export function BoardStage({ open, roster, lastBoardUpdate, onClose }: BoardStageProps) {
  const [boards, setBoards] = useState<WorkBoardT[]>([]);
  const [boardErrors, setBoardErrors] = useState<Array<{ file: string; error: string }>>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingCard, setAddingCard] = useState(false);
  const [cardTitle, setCardTitle] = useState("");
  const [creatingBoard, setCreatingBoard] = useState(false);
  const [boardName, setBoardName] = useState("");
  const [template, setTemplate] = useState<"personal" | "capability">("personal");

  const refetch = useCallback(async () => {
    try {
      const res = (await fetch(`http://${BASE}/work/boards`).then((r) => r.json())) as {
        boards?: WorkBoardT[];
        errors?: Array<{ file: string; error: string }>;
        error?: string;
      };
      if (res.error) throw new Error(res.error);
      setBoards(res.boards ?? []);
      setBoardErrors(res.errors ?? []);
      setError(null);
      setActiveId((id) => id ?? res.boards?.[0]?.id ?? null);
    } catch {
      setError("Could not load boards — is the broker running?");
    }
  }, []);

  useEffect(() => {
    if (open) void refetch();
  }, [open, refetch]);

  useEffect(() => {
    if (open && lastBoardUpdate && lastBoardUpdate.boardId === activeId) void refetch();
  }, [open, lastBoardUpdate, activeId, refetch]);

  if (!open) return null;
  const board = boards.find((b) => b.id === activeId) ?? null;
  const agentFor = (id?: string) => (id ? roster.find((a) => a.id === id) : undefined);

  const addCard = async () => {
    if (!board || !cardTitle.trim()) return;
    await fetch(`http://${BASE}/work/boards/${encodeURIComponent(board.id)}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: cardTitle.trim() }),
    }).catch(() => setError("Could not add the card"));
    setCardTitle("");
    setAddingCard(false);
    void refetch();
  };

  const createBoard = async () => {
    if (!boardName.trim()) return;
    const res = (await fetch(`http://${BASE}/work/boards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: boardName.trim(), template }),
    })
      .then((r) => r.json())
      .catch(() => ({ error: "unreachable" }))) as WorkBoardT & { error?: string };
    if (res.error) {
      setError(res.error);
      return;
    }
    setCreatingBoard(false);
    setBoardName("");
    setActiveId(res.id);
    void refetch();
  };

  return (
    <section className="board-stage" aria-label="Work boards">
      <header className="board-stage__bar">
        <SquareKanban size={14} strokeWidth={2} />
        <select aria-label="Board" value={activeId ?? ""} onChange={(e) => setActiveId(e.target.value)}>
          {boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <button type="button" className="settings-btn" onClick={() => setCreatingBoard((v) => !v)}>
          new board
        </button>
        <button type="button" className="settings-btn" onClick={() => setAddingCard((v) => !v)} disabled={!board}>
          <Plus size={12} strokeWidth={2} /> add card
        </button>
        <span className="spacer" />
        <button type="button" className="settings-btn" onClick={onClose} aria-label="Close board">
          <X size={12} strokeWidth={2} />
        </button>
      </header>
      {creatingBoard && (
        <div className="board-stage__composer">
          <input placeholder="Board name" value={boardName} onChange={(e) => setBoardName(e.target.value)} />
          <label>
            Template
            <select
              aria-label="Template"
              value={template}
              onChange={(e) => setTemplate(e.target.value as "personal" | "capability")}
            >
              <option value="personal">Personal</option>
              <option value="capability">Capability Pipeline</option>
            </select>
          </label>
          <button type="button" className="settings-btn settings-btn--primary" onClick={() => void createBoard()}>
            create board
          </button>
        </div>
      )}
      {addingCard && board && (
        <div className="board-stage__composer">
          <input
            placeholder="Card title"
            value={cardTitle}
            onChange={(e) => setCardTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addCard();
            }}
          />
        </div>
      )}
      {error && <p className="wizard__error">{error}</p>}
      {boardErrors.length > 0 && (
        <p className="wizard__hint">Some board files failed to load: {boardErrors.map((e) => e.file).join(", ")}</p>
      )}
      {board && (
        <div className="board-stage__columns">
          {board.columns.map((col) => (
            <div key={col.id} className="board-column">
              <h3 className="board-column__name">{col.name}</h3>
              <div className="board-column__cards">
                {board.cards
                  .filter((c) => c.columnId === col.id)
                  .sort((a, b) => a.order - b.order)
                  .map((card) => (
                    <BoardCard key={card.id} card={card} agent={agentFor(card.delegation?.agentId)} onOpen={() => {}} />
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
