// Kanban work boards — the user's personal planning store, one JSON file per
// board under .smith/work/. Boards are data (columns included), never code:
// seven typed templates seed them, and every mutation goes through the
// helpers here so routes stay thin and unit tests never boot the server.
// Cards may LINK to a Jira issue or a delegated agent task; neither linkage
// is required, and execution state never moves a card — columns belong to
// the human.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface WorkColumn {
  id: string;
  name: string;
  /** Jira status to transition a linked card to when it lands here; absent = no push. */
  jiraStatus?: string;
}

export type FlagKind = "blocked" | "at-risk" | "waiting";

/** Orthogonal to columnId — a flagged card keeps its position. */
export interface CardFlag {
  kind: FlagKind;
  reason?: string;
  /** Stamped on entry into a flagged state; survives kind/reason edits, dropped on clear. */
  since: string;
}

const FLAG_KINDS: FlagKind[] = ["blocked", "at-risk", "waiting"];

export interface WorkCard {
  id: string;
  title: string;
  notes?: string;
  columnId: string;
  /** Position within its column, always renumbered 0..n-1 by the helpers. */
  order: number;
  createdAt: string;
  updatedAt: string;
  jira?: { key: string; url: string; lastPushError?: string };
  delegation?: { agentId: string; taskId: string; state: "working" | "completed" | "failed"; prUrl?: string };
  /** Acceptance-criteria checklist — authored by hand in v1, replaced wholesale on PATCH. Never a column. */
  stories?: Array<{ id: string; text: string; done: boolean; verifiedBy?: string }>;
  /** Set when this card tracks a capability slice — its checklist becomes a toggle-only view of the capability's stories. */
  capabilityRef?: { capabilityId: string; sliceId: string };
  /** Appended each time this card is routed to another board. Never rewritten. */
  routedFrom?: Array<{ boardId: string; boardType: BoardType; columnId: string; at: string }>;
  flag?: CardFlag;
}

export interface WorkBoard {
  id: string;
  name: string;
  /** Persisted board identity — drives tabs, one-per-type cardinality, and routing. */
  type: BoardType;
  columns: WorkColumn[];
  cards: WorkCard[];
  jira?: { connectorId: string; siteUrl: string; projectKey: string; jql?: string };
  /** Present on every workspace board; absent only on the single personal board. */
  workspaceId?: string;
}

const BOARD_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type BoardType = "personal" | "ideation" | "plan" | "deliver" | "release" | "reactive" | "maintenance";

/** Tab order. personal is always first; the other six are the workspace types. */
export const BOARD_TYPE_ORDER: BoardType[] = [
  "personal",
  "ideation",
  "plan",
  "deliver",
  "release",
  "reactive",
  "maintenance",
];

export const WORKSPACE_BOARD_TYPES: BoardType[] = BOARD_TYPE_ORDER.filter((t) => t !== "personal");

export const BOARD_TYPE_LABELS: Record<BoardType, string> = {
  personal: "Active To-dos",
  ideation: "Ideation",
  plan: "Plan",
  deliver: "Deliver",
  release: "Release",
  reactive: "Reactive",
  maintenance: "Maintenance",
};

