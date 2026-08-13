// Terminal side-effects (spec 2026-08-13 queue-sources): fire when a card
// ENTERS a board's terminal column. Pure per the swarm test law — the route
// handler injects createIssue/newId/now. Effects NEVER throw out of here: the
// move that triggered them must always succeed.
import { findRouteDestination, hasSourceRef, terminalColumnId, type WorkBoard, type WorkCard } from "./work-items.js";

/** The trigger: a patch that moves the card INTO the terminal column. */
export function shouldFireTerminal(board: WorkBoard, movedTo: string | undefined): boolean {
  return movedTo !== undefined && movedTo === terminalColumnId(board);
}

export interface EffectDeps {
  createIssue(
    connectorId: string,
    projectKey: string,
    summary: string,
    description: string,
  ): Promise<{ key: string; url: string }>;
  newId(): string;
  now(): string;
}

export async function applyTerminalEffects(
  board: WorkBoard,
  card: WorkCard,
  allBoards: WorkBoard[],
  deps: EffectDeps,
): Promise<{ changed: WorkBoard[]; errors: string[] }> {
  const changed = new Set<WorkBoard>();
  const errors: string[] = [];
  for (const effect of board.terminal?.effects ?? []) {
    if (effect.kind === "publish-jira") {
      if (card.jira?.key) continue; // linked already — idempotent
      try {
        card.jira = await deps.createIssue(effect.connectorId, effect.projectKey, card.title, card.notes ?? "");
        changed.add(board);
      } catch (err) {
        const msg = String((err as Error).message ?? err);
        card.jira = { key: "", url: "", lastPushError: msg };
        changed.add(board);
        errors.push(`publish-jira: ${msg}`);
      }
    } else {
      // route: COPY onward — the original completed here and stays. routeCard
      // MOVES, so this is its own stamp site (the second after work-items:259).
      const dest = findRouteDestination(allBoards, board, {
        from: card.columnId,
        toType: effect.toType,
        toColumn: effect.toColumn,
        label: "",
      });
      if (!dest) {
        errors.push(`route: no ${effect.toType} board for ${board.workspaceId ?? "personal"}`);
        continue;
      }
      if (dest.id === board.id) {
        // A same-type effect resolves `dest` from allBoards, which — unlike
        // `board` itself — may be a freshly-loaded copy sharing the same id.
        // Pushing onto that copy would be silently lost: it's never `board`
        // (so the changed-loop's byId skip hides it) and it's never in
        // `changed` under any id the caller would think to save. Refuse it
        // outright, same as the no-destination case above.
        errors.push(`route: ${board.id} cannot route to itself`);
        continue;
      }
      if (!dest.columns.some((c) => c.id === effect.toColumn)) {
        errors.push(`route: ${dest.id} has no column ${effect.toColumn}`);
        continue;
      }
      const ref = { sourceId: `terminal:${board.id}`, itemKey: card.id };
      if (hasSourceRef(dest, ref)) continue; // re-entry — copied already
      const order = dest.cards.filter((c) => c.columnId === effect.toColumn).length;
      dest.cards.push({
        ...card,
        id: deps.newId(),
        columnId: effect.toColumn,
        order,
        updatedAt: deps.now(),
        sourceRef: ref,
        jira: undefined,
        delegation: undefined,
        routedFrom: [
          ...(card.routedFrom ?? []),
          { boardId: board.id, boardType: board.type, columnId: card.columnId, at: deps.now() },
        ],
      });
      changed.add(dest);
    }
  }
  return { changed: [...changed], errors };
}
