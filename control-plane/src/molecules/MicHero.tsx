import { AudioLines } from "lucide-react";

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
        title="Activate always listening"
        aria-label="Activate always listening"
        aria-pressed={live}
        onClick={onToggle}
      >
        <AudioLines strokeWidth={1.7} />
      </button>
      <div className="mic-caption">
        {live ? (
          <>
            <b style={{ color: "var(--accent)" }}>Listening…</b> tap to stop
          </>
        ) : (
          <b>Activate always listening</b>
        )}
      </div>
    </div>
  );
}