// Boards that own an outcome get a terminal column (Killed / Won't do / Not
// Doing); boards that hand work onward get an exit in BOARD_ROUTES instead,
// which is why plan and deliver have neither.
export const BOARD_TEMPLATES: Record<BoardType, WorkColumn[]> = {
  personal: [
    { id: "queue", name: "Queue" },
    { id: "todo", name: "Todo" },
    { id: "doing", name: "Doing" },
    { id: "done", name: "Done" },
    { id: "not-doing", name: "Not Doing" },
  ],
  ideation: [
    { id: "intake", name: "Intake" },
    { id: "scoping", name: "Scoping" },
    { id: "confirm", name: "Confirm" },
    { id: "killed", name: "Killed" },
  ],
  plan: [
    { id: "spec", name: "Spec" },
    { id: "tech-design", name: "Tech design" },
    { id: "decomposed", name: "Decomposed" },
    { id: "ready", name: "Ready" },
  ],
  deliver: [
    { id: "ready", name: "Ready" },
    { id: "in-progress", name: "In progress" },
    { id: "review", name: "Review" },
    { id: "verify", name: "Verify" },
    { id: "merged", name: "Merged" },
  ],
  release: [
    { id: "cut", name: "Cut" },
    { id: "regression", name: "Regression" },
    { id: "sign-off", name: "Sign-off" },
    { id: "ship", name: "Ship" },
    { id: "rollback", name: "Rollback" },
  ],
  reactive: [
    { id: "triage", name: "Triage" },
    { id: "diagnose", name: "Diagnose" },
    { id: "fix", name: "Fix" },
    { id: "verify", name: "Verify" },
    { id: "closed", name: "Closed" },
  ],
  maintenance: [
    { id: "triage", name: "Triage" },
    { id: "queued", name: "Queued" },
    { id: "doing", name: "Doing" },
    { id: "done", name: "Done" },
    { id: "wont-do", name: "Won't do" },
  ],
};

