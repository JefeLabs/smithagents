import { AgentAvatar } from "./AgentAvatar";

export interface IdentityTileProps {
  name: string;
  role: string;
  ring?: string;
  listening?: boolean;
}

/** The broker's own host tile — rendered OUTSIDE the agent grid (host, not crew). */
export function IdentityTile({ name, role, ring, listening }: IdentityTileProps) {
  return (
    <div className="identity-tile">
      <AgentAvatar name={name} role={role} ring={ring ?? "#8a93a6"} listening={listening ?? false} />
    </div>
  );
}
