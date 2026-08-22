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
import { columnLabel, workKindFor } from "./work-kinds.js";

export interface WorkColumn {
  id: string;
  name: string;
  /** Jira status to transition a linked card to when it lands here; absent = no push. */
  jiraStatus?: string;
  /** This column structurally waits on a human — its unheld cards surface in the shared queue. */
  gatesHuman?: boolean;
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

export type StepState = "plate" | "today";

export const STEP_STATES: StepState[] = ["plate", "today"];

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
  /** Acceptance-criteria checklist — authored by hand in v1, replaced wholesale on PATCH. Never a column.
      `points` (real-dashboards spec 2026-08-13): whole ≥ 0; mirrored from the map on linked cards. */
  stories?: Array<{ id: string; text: string; done: boolean; points?: number; verifiedBy?: string }>;
  /** Set when this card tracks a capability slice — its checklist becomes a toggle-only view of the capability's stories. */
  capabilityRef?: { capabilityId: string; sliceId: string };
  /** Appended each time this card is routed to another board. Never rewritten. */
  routedFrom?: Array<{ boardId: string; boardType: BoardType; columnId: string; at: string }>;
  flag?: CardFlag;
  /** Set when this card was carded from a bound queue source — the dedup key hasSourceRef checks. */
  sourceRef?: { sourceId: string; itemKey: string };
  /** Who holds this card's CURRENT step. Orthogonal to columnId, like `flag`; cleared
      when the card changes column. One holder — grabbing is exclusive. An AGENT holding
      work is `delegation`, not this. */
  agenda?: {
    by: string;
    state: StepState;
    /** Entry into the CURRENT state — same contract as CardFlag.since. The sweep re-stamps it. */
    since: string;
    /** When it landed on this plate. Set once at grab, never touched again — the clock
        that answers "how long have I been sitting on this", which `since` cannot. */
    grabbedAt: string;
  };
  /** Append-only: what people said they were doing, and what they said they did. On the
      CARD, not inside `agenda`, so it survives the column change that clears the holder.
      `kind` makes it start/done pairs rather than a flat stream, which is what a summary
      needs. Substrate for Jira comments and AI summaries. */
  intents?: Array<{ at: string; by: string; kind: "start" | "done"; text: string }>;
}

/** Terminal side-effect config (spec 2026-08-13 queue-sources). */
export type TerminalEffect =
  | { kind: "publish-jira"; connectorId: string; projectKey: string }
  | { kind: "route"; toType: BoardType; toColumn: string };

export interface WorkBoard {
  id: string;
  name: string;
  /** Persisted board identity — drives tabs, one-per-type cardinality, and routing. */
  type: BoardType;
  columns: WorkColumn[];
  cards: WorkCard[];
  jira?: { connectorId: string; siteUrl: string; projectKey: string; jql?: string };
  /** Bound queue sources card their items into this board's intake lane (see intakeColumnId). */
  queue?: { sourceIds: string[] };
  /** Side effects fired when a card enters the terminal column (see terminalColumnId). */
  terminal?: { columnId?: string; effects: TerminalEffect[] };
  /** Present on every workspace board; absent only on the single personal board. */
  workspaceId?: string;
  /** Local YYYY-MM-DD of the last midnight sweep. Personal board only. Legacy: retired by
      the step-axis sweep (sweepUserAgenda, which stamps User.agendaSweptDay instead) —
      kept on the type so older board files still parse, but no longer written. */
  sweptDay?: string;
}

const BOARD_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type BoardType = "personal" | "ideation" | "plan" | "deliver" | "release" | "reactive" | "maintenance";

/** Tab order. personal is always first, release always last; the other five follow the work's lifecycle. */
export const BOARD_TYPE_ORDER: BoardType[] = [
  "personal",
  "ideation",
  "plan",
  "deliver",
  "reactive",
  "maintenance",
  "release",
];

export const WORKSPACE_BOARD_TYPES: BoardType[] = BOARD_TYPE_ORDER.filter((t) => t !== "personal");

export const BOARD_TYPE_LABELS: Record<BoardType, string> = {
  personal: "Agenda",
  ideation: "Ideate",
  plan: "Plan",
  deliver: "Deliver",
  release: "Release",
  reactive: "React",
  maintenance: "Maintain",
};

