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
import type { FeedItem } from './types.ts';

export function boardTypeFor(item: FeedItem): 'reactive' | 'maintenance' {
  return item.release?.security ? 'reactive' : 'maintenance';
}

export function cardTitle(item: FeedItem, currentVersion: string): string {
  return `Upgrade ${item.release!.name} ${currentVersion} → ${item.release!.version}`;
}

export async function cardForRelease(
  deps: {
    boards(): Promise<Array<{ id: string; type: string; workspaceId?: string }>>;
    addCard(boardId: string, card: { title: string; notes: string; columnId: string }): Promise<void>;
    /** The action plan: at most 5 steps, generated once, about THIS repo. */
    plan(item: FeedItem, currentVersion: string): Promise<string>;
    now(): string;
  },
  item: FeedItem,
  ctx: { workspace: string; currentVersion: string },
): Promise<{ carded: boolean; reason?: string }> {
  if (!item.release) return { carded: false, reason: 'not a release' };
  if (item.cardedAt) return { carded: false, reason: 'already carded' };

  const wanted = boardTypeFor(item);
  try {
    const board = (await deps.boards()).find((b) => b.type === wanted && b.workspaceId === ctx.workspace);
    if (!board) return { carded: false, reason: `no ${wanted} board for ${ctx.workspace}` };

    const notes = await deps.plan(item, ctx.currentVersion);
    await deps.addCard(board.id, { title: cardTitle(item, ctx.currentVersion), notes, columnId: 'triage' });
    return { carded: true };
  } catch (err) {
    return { carded: false, reason: String((err as Error).message ?? err) };
  }
}
