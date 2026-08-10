import { PromptInput } from "@heroui-pro/react";
import { ArrowUp, AudioLines, ChevronDown, Mic, Plus, Volume2, VolumeX } from "lucide-react";
import { useRef, useState } from "react";

// Pro's Button CSS clamps child svgs to 16px and gives them their own -mx-0.5/my-1
// margin (for its own icon+label layout); the original toolbar icons were lucide's
// unstyled 24px default with no margin, centered purely by the button's
// `display: grid; place-items: center`. Inline style (highest specificity) restores
// both — leaving the margin in place makes the icon's margin box taller than the
// 30px button and throws grid's centering off by a rounded pixel.
const ICON_SIZE = { width: 24, height: 24, margin: 0 };

interface ComposerProps {
  onSend: (text: string) => void;
  disabled?: boolean;
  /** Always-listening state; the toggle renders only when onMicToggle is wired. */
  micLive?: boolean;
  onMicToggle?: () => void;
  /** TTS output state; the toggle renders only when onSoundToggle is wired. */
  soundOn?: boolean;
  onSoundToggle?: () => void;
  /** STT capability gate (spec §3) — false dims the mic buttons and reroutes presses to onVoiceBlocked. */
  sttEnabled?: boolean;
  onVoiceBlocked?: () => void;
}

export function Composer({
  onSend,
  disabled = false,
  micLive = false,
  onMicToggle,
  soundOn = false,
  onSoundToggle,
  sttEnabled = true,
  onVoiceBlocked,
}: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [holding, setHolding] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const startHold = () => {
    if (!sttEnabled) {
      onVoiceBlocked?.();
      return;
    }
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
    <PromptInput value={draft} onValueChange={setDraft} onSubmit={submit} isDisabled={disabled} layout="stacked">
      <PromptInput.Shell className="composer composer--stacked">
        <PromptInput.Content>
          <PromptInput.TextArea
            ref={textareaRef}
            disableAutosize
            rows={1}
            aria-label="Type a request"
            placeholder={disabled ? "Broker offline — start the broker to chat…" : "Type a request…"}
            // Pro's own textarea reserves space for its absolutely-positioned toolbar
            // (min-height + margin-bottom) and carries its own padding; the shell (via
            // .composer--stacked) already supplies the padding the original design used,
            // and the toolbar below is pinned back into normal flow, so both have to go.
            style={{ minHeight: 0, marginBottom: 0, padding: 0 }}
            onChange={(e) => {
              setDraft(e.target.value);
              // Auto-grow up to the CSS max-height (132px ≈ 6 lines), then scroll internally.
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 132)}px`;
            }}
          />
        </PromptInput.Content>
        {/* Pro pins the toolbar absolute to the shell's bottom edge; the original
            markup had it in normal flow below the textarea, so put it back. */}
        <PromptInput.Toolbar className="composer__row" style={{ position: "static" }}>
          <PromptInput.ToolbarStart>
            <button
              type="button"
              className="plus"
              title="Add context — links, files, screenshots"
              aria-label="Add context"
            >
              <Plus strokeWidth={1.7} />
            </button>
          </PromptInput.ToolbarStart>
          <PromptInput.ToolbarEnd className="composer__actions">
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
              <PromptInput.Action
                className={holding ? "voice-toggle live" : "voice-toggle"}
                aria-label="Hold to talk"
                aria-pressed={holding}
                aria-disabled={!sttEnabled}
                onPointerDown={startHold}
                onPointerUp={endHold}
                onPointerLeave={endHold}
                onBlur={endHold}
              >
                <Mic strokeWidth={1.7} style={ICON_SIZE} />
              </PromptInput.Action>
            )}
            {onMicToggle && (
              <PromptInput.Action
                className={micLive ? "voice-toggle live" : "voice-toggle"}
                aria-label="Always listening"
                aria-pressed={micLive}
                aria-disabled={!sttEnabled}
                isDisabled={holding}
                onPress={() => (sttEnabled ? onMicToggle() : onVoiceBlocked?.())}
              >
                <AudioLines strokeWidth={1.7} style={ICON_SIZE} />
              </PromptInput.Action>
            )}
            {onSoundToggle && (
              <PromptInput.Action
                className={soundOn ? "sound-toggle" : "sound-toggle off"}
                aria-label={soundOn ? "Mute agent voices" : "Unmute agent voices"}
                aria-pressed={soundOn}
                onPress={onSoundToggle}
              >
                {soundOn ? (
                  <Volume2 strokeWidth={1.7} style={ICON_SIZE} />
                ) : (
                  <VolumeX strokeWidth={1.7} style={ICON_SIZE} />
                )}
              </PromptInput.Action>
            )}
            <PromptInput.Send className="send" aria-label="Send" isDisabled={disabled || draft.trim() === ""}>
              <ArrowUp strokeWidth={2} style={ICON_SIZE} />
            </PromptInput.Send>
          </PromptInput.ToolbarEnd>
        </PromptInput.Toolbar>
      </PromptInput.Shell>
    </PromptInput>
  );
}