// Boards that own an outcome get a terminal column (Killed / Won't do / Not
// Doing); boards that hand work onward get an exit in BOARD_ROUTES instead,
// which is why plan and deliver have neither.
export const BOARD_TEMPLATES: Record<BoardType, WorkColumn[]> = {
  personal: [
    { id: "plate", name: "My plate" },
    { id: "today", name: "Today" },
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
    { id: "queue", name: "Queue" },
    { id: "define", name: "Spec" },
    { id: "design", name: "Tech design" },
    { id: "breakdown", name: "Decomposed" },
    { id: "ready", name: "Ready" },
  ],
  deliver: [
    { id: "queue", name: "Queue" },
    { id: "ready", name: "Ready" },
    { id: "in-progress", name: "In progress" },
    { id: "review", name: "Review", gatesHuman: true },
    { id: "verify", name: "Verify", gatesHuman: true },
    { id: "complete", name: "Merged" },
  ],
  release: [
    { id: "queue", name: "Queue" },
    { id: "prepare", name: "Cut" },
    { id: "validate", name: "Regression" },
    { id: "sign-off", name: "Sign-off" },
    { id: "ship", name: "Ship" },
    { id: "rollback", name: "Rollback" },
  ],
  reactive: [
    { id: "queue", name: "Queue" },
    { id: "triage", name: "Triage", gatesHuman: true },
    { id: "diagnose", name: "Diagnose" },
    { id: "fix", name: "Fix" },
    { id: "verify", name: "Verify" },
    { id: "closed", name: "Closed" },
  ],
  maintenance: [
    { id: "queue", name: "Queue" },
    { id: "triage", name: "Triage", gatesHuman: true },
    { id: "doing", name: "Doing" },
    { id: "done", name: "Done" },
    { id: "wont-do", name: "Won't do" },
  ],
};

/**
 * 2026-08-17: six product-development column ids became domain-neutral, so the
 * same board reads correctly for marketing, sales, consulting, content,
 * creators and trading. Ids are the contract — BOARD_ROUTES matches on them and
 * every card stores one — so a rename must rewrite columns and cards together.
 *
 * Ids only. A column's displayed NAME is deliberately left alone: labels are
 * chosen at seed time and a live board is never retitled, and "Merged" is in any
 * case the correct product/software label for `complete`.
 */
