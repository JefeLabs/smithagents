import { BROKER_BASE, httpUrl } from "../api/origin";
import type { RosterAgent } from "../api/types";
import { Avatar } from "../atoms/Avatar";
import type { WorkCardT } from "../organisms/BoardStage";

const FLAG_LABEL = { blocked: "Blocked", "at-risk": "At risk", waiting: "Waiting" } as const;
const FLAG_GLYPH = { blocked: "⛔", "at-risk": "⚠", waiting: "⏸" } as const;

/** Whole days since `since`, floored — "how long has this been stuck now". */
export function flagAge(since: string, now: Date = new Date()): string {
  const days = Math.floor((now.getTime() - new Date(since).getTime()) / 86_400_000);
  return `${Math.max(0, days)}d`;
}

interface BoardCardProps {
  card: WorkCardT;
  /** Roster entry for the delegated agent, when the card is delegated. */
  agent?: RosterAgent;
  onOpen: () => void;
  /** Extra classes appended by the drag wrapper (e.g. "is-dragging"). */
  className?: string;
  /** Workspace identity colour; applied to the card fill in the aggregate view only. */
  tint?: string;
}

/** One kanban card face: title, flag, Jira chip, delegation badge. Pure display — drag wiring wraps it. */
export function BoardCard({ card, agent, onOpen, className, tint }: BoardCardProps) {
  const d = card.delegation;
  const total = card.stories?.length ?? 0;
  const done = card.stories?.filter((s) => s.done).length ?? 0;
  return (
    <button
      type="button"
      className={`board-card${card.flag ? ` has-flag is-${card.flag.kind}` : ""}${className ? ` ${className}` : ""}`}
      style={tint ? ({ "--card-tint": tint } as React.CSSProperties) : undefined}
      onClick={onOpen}
    >
      <span className="board-card__title">{card.title}</span>
      <span className="board-card__meta">
        {card.flag && (
          // biome-ignore lint/a11y/useSemanticElements: no semantic element fits a status chip inline in flow text; role="group" names it for AT and makes aria-label valid.
          <span
            className="board-card__flag"
            role="group"
            aria-label={`${FLAG_LABEL[card.flag.kind]} for ${flagAge(card.flag.since)}`}
            title={card.flag.reason}
          >
            {FLAG_GLYPH[card.flag.kind]} {flagAge(card.flag.since)}
          </span>
        )}
        {total > 0 && (
          <span className={`board-card__stories${done === total ? " is-complete" : ""}`} title="stories verified">
            {done}/{total}
          </span>
        )}
        {card.capabilityRef && (
          <span className="board-card__cap" title={`capability: ${card.capabilityRef.capabilityId}`}>
            ⧉ map
          </span>
        )}
        {card.jira && (
          <a
            className={`board-card__jira${card.jira.lastPushError ? " has-error" : ""}`}
            href={card.jira.url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={card.jira.lastPushError ? `Jira push failed: ${card.jira.lastPushError}` : card.jira.key}
          >
            {card.jira.key}
          </a>
        )}
        {d && (
          // biome-ignore lint/a11y/useSemanticElements: fieldset can't nest inside the enclosing button; span+role="group" names the badge for AT.
          <span
            className={`board-card__delegation is-${d.state}`}
            role="group"
            aria-label={`${agent?.name ?? d.agentId} ${d.state === "working" ? "is working on this card" : d.state === "completed" ? "finished this card's task" : "failed this card's task"}`}
          >
            <Avatar
              initial={(agent?.name ?? d.agentId)[0]?.toUpperCase() ?? "?"}
              label={agent?.name ?? d.agentId}
              ring={agent?.ring}
              image={agent?.avatar ? httpUrl(`/avatars/${agent.avatar}`, BROKER_BASE) : undefined}
              state={d.state === "working" ? "working" : undefined}
              interactive={false}
            />
            {d.prUrl && (
              <a
                className="board-card__pr"
                href={d.prUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                PR
              </a>
            )}
          </span>
        )}
      </span>
    </button>
  );
}
