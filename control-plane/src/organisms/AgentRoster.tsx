import {
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, GripVertical } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentSeed } from "../data/agents";
import type { ComposeOp } from "../hooks/useBrokerChat";
import { useLongPress } from "../hooks/useLongPress";
import { AgentAvatar } from "../molecules/AgentAvatar";

const ORDER_KEY = "smith.rosterOrder";
/** Drop-into (form/join a squad) triggers when the dragged circle's center is this close to the target's. */
const COMBINE_RATIO = 0.35;

interface AgentRosterProps {
  agents: AgentSeed[];
  onAdd: () => void;
  onCall?: (name: string) => void;
  onCompose?: (op: ComposeOp) => void;
  /** Open the focused work view for a busy agent/squad. */
  onInspect?: (entry: AgentSeed) => void;
}

function loadOrder(): string[] {
  try {
    return JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

function applyOrder(agents: AgentSeed[], order: string[]): AgentSeed[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...agents].sort((a, b) => (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length));
}

/** One rail circle — sortable in edit mode, long-pressable out of it. */
function RosterItem(props: {
  entry: AgentSeed;
  editMode: boolean;
  combineTarget: boolean;
  expanded: boolean;
  onLongPress: () => void;
  onTap: () => void;
  onCallWhenHand?: () => void;
}) {
  const { entry, editMode, combineTarget, expanded } = props;
  const busy = entry.status === "busy";
  // Working units are locked: no drag, no wiggle — cancel or wait to edit them.
  const sortable = useSortable({ id: entry.id, disabled: !editMode || busy });
  const longPress = useLongPress(props.onLongPress);
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  const cls = [
    "roster-item",
    editMode && !busy ? "roster-item--wiggle" : "",
    editMode && busy ? "roster-item--locked" : "",
    combineTarget ? "roster-item--combine" : "",
    expanded ? "roster-item--expanded" : "",
    sortable.isDragging ? "roster-item--dragging" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag/long-press surface; in edit mode useSortable's attributes provide role+tabindex, and the inner Avatar stays the keyboard-interactive element
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={cls}
      {...(editMode ? { ...sortable.attributes, ...sortable.listeners } : longPress)}
      onClick={editMode ? props.onTap : undefined}
      onKeyDown={editMode ? (e) => (e.key === "Enter" || e.key === " ") && props.onTap() : undefined}
    >
      <AgentAvatar
        name={entry.name}
        role={entry.role}
        ring={entry.ring}
        status={entry.status}
        hand={editMode ? undefined : entry.hand}
        onCall={editMode ? undefined : props.onCallWhenHand}
        group={entry.kind === "squad" && (entry.members?.length ?? 0) >= 2}
      />
    </div>
  );
}

/** Expanded squad panel: members are draggable chips; dragging one out removes it. */
function SquadPanel(props: { squad: AgentSeed }) {
  const drop = useDroppable({ id: `panel-${props.squad.id}` });
  return (
    <section ref={drop.setNodeRef} className="squad-panel" aria-label={`${props.squad.name} members`}>
      <div className="squad-panel__title">{props.squad.name}</div>
      {(props.squad.members ?? []).map((name) => (
        <MemberChip key={name} squadId={props.squad.id} name={name} />
      ))}
      <div className="squad-panel__hint">drag a member out to remove</div>
    </section>
  );
}

function MemberChip({ squadId, name }: { squadId: string; name: string }) {
  const drag = useDraggable({ id: `member:${squadId}:${name}` });
  return (
    <div
      ref={drag.setNodeRef}
      {...drag.listeners}
      {...drag.attributes}
      className={`member-chip${drag.isDragging ? " member-chip--dragging" : ""}`}
      style={{ transform: CSS.Translate.toString(drag.transform) }}
    >
      <GripVertical size={11} strokeWidth={1.6} />
      {name}
    </div>
  );
}

export function AgentRoster({ agents, onAdd, onCall, onCompose, onInspect }: AgentRosterProps) {
  const [editMode, setEditMode] = useState(false);
  const [order, setOrder] = useState<string[]>(loadOrder);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [combineId, setCombineId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const entries = applyOrder(agents, order);
  const byId = (id: string | null) => entries.find((e) => e.id === id);
  const expanded = byId(expandedId);

  useEffect(() => {
    if (!editMode) setExpandedId(null);
  }, [editMode]);

  const saveOrder = (ids: string[]) => {
    setOrder(ids);
    localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
  };

  const handleDragMove = (e: DragMoveEvent) => {
    const activeRect = e.active.rect.current.translated;
    const overId = e.over?.id;
    if (String(e.active.id).startsWith("member:") || !activeRect || !overId || overId === e.active.id) {
      setCombineId(null);
      return;
    }
    const source = byId(String(e.active.id));
    const target = byId(String(overId));
    if (!source || !target || source.kind === "squad" || target.status === "busy") {
      setCombineId(null); // only solo agents combine, and never into a working unit
      return;
    }
    const overRect = e.over?.rect;
    if (!overRect) {
      setCombineId(null);
      return;
    }
    const dy = Math.abs(activeRect.top + activeRect.height / 2 - (overRect.top + overRect.height / 2));
    setCombineId(dy < overRect.height * COMBINE_RATIO ? String(overId) : null);
  };

  const handleDragEnd = (e: DragEndEvent) => {
    const active = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    const wasCombine = combineId;
    setCombineId(null);

    // A member chip dragged out of its squad panel -> remove from the squad.
    if (active.startsWith("member:")) {
      const [, squadId, name] = active.split(":");
      if (!overId?.startsWith("panel-") && squadId && name) onCompose?.({ op: "remove", target: squadId, agent: name });
      return;
    }

    const source = byId(active);
    if (!source) return;

    // Drop INTO: agent onto squad joins it; agent onto agent forms a new squad.
    if (wasCombine && overId && wasCombine === overId) {
      const target = byId(overId);
      if (target?.kind === "squad") onCompose?.({ op: "add", target: target.id, agent: source.id });
      else if (target) onCompose?.({ op: "form", agents: [target.id, source.id] });
      return;
    }

    // Otherwise: reorder.
    if (overId && overId !== active && !overId.startsWith("panel-")) {
      const ids = entries.map((x) => x.id);
      const from = ids.indexOf(active);
      const to = ids.indexOf(overId);
      if (from >= 0 && to >= 0) saveOrder(arrayMove(ids, from, to));
    }
  };

  return (
    <aside className="rail rail--right" aria-label="Agents">
      <div className="rail__label">
        {editMode ? (
          <button
            type="button"
            className="done"
            onClick={() => setEditMode(false)}
            title="Done editing"
            aria-label="Done editing"
          >
            <Check size={12} strokeWidth={2.5} /> done
          </button>
        ) : (
          "agents"
        )}
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setCombineId(null)}
      >
        <SortableContext items={entries.map((e) => e.id)} strategy={verticalListSortingStrategy}>
          <div className={`roster${editMode ? " roster--editing" : ""}`}>
            {entries.map((entry) => (
              <RosterItem
                key={entry.id}
                entry={entry}
                editMode={editMode}
                combineTarget={combineId === entry.id}
                expanded={expandedId === entry.id}
                onLongPress={() => setEditMode(true)}
                onTap={() => {
                  if (entry.kind === "squad") setExpandedId((cur) => (cur === entry.id ? null : entry.id));
                }}
                onCallWhenHand={
                  entry.status === "busy" && onInspect
                    ? () => onInspect(entry)
                    : entry.hand && onCall
                      ? () => onCall(entry.name)
                      : undefined
                }
              />
            ))}
          </div>
        </SortableContext>
        {editMode && expanded?.kind === "squad" && <SquadPanel squad={expanded} />}
        <DragOverlay>{null}</DragOverlay>
      </DndContext>
      {!editMode && (
        <button type="button" className="add" onClick={onAdd} title="Configure a new agent" aria-label="Add agent">
          +
        </button>
      )}
      <div className="spacer" />
    </aside>
  );
}
