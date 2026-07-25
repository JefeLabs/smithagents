import { ChevronDown, Plus } from "lucide-react";

export function Composer() {
  return (
    <form className="composer" onSubmit={(e) => e.preventDefault()}>
      <button type="button" className="plus" title="Attach screenshot or file" aria-label="Attach">
        <Plus strokeWidth={1.7} />
      </button>
      <input type="text" placeholder="Type a request…" aria-label="Type a request" />
      {/* biome-ignore lint/a11y/useSemanticElements: artifact-faithful markup — .selector styles a div; becomes a real menu trigger when routing is wired */}
      <div className="selector" role="button" tabIndex={0} title="Route to a specific agent, or let the swarm decide">
        Swarm
        <ChevronDown strokeWidth={2} />
      </div>
    </form>
  );
}
