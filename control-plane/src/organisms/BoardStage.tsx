import { DndContext, type DragEndEvent, PointerSensor, pointerWithin, useSensor, useSensors } from "@dnd-kit/core";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Plus, SquareKanban } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { RosterAgent, WorkspaceRecord } from "../api/types";
import type { BoardsResult } from "../api/work";
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
import { useWorkspaceRecords } from "../queries/http";
import { qk } from "../queries/keys";
import { useBoards, useCreateBoard, useCreateCard, useImportJira, useMoveCard } from "../queries/work";
import { CardSheet } from "./CardSheet";

/** Stable empty while the records query is pending — `colorFor` runs per card. */
const NO_WORKSPACES: WorkspaceRecord[] = [];

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
 *
 * Returns `{error}` rather than throwing on purpose: this is a pure domain
 * predicate over an in-memory list, not I/O — the throw-on-failure convention
 * `api/work.ts` uses everywhere else applies to network calls, not to this.
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
export function BoardStage({ roster }: BoardStageProps) {
  const qc = useQueryClient();
  const boardsQuery = useBoards();
  const boards = boardsQuery.data?.boards ?? [];
  const boardErrors = boardsQuery.data?.errors ?? [];
  const loadError = boardsQuery.isError ? "Could not load boards — is the broker running?" : null;

  const createBoardMutation = useCreateBoard();
  const createCardMutation = useCreateCard();
  const moveCardMutation = useMoveCard();
  const importJiraMutation = useImportJira();

  const [scope, setScope] = useState<string>(ALL_WORKSPACES);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingCard, setAddingCard] = useState(false);
  const [cardTitle, setCardTitle] = useState("");
  const [open, setOpen] = useState<{ boardId: string; cardId: string } | null>(null);
  // Same endpoint and envelope the hand-rolled fetch here used, but on the
  // shared key — so this stage and the map issue one request between them
  // rather than one each, and a workspace edit invalidates both.
  const { data: workspaces = NO_WORKSPACES } = useWorkspaceRecords();

  const displayError = error ?? loadError;

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
      qc.setQueryData<BoardsResult>(qk.boards, (curr) =>
        curr ? { ...curr, boards: curr.boards.map((b) => (b.id === next.id ? next : b)) } : curr,
      );
      const body: { columnId?: string; order: number } = sameColumn ? { order } : { columnId, order };
      try {
        // Success invalidates qk.boards itself (useMoveCard's onSuccess), which
        // picks up server-side effects (renumber, jira lastPushError) — same as
        // the original's `void refetch()` after a successful PATCH.
        await moveCardMutation.mutateAsync({ boardId, cardId, body });
        setError(null);
      } catch {
        // Full-snapshot restore: a second drag that started (and applied its
        // own optimistic update) while this PATCH was in flight gets
        // discarded too — this rolls back to the state captured before
        // THIS move, not a merge of the two.
        qc.setQueryData<BoardsResult>(qk.boards, (curr) =>
          curr ? { ...curr, boards: curr.boards.map((b) => (b.id === previous.id ? previous : b)) } : curr,
        );
        setError("Move failed — restored the previous order");
      }
    },
    [boards, moveCardMutation, qc],
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
    try {
      await createCardMutation.mutateAsync({ boardId: target.id, body: { title: cardTitle.trim() } });
      setError(null);
    } catch {
      setError("Could not add the card");
    }
    setCardTitle("");
    setAddingCard(false);
  };

  const addBoard = async (type: BoardTypeT) => {
    try {
      await createBoardMutation.mutateAsync({ type, workspaceId: scope });
      setActiveKey(type);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "unreachable");
    }
  };

  const importFromJira = async () => {
    const target = tabBoards[0];
    if (!target) return;
    try {
      await importJiraMutation.mutateAsync(target.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Broker unreachable");
    }
  };

  return (
    <section className="stage board-stage" aria-label="Work boards">
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
      {displayError && <p className="wizard__error">{displayError}</p>}
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
          onChanged={() => void qc.invalidateQueries({ queryKey: qk.boards })}
        />
      )}
    </section>
  );
}
