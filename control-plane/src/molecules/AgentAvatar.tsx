import { Hand, TriangleAlert, Users } from "lucide-react";
import { useRef, useState } from "react";
import { BROKER_BASE, httpUrl } from "../api/origin";
import { Avatar } from "../atoms/Avatar";
import { useLongPress } from "../hooks/useLongPress";
import { SurfacePolicyPopover } from "./SurfacePolicyPopover";

/** Hover-intent delay before the surface-policy popover opens — long enough to filter out a passing cursor. */
const HOVER_INTENT_MS = 500;
/**
 * The popover renders well outside the avatar's own box (see `.surface-popover`'s `right: 56px` in
 * components.css), so the cursor crosses dead space — not part of either element — to get from one to the
 * other. That gap fires a real `mouseleave` on whichever one the cursor just left. This grace window absorbs
 * it: a leave only actually closes the popover if the cursor hasn't landed back on the avatar or the popover
 * itself by the time it elapses.
 */
const LEAVE_GRACE_MS = 150;

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
  /** Solo agent id — when present, hover (intent delay) or long-press opens the surface-policy popover. */
  agentId?: string;
  /** Portrait filename from the roster frame. */
  avatar?: string;
  /** Engine-tool warning ("codex: not logged in…") — shows the badge + tooltip line. */
  engineWarning?: string;
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
  agentId,
  avatar,
  engineWarning,
}: AgentAvatarProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelOpenTimer = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
  };
  const cancelLeaveTimer = () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
  };
  /** Either region (avatar or popover) reporting the pointer back — cancel any pending close. */
  const handleEnter = () => {
    cancelLeaveTimer();
    if (!popoverOpen) {
      cancelOpenTimer();
      openTimer.current = setTimeout(() => setPopoverOpen(true), HOVER_INTENT_MS);
    }
  };
  /** Either region reporting the pointer gone — give it LEAVE_GRACE_MS to show back up before closing. */
  const handleLeave = () => {
    cancelOpenTimer();
    cancelLeaveTimer();
    leaveTimer.current = setTimeout(() => setPopoverOpen(false), LEAVE_GRACE_MS);
  };
  const closeNow = () => {
    cancelOpenTimer();
    cancelLeaveTimer();
    setPopoverOpen(false);
  };
  const longPress = useLongPress(() => setPopoverOpen(true));

  const label =
    engineWarning && !hand
      ? `${name}, ${role} — engine unavailable: ${engineWarning}`
      : hand
        ? `${name} has a hand raised: ${hand} — click to give them the floor`
        : listening
          ? `${name} is being addressed`
          : status === "busy"
            ? `${name} is working — click to watch and steer`
            : `${name}, ${role} — ${status}`;

  return (
    <span
      className="agent-avatar-anchor"
      {...(agentId ? { ...longPress, onMouseEnter: handleEnter, onMouseLeave: handleLeave } : {})}
    >
      <Avatar
        initial={name[0]?.toUpperCase() ?? "?"}
        ring={ring}
        label={label}
        onClick={onCall}
        state={status === "busy" ? "working" : listening ? "listening" : undefined}
        image={avatar ? httpUrl(`/avatars/${avatar}`, BROKER_BASE) : undefined}
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
        {engineWarning && !hand && (
          <span className="engine-warning" aria-hidden="true">
            <TriangleAlert strokeWidth={2.2} />
          </span>
        )}
        <span className="tip">
          <b>{name}</b>
          <span>
            {hand ? `✋ ${hand}` : listening ? "listening…" : status === "idle" ? role : `${role} — ${status}`}
          </span>
          {engineWarning && <span>⚠ {engineWarning}</span>}
        </span>
      </Avatar>
      {agentId && popoverOpen && (
        <SurfacePolicyPopover
          agentId={agentId}
          name={name}
          onClose={closeNow}
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
        />
      )}
    </span>
  );
}
