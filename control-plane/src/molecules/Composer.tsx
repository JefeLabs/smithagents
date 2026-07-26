import { ChevronDown, Plus } from "lucide-react";
import { useState } from "react";

interface ComposerProps {
  onSend: (text: string) => void;
  disabled?: boolean;
}

export function Composer({ onSend, disabled = false }: ComposerProps) {
  const [draft, setDraft] = useState("");

  const submit = () => {
    const text = draft.trim();
    if (!text || disabled) return;
    onSend(text);
    setDraft("");
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <button type="button" className="plus" title="Attach screenshot or file" aria-label="Attach">
        <Plus strokeWidth={1.7} />
      </button>
      <input
        type="text"
        placeholder={disabled ? "Broker offline — start the broker to chat…" : "Type a request…"}
        aria-label="Type a request"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={disabled}
      />
      {/* biome-ignore lint/a11y/useSemanticElements: artifact-faithful markup — .selector styles a div; becomes a real menu trigger when routing is wired */}
      <div className="selector" role="button" tabIndex={0} title="Route to a specific agent, or let the swarm decide">
        Swarm
        <ChevronDown strokeWidth={2} />
      </div>
    </form>
  );
}
