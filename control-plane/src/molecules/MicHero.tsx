import { AudioLines } from "lucide-react";

interface MicHeroProps {
  live: boolean;
  onToggle: () => void;
  /** STT capability gate (spec §3) — false dims the button and reroutes the click to onVoiceBlocked. */
  sttEnabled?: boolean;
  onVoiceBlocked?: () => void;
}

export function MicHero({ live, onToggle, sttEnabled = true, onVoiceBlocked }: MicHeroProps) {
  return (
    <div className="voice">
      <button
        type="button"
        className={(live ? "mic-hero live" : "mic-hero") + (sttEnabled ? "" : " is-voice-disabled")}
        title="Activate always listening"
        aria-label="Activate always listening"
        aria-pressed={live}
        onClick={sttEnabled ? onToggle : () => onVoiceBlocked?.()}
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
