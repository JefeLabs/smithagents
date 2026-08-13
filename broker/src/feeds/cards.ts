/**
 * A qualifying release becomes work (spec §5b).
 *
 * This answers how the maintenance and reactive boards get filled: they are
 * the boards for work that ARRIVES rather than work you chose, and both open
 * with a Triage column. An upgrade is exactly that.
 *
 * Card creation is a SEPARATE consumer from the digest. If this fails, the
 * release is still spoken — nothing about small talk depends on the boards.
 */
import type { FeedItem, ReleaseItem } from "./types.ts";

const isRelease = (item: FeedItem): item is ReleaseItem => item.release !== undefined;

export function boardTypeFor(item: FeedItem): "reactive" | "maintenance" {
  return item.release?.security ? "reactive" : "maintenance";
}

export function cardTitle(item: ReleaseItem, currentVersion: string): string {
  return `Upgrade ${item.release.name} ${currentVersion} → ${item.release.version}`;
}

/** Wire shape of a board as GET /work/boards returns it — enough to match a
    queue binding and dedup a card by sourceRef (spec 2026-08-13 queue-sources). */
export interface BoundBoard {
  id: string;
  type: string;
  workspaceId?: string;
  columns: Array<{ id: string }>;
  queue?: { sourceIds: string[] };
  cards: Array<{ sourceRef?: { sourceId: string; itemKey: string } }>;
}

export function boardsBoundTo(boards: BoundBoard[], workspace: string | undefined, contextId: string): BoundBoard[] {
  return boards.filter((b) => b.workspaceId === workspace && (b.queue?.sourceIds ?? []).includes(contextId));
}

/** Broker-side copy of the swarm's intake resolver (cannot import across
    packages) — queue lane when present, else first column. Spec 2026-08-13. */
export function intakeColumnIdOf(board: BoundBoard): string | undefined {
  return (board.columns.find((c) => c.id === "queue") ?? board.columns[0])?.id;
}

/** Release targeting: bindings first, legacy boardTypeFor as the fallback for
    boards that predate binding config entirely (fresh workspaces before their
    seeding restart) — migrated installs behave byte-for-byte (regression-tested).
    A board with a `queue` block that omits "releases" was explicitly unbound by
    the user and must NOT fall back — `queue === undefined` is what marks "never
    configured" rather than "configured to exclude releases". */
export function releaseTargetBoards(boards: BoundBoard[], item: FeedItem, workspace: string): BoundBoard[] {
  const wanted = boardTypeFor(item);
  const bound = boardsBoundTo(boards, workspace, "releases").filter((b) => b.type === wanted);
  if (bound.length > 0) return bound;
  const legacy = boards.find((b) => b.type === wanted && b.workspaceId === workspace && b.queue === undefined);
  return legacy ? [legacy] : [];
}

export async function cardForSource(
  deps: {
    addCard(
      boardId: string,
      card: { title: string; notes: string; columnId: string; sourceRef: { sourceId: string; itemKey: string } },
    ): Promise<void>;
  },
  boards: BoundBoard[],
  source: { id: string; workspace?: string; contextId?: string },
  items: Array<{ title: string; summary: string; itemKey: string }>,
): Promise<{ carded: number }> {
  if (!source.contextId) return { carded: 0 };
  let carded = 0;
  for (const board of boardsBoundTo(boards, source.workspace, source.contextId)) {
    const column = intakeColumnIdOf(board);
    if (!column) continue;
    for (const item of items) {
      const ref = { sourceId: source.id, itemKey: item.itemKey };
      if (board.cards.some((c) => c.sourceRef?.sourceId === ref.sourceId && c.sourceRef.itemKey === ref.itemKey))
        continue;
      await deps.addCard(board.id, { title: item.title, notes: item.summary, columnId: column, sourceRef: ref });
      carded++;
    }
  }
  return { carded };
}

export async function cardForRelease(
  deps: {
    boards(): Promise<BoundBoard[]>;
    addCard(boardId: string, card: { title: string; notes: string; columnId: string }): Promise<void>;
    /** The action plan: at most 5 steps, generated once, about THIS repo. */
    plan(item: ReleaseItem, currentVersion: string): Promise<string>;
    now(): string;
  },
  item: FeedItem,
  ctx: { workspace: string; currentVersion: string },
): Promise<{ carded: boolean; reason?: string }> {
  if (!isRelease(item)) return { carded: false, reason: "not a release" };
  if (item.cardedAt) return { carded: false, reason: "already carded" };

  const wanted = boardTypeFor(item);
  try {
    const board = releaseTargetBoards(await deps.boards(), item, ctx.workspace)[0];
    if (!board) return { carded: false, reason: `no ${wanted} board for ${ctx.workspace}` };

    const notes = await deps.plan(item, ctx.currentVersion);
    await deps.addCard(board.id, { title: cardTitle(item, ctx.currentVersion), notes, columnId: "triage" });
    return { carded: true };
  } catch (err) {
    return { carded: false, reason: String((err as Error).message ?? err) };
  }
}
