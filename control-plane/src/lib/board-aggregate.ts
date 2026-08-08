import type { WorkBoardT, WorkCardT } from "../organisms/BoardStage";

/** Sentinel scope: aggregate across every workspace. */
export const ALL_WORKSPACES = "*";

export type BoardTypeT = "personal" | "ideation" | "plan" | "deliver" | "release" | "reactive" | "maintenance";

/** Mirrors the swarm's BOARD_TYPE_ORDER — personal always last. */
export const BOARD_TYPE_ORDER_UI: BoardTypeT[] = [
  "ideation",
  "plan",
  "deliver",
  "release",
  "reactive",
  "maintenance",
  "personal",
];

/** The six workspace types. Personal is deliberately absent — it belongs to no workspace. */
export const WORKSPACE_BOARD_TYPES_UI: Exclude<BoardTypeT, "personal">[] = [
  "ideation",
  "plan",
  "deliver",
  "release",
  "reactive",
  "maintenance",
];

export const BOARD_TYPE_LABELS_UI: Record<BoardTypeT, string> = {
  personal: "Personal",
  ideation: "Ideation",
  plan: "Plan",
  deliver: "Deliver",
  release: "Release",
  reactive: "Reactive",
  maintenance: "Maintenance",
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
 * function of the dropdown, so it is appended explicitly rather than falling
 * out of a `workspaceId === undefined` filter — which is how it would get
 * folded into the aggregate by accident later.
 */
export function tabsFor(boards: WorkBoardT[], scope: string): TabDescriptor[] {
  const all = scope === ALL_WORKSPACES;
  const tabs: TabDescriptor[] = [];
  for (const type of WORKSPACE_BOARD_TYPES_UI) {
    const matches = boards.filter((b) => b.type === type && (all ? Boolean(b.workspaceId) : b.workspaceId === scope));
    if (matches.length === 0) continue;
    tabs.push({
      key: type,
      label: all ? BOARD_TYPE_LABELS_UI[type] : matches[0].name,
      type,
      boardIds: matches.map((b) => b.id),
      clustered: all,
    });
  }
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
  ],
  ideation: [],
  maintenance: [],
  personal: [],
};

export function exitsForUI(type: BoardTypeT, columnId: string): RouteExitT[] {
  return BOARD_ROUTES_UI[type].filter((e) => e.from === columnId);
}