function slug(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The on-disk id (and filename) of a workspace's board of a given type. */
export function boardIdFor(workspaceId: string, type: BoardType): string {
  return `${slug(workspaceId)}-${type}`;
}

/**
 * Mint a board from its type. The id comes from the type, never the name, so a
 * later rename via PATCH never has to move a file.
 */
export function createBoard(type: BoardType, workspaceId?: string): WorkBoard {
  if (!BOARD_TEMPLATES[type]) throw new Error(`Unknown board type: ${type}`);
  if (type === "personal" && workspaceId) throw new Error("The personal board belongs to no workspace");
  if (type !== "personal" && !workspaceId) throw new Error(`Board type "${type}" requires a workspace`);
  const id = type === "personal" ? "personal" : boardIdFor(workspaceId as string, type);
  if (!BOARD_ID_RE.test(id)) throw new Error(`Workspace "${workspaceId}" does not reduce to a usable board id`);
  const board: WorkBoard = {
    id,
    name: BOARD_TYPE_LABELS[type],
    type,
    columns: BOARD_TEMPLATES[type].map((c) => ({ ...c })),
    cards: [],
  };
  if (workspaceId) board.workspaceId = workspaceId;
  return board;
}

export interface RouteExit {
  /** Column id on the source board this exit leaves from. */
  from: string;
  toType: BoardType;
  /** Column id on the destination board the card lands in. */
  toColumn: string;
  label: string;
}

/**
 * Cross-board transitions, static rather than per-board config: there is no UI
 * to edit a per-board table, so configurable-only-by-hand-editing-JSON is the
 * trap this avoids. Ideation's Confirm→Scoping loop is a same-board drag, and
 * Maintenance's scanner intake is descriptive — neither is a route.
 */
export const BOARD_ROUTES: Record<BoardType, RouteExit[]> = {
  plan: [
    { from: "tech-design", toType: "ideation", toColumn: "scoping", label: "Back to ideation" },
    { from: "ready", toType: "deliver", toColumn: "ready", label: "Send to deliver" },
  ],
  deliver: [{ from: "in-progress", toType: "plan", toColumn: "tech-design", label: "Back to plan" }],
  release: [
    { from: "regression", toType: "deliver", toColumn: "in-progress", label: "Drop change to deliver" },
    { from: "rollback", toType: "maintenance", toColumn: "triage", label: "To maintenance" },
  ],
  reactive: [
    { from: "triage", toType: "maintenance", toColumn: "triage", label: "To maintenance" },
    { from: "triage", toType: "ideation", toColumn: "intake", label: "To ideation" },
  ],
  ideation: [],
  maintenance: [],
  personal: [],
};

export function exitsFor(board: WorkBoard, columnId: string): RouteExit[] {
  return BOARD_ROUTES[board.type].filter((e) => e.from === columnId);
}

export function resolveExit(board: WorkBoard, columnId: string, toType: BoardType): RouteExit | undefined {
  return BOARD_ROUTES[board.type].find((e) => e.from === columnId && e.toType === toType);
}

/**
 * The two boards a routed card touches, in the order they MUST be persisted.
 * Two file writes cannot be atomic, so the ordering is the failure design:
 * destination-first means a crash between them leaves a visible duplicate,
 * source-first would lose the card outright.
 */
export interface RoutePlan {
  card: WorkCard;
  writeFirst: WorkBoard;
  writeSecond: WorkBoard;
}

/** The board a routed card lands on: same workspace as the source, the exit's destination type. */
export function findRouteDestination(boards: WorkBoard[], source: WorkBoard, exit: RouteExit): WorkBoard | undefined {
  return boards.find((b) => b.type === exit.toType && b.workspaceId === source.workspaceId);
}

export function routeCard(source: WorkBoard, dest: WorkBoard, cardId: string, exit: RouteExit, now: string): RoutePlan {
  const card = source.cards.find((c) => c.id === cardId);
  if (!card) throw new Error(`Unknown card: ${cardId}`);
  const trace = { boardId: source.id, boardType: source.type, columnId: card.columnId, at: now };
  removeCard(source, cardId);
  const moved: WorkCard = {
    ...card,
    columnId: exit.toColumn,
    order: dest.cards.filter((c) => c.columnId === exit.toColumn).length,
    updatedAt: now,
    routedFrom: [...(card.routedFrom ?? []), trace],
  };
  dest.cards.push(moved);
  return { card: moved, writeFirst: dest, writeSecond: source };
}

/**
 * Resolve a persisted `{ boardId, cardId }` ref — a slice's capCardRef, a
 * task manifest's workCardRef — against every board at once.
 *
 * The card id is the KEY and the board id only a HINT, because routeCard
 * moves a card between board files and every such ref names the board it
 * left. Card ids are uuids, so a cardId-keyed search is exact; a
 * boardId-keyed one silently orphans the ref the moment the card is routed
 * (unlinkSliceCard has always matched on cardId alone — this is that rule
 * made reusable). Undefined means the card genuinely no longer exists.
 */
export function findCardByRef(
  boards: WorkBoard[],
  ref: { boardId?: string; cardId: string },
): { board: WorkBoard; card: WorkCard } | undefined {
  const hinted = boards.find((b) => b.id === ref.boardId);
  const hintedCard = hinted?.cards.find((c) => c.id === ref.cardId);
  if (hinted && hintedCard) return { board: hinted, card: hintedCard };
  for (const board of boards) {
    const card = board.cards.find((c) => c.id === ref.cardId);
    if (card) return { board, card };
  }
  return undefined;
}

function assertBoard(file: string, v: unknown): WorkBoard {
  const o = v as WorkBoard;
  const ok =
    o &&
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    typeof o.type === "string" &&
    Boolean(BOARD_TEMPLATES[o.type]) &&
    Array.isArray(o.columns) &&
    o.columns.every((c) => typeof c?.id === "string" && typeof c?.name === "string") &&
    Array.isArray(o.cards);
  if (!ok) throw new Error(`Invalid work-board file ${file}: requires id, name, a known type, columns[], cards[]`);
  return o;
}

export async function loadBoards(
  dir: string,
): Promise<{ boards: WorkBoard[]; errors: Array<{ file: string; error: string }> }> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { boards: [], errors: [] };
  }
  const boards: WorkBoard[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  for (const file of entries.filter((f) => f.endsWith(".json"))) {
    try {
      boards.push(assertBoard(file, JSON.parse(await readFile(join(dir, file), "utf8"))));
    } catch (err) {
      errors.push({ file, error: String((err as Error).message) });
    }
  }
  return { boards, errors };
}

