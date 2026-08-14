import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Settings } from "lucide-react";
import type { ReactNode } from "react";
import type { RosterAgent } from "../api/types";
import type { AggCard, Cluster } from "../lib/board-aggregate";
import type { WorkColumn } from "../organisms/BoardStage";
import { BoardCard } from "./BoardCard";

/** One sortable card wrapper — BoardCard stays a pure display button. */
function SortableCard({
  card,
  agent,
  tint,
  onOpen,
}: {
  card: AggCard;
  agent?: RosterAgent;
  tint?: string;
  onOpen: () => void;
}) {
  const sortable = useSortable({ id: card.id });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  return (
    <div ref={sortable.setNodeRef} style={style} {...sortable.attributes} {...sortable.listeners}>
      <BoardCard
        card={card}
        agent={agent}
        tint={tint}
        onOpen={onOpen}
        className={sortable.isDragging ? "is-dragging" : undefined}
      />
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
   * Full replacement for one card's face (a Grab control, an intent/close
   * composer). Returning undefined falls back to the normal sortable card.
   * The overridden card is also excluded from the sortable items list — it
   * isn't draggable while overridden.
   */
  cardOverride?: (card: AggCard) => ReactNode | undefined;
}) {
  const droppable = useDroppable({ id: `column:${col.id}`, disabled: !isDroppable });
  const flat = clusters.flatMap((g) => g.cards);
  const sortableIds = flat.filter((c) => cardOverride?.(c) === undefined).map((c) => c.id);
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
                if (override !== undefined) return <div key={card.id}>{override}</div>;
                return (
                  <SortableCard
                    key={card.id}
                    card={card}
                    agent={agentFor(card.delegation?.agentId)}
                    tint={g.label !== null ? colorFor(card.workspaceId) : undefined}
                    onOpen={() => onOpenCard(card.boardId, card.id)}
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