export const NEUTRAL_COLUMN_IDS: Partial<Record<BoardType, Record<string, string>>> = {
  plan: { spec: "define", "tech-design": "design", decomposed: "breakdown" },
  deliver: { merged: "complete" },
  release: { cut: "prepare", regression: "validate" },
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
 *
 * `workKind` is consulted HERE AND NOWHERE ELSE — labels are a seed-time choice,
 * and `board.columns` is persisted per board, so changing a vocabulary later
 * never rewrites a live board. Omitting it reproduces the product/software
 * vocabulary exactly.
 */
export function createBoard(type: BoardType, workspaceId?: string, workKind?: string): WorkBoard {
  if (!BOARD_TEMPLATES[type]) throw new Error(`Unknown board type: ${type}`);
  if (type === "personal" && workspaceId) throw new Error("The personal board belongs to no workspace");
  if (type !== "personal" && !workspaceId) throw new Error(`Board type "${type}" requires a workspace`);
  const id = type === "personal" ? "personal" : boardIdFor(workspaceId as string, type);
  if (!BOARD_ID_RE.test(id)) throw new Error(`Workspace "${workspaceId}" does not reduce to a usable board id`);
  const kind = workKindFor(workKind);
  const board: WorkBoard = {
    id,
    name: BOARD_TYPE_LABELS[type],
    type,
    columns: BOARD_TEMPLATES[type].map((c) => ({ ...c, name: columnLabel(kind, c) })),
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
    { from: "design", toType: "ideation", toColumn: "scoping", label: "Back to ideation" },
    { from: "ready", toType: "deliver", toColumn: "ready", label: "Send to deliver" },
  ],
  deliver: [{ from: "in-progress", toType: "plan", toColumn: "design", label: "Back to plan" }],
  release: [
    { from: "validate", toType: "deliver", toColumn: "in-progress", label: "Drop change to deliver" },
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

/**
 * The board a routed card lands on: same workspace as the source, the exit's
 * destination type. The personal board is the workspace-less singleton, so an
 * escalation reaches it from any workspace.
 */
export function findRouteDestination(boards: WorkBoard[], source: WorkBoard, exit: RouteExit): WorkBoard | undefined {
  if (exit.toType === "personal") return boards.find((b) => b.type === "personal");
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
    // A board change is strictly more than a column change, so the same invariant
    // applies: the step this holder described no longer exists. Routing deliberately
    // does NOT demand a closing comment — it is a board-to-board handoff with its own
    // UI, and gating it here would block a route behind a composer that isn't built.
    agenda: undefined,
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

/** The column whose entry fires terminal effects. Explicit beats positional:
    Release ends in Rollback, and rollbacks must not publish. */
export function terminalColumnId(board: WorkBoard): string | undefined {
  return board.terminal?.columnId ?? board.columns[board.columns.length - 1]?.id;
}

/** Where bound sources card into: the queue lane when the board has one,
    else the first column (Ideate has no queue lane). */
export function intakeColumnId(board: WorkBoard): string | undefined {
  return (board.columns.find((c) => c.id === "queue") ?? board.columns[0])?.id;
}

/** Source-item dedup: has this board already carded this item? */
export function hasSourceRef(board: WorkBoard, ref: { sourceId: string; itemKey: string }): boolean {
  return board.cards.some((c) => c.sourceRef?.sourceId === ref.sourceId && c.sourceRef.itemKey === ref.itemKey);
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

/** Default names boards used to seed with — a board still wearing one follows the label when it changes. */
const LEGACY_DEFAULT_NAMES: Partial<Record<BoardType, string[]>> = {
  personal: ["Personal", "Active To-dos", "Action Planner"],
  ideation: ["Ideation"],
  reactive: ["Reactive"],
  maintenance: ["Maintenance"],
};

/** The boards whose leftmost lane is the Queue intake. Not personal — its intake is the
    derived shared queue, which is not a column at all. */
const QUEUE_TYPES: BoardType[] = ["plan", "deliver", "release", "reactive", "maintenance"];

/**
 * Reshape a board persisted under an earlier template: default names follow
 * the current labels (a custom rename is preserved), the queue intake lane is
 * prepended where the type carries one, and maintenance's old `queued` column
 * becomes that lane — moved to the front with its cards' columnIds rewritten,
 * so nothing strands. The personal board's pre-step-axis columns fold into
 * plate/today/done/not-doing. Finally, every column is backfilled with its
 * template's `gatesHuman`, so a board persisted before that field existed
 * doesn't silently drop out of the shared queue. In-memory only — the file is
 * rewritten the next time any mutation saves the board.
 */
export function normalizeBoard(board: WorkBoard): WorkBoard {
  if (LEGACY_DEFAULT_NAMES[board.type]?.includes(board.name)) board.name = BOARD_TYPE_LABELS[board.type];
  if (QUEUE_TYPES.includes(board.type) && !board.columns.some((c) => c.id === "queue")) {
    const queued = board.type === "maintenance" ? board.columns.findIndex((c) => c.id === "queued") : -1;
    if (queued >= 0) {
      const [column] = board.columns.splice(queued, 1);
      column.id = "queue";
      column.name = "Queue";
      board.columns.unshift(column);
      for (const card of board.cards) {
        if (card.columnId === "queued") card.columnId = "queue";
      }
    } else {
      board.columns.unshift({ id: "queue", name: "Queue" });
    }
  }
  if (board.type === "personal") {
    const RENAMED: Record<string, string> = { queue: "plate", todo: "plate", doing: "today" };
    if (board.columns.some((c) => RENAMED[c.id])) {
      for (const card of board.cards) {
        const to = RENAMED[card.columnId];
        if (to) card.columnId = to;
      }
      // queue and todo both fold into plate, so rebuild the column list from the
      // template rather than renaming in place — two columns collapsing into one
      // cannot be expressed as a rename.
      board.columns = BOARD_TEMPLATES.personal.map((c) => ({ ...c }));
      renumberAll(board);
    }
  }
  const renames = NEUTRAL_COLUMN_IDS[board.type];
  if (renames) {
    for (const column of board.columns) {
      const to = renames[column.id];
      if (to) column.id = to;
    }
    for (const card of board.cards) {
      const to = renames[card.columnId];
      if (to) card.columnId = to;
    }
  }
  // A card pointing at no column would vanish from every lane while still
  // occupying the file — a defect, not a tolerable orphan. loadBoards wraps this
  // per file, so the board is reported rather than the boot being killed.
  const ids = new Set(board.columns.map((c) => c.id));
  const orphan = board.cards.find((c) => !ids.has(c.columnId));
  if (orphan) {
    throw new Error(
      `Board "${board.id}": card "${orphan.id}" is in column "${orphan.columnId}", which does not exist on this board`,
    );
  }
  // Driven off the template rather than a second hardcoded list, so the two can't drift:
  // a column persisted before `gatesHuman` existed otherwise never gets it, and its
  // unheld cards would silently fall out of the shared queue.
  for (const column of board.columns) {
    if (column.gatesHuman !== undefined) continue;
    const templateColumn = BOARD_TEMPLATES[board.type].find((c) => c.id === column.id);
    if (templateColumn?.gatesHuman) column.gatesHuman = true;
  }
  return board;
}

/** Local calendar day, YYYY-MM-DD — the sweptDay idempotence stamp. */
export function localDayStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Milliseconds from `now` to the next local midnight. The Date constructor normalizes the day+1 overflow, which keeps DST days honest. */
export function msUntilNextMidnight(now: Date): number {
  return Math.max(1, new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime());
}

/**
 * Day rollover for the step axis: everything this user claimed for today reverts to
 * their plate, so each morning starts from one honest list and they re-declare what
 * they are actually working on.
 *
 * It never RELEASES: grabbing is a commitment that outlives the day, picking something
 * for today is not. Pure — the caller owns load, save, the clock, and the
 * agendaSweptDay stamp, which lives on the user because the sweep is per-user.
 * Returns the boards that changed.
 */
export function sweepUserAgenda(boards: WorkBoard[], userId: string, now: string): WorkBoard[] {
  const dirty: WorkBoard[] = [];
  for (const board of boards) {
    let changed = false;
    for (const card of board.cards) {
      // Personal todos have no holder — their columnId IS their lane, so the same
      // daily reset applies by column. This is what sweepPersonalBoard used to do,
      // in the new vocabulary; keeping two sweeps would mean two vocabularies.
      if (board.type === "personal") {
        if (card.columnId !== "today") continue;
        card.columnId = "plate";
        card.updatedAt = now;
        changed = true;
        continue;
      }
      if (card.agenda?.by !== userId || card.agenda.state !== "today") continue;
      setStepState(card, userId, "plate", now);
      changed = true;
    }
    if (changed) {
      if (board.type === "personal") renumber(board, "plate");
      dirty.push(board);
    }
  }
  return dirty;
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
      boards.push(normalizeBoard(assertBoard(file, JSON.parse(await readFile(join(dir, file), "utf8")))));
    } catch (err) {
      errors.push({ file, error: String((err as Error).message) });
    }
  }
  return { boards, errors };
}

/**
 * Every board across several directories — normally each workspace's
 * `workspaces/<slug>/boards` in the org config repo, plus the host work dir.
 * Reading all of them is what lets
 * boards move gradually: a board that has not been migrated yet still loads
 * from wherever it currently sits.
 *
 * On a duplicate id the FIRST directory in `dirs` wins. This ordering is
 * LOAD-BEARING, not arbitrary: a board write always resolves to its
 * workspace directory once the workspace is known (see boardsDirFor), even
 * before that board's file has actually been moved there. If the host
 * directory were listed before the workspace directories, a fresh write to
 * the workspace copy would be shadowed forever by the stale original still
 * sitting in the host dir — the edit would look like it never happened.
 * Callers MUST list workspace directories before the host directory so a
 * real write is always the copy that wins.
 */
export async function loadAllBoards(
  dirs: string[],
): Promise<{ boards: WorkBoard[]; errors: Array<{ file: string; error: string }> }> {
  const boards: WorkBoard[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const result = await loadBoards(dir);
    errors.push(...result.errors);
    for (const board of result.boards) {
      if (seen.has(board.id)) continue;
      seen.add(board.id);
      boards.push(board);
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

/** Renumber every column on the board — needed when a migration can merge two columns
    into one, which leaves duplicate `order` values that a single-column renumber can't fix. */
function renumberAll(board: WorkBoard): void {
  for (const column of board.columns) renumber(board, column.id);
}

/**
 * Quick-adds land where the user works, not where the system routes: Queue is
 * the system's intake lane (bound sources card into it), so fresh cards
 * default to the first column that ISN'T it — My plate on the personal
 * board (which has no Queue lane at all — see BOARD_TEMPLATES.personal),
 * Ready on Deliver, Triage on React/Maintain.
 */
export function defaultColumnFor(board: WorkBoard): string {
  return (board.columns.find((c) => c.id !== "queue") ?? board.columns[0])?.id;
}

export function addCard(
  board: WorkBoard,
  input: { title: string; notes?: string; columnId?: string; sourceRef?: { sourceId: string; itemKey: string } },
): WorkCard {
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
    sourceRef: input.sourceRef,
  };
  board.cards.push(card);
  return card;
}

/**
 * Pull a card out of the shared queue. Exclusive by design: two people pulling the
 * same card at the same moment must not silently produce one winner and one confused
 * loser, so a second grab throws rather than overwriting.
 */
export function grabCard(card: WorkCard, userId: string, now: string): void {
  if (card.agenda) throw new Error(`Card already held by ${card.agenda.by}`);
  card.agenda = { by: userId, state: "plate", since: now, grabbedAt: now };
}

/**
 * Hand it back. The shared queue is derived from "nobody holds it", so deleting the
 * field IS the return to the pool — there is no queued state to write.
 */
export function releaseCard(card: WorkCard): void {
  card.agenda = undefined;
}

/**
 * The holder's own daily declaration. `since` measures how long they have been in THIS
 * state, so an unchanged state keeps its stamp — same contract as CardFlag.since.
 *
 * Claiming a card for TODAY demands a sentence, and the rule lives here rather than in
 * the composer so no route, script or import can move a card into today silently. Every
 * validation runs before anything mutates: a rejected claim must not leave the card
 * half-applied.
 */
export function setStepState(card: WorkCard, userId: string, state: StepState, now: string, intent?: string): void {
  if (!STEP_STATES.includes(state)) throw new Error(`Unknown step state: ${state}`);
  if (!card.agenda) throw new Error("Card is not held — grab it first");
  if (card.agenda.by !== userId) throw new Error(`Card is not held by ${userId}`);
  const entering = card.agenda.state !== state;
  const text = intent?.trim();
  if (state === "today" && entering && !text) throw new Error("An intent is required to claim a card for today");
  if (state === "today" && entering && text) {
    card.intents = [...(card.intents ?? []), { at: now, by: userId, kind: "start", text }];
  }
  if (entering) card.agenda.since = now;
  card.agenda.state = state;
}

export function patchCard(
  board: WorkBoard,
  cardId: string,
  patch: Partial<
    Pick<WorkCard, "title" | "notes" | "columnId" | "order" | "jira" | "delegation" | "stories" | "capabilityRef">
  > & {
    flag?: { kind: FlagKind; reason?: string } | null;
    /** Required when this move ends a held step, or sends a personal todo to done. */
    close?: { by: string; text: string };
  },
): WorkCard {
  const card = board.cards.find((c) => c.id === cardId);
  if (!card) throw new Error(`Unknown card: ${cardId}`);
  if (patch.columnId !== undefined && !board.columns.some((c) => c.id === patch.columnId)) {
    throw new Error(`Unknown column: ${patch.columnId}`);
  }
  const fromColumn = card.columnId;
  const toColumn = patch.columnId ?? card.columnId;
  const changingColumn = toColumn !== card.columnId;
  // Finishing costs a sentence, symmetrically with claiming a day. Two gestures end
  // work: advancing a card someone holds (whoever moves it — if Ana advances Edwin's
  // card, Ana writes it), and sending a personal todo to done. An UNHELD team card
  // moves freely: the rule attaches to finishing work someone took, not to tidying.
  const endsHeldStep = changingColumn && Boolean(card.agenda);
  const personalDone = changingColumn && board.type === "personal" && toColumn === "done";
  if ((endsHeldStep || personalDone) && !patch.close?.text.trim()) {
    throw new Error("A closing comment is required to finish this work");
  }
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
    if (fromColumn !== toColumn) {
      renumber(board, fromColumn);
      const close = patch.close;
      const closing = close?.text.trim();
      if (close && closing) {
        card.intents = [
          ...(card.intents ?? []),
          { at: new Date().toISOString(), by: close.by, kind: "done", text: closing },
        ];
      }
      // The step this described has ended, so its holder is void. Appended FIRST —
      // clearing the holder must not cost us the record of what closed it.
      card.agenda = undefined;
    }
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
