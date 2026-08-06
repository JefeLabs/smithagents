import { ArrowUp, AudioLines, ChevronDown, Mic, Plus, Volume2, VolumeX } from "lucide-react";
import { useRef, useState } from "react";

interface ComposerProps {
  onSend: (text: string) => void;
  disabled?: boolean;
  /** Always-listening state; the toggle renders only when onMicToggle is wired. */
  micLive?: boolean;
  onMicToggle?: () => void;
  /** TTS output state; the toggle renders only when onSoundToggle is wired. */
  soundOn?: boolean;
  onSoundToggle?: () => void;
}

export function Composer({
  onSend,
  disabled = false,
  micLive = false,
  onMicToggle,
  soundOn = false,
  onSoundToggle,
}: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [holding, setHolding] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const startHold = () => {
    if (micLive || holding || !onMicToggle) return;
    setHolding(true);
    onMicToggle();
  };
  const endHold = () => {
    if (!holding || !onMicToggle) return;
    setHolding(false);
    onMicToggle();
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || disabled) return;
    onSend(text);
    setDraft("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  return (
    <form
      className="composer composer--stacked"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={textareaRef}
        rows={1}
        placeholder={disabled ? "Broker offline — start the broker to chat…" : "Type a request…"}
        aria-label="Type a request"
        value={draft}
        disabled={disabled}
        onChange={(e) => {
          setDraft(e.target.value);
          // Auto-grow up to the CSS max-height (132px ≈ 6 lines), then scroll internally.
          e.target.style.height = "auto";
          e.target.style.height = `${Math.min(e.target.scrollHeight, 132)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer__row">
        <button type="button" className="plus" title="Add context — links, files, screenshots" aria-label="Add context">
          <Plus strokeWidth={1.7} />
        </button>
        <div className="composer__actions">
          {/* biome-ignore lint/a11y/useSemanticElements: artifact-faithful markup — .selector styles a div; becomes a real menu trigger when routing is wired */}
          <div
            className="selector"
            role="button"
            tabIndex={0}
            title="Route to a specific agent, or let the swarm decide"
          >
            Swarm
            <ChevronDown strokeWidth={2} />
          </div>
          {onMicToggle && (
            <>
              <button
                type="button"
                className={holding ? "voice-toggle live" : "voice-toggle"}
                title="Hold to talk"
                aria-label="Hold to talk"
                aria-pressed={holding}
                onPointerDown={startHold}
                onPointerUp={endHold}
                onPointerLeave={endHold}
                onPointerCancel={endHold}
                onKeyDown={(e) => {
                  if ((e.key === " " || e.key === "Enter") && !e.repeat) {
                    e.preventDefault();
                    startHold();
                  }
                }}
                onKeyUp={(e) => {
                  if (e.key === " " || e.key === "Enter") endHold();
                }}
              >
                <Mic strokeWidth={1.7} />
              </button>
              <button
                type="button"
                className={micLive ? "voice-toggle live" : "voice-toggle"}
                title="Always listening"
                aria-label="Always listening"
                aria-pressed={micLive}
                onClick={onMicToggle}
              >
                <AudioLines strokeWidth={1.7} />
              </button>
            </>
          )}
          {onSoundToggle && (
            <button
              type="button"
              className={soundOn ? "sound-toggle" : "sound-toggle off"}
              title={soundOn ? "Mute agent voices" : "Unmute agent voices"}
              aria-label={soundOn ? "Mute agent voices" : "Unmute agent voices"}
              aria-pressed={soundOn}
              onClick={onSoundToggle}
            >
              {soundOn ? <Volume2 strokeWidth={1.7} /> : <VolumeX strokeWidth={1.7} />}
            </button>
          )}
          <button type="submit" className="send" title="Send" aria-label="Send" disabled={disabled || !draft.trim()}>
            <ArrowUp strokeWidth={2} />
          </button>
        </div>
      </div>
    </form>
  );
}
