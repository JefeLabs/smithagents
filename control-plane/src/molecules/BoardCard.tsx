import { Avatar } from "../atoms/Avatar";
import type { RosterAgent } from "../hooks/useBrokerChat";
import type { WorkCardT } from "../organisms/BoardStage";

const BASE = "127.0.0.1:7790";

interface BoardCardProps {
  card: WorkCardT;
  /** Roster entry for the delegated agent, when the card is delegated. */
  agent?: RosterAgent;
  onOpen: () => void;
}

/** One kanban card face: title, Jira chip, delegation badge. Pure display — drag wiring wraps it. */
export function BoardCard({ card, agent, onOpen }: BoardCardProps) {
  const d = card.delegation;
  return (
    <button type="button" className="board-card" onClick={onOpen}>
      <span className="board-card__title">{card.title}</span>
      <span className="board-card__meta">
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
              image={agent?.avatar ? `http://${BASE}/avatars/${agent.avatar}` : undefined}
              state={d.state === "working" ? "working" : undefined}
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
