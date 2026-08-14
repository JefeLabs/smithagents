import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Settings } from "lucide-react";
import type { ReactNode } from "react";
import type { RosterAgent } from "../api/types";
import type { AggCard, Cluster } from "../lib/board-aggregate";
import type { WorkColumn } from "../organisms/BoardStage";
import { BoardCard } from "./BoardCard";

export interface CardFaceAction {
  verb: string;
  pending: boolean;
  onAction: () => void;
}

/**
 * One sortable card wrapper — BoardCard stays a pure display button. `action`
 * (Release on a held card) renders as a SIBLING button inside the same
 * sortable node, never nested inside BoardCard's own `<button>` — this is
 * still one genuinely draggable, sortable item; the action is an addition to
 * its face, not a replacement of it. Its own pointerdown/click stop
 * propagation so a click doesn't get eaten by the drag listeners on the
 * wrapping div (same pattern BoardCard already uses for its Jira/PR links).
 */
function SortableCard({
  card,
  agent,
  tint,
  onOpen,
  action,
}: {
  card: AggCard;
  agent?: RosterAgent;
  tint?: string;
  onOpen: () => void;
  action?: CardFaceAction;
}) {
  const sortable = useSortable({ id: card.id });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={action ? "board-card-slot has-action" : undefined}
      {...sortable.attributes}
      {...sortable.listeners}
    >
      <BoardCard
        card={card}
        agent={agent}
        tint={tint}
        onOpen={onOpen}
        className={sortable.isDragging ? "is-dragging" : undefined}
      />
      {action && (
        <button
          type="button"
          className="settings-btn board-card__action"
          disabled={action.pending}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            action.onAction();
          }}
        >
          {action.verb}
        </button>
      )}
    </div>
  );
}

/**
 * A droppable column whose body groups by workspace. SortableContext keeps ONE
 * flat items array while the render nests, so clustering never touches
 * resolveDrop.
 */
export function BoardColumn({
  col,
  clusters,
  colorFor,
  agentFor,
  onOpenCard,
  onConfigure,
  droppable: isDroppable = true,
  cardOverride,
}: {
  col: WorkColumn;
  clusters: Cluster[];
  colorFor: (workspaceId?: string) => string | undefined;
  agentFor: (id?: string) => RosterAgent | undefined;
  onOpenCard: (boardId: string, cardId: string) => void;
  onConfigure?: () => void;
  /** False for the synthetic shared-queue lane — it is a derived pool, not a move target. */
  droppable?: boolean;
  /**
   * Two kinds of per-card override, never conflated:
   * `{kind:"replace"}` swaps the card's whole face out (an intent/close
   * composer, or the shared-queue Grab control) — that card is excluded from
   * the sortable items list and cannot be dragged. `{kind:"action"}` keeps
   * the card a genuine, draggable SortableCard and layers one extra button
   * onto its face (Release on a held card) — dropping the drag capability
   * here would make the card's drag-driven state changes unreachable by any
   * real gesture, only by a test calling the seam directly. Returning
   * undefined falls back to the plain sortable card, no override at all.
   */
  cardOverride?: (
    card: AggCard,
  ) => { kind: "replace"; node: ReactNode } | ({ kind: "action" } & CardFaceAction) | undefined;
}) {
  const droppable = useDroppable({ id: `column:${col.id}`, disabled: !isDroppable });
  const flat = clusters.flatMap((g) => g.cards);
  const sortableIds = flat.filter((c) => cardOverride?.(c)?.kind !== "replace").map((c) => c.id);
  return (
    <div
      ref={droppable.setNodeRef}
      className={`board-column${col.id === "queue" || col.id === "shared-queue" ? " board-column--queue" : ""}${droppable.isOver ? " is-over" : ""}`}
    >
      <div className="board-column__head">
        <h3 className="board-column__name">{col.name}</h3>
        {onConfigure && (
          <button
            type="button"
            className="board-column__config"
            aria-label={`Configure ${col.name} column`}
            onClick={onConfigure}
          >
            <Settings size={12} strokeWidth={2} />
          </button>
        )}
      </div>
      <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
        <div className="board-column__cards">
          {clusters.map((g) => (
            <div key={g.label ?? "_"} className="board-column__cluster">
              {g.label !== null && (
                <span className="board-column__cluster-name" style={{ color: colorFor(g.label ?? undefined) }}>
                  {g.label}
                </span>
              )}
              {g.cards.map((card) => {
                const override = cardOverride?.(card);
                if (override?.kind === "replace") return <div key={card.id}>{override.node}</div>;
                return (
                  <SortableCard
                    key={card.id}
                    card={card}
                    agent={agentFor(card.delegation?.agentId)}
                    tint={g.label !== null ? colorFor(card.workspaceId) : undefined}
                    onOpen={() => onOpenCard(card.boardId, card.id)}
                    action={override?.kind === "action" ? override : undefined}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </SortableContext>
    </div>
  );
}
