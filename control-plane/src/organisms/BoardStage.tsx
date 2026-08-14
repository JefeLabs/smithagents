import { DndContext, type DragEndEvent, PointerSensor, pointerWithin, useSensor, useSensors } from "@dnd-kit/core";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Plus, SquareKanban } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { RosterAgent, TerminalEffectT, WorkspaceRecord } from "../api/types";
import type { BoardsResult } from "../api/work";
import { useRangeBounds } from "../hooks/useRangeBounds";
import {
  type AggCard,
  ALL_WORKSPACES,
  addableTypes,
  BOARD_TYPE_LABELS_UI,
  type BoardTypeT,
  clusterByWorkspace,
  collectAgendaCards,
  collectCards,
  sharedQueueCards,
  tabsFor,
} from "../lib/board-aggregate";
import { inDateRange } from "../lib/dateRange";
import { workspaceColor } from "../lib/workspace-color";
import { flagAge } from "../molecules/BoardCard";
import { BoardColumn } from "../molecules/BoardColumn";
import { BoardTabs } from "../molecules/BoardTabs";
import { useMe, useWorkspaceRecords } from "../queries/http";
import { qk } from "../queries/keys";
import { useSession } from "../queries/pushed";
import { useBoards, useCardAgenda, useCreateBoard, useCreateCard, useImportJira, useMoveCard } from "../queries/work";
import { useUiStore } from "../stores/uiStore";
import { CardSheet } from "./CardSheet";
import { QueueSourcesSheet } from "./QueueSourcesSheet";
import { TerminalEffectsSheet } from "./TerminalEffectsSheet";

/** Stable empty while the records query is pending — `colorFor` runs per card. */
const NO_WORKSPACES: WorkspaceRecord[] = [];

/** The Agenda tab's derived pool lane. Exists on no board — nothing may persist this id. */
const SHARED_LANE: WorkColumn = { id: "shared-queue", name: "Shared queue" };

