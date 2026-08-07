import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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

/** Optimistic mirror of the server's move: new board object, both columns renumbered. */
export function moveCard(board: WorkBoardT, cardId: string, columnId: string, order: number): WorkBoardT {
  const cards = board.cards.map((c) => ({ ...c }));
  const card = cards.find((c) => c.id === cardId);
  if (!card) return board;
  const from = card.columnId;
  const siblings = cards.filter((c) => c.columnId === columnId && c.id !== cardId).sort((a, b) => a.order - b.order);
  const at = Math.max(0, Math.min(order, siblings.length));
  card.columnId = columnId;
  siblings.splice(at, 0, card);
  siblings.forEach((c, i) => {
    c.order = i;
  });
  if (from !== columnId) {
    cards
      .filter((c) => c.columnId === from)
      .sort((a, b) => a.order - b.order)
      .forEach((c, i) => {
        c.order = i;
      });
  }
  return { ...board, cards };
}

// Test seam: jsdom cannot synthesize dnd-kit pointer sequences; the drop
// handler is registered here so tests can invoke the exact code path a real
// drop takes.
let dropHandler: ((cardId: string, columnId: string, order: number) => Promise<void>) | null = null;
export async function fireDrop(cardId: string, columnId: string, order: number): Promise<void> {
  if (!dropHandler) throw new Error("BoardStage is not mounted");
  await dropHandler(cardId, columnId, order);
}

/** One sortable card wrapper — BoardCard stays a pure display button; this owns the drag handle. */
function SortableCard({ card, agent }: { card: WorkCardT; agent?: RosterAgent }) {
  const sortable = useSortable({ id: card.id });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  return (
    <div ref={sortable.setNodeRef} style={style} {...sortable.attributes} {...sortable.listeners}>
      <BoardCard
        card={card}
        agent={agent}
        onOpen={() => {}}
        className={sortable.isDragging ? "is-dragging" : undefined}
      />
    </div>
  );
}

/** One column: a droppable zone (for empty-column drops) containing a sortable card list. */
function BoardColumn({
  col,
  cards,
  agentFor,
}: {
  col: WorkColumn;
  cards: WorkCardT[];
  agentFor: (id?: string) => RosterAgent | undefined;
}) {
  const droppable = useDroppable({ id: `column:${col.id}` });
  const sorted = [...cards].sort((a, b) => a.order - b.order);
  return (
    <div ref={droppable.setNodeRef} className={`board-column${droppable.isOver ? " is-over" : ""}`}>
      <h3 className="board-column__name">{col.name}</h3>
      <SortableContext items={sorted.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div className="board-column__cards">
          {sorted.map((card) => (
            <SortableCard key={card.id} card={card} agent={agentFor(card.delegation?.agentId)} />
          ))}
        </div>
      </SortableContext>
    </div>
  );
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

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  // Optimistic move + PATCH + rollback-on-fail. Same-column reorders PATCH
  // {order} only — omitting columnId keeps the swarm's Jira push-on-move
  // (which triggers on any body carrying columnId) from firing on a card
  // that never left its column.
  const applyMove = useCallback(
    async (cardId: string, columnId: string, order: number) => {
      const previous = boards.find((b) => b.id === activeId);
      if (!previous) return;
      const movingCard = previous.cards.find((c) => c.id === cardId);
      const sameColumn = movingCard?.columnId === columnId;
      const next = moveCard(previous, cardId, columnId, order);
      setBoards((all) => all.map((b) => (b.id === next.id ? next : b)));
      const body: { columnId?: string; order: number } = sameColumn ? { order } : { columnId, order };
      const res = await fetch(
        `http://${BASE}/work/boards/${encodeURIComponent(previous.id)}/cards/${encodeURIComponent(cardId)}`,
        { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      ).catch(() => null);
      if (!res?.ok) {
        setBoards((all) => all.map((b) => (b.id === previous.id ? previous : b)));
        setError("Move failed — restored the previous order");
        return;
      }
      void refetch(); // pick up server-side effects (renumber, jira lastPushError)
    },
    [boards, activeId, refetch],
  );

  useEffect(() => {
    dropHandler = applyMove;
    return () => {
      dropHandler = null;
    };
  }, [applyMove]);

  if (!open) return null;
  const board = boards.find((b) => b.id === activeId) ?? null;
  const agentFor = (id?: string) => (id ? roster.find((a) => a.id === id) : undefined);

  const handleDragEnd = (e: DragEndEvent) => {
    if (!board || !e.over) return;
    const cardId = String(e.active.id);
    const overId = String(e.over.id);
    let columnId: string;
    let order: number;
    if (overId.startsWith("column:")) {
      columnId = overId.slice("column:".length);
      order = board.cards.filter((c) => c.columnId === columnId && c.id !== cardId).length;
    } else {
      const overCard = board.cards.find((c) => c.id === overId);
      if (!overCard) return;
      columnId = overCard.columnId;
      const siblings = board.cards
        .filter((c) => c.columnId === columnId && c.id !== cardId)
        .sort((a, b) => a.order - b.order);
      const idx = siblings.findIndex((c) => c.id === overId);
      order = idx < 0 ? siblings.length : idx;
    }
    void applyMove(cardId, columnId, order);
  };

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
        <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={handleDragEnd}>
          <div className="board-stage__columns">
            {board.columns.map((col) => (
              <BoardColumn
                key={col.id}
                col={col}
                cards={board.cards.filter((c) => c.columnId === col.id)}
                agentFor={agentFor}
              />
            ))}
          </div>
        </DndContext>
      )}
    </section>
  );
}
