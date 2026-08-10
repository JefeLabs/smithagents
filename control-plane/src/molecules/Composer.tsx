import { PromptInput } from "@heroui-pro/react";
import { ArrowUp, AudioLines, ChevronDown, Mic, Plus, Sparkles, Volume2, VolumeX } from "lucide-react";
import { useRef, useState } from "react";
import type { BlueprintT } from "../api/types";

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
  /** Rewrites the draft in place; the polish action renders only when this is wired. */
  onPolish?: (text: string) => Promise<string | null>;
  /** Which surface this composer sits on — the group shows it as the active kind. */
  kind?: "chat" | "document";
  /** Document surface only: pressing "chat" leaves for the conversation. */
  onKindChat?: () => void;
  /**
   * Chat surface: arming "document" is free and reversible — THIS is what a send
   * commits to, creating the document from the very text you typed.
   */
  onSendDocument?: (blueprintId: string, text: string) => Promise<{ error?: string } | undefined>;
  /** The blueprint chips shown while armed; the first is preselected. */
  blueprints?: BlueprintT[];
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
  onPolish,
  kind = "chat",
  onKindChat,
  onSendDocument,
  blueprints,
}: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [holding, setHolding] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const [polishError, setPolishError] = useState<string | null>(null);
  // Arming is local and free: nothing is created until a send commits it.
  const [armed, setArmed] = useState(false);
  const [pickedBlueprint, setPickedBlueprint] = useState<string>();
  const blueprintId = pickedBlueprint ?? blueprints?.[0]?.id;
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
    if (armed && onSendDocument && blueprintId) {
      void onSendDocument(blueprintId, text).then((r) => {
        if (r?.error) {
          setPolishError(r.error); // same status line the polish failure uses
          return;
        }
        setDraft("");
        setArmed(false);
        setPolishError(null);
      });
      return;
    }
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
            aria-label={armed ? "describe the document you want" : "Type a request"}
            placeholder={
              disabled
                ? "Broker offline — start the broker to chat…"
                : armed
                  ? "describe the document you want…"
                  : "Type a request…"
            }
            onChange={(e) => {
              setDraft(e.target.value);
              setPolishError(null);
              // Auto-grow up to the CSS max-height (132px ≈ 6 lines), then scroll internally.
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 132)}px`;
            }}
          />
        </PromptInput.Content>
        {armed && blueprints && blueprints.length > 0 && (
          // biome-ignore lint/a11y/useSemanticElements: a fieldset cannot live inside PromptInput's shell (no form, and its default chrome breaks the dock); role="group" is the ARIA equivalent for a toggle-button set
          <div className="composer__chips" role="group" aria-label="document blueprint">
            {blueprints.map((b) => (
              <button
                key={b.id}
                type="button"
                aria-pressed={b.id === blueprintId}
                className={`composer__bp-chip${b.id === blueprintId ? " composer__bp-chip--on" : ""}`}
                onClick={() => setPickedBlueprint(b.id)}
              >
                {b.name}
              </button>
            ))}
          </div>
        )}
        <PromptInput.Toolbar className="composer__row">
          <PromptInput.ToolbarStart>
            <button
              type="button"
              className="plus"
              title="Add context — links, files, screenshots"
              aria-label="Add context"
            >
              <Plus strokeWidth={1.7} />
            </button>
            {onPolish && (
              <PromptInput.Action
                className="polish-toggle"
                aria-label="Polish my input"
                aria-disabled={draft.trim() === "" || polishing || disabled}
                onPress={() => {
                  const text = draft.trim();
                  if (!text || polishing || disabled) return;
                  setPolishing(true);
                  setPolishError(null);
                  void onPolish(text).then((polished) => {
                    setPolishing(false);
                    if (polished) {
                      setDraft(polished);
                      textareaRef.current?.focus();
                    } else {
                      setPolishError("polish failed — draft unchanged");
                    }
                  });
                }}
              >
                <Sparkles strokeWidth={1.7} />
              </PromptInput.Action>
            )}
            {polishError && (
              <span className="composer__polish-error" role="status">
                {polishError}
              </span>
            )}
            {(onSendDocument || kind === "document") && (
              // biome-ignore lint/a11y/useSemanticElements: same as the chips row — a toolbar-embedded toggle pair, not a form fieldset
              <div className="composer__kind-group" role="group" aria-label="composer mode">
                <button
                  type="button"
                  className={`composer__kind${kind === "chat" && !armed ? " composer__kind--on" : ""}`}
                  aria-pressed={kind === "chat" && !armed}
                  onClick={() => (kind === "document" ? onKindChat?.() : setArmed(false))}
                >
                  chat
                </button>
                <button
                  type="button"
                  className={`composer__kind${kind === "document" || armed ? " composer__kind--on" : ""}`}
                  aria-pressed={kind === "document" || armed}
                  onClick={() => {
                    if (kind !== "document") setArmed(true);
                  }}
                >
                  document
                </button>
              </div>
            )}
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
                onPointerCancel={endHold}
                onBlur={endHold}
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
                <AudioLines strokeWidth={1.7} />
              </PromptInput.Action>
            )}
            {onSoundToggle && (
              <PromptInput.Action
                className={soundOn ? "sound-toggle" : "sound-toggle off"}
                aria-label={soundOn ? "Mute agent voices" : "Unmute agent voices"}
                aria-pressed={soundOn}
                onPress={onSoundToggle}
              >
                {soundOn ? <Volume2 strokeWidth={1.7} /> : <VolumeX strokeWidth={1.7} />}
              </PromptInput.Action>
            )}
            <PromptInput.Send className="send" aria-label="Send" isDisabled={disabled || draft.trim() === ""}>
              <ArrowUp strokeWidth={2} />
            </PromptInput.Send>
          </PromptInput.ToolbarEnd>
        </PromptInput.Toolbar>
      </PromptInput.Shell>
    </PromptInput>
  );
}
