import type { WorkBoardT, WorkCardT } from "../organisms/BoardStage";

/** Sentinel scope: aggregate across every workspace. */
export const ALL_WORKSPACES = "*";

export type BoardTypeT = "personal" | "ideation" | "plan" | "deliver" | "release" | "reactive" | "maintenance";

/** Mirrors the swarm's BOARD_TYPE_ORDER — personal always first, release always last. */
export const BOARD_TYPE_ORDER_UI: BoardTypeT[] = [
  "personal",
  "ideation",
  "plan",
  "deliver",
  "reactive",
  "maintenance",
  "release",
];

/** The six workspace types. Personal is deliberately absent — it belongs to no workspace. */
export const WORKSPACE_BOARD_TYPES_UI: Exclude<BoardTypeT, "personal">[] = [
  "ideation",
  "plan",
  "deliver",
  "reactive",
  "maintenance",
  "release",
];

export const BOARD_TYPE_LABELS_UI: Record<BoardTypeT, string> = {
  personal: "Agenda",
  ideation: "Ideate",
  plan: "Plan",
  deliver: "Deliver",
  release: "Release",
  reactive: "React",
  maintenance: "Maintain",
};

export interface TabDescriptor {
  /** Stable selection value and React key. */
  key: string;
  label: string;
  type: BoardTypeT;
  /** One board in workspace scope; the union of a type's boards in all scope. */
  boardIds: string[];
  /** Whether the column body groups by workspace. Never true for personal. */
  clustered: boolean;
}

export interface AggCard extends WorkCardT {
  boardId: string;
  workspaceId?: string;
}

export interface Cluster {
  /** null renders no subheading — workspace scope and the personal tab. */
  label: string | null;
  cards: AggCard[];
}

/**
 * Personal is context-invariant: it is the one tab whose content is not a
 * function of the dropdown, so it is prepended explicitly rather than falling
 * out of a `workspaceId === undefined` filter — which is how it would get
 * folded into the aggregate by accident later. It leads the strip: Active
 * To-dos is the first thing the boards stage shows.
 */
export function tabsFor(boards: WorkBoardT[], scope: ReadonlySet<string> | typeof ALL_WORKSPACES): TabDescriptor[] {
  const all = scope === ALL_WORKSPACES;
  const tabs: TabDescriptor[] = [];
  const personal = boards.find((b) => b.type === "personal");
  if (personal) {
    tabs.push({
      key: "personal",
      label: personal.name,
      type: "personal",
      boardIds: [personal.id],
      clustered: false,
    });
  }
  for (const type of WORKSPACE_BOARD_TYPES_UI) {
    const matches = boards.filter(
      (b) => b.type === type && (all ? Boolean(b.workspaceId) : scope.has(b.workspaceId ?? "")),
    );
    if (matches.length === 0) continue;
    tabs.push({
      key: type,
      label: all ? BOARD_TYPE_LABELS_UI[type] : matches[0].name,
      type,
      boardIds: matches.map((b) => b.id),
      clustered: all || scope.size > 1,
    });
  }
  return tabs;
}

/** The workspace types this workspace does not yet hold. Never offers personal. */
export function addableTypes(boards: WorkBoardT[], workspaceId: string): BoardTypeT[] {
  const held = new Set(boards.filter((b) => b.workspaceId === workspaceId).map((b) => b.type));
  return WORKSPACE_BOARD_TYPES_UI.filter((t) => !held.has(t));
}

/** Every card in `columnId` across `boards`, tagged with where it came from. */
export function collectCards(boards: WorkBoardT[], columnId: string): AggCard[] {
  return boards.flatMap((b) =>
    b.cards.filter((c) => c.columnId === columnId).map((c) => ({ ...c, boardId: b.id, workspaceId: b.workspaceId })),
  );
}

export type StepStateT = "plate" | "today";

const STEP_LANES: string[] = ["plate", "today"];
const SOURCE_TYPES: BoardTypeT[] = ["maintenance", "reactive", "deliver"];

