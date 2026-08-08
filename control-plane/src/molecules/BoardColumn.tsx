import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { RosterAgent } from "../hooks/useBrokerChat";
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
}: {
  col: WorkColumn;
  clusters: Cluster[];
  colorFor: (workspaceId?: string) => string | undefined;
  agentFor: (id?: string) => RosterAgent | undefined;
  onOpenCard: (boardId: string, cardId: string) => void;
}) {
  const droppable = useDroppable({ id: `column:${col.id}` });
  const flat = clusters.flatMap((g) => g.cards);
  return (
    <div ref={droppable.setNodeRef} className={`board-column${droppable.isOver ? " is-over" : ""}`}>
      <h3 className="board-column__name">{col.name}</h3>
      <SortableContext items={flat.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div className="board-column__cards">
          {clusters.map((g) => (
            <div key={g.label ?? "_"} className="board-column__cluster">
              {g.label !== null && (
                <span className="board-column__cluster-name" style={{ color: colorFor(g.label ?? undefined) }}>
                  {g.label}
                </span>
              )}
              {g.cards.map((card) => (
                <SortableCard
                  key={card.id}
                  card={card}
                  agent={agentFor(card.delegation?.agentId)}
                  tint={g.label !== null ? colorFor(card.workspaceId) : undefined}
                  onOpen={() => onOpenCard(card.boardId, card.id)}
                />
              ))}
            </div>
          ))}
        </div>
      </SortableContext>
    </div>
  );
}
