import { Avatar } from "../atoms/Avatar";

interface AgentAvatarProps {
  name: string;
  role: string;
  ring: string;
}

export function AgentAvatar({ name, role, ring }: AgentAvatarProps) {
  return (
    <Avatar initial={name[0]?.toUpperCase() ?? "?"} ring={ring} label={`${name}, ${role}`}>
      <span className="status" />
      <span className="tip">
        <b>{name}</b>
        <span>{role}</span>
      </span>
    </Avatar>
  );
}
