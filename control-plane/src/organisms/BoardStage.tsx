import { DndContext, type DragEndEvent, PointerSensor, pointerWithin, useSensor, useSensors } from "@dnd-kit/core";
import { Download, Plus, SquareKanban } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { RosterAgent } from "../api/types";
import {
  ALL_WORKSPACES,
  addableTypes,
  type BoardTypeT,
  clusterByWorkspace,
  collectCards,
  tabsFor,
} from "../lib/board-aggregate";
import { workspaceColor } from "../lib/workspace-color";
import { BoardColumn } from "../molecules/BoardColumn";
import { BoardTabs } from "../molecules/BoardTabs";
import { CardSheet } from "./CardSheet";

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
  /** Present when this card tracks a capability slice — its checklist becomes toggle-only. */
  capabilityRef?: { capabilityId: string; sliceId: string };
  flag?: { kind: "blocked" | "at-risk" | "waiting"; reason?: string; since: string };
  routedFrom?: Array<{ boardId: string; boardType: string; columnId: string; at: string }>;
}
export interface WorkBoardT {
  id: string;
  name: string;
  type: BoardTypeT;
  columns: WorkColumn[];
  cards: WorkCardT[];
  jira?: { connectorId: string; siteUrl: string; projectKey: string; jql?: string };
  /** Present on a workspace's standing boards; absent on personal boards. */
  workspaceId?: string;
}

