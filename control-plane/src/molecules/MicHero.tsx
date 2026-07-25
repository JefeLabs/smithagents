import { Mic } from "lucide-react";

interface MicHeroProps {
  live: boolean;
  onToggle: () => void;
}

export function MicHero({ live, onToggle }: MicHeroProps) {
  return (
    <div className="voice">
      <button
        type="button"
        className={live ? "mic-hero live" : "mic-hero"}
        title="Push to talk"
        aria-label="Push to talk"
        aria-pressed={live}
        onClick={onToggle}
      >
        <Mic strokeWidth={1.7} />
      </button>
      <div className="mic-caption">
        {live ? (
          <>
            <b style={{ color: "var(--accent)" }}>Listening…</b> tap to stop
          </>
        ) : (
          <>
            <b>Push to talk</b> — or type below
          </>
        )}
      </div>
    </div>
  );
}
