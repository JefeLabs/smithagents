import { Hand, Users } from "lucide-react";
import { Avatar } from "../atoms/Avatar";

interface AgentAvatarProps {
  name: string;
  role: string;
  ring: string;
  status?: "idle" | "busy" | "in-meeting" | "offline";
  /** One-line reason when this agent has a hand raised; click calls on them. */
  hand?: string;
  onCall?: () => void;
  /** True for a squad/group circle of two or more agents — shows the group badge. */
  group?: boolean;
  /** True while the human is addressing them — drives the listening ring. */
  listening?: boolean;
}

export function AgentAvatar({
  name,
  role,
  ring,
  status = "idle",
  hand,
  onCall,
  group = false,
  listening = false,
}: AgentAvatarProps) {
  const label = hand
    ? `${name} has a hand raised: ${hand} — click to give them the floor`
    : listening
      ? `${name} is being addressed`
      : status === "busy"
        ? `${name} is working — click to watch and steer`
        : `${name}, ${role} — ${status}`;
  return (
    <Avatar
      initial={name[0]?.toUpperCase() ?? "?"}
      ring={ring}
      label={label}
      onClick={onCall}
      state={status === "busy" ? "working" : listening ? "listening" : undefined}
    >
      <span className={`status status--${status}`} />
      {group && (
        <span className="group-badge" aria-hidden="true">
          <Users strokeWidth={2.2} />
        </span>
      )}
      {hand && (
        <span className="hand" aria-hidden="true">
          <Hand strokeWidth={2.2} />
        </span>
      )}
      <span className="tip">
        <b>{name}</b>
        <span>{hand ? `✋ ${hand}` : listening ? "listening…" : status === "idle" ? role : `${role} — ${status}`}</span>
      </span>
    </Avatar>
  );
}