interface BoardStageProps {
  roster: RosterAgent[];
  /**
   * Dead as of the socket store: a `board-updated` frame now invalidates
   * `qk.board(id)` instead of bumping a seq counter, so nothing supplies this
   * any more. It (and the effect below that reads it) go away with the rest of
   * the seq mechanism once this stage reads its boards through Query.
   */
  lastBoardUpdate?: { boardId: string; seq: number } | null;
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

/**
 * Resolves a raw dnd-kit drop target (`over.id`) into the column + insertion
 * index moveCard expects. moveCard's `order` always indexes into the target
 * column's siblings with the active card already excluded, so a same-column
 * forward drag (active card started before the target) must land one slot
 * AFTER the target's position in that excluded list — landing AT it is a
 * no-op, since that's exactly where the active card already sits once
 * excluded. A backward drag (or a cross-column drop) lands AT the target's
 * position, i.e. right before it.
 */
export function resolveDrop(
  board: WorkBoardT,
  activeCardId: string,
  overId: string,
): { columnId: string; order: number } | null {
  if (overId === activeCardId) return null;
  const active = board.cards.find((c) => c.id === activeCardId);
  if (!active) return null;

  if (overId.startsWith("column:")) {
    const columnId = overId.slice("column:".length);
    const order = board.cards.filter((c) => c.columnId === columnId && c.id !== activeCardId).length;
    return { columnId, order };
  }

  const overCard = board.cards.find((c) => c.id === overId);
  if (!overCard) return null;
  const columnId = overCard.columnId;
  const siblings = board.cards
    .filter((c) => c.columnId === columnId && c.id !== activeCardId)
    .sort((a, b) => a.order - b.order);
  const idx = siblings.findIndex((c) => c.id === overId);
  if (idx < 0) return null;

  const forward = active.columnId === columnId && active.order < overCard.order;
  return { columnId, order: forward ? idx + 1 : idx };
}

/**
 * Resolves a drop in the aggregate view, where one tab spans several boards.
 * The dragged card's OWN board is the authority — the PATCH route addresses a
 * single board, so a card dropped onto another board's card has no meaning and
 * is refused rather than silently moved. Grouping doubles as the drag fence.
 */
export function resolveCrossBoardDrop(
  boards: WorkBoardT[],
  activeCardId: string,
  overId: string,
): { boardId: string; columnId: string; order: number } | { error: string } | null {
  const source = boards.find((b) => b.cards.some((c) => c.id === activeCardId));
  if (!source) return null;
  const overCard = boards.flatMap((b) => b.cards.map((c) => ({ card: c, board: b }))).find((x) => x.card.id === overId);
  if (overCard && overCard.board.id !== source.id) return { error: "Cards can only move within their own workspace" };
  const target = resolveDrop(source, activeCardId, overId);
  if (!target) return null;
  return { boardId: source.id, ...target };
}

// Test seam: jsdom cannot synthesize dnd-kit pointer sequences; the drop
// handler is registered here so tests can invoke the exact code path a real
// drop takes.
let dropHandler: ((boardId: string, cardId: string, columnId: string, order: number) => Promise<void>) | null = null;
export async function fireDrop(boardId: string, cardId: string, columnId: string, order: number): Promise<void> {
  if (!dropHandler) throw new Error("BoardStage is not mounted");
  await dropHandler(boardId, cardId, columnId, order);
}

/**
 * The kanban stage — the user's boards. Drag (Task 6) only ever changes the
 * user's own status; delegation state is badges on cards, never movement.
 */
export function BoardStage({ roster, lastBoardUpdate }: BoardStageProps) {
  const [boards, setBoards] = useState<WorkBoardT[]>([]);
  const [boardErrors, setBoardErrors] = useState<Array<{ file: string; error: string }>>([]);
  const [scope, setScope] = useState<string>(ALL_WORKSPACES);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingCard, setAddingCard] = useState(false);
  const [cardTitle, setCardTitle] = useState("");
  const [open, setOpen] = useState<{ boardId: string; cardId: string } | null>(null);
  const [workspaces, setWorkspaces] = useState<Array<{ name: string; color?: string }>>([]);

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
    } catch {
      setError("Could not load boards — is the broker running?");
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    fetch(`http://${BASE}/workspaces`)
      .then((r) => r.json())
      .then((res: { workspaces?: Array<{ name: string; color?: string }> }) =>
        setWorkspaces((res.workspaces ?? []).map((w) => ({ name: w.name, color: w.color }))),
      )
      .catch(() => {});
  }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const tabs = tabsFor(boards, scope);
  const tab = tabs.find((t) => t.key === activeKey) ?? tabs[0] ?? null;
  const tabBoards = tab ? boards.filter((b) => tab.boardIds.includes(b.id)) : [];
  const columns = tabBoards[0]?.columns ?? [];
  // Cards go to the board they came from, never the tab — in aggregate scope a
  // tab spans several boards.
  const boardOf = (id: string) => boards.find((b) => b.id === id) ?? null;
  const colorFor = (workspaceId?: string) => {
    if (!workspaceId) return undefined;
    const ws = workspaces.find((w) => w.name === workspaceId);
    return workspaceColor(ws ?? { name: workspaceId });
  };
  const agentFor = (id?: string) => (id ? roster.find((a) => a.id === id) : undefined);
  // Both looked up here, and both guarded at the render site. A refetch can
  // drop the open card out from under the sheet — an agent deletes it, or a
  // route moves it to another board — and CardSheet reads `card.title`
  // unconditionally, so a board-only guard renders it with an undefined card.
  const openBoard = open ? boardOf(open.boardId) : null;
  const openCard = open ? (openBoard?.cards.find((c) => c.id === open.cardId) ?? null) : null;

  // Keyed on the joined ids, not the tabBoards array: that array is rebuilt on
  // every render, and refetch replaces `boards` with a fresh array, so an
  // identity-keyed effect would refetch itself in a loop.
  const tabBoardIds = tab ? tab.boardIds.join(",") : "";
  useEffect(() => {
    if (lastBoardUpdate && tabBoardIds.split(",").includes(lastBoardUpdate.boardId)) void refetch();
  }, [lastBoardUpdate, tabBoardIds, refetch]);

  // The composer targets tabBoards[0], so a half-typed card must not survive a
  // move to a different board — same reset BoardTabs does for its add menu.
  // `open` joins them: it names a card in another collection, so neither tool
  // alone fits, and without this an A-workspace card sheet floats over B's board.
  //
  // The rule, for the next person: use `key=` when the state is SEEDED from the
  // identity that changed (CardSheet's title/notes/stories all derive from the
  // card, so key={openCard.id} is complete); use a reset effect when the state
  // derives from nothing but is only MEANINGFUL in a context.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope/tab-keyed reset, same pattern as BoardTabs' scope-keyed reset
  useEffect(() => {
    setAddingCard(false);
    setCardTitle("");
    setOpen(null);
  }, [scope, tab?.key]);

  // Optimistic move + PATCH + rollback-on-fail. Same-column reorders PATCH
  // {order} only — omitting columnId keeps the swarm's Jira push-on-move
  // (which triggers on any body carrying columnId) from firing on a card
  // that never left its column.
  const applyMove = useCallback(
    async (boardId: string, cardId: string, columnId: string, order: number) => {
      const previous = boards.find((b) => b.id === boardId);
      if (!previous) return;
      const movingCard = previous.cards.find((c) => c.id === cardId);
      const sameColumn = movingCard?.columnId === columnId;
      const next = moveCard(previous, cardId, columnId, order);
      setBoards((all) => all.map((b) => (b.id === next.id ? next : b)));
      const body: { columnId?: string; order: number } = sameColumn ? { order } : { columnId, order };
      const res = await fetch(
        `http://${BASE}/work/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}`,
        { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      ).catch(() => null);
      if (!res?.ok) {
        // Full-snapshot restore: a second drag that started (and applied its
        // own optimistic update) while this PATCH was in flight gets
        // discarded too — this rolls back to the state captured before
        // THIS move, not a merge of the two.
        setBoards((all) => all.map((b) => (b.id === previous.id ? previous : b)));
        setError("Move failed — restored the previous order");
        return;
      }
      void refetch(); // pick up server-side effects (renumber, jira lastPushError)
    },
    [boards, refetch],
  );

  useEffect(() => {
    dropHandler = applyMove;
    return () => {
      dropHandler = null;
    };
  }, [applyMove]);

  const handleDragEnd = (e: DragEndEvent) => {
    if (!e.over) return;
    const cardId = String(e.active.id);
    const outcome = resolveCrossBoardDrop(boards, cardId, String(e.over.id));
    if (!outcome) return;
    if ("error" in outcome) {
      setError(outcome.error);
      return;
    }
    void applyMove(outcome.boardId, cardId, outcome.columnId, outcome.order);
  };

  const addCard = async () => {
    const target = tabBoards[0];
    if (!target || !cardTitle.trim()) return;
    await fetch(`http://${BASE}/work/boards/${encodeURIComponent(target.id)}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: cardTitle.trim() }),
    }).catch(() => setError("Could not add the card"));
    setCardTitle("");
    setAddingCard(false);
    void refetch();
  };

  const addBoard = async (type: BoardTypeT) => {
    const res = (await fetch(`http://${BASE}/work/boards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, workspaceId: scope }),
    })
      .then((r) => r.json())
      .catch(() => ({ error: "unreachable" }))) as WorkBoardT & { error?: string };
    if (res.error) {
      setError(res.error);
      return;
    }
    setActiveKey(type);
    void refetch();
  };

  const importFromJira = async () => {
    const target = tabBoards[0];
    if (!target) return;
    const res = (await fetch(`http://${BASE}/work/boards/${encodeURIComponent(target.id)}/jira/import`, {
      method: "POST",
    })
      .then((r) => r.json())
      .catch(() => ({ error: "Broker unreachable" }))) as { error?: string };
    if (res.error) {
      setError(res.error);
      return;
    }
    void refetch();
  };

  return (
    <main className="board-stage" aria-label="Work boards">
      <BoardTabs
        scope={scope}
        workspaces={workspaces.map((w) => w.name)}
        tabs={tabs}
        activeKey={tab?.key ?? null}
        addable={scope === ALL_WORKSPACES ? [] : addableTypes(boards, scope)}
        onScope={(s) => {
          setScope(s);
          setActiveKey(null);
        }}
        onSelect={setActiveKey}
        onAdd={(t) => void addBoard(t)}
      />
      <header className="board-stage__bar">
        <SquareKanban size={14} strokeWidth={2} />
        <button
          type="button"
          className="settings-btn"
          onClick={() => setAddingCard((v) => !v)}
          disabled={tabBoards.length !== 1}
          title={tabBoards.length > 1 ? "Pick a single workspace to add a card" : undefined}
        >
          <Plus size={12} strokeWidth={2} /> add card
        </button>
        {tabBoards.length === 1 && tabBoards[0].jira && (
          <button type="button" className="settings-btn" onClick={() => void importFromJira()}>
            <Download size={12} strokeWidth={2} /> import from jira
          </button>
        )}
      </header>
      {addingCard && tabBoards.length === 1 && (
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
      {tab && (
        <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={handleDragEnd}>
          <div className="board-stage__columns">
            {columns.map((col) => (
              <BoardColumn
                key={col.id}
                col={col}
                clusters={clusterByWorkspace(collectCards(tabBoards, col.id), tab.clustered)}
                colorFor={colorFor}
                agentFor={agentFor}
                onOpenCard={(boardId, cardId) => setOpen({ boardId, cardId })}
              />
            ))}
          </div>
        </DndContext>
      )}
      {openBoard && openCard && (
        <CardSheet
          key={openCard.id}
          board={openBoard}
          card={openCard}
          roster={roster}
          workspaces={workspaces.map((w) => w.name)}
          onClose={() => setOpen(null)}
          onChanged={() => void refetch()}
        />
      )}
    </main>
  );
}