/** Mirrors the swarm's `sharedQueue`: needs a human, nobody holds it, no agent mid-flight. */
export function sharedQueueCards(boards: WorkBoardT[]): AggCard[] {
  const out: AggCard[] = [];
  for (const b of boards) {
    if (!SOURCE_TYPES.includes(b.type)) continue;
    for (const c of b.cards) {
      if (c.agenda || c.delegation?.state === "working") continue;
      const gated = b.columns.find((col) => col.id === c.columnId)?.gatesHuman === true;
      const handedBack = c.delegation?.state === "completed" || c.delegation?.state === "failed";
      if (gated || handedBack || c.flag || c.jira?.lastPushError) {
        out.push({ ...c, boardId: b.id, workspaceId: b.workspaceId });
      }
    }
  }
  return out.sort((a, b) => (a.flag?.since ?? a.updatedAt ?? "").localeCompare(b.flag?.since ?? b.updatedAt ?? ""));
}

/**
 * One Agenda lane. Two card kinds share it and order differently, deliberately:
 * personal cards have no workflow axis, so their columnId IS the lane and their drag
 * `order` still means something — they come first. Team cards are matched on the
 * holder's step state, because `order` is per-column-per-board and cannot order a
 * lane that spans boards.
 *
 * Team cards order by `grabbedAt`, NOT `since`: the morning sweep re-stamps `since` on
 * everything it reverts, so sorting by it would reshuffle the lane every midnight and
 * make the work you touched yesterday look newest. `grabbedAt` is the stable age.
 */
export function collectAgendaCards(boards: WorkBoardT[], userId: string, laneId: string): AggCard[] {
  const personal: AggCard[] = [];
  const team: Array<{ card: AggCard; grabbedAt: string }> = [];
  for (const b of boards) {
    for (const c of b.cards) {
      const tagged: AggCard = { ...c, boardId: b.id, workspaceId: b.workspaceId };
      if (b.type === "personal") {
        if (c.columnId === laneId) personal.push(tagged);
        continue;
      }
      // Also defends against a stale/malformed persisted `agenda.state`: it arrives as
      // JSON, so TS's "plate" | "today" is erased at runtime and a corrupted value could
      // otherwise coincidentally equal a non-lane laneId like "done" below.
      if (!STEP_LANES.includes(laneId)) continue;
      if (c.agenda?.by === userId && c.agenda.state === laneId) {
        team.push({ card: tagged, grabbedAt: c.agenda.grabbedAt });
      }
    }
  }
  personal.sort((a, b) => a.order - b.order);
  team.sort((a, b) => a.grabbedAt.localeCompare(b.grabbedAt));
  return [...personal, ...team.map((t) => t.card)];
}

export function clusterByWorkspace(cards: AggCard[], clustered: boolean): Cluster[] {
  const byOrder = (a: AggCard, b: AggCard) => a.order - b.order;
  if (!clustered) return [{ label: null, cards: [...cards].sort(byOrder) }];
  const groups = new Map<string, AggCard[]>();
  for (const c of cards) {
    const key = c.workspaceId ?? "";
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, list]) => ({ label, cards: list.sort(byOrder) }));
}

export interface RouteExitT {
  from: string;
  toType: BoardTypeT;
  toColumn: string;
  label: string;
}

/** Mirrors the swarm's BOARD_ROUTES. The server re-validates every route request. */
export const BOARD_ROUTES_UI: Record<BoardTypeT, RouteExitT[]> = {
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
    { from: "triage", toType: "personal", toColumn: "queue", label: "Escalate to Agenda" },
  ],
  ideation: [],
  maintenance: [{ from: "triage", toType: "personal", toColumn: "queue", label: "Escalate to Agenda" }],
  personal: [],
};

export function exitsForUI(type: BoardTypeT, columnId: string): RouteExitT[] {
  return BOARD_ROUTES_UI[type].filter((e) => e.from === columnId);
}