export interface WorkColumn {
  id: string;
  name: string;
  jiraStatus?: string;
  gatesHuman?: boolean;
}
export interface WorkCardT {
  id: string;
  title: string;
  /** Swarm cards always stamp these; optional here because a hand-written board file might not. */
  createdAt?: string;
  updatedAt?: string;
  notes?: string;
  columnId: string;
  order: number;
  jira?: { key: string; url: string; lastPushError?: string };
  delegation?: { agentId: string; taskId: string; state: "working" | "completed" | "failed"; prUrl?: string };
  stories?: Array<{ id: string; text: string; done: boolean; points?: number; verifiedBy?: string }>;
  /** Present when this card tracks a capability slice — its checklist becomes toggle-only. */
  capabilityRef?: { capabilityId: string; sliceId: string };
  flag?: { kind: "blocked" | "at-risk" | "waiting"; reason?: string; since: string };
  /** Who holds this card's current step — orthogonal to columnId. */
  agenda?: { by: string; state: "plate" | "today"; since: string; grabbedAt: string };
  intents?: Array<{ at: string; by: string; kind: "start" | "done"; text: string }>;
  routedFrom?: Array<{ boardId: string; boardType: string; columnId: string; at: string }>;
  /** Set when this card was carded from a bound queue source. */
  sourceRef?: { sourceId: string; itemKey: string };
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
  /** Bound queue sources card their items into this board's intake lane. */
  queue?: { sourceIds: string[] };
  /** Side effects fired when a card enters the terminal column. */
  terminal?: { columnId?: string; effects: TerminalEffectT[] };
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

/**
 * Resolves a drop on the Agenda tab, where the rendered lanes (Shared queue /
 * My plate / Today / Done / Not Doing) are NOT any one board's columns —
 * they're derived (collectAgendaCards, sharedQueueCards). resolveCrossBoardDrop
 * can't be reused here: its same-board fence rejects the cross-board drops
 * that are the entire point of this tab, and card-onto-card resolution reads
 * overCard.columnId, which for a team card is its real workflow column (e.g.
 * "review") and never "plate"/"today" — this maps `overId` to the LANE the
 * over card is rendered in instead.
 *
 * A team card's own drop position never matters (applyMove's Agenda branch
 * writes a pure step-state PATCH for it, order and all), so only a personal
 * card's `order` needs to be a real per-column index — computed against the
 * personal board alone, since that's the only board a personal card's
 * siblings can come from. Team cards always render after every personal card
 * in a lane (collectAgendaCards), so dropping onto one, or onto the lane's
 * empty background, both land at the end of the personal cards already there.
 */
export function resolveAgendaDrop(
  boards: WorkBoardT[],
  userId: string,
  activeCardId: string,
  overId: string,
): { boardId: string; columnId: string; order: number } | null {
  if (overId === activeCardId) return null;
  const entries = boards.flatMap((b) => b.cards.map((c) => ({ card: c, board: b })));
  const active = entries.find((x) => x.card.id === activeCardId);
  if (!active) return null;

  const laneOf = ({ card, board }: { card: WorkCardT; board: WorkBoardT }): string | undefined =>
    board.type === "personal" ? card.columnId : card.agenda?.by === userId ? card.agenda.state : undefined;

  let laneId: string | undefined;
  if (overId.startsWith("column:")) {
    laneId = overId.slice("column:".length);
  } else {
    const overEntry = entries.find((x) => x.card.id === overId);
    laneId = overEntry ? laneOf(overEntry) : undefined;
  }
  if (!laneId) return null;

  if (active.board.type !== "personal") return { boardId: active.board.id, columnId: laneId, order: 0 };

  const personalBoard = active.board;
  const overEntry = overId.startsWith("column:") ? undefined : entries.find((x) => x.card.id === overId);
  if (overEntry && overEntry.board.id === personalBoard.id) {
    const target = resolveDrop(personalBoard, activeCardId, overId);
    if (!target) return null;
    return { boardId: personalBoard.id, ...target };
  }
  const order = personalBoard.cards.filter((c) => c.columnId === laneId && c.id !== activeCardId).length;
  return { boardId: personalBoard.id, columnId: laneId, order };
}

// Test seam: jsdom cannot synthesize dnd-kit pointer sequences; the drop
// handler is registered here so tests can invoke the exact code path a real
// drop takes.
let dropHandler: ((boardId: string, cardId: string, columnId: string, order: number) => Promise<void>) | null = null;
export async function fireDrop(boardId: string, cardId: string, columnId: string, order: number): Promise<void> {
  if (!dropHandler) throw new Error("BoardStage is not mounted");
  await dropHandler(boardId, cardId, columnId, order);
}

// Test seam, one layer above fireDrop: fireDrop calls applyMove directly, so
// it cannot exercise the RESOLUTION layer (resolveCrossBoardDrop /
// resolveAgendaDrop) that sits between a real dnd-kit gesture and applyMove.
// This registers the actual onDragEnd handler DndContext is wired to, so a
// test can drive the exact code path a real drop takes, over.id and all.
let dragEndHandler: ((e: DragEndEvent) => void) | null = null;
export function fireDragEnd(activeId: string, overId: string): void {
  if (!dragEndHandler) throw new Error("BoardStage is not mounted");
  dragEndHandler({ active: { id: activeId }, over: { id: overId } } as DragEndEvent);
}

/** Shared face for the two card-position composers below — only the label/verb differ. */
function CardComposer({
  question,
  verb,
  submitting,
  onCancel,
  onSubmit,
}: {
  question: string;
  verb: string;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const [text, setText] = useState("");
  return (
    <div className="board-card board-card--composer">
      <label>
        {question}
        <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="board-card__composer-actions">
        <button type="button" className="settings-btn" onClick={onCancel}>
          cancel
        </button>
        <button
          type="button"
          className="settings-btn settings-btn--primary"
          disabled={!text.trim() || submitting}
          onClick={() => onSubmit(text.trim())}
        >
          {verb}
        </button>
      </div>
    </div>
  );
}

/**
 * A card reduced to an open control plus one card-level action, never a
 * nested button — the action sits beside the title, not inside it. Shared by
 * Grab (shared-queue cards) and Release (cards the viewer already holds, in
 * My plate / Today): same shape, only the verb and the write differ.
 */
function CardAction({
  card,
  verb,
  pending,
  onOpen,
  onAction,
}: {
  card: AggCard;
  verb: string;
  pending: boolean;
  onOpen: () => void;
  onAction: () => void;
}) {
  return (
    <div className="board-card board-card--action">
      <button type="button" className="board-card__open" onClick={onOpen}>
        <span className="board-card__title">{card.title}</span>
      </button>
      <button type="button" className="settings-btn board-card__action" disabled={pending} onClick={onAction}>
        {verb}
      </button>
    </div>
  );
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
  const cardAgendaMutation = useCardAgenda();
  const { data: me } = useMe();

  const { data: session } = useSession();
  const viewed = useUiStore((s) => s.viewedWorkspaces);
  const rangeBounds = useRangeBounds();
  // Derived, not stored: the session frame is authoritative for the active
  // workspace, and `viewed` only needs to hold state once the user diverges
  // from it — an untouched (empty) selection means "no explicit view yet", so
  // a fresh load follows the active session's one workspace instead of
  // defaulting to every workspace at once. When there is PROVABLY no session
  // to follow yet (the frame hasn't landed, or it landed confirming zero
  // sessions), "follow the session" has no meaning — fall back to every
  // workspace, the prior default, rather than to none. Memoized so its
  // identity stays stable across renders where neither input actually
  // changed — the reset effects below are keyed on it, and a fresh Set()
  // every render would fire them continuously.
  const scope = useMemo<ReadonlySet<string> | typeof ALL_WORKSPACES>(() => {
    if (viewed === ALL_WORKSPACES) return ALL_WORKSPACES;
    if (viewed.size > 0) return viewed;
    return session?.workspace ? new Set([session.workspace]) : ALL_WORKSPACES;
  }, [viewed, session?.workspace]);
  // The one workspace this render may create into, or null when zero or several
  // are in view — "you may look at many, but you may only create in one."
  const singleWorkspace = scope !== ALL_WORKSPACES && scope.size === 1 ? [...scope][0] : null;
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingCard, setAddingCard] = useState(false);
  const [addingBoard, setAddingBoard] = useState(false);
  const [cardTitle, setCardTitle] = useState("");
  const [open, setOpen] = useState<{ boardId: string; cardId: string } | null>(null);
  const [configOpen, setConfigOpen] = useState<{ boardId: string; column: "queue" | "terminal" } | null>(null);
  // Claiming "today" needs a sentence; ending a held step needs a word. Both
  // hold the drop's target coordinates and gate the card's face — see applyMove.
  const [pendingIntent, setPendingIntent] = useState<{ boardId: string; cardId: string } | null>(null);
  const [pendingClose, setPendingClose] = useState<{
    boardId: string;
    cardId: string;
    columnId: string;
    order: number;
  } | null>(null);
  // Same endpoint and envelope the hand-rolled fetch here used, but on the
  // shared key — so this stage and the map issue one request between them
  // rather than one each, and a workspace edit invalidates both.
  const { data: workspaces = NO_WORKSPACES } = useWorkspaceRecords();

  const displayError = error ?? loadError;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const tabs = tabsFor(boards, scope);
  const tab = tabs.find((t) => t.key === activeKey) ?? tabs[0] ?? null;
  const tabBoards = tab ? boards.filter((b) => tab.boardIds.includes(b.id)) : [];
  // The context window (date-range spec 2026-08-12): cards not touched in the
  // picked range leave the VIEW — the swarm store is untouched, counts shrink
  // to the window. All time (null bounds) is a no-op identity.
  const windowedBoards = rangeBounds
    ? tabBoards.map((b) => ({
        ...b,
        cards: b.cards.filter((c) => !c.updatedAt || inDateRange(c.updatedAt, rangeBounds)),
      }))
    : tabBoards;
  const isAgendaTab = tab?.type === "personal";
  const personalBoard = boards.find((b) => b.type === "personal") ?? null;
  // Agenda's boardIds span every board (Task 6), so tabBoards[0] is no longer
  // the personal board — it's whichever board happens to sort first. The
  // rendered lanes come from the personal board specifically, with the
  // derived shared-queue lane prepended.
  const columns = isAgendaTab ? [SHARED_LANE, ...(personalBoard?.columns ?? [])] : (tabBoards[0]?.columns ?? []);
  // The composer targets a single board: on Agenda that's always the personal
  // board (unambiguous even though the tab spans every board), everywhere
  // else it's the tab's one board, when there is exactly one in view.
  const addCardTarget = isAgendaTab ? personalBoard : tabBoards.length === 1 ? tabBoards[0] : null;
  // Cards go to the board they came from, never the tab — in aggregate scope a
  // tab spans several boards.
  const boardOf = (id: string) => boards.find((b) => b.id === id) ?? null;
  const colorFor = (workspaceId?: string) => {
    if (!workspaceId) return undefined;
    const ws = workspaces.find((w) => w.name === workspaceId);
    return workspaceColor(ws ?? { name: workspaceId });
  };
  const agentFor = (id?: string) => (id ? roster.find((a) => a.id === id) : undefined);
  // Rendered on team boards only — on Agenda every card in Plate/Today is
  // definitionally the viewer's own, so naming the holder would be inert noise.
  const holderFor = (card: AggCard) => {
    if (isAgendaTab || !card.agenda) return undefined;
    const by = card.agenda.by;
    return { name: me && me.id === by ? me.name : by, state: card.agenda.state };
  };
  // The workflow axis a card carries onto Agenda from its home board — never
  // shown for personal todos, which have no board type to name.
  const provenanceFor = (card: AggCard) => {
    if (!isAgendaTab) return undefined;
    const home = boardOf(card.boardId);
    if (!home || home.type === "personal") return undefined;
    return `${BOARD_TYPE_LABELS_UI[home.type]} · ${card.columnId}`;
  };
  // A committed step reads as a sentence, not a title — shown wherever the
  // held card appears (Agenda's own Today lane and the team board alike).
  const intentFor = (card: AggCard) => {
    if (card.agenda?.state !== "today" || !card.intents?.length) return undefined;
    const last = card.intents[card.intents.length - 1];
    return last.kind === "start" ? last.text : undefined;
  };
  // grabbedAt, never `since` — the morning sweep re-stamps `since` on every
  // card it reverts, which would make yesterday's plate look freshly grabbed.
  const ageFor = (card: AggCard) => (card.agenda?.state === "plate" ? flagAge(card.agenda.grabbedAt) : undefined);
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
    setConfigOpen(null);
    setPendingIntent(null);
    setPendingClose(null);
  }, [scope, tab?.key]);

  // Lifted from BoardTabs: the add-board menu unmounts whenever `addable` is
  // empty, but `adding` was component state there and survived that —
  // without this, opening the menu, viewing several workspaces, then
  // returning to one resurrects it already open. Kept scope-only (not
  // tab-keyed) to match what it replaces.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope-keyed reset, same pattern as the effect above
  useEffect(() => {
    setAddingBoard(false);
  }, [scope]);

  // Optimistic move + PATCH + rollback-on-fail. Same-column reorders PATCH
  // {order} only — omitting columnId keeps the swarm's Jira push-on-move
  // (which triggers on any body carrying columnId) from firing on a card
  // that never left its column.
  const applyMove = useCallback(
    async (boardId: string, cardId: string, columnId: string, order: number) => {
      const previous = boards.find((b) => b.id === boardId);
      if (!previous) return;
      const movingCard = previous.cards.find((c) => c.id === cardId);

      // Agenda's plate/today lanes hold TEAM cards on their home board — the
      // dragged card's own board, not "personal". Their drop writes a step
      // state, never a columnId; the server treats a column move and a
      // step-state write as mutually exclusive on one call.
      if (isAgendaTab && previous.type !== "personal") {
        if (columnId !== "plate" && columnId !== "today") return;
        if (columnId === "today") {
          // Claiming a day needs a sentence. Nothing is written until it is
          // submitted — no optimistic move, no PATCH — so cancelling leaves
          // the card exactly where it was. This is the one drop in the app
          // that a drag alone cannot complete.
          setPendingIntent({ boardId, cardId });
          return;
        }
        await cardAgendaMutation.mutateAsync({ boardId, cardId, agenda: { state: "plate" } });
        return;
      }

      // The closing composer: fires here too, on the team board's own
      // columns, not only on Agenda — ending a held step, or a personal card
      // entering Done.
      const changingColumn = Boolean(movingCard) && movingCard?.columnId !== columnId;
      const endsHeldStep = changingColumn && Boolean(movingCard?.agenda);
      const personalDone = changingColumn && previous.type === "personal" && columnId === "done";
      if (endsHeldStep || personalDone) {
        // Mirrors the server guard in patchCard. Asking here is a courtesy —
        // the server refuses the move regardless, which is what makes the
        // rule real.
        setPendingClose({ boardId, cardId, columnId, order });
        return;
      }

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
    [boards, moveCardMutation, qc, isAgendaTab, cardAgendaMutation],
  );

  useEffect(() => {
    dropHandler = applyMove;
    return () => {
      dropHandler = null;
    };
  }, [applyMove]);

  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      if (!e.over) return;
      const cardId = String(e.active.id);
      const overId = String(e.over.id);
      // Agenda's lanes are rendered lanes spanning every board, not any one
      // board's columns — resolveCrossBoardDrop's same-board fence and its
      // reliance on overCard.columnId both assume a single board's column
      // set, which Agenda breaks by design. See resolveAgendaDrop's doc.
      if (isAgendaTab) {
        const outcome = resolveAgendaDrop(boards, me?.id ?? "", cardId, overId);
        if (!outcome) return;
        void applyMove(outcome.boardId, cardId, outcome.columnId, outcome.order);
        return;
      }
      const outcome = resolveCrossBoardDrop(boards, cardId, overId);
      if (!outcome) return;
      if ("error" in outcome) {
        setError(outcome.error);
        return;
      }
      void applyMove(outcome.boardId, cardId, outcome.columnId, outcome.order);
    },
    [boards, isAgendaTab, me?.id, applyMove],
  );

  useEffect(() => {
    dragEndHandler = handleDragEnd;
    return () => {
      dragEndHandler = null;
    };
  }, [handleDragEnd]);

  const addCard = async () => {
    const target = addCardTarget;
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
    if (!singleWorkspace) return; // the add control is hidden in this case; guard the mutation too
    try {
      await createBoardMutation.mutateAsync({ type, workspaceId: singleWorkspace });
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

  // Config gear is per-board, so aggregate tabs (several boards in one tab)
  // hide it entirely rather than guess which board a gear click means.
  const configBoard = tab && tab.boardIds.length === 1 ? (boardOf(tab.boardIds[0]) ?? null) : null;
  const intakeId = configBoard
    ? configBoard.columns.some((c) => c.id === "queue")
      ? "queue"
      : configBoard.columns[0]?.id
    : undefined;
  const terminalId = configBoard
    ? (configBoard.terminal?.columnId ?? configBoard.columns[configBoard.columns.length - 1]?.id)
    : undefined;

  return (
    <section className="stage board-stage" aria-label="Work boards">
      <BoardTabs
        tabs={tabs}
        activeKey={tab?.key ?? null}
        addable={singleWorkspace ? addableTypes(boards, singleWorkspace) : []}
        adding={addingBoard}
        onAddingChange={setAddingBoard}
        onSelect={setActiveKey}
        onAdd={(t) => void addBoard(t)}
      />
      <header className="board-stage__bar">
        <SquareKanban size={14} strokeWidth={2} />
        <button
          type="button"
          className="settings-btn"
          onClick={() => setAddingCard((v) => !v)}
          disabled={!addCardTarget}
          title={!isAgendaTab && tabBoards.length > 1 ? "Pick a single workspace to add a card" : undefined}
        >
          <Plus size={12} strokeWidth={2} /> add card
        </button>
        {tabBoards.length === 1 && tabBoards[0].jira && (
          <button type="button" className="settings-btn" onClick={() => void importFromJira()}>
            <Download size={12} strokeWidth={2} /> import from jira
          </button>
        )}
      </header>
      {addingCard && addCardTarget && (
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
            {columns.map((col) => {
              const isSharedQueue = isAgendaTab && col.id === "shared-queue";
              // boards, not windowedBoards: Agenda is range-invariant, same
              // reasoning as its workspace-invariance (tabsFor's comment on
              // `personal`). A held team card's `updatedAt` is never
              // re-stamped by setStepState or the morning sweep, so the date
              // window would silently drop long-held cards from the exact
              // view that exists to surface them (grabbedAt ordering, age
              // chip). Team-board tabs keep windowedBoards unchanged below.
              const cards: AggCard[] = isAgendaTab
                ? isSharedQueue
                  ? sharedQueueCards(boards)
                  : collectAgendaCards(boards, me?.id ?? "", col.id)
                : collectCards(windowedBoards, col.id);
              // Agenda's lane order (personal cards first by order, then team
              // cards by grabbedAt) is meaningful — clusterByWorkspace's
              // single-cluster path re-sorts by `order`, which is per-column-
              // per-board and would scramble it. Agenda is never clustered
              // (tabsFor never sets it), so it bypasses that sort entirely.
              const clusters = isAgendaTab ? [{ label: null, cards }] : clusterByWorkspace(cards, tab.clustered);
              // Two override shapes, never conflated (see BoardColumn's
              // doc): "replace" swaps the whole face out and drops the card
              // from SortableContext — right for the two composers and for
              // Shared queue, whose cards are button-only by design and
              // never draggable. "action" leaves the card a genuine
              // SortableCard and only adds a button to its face — required
              // for Release, or a held card could never again be dragged to
              // advance it, which is the whole point of the drag branch.
              const cardOverride = (card: AggCard) => {
                if (pendingIntent?.cardId === card.id) {
                  const target = pendingIntent;
                  return {
                    kind: "replace" as const,
                    node: (
                      <CardComposer
                        question="What are you doing?"
                        verb="start"
                        submitting={cardAgendaMutation.isPending}
                        onCancel={() => setPendingIntent(null)}
                        onSubmit={(text) =>
                          void cardAgendaMutation
                            .mutateAsync({
                              boardId: target.boardId,
                              cardId: target.cardId,
                              agenda: { state: "today", intent: text },
                            })
                            .then(() => setPendingIntent(null))
                            .catch((err) =>
                              setError(err instanceof Error ? err.message : "Could not start the day's work"),
                            )
                        }
                      />
                    ),
                  };
                }
                if (pendingClose?.cardId === card.id) {
                  const target = pendingClose;
                  return {
                    kind: "replace" as const,
                    node: (
                      <CardComposer
                        question="What did you do?"
                        verb="done"
                        submitting={moveCardMutation.isPending}
                        onCancel={() => setPendingClose(null)}
                        onSubmit={(text) =>
                          void moveCardMutation
                            .mutateAsync({
                              boardId: target.boardId,
                              cardId: target.cardId,
                              body: { columnId: target.columnId, order: target.order, close: { text } },
                            })
                            .then(() => setPendingClose(null))
                            .catch((err) => setError(err instanceof Error ? err.message : "Could not close the card"))
                        }
                      />
                    ),
                  };
                }
                if (isSharedQueue) {
                  return {
                    kind: "replace" as const,
                    node: (
                      <CardAction
                        card={card}
                        verb="grab"
                        pending={cardAgendaMutation.isPending}
                        onOpen={() => setOpen({ boardId: card.boardId, cardId: card.id })}
                        onAction={() =>
                          void cardAgendaMutation
                            .mutateAsync({
                              boardId: card.boardId,
                              cardId: card.id,
                              agenda: { action: "grab" },
                            })
                            .catch((err) => setError(err instanceof Error ? err.message : "Could not grab the card"))
                        }
                      />
                    ),
                  };
                }
                // A team card the viewer holds, sitting in My plate or Today
                // — Release is the mirror of Grab. Checked here explicitly
                // (not only relied on via collectAgendaCards' own by===userId
                // filter) so a future wiring drift between `me.id` and that
                // collector's argument can't silently offer Release on
                // someone else's card — a belt-and-suspenders check, not the
                // only one.
                if (isAgendaTab && (col.id === "plate" || col.id === "today") && card.agenda?.by === me?.id) {
                  return {
                    kind: "action" as const,
                    verb: "release",
                    pending: cardAgendaMutation.isPending,
                    onAction: () =>
                      void cardAgendaMutation
                        .mutateAsync({ boardId: card.boardId, cardId: card.id, agenda: null })
                        .catch((err) => setError(err instanceof Error ? err.message : "Could not release the card")),
                  };
                }
                return undefined;
              };
              return (
                <BoardColumn
                  key={col.id}
                  col={col}
                  clusters={clusters}
                  colorFor={colorFor}
                  agentFor={agentFor}
                  holderFor={holderFor}
                  provenanceFor={provenanceFor}
                  intentFor={intentFor}
                  ageFor={ageFor}
                  onOpenCard={(boardId, cardId) => setOpen({ boardId, cardId })}
                  droppable={!isSharedQueue}
                  cardOverride={cardOverride}
                  onConfigure={
                    configBoard && col.id === intakeId
                      ? () => setConfigOpen({ boardId: configBoard.id, column: "queue" })
                      : configBoard && col.id === terminalId
                        ? () => setConfigOpen({ boardId: configBoard.id, column: "terminal" })
                        : undefined
                  }
                />
              );
            })}
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
      {configOpen?.column === "queue" && boardOf(configOpen.boardId) && (
        <QueueSourcesSheet board={boardOf(configOpen.boardId) as WorkBoardT} open onClose={() => setConfigOpen(null)} />
      )}
      {configOpen?.column === "terminal" && boardOf(configOpen.boardId) && (
        <TerminalEffectsSheet
          board={boardOf(configOpen.boardId) as WorkBoardT}
          open
          onClose={() => setConfigOpen(null)}
        />
      )}
    </section>
  );
}