export async function saveBoard(dir: string, board: WorkBoard): Promise<void> {
  if (!BOARD_ID_RE.test(board.id)) throw new Error(`Invalid board id "${board.id}"`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${board.id}.json`), `${JSON.stringify(board, null, 2)}\n`);
}

export async function deleteBoardFile(dir: string, id: string): Promise<void> {
  if (!BOARD_ID_RE.test(id)) throw new Error(`Invalid board id "${id}"`);
  await rm(join(dir, `${id}.json`));
}

function renumber(board: WorkBoard, columnId: string): void {
  board.cards
    .filter((c) => c.columnId === columnId)
    .sort((a, b) => a.order - b.order)
    .forEach((c, i) => {
      c.order = i;
    });
}

/**
 * Quick-adds land where the user works, not where the system routes: the
 * personal board's leftmost column is the Queue intake (sweep + escalations
 * only), so fresh cards default to Todo there and to the leftmost column
 * everywhere else.
 */
export function defaultColumnFor(board: WorkBoard): string | undefined {
  return board.type === "personal" ? "todo" : board.columns[0]?.id;
}

export function addCard(board: WorkBoard, input: { title: string; notes?: string; columnId?: string }): WorkCard {
  const title = input.title?.trim();
  if (!title) throw new Error("Card title is required");
  const columnId = input.columnId ?? defaultColumnFor(board);
  if (!board.columns.some((c) => c.id === columnId)) throw new Error(`Unknown column: ${input.columnId}`);
  const now = new Date().toISOString();
  const card: WorkCard = {
    id: randomUUID(),
    title,
    notes: input.notes?.trim() || undefined,
    columnId,
    order: board.cards.filter((c) => c.columnId === columnId).length,
    createdAt: now,
    updatedAt: now,
  };
  board.cards.push(card);
  return card;
}

export function patchCard(
  board: WorkBoard,
  cardId: string,
  patch: Partial<
    Pick<WorkCard, "title" | "notes" | "columnId" | "order" | "jira" | "delegation" | "stories" | "capabilityRef">
  > & { flag?: { kind: FlagKind; reason?: string } | null },
): WorkCard {
  const card = board.cards.find((c) => c.id === cardId);
  if (!card) throw new Error(`Unknown card: ${cardId}`);
  if (patch.columnId !== undefined && !board.columns.some((c) => c.id === patch.columnId)) {
    throw new Error(`Unknown column: ${patch.columnId}`);
  }
  const fromColumn = card.columnId;
  if (patch.title !== undefined) card.title = patch.title.trim() || card.title;
  if (patch.notes !== undefined) card.notes = patch.notes.trim() || undefined;
  if (patch.jira !== undefined) card.jira = patch.jira ?? undefined;
  if (patch.delegation !== undefined) card.delegation = patch.delegation ?? undefined;
  if (patch.stories !== undefined) card.stories = patch.stories ?? undefined;
  if (patch.capabilityRef !== undefined) card.capabilityRef = patch.capabilityRef ?? undefined;
  if (patch.flag !== undefined) {
    if (patch.flag === null) {
      card.flag = undefined;
    } else {
      if (!FLAG_KINDS.includes(patch.flag.kind)) throw new Error(`Unknown flag kind: ${patch.flag.kind}`);
      // The clock measures how long it has been stuck NOW, so an in-place
      // correction keeps it and only a clear-then-reflag restarts it.
      card.flag = {
        kind: patch.flag.kind,
        reason: patch.flag.reason?.trim() || undefined,
        since: card.flag?.since ?? new Date().toISOString(),
      };
    }
  }
  if (patch.columnId !== undefined || patch.order !== undefined) {
    const toColumn = patch.columnId ?? card.columnId;
    const siblings = board.cards
      .filter((c) => c.columnId === toColumn && c.id !== card.id)
      .sort((a, b) => a.order - b.order);
    const at = Math.max(0, Math.min(patch.order ?? siblings.length, siblings.length));
    card.columnId = toColumn;
    siblings.splice(at, 0, card);
    siblings.forEach((c, i) => {
      c.order = i;
    });
    if (fromColumn !== toColumn) renumber(board, fromColumn);
  }
  card.updatedAt = new Date().toISOString();
  return card;
}

export function removeCard(board: WorkBoard, cardId: string): void {
  const i = board.cards.findIndex((c) => c.id === cardId);
  if (i < 0) throw new Error(`Unknown card: ${cardId}`);
  const columnId = board.cards[i].columnId;
  board.cards.splice(i, 1);
  renumber(board, columnId);
}
