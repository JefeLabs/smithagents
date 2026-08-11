import { Header, ListBox, Select, Separator } from "@heroui/react";
import { PromptInput } from "@heroui-pro/react";
import { ArrowUp, AudioLines, Mic, Plus, Sparkles, Volume2, VolumeX } from "lucide-react";
import { useRef, useState } from "react";
import type { RosterAgent, Target } from "../api/types";
import { ARTIFACT_KINDS, type ArtifactKind } from "../lib/artifactKinds";

interface ComposerProps {
  /**
   * Send. A directed send resolves to the broker's refusal text (or null) —
   * a busy agent has to be able to say so; an untargeted one returns nothing.
   */
  onSend: (text: string, target?: Target) => void | Promise<string | null>;
  /** The rail's entries, in rail order. Omit and no target selector renders. */
  targets?: RosterAgent[];
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
  /**
   * The artifact-kind row (reveal-on-engage). Clicking a kind navigates
   * immediately — it does not arm a send. Omit and no kind row renders.
   */
  onPickKind?: (kind: ArtifactKind) => void;
  /** The current surface's kind, highlighted in the row. */
  activeKind?: ArtifactKind;
}

/** HeroUI's Select speaks string Keys; the wire speaks Target objects. Encode here, decode on the way out. */
export function targetKey(t: Target): string {
  return t.kind === "host" || t.kind === "crew" ? t.kind : `${t.kind}:${t.id}`;
}

export function parseTargetKey(key: string): Target {
  if (key === "host" || key === "crew") return { kind: key };
  const [kind, ...rest] = key.split(":");
  const id = rest.join(":");
  if ((kind === "squad" || kind === "group" || kind === "agent") && id) return { kind, id };
  return { kind: "host" };
}

/**
 * A rail entry's id carries its own prefix; the wire wants the bare id.
 *
 * `freed-` matters as much as the other two: a squad member dragged out to
 * stand alone rides the roster as `freed-osvaldo` while the registry — and so
 * the broker's target resolution — only knows `osvaldo`. compose() strips the
 * same prefix for the same reason (broker.ts).
 */
function targetOf(entry: RosterAgent): Target {
  if (entry.id.startsWith("squad-")) return { kind: "squad", id: entry.id.slice("squad-".length) };
  if (entry.id.startsWith("group-")) return { kind: "group", id: entry.id.slice("group-".length) };
  if (entry.id.startsWith("freed-")) return { kind: "agent", id: entry.id.slice("freed-".length) };
  return { kind: "agent", id: entry.id };
}

export function Composer({
  onSend,
  targets,
  disabled = false,
  micLive = false,
  onMicToggle,
  soundOn = false,
  onSoundToggle,
  sttEnabled = true,
  onVoiceBlocked,
  onPolish,
  onPickKind,
  activeKind = "chat",
}: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [holding, setHolding] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const [polishError, setPolishError] = useState<string | null>(null);
  // Directing is a per-message act, so this resets to the chief of staff after
  // every send — you can never leak a message to a CLI by forgetting a mode.
  const [target, setTarget] = useState<Target>({ kind: "host" });
  const [refusal, setRefusal] = useState<string | null>(null);
  // The kind row reveals while the user is engaged with the box, and collapses
  // when idle — focus OR a non-empty draft counts as engaged.
  const [focused, setFocused] = useState(false);
  const engaged = focused || draft.trim() !== "";
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
    // Host sends call onSend(text) with ONE argument, exactly as before this
    // feature — every existing caller and test depends on that call shape.
    const outcome = target.kind === "host" ? onSend(text) : onSend(text, target);
    if (outcome && typeof (outcome as Promise<string | null>).then === "function") {
      void (outcome as Promise<string | null>).then((error) => {
        if (error) {
          // Refused (busy agent, unknown target): KEEP the draft — nothing was sent.
          setRefusal(error);
          return;
        }
        setRefusal(null);
        setDraft("");
        setTarget({ kind: "host" });
      });
      return;
    }
    setRefusal(null);
    setDraft("");
    setTarget({ kind: "host" });
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
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={disabled ? "Broker offline — start the broker to chat…" : "Type a request…"}
            onChange={(e) => {
              setDraft(e.target.value);
              setPolishError(null);
              // Auto-grow up to the CSS max-height (132px ≈ 6 lines), then scroll internally.
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 132)}px`;
            }}
          />
        </PromptInput.Content>
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
            {refusal && (
              // Nothing was dispatched and the draft is still in the box — this
              // says why, in the broker's own words ("Osvaldo is busy with: …").
              <span className="composer__target-error" role="status">
                {refusal}
              </span>
            )}
            {onPickKind && engaged && (
              // biome-ignore lint/a11y/useSemanticElements: a toolbar-embedded nav row, not a form fieldset
              <div className="composer__kind-group" role="group" aria-label="artifact kind">
                {ARTIFACT_KINDS.map((k) => (
                  <button
                    key={k.kind}
                    type="button"
                    className={`composer__kind${activeKind === k.kind ? " composer__kind--on" : ""}`}
                    aria-pressed={activeKind === k.kind}
                    // A nav trigger fired on mousedown so it beats the textarea's
                    // blur (which would collapse the row before the click lands).
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onPickKind(k.kind);
                    }}
                  >
                    {k.label}
                  </button>
                ))}
              </div>
            )}
          </PromptInput.ToolbarStart>
          <PromptInput.ToolbarEnd className="composer__actions">
            {targets && targets.length > 0 && (
              <Select
                className="selector"
                aria-label="Send to"
                value={targetKey(target)}
                onChange={(key) => {
                  setRefusal(null);
                  setTarget(parseTargetKey(String(key)));
                }}
              >
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item id="host" textValue="Anderson">
                      Anderson
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                    <ListBox.Item id="crew" textValue="Entire Crew">
                      Entire Crew
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                    <Separator />
                    <ListBox.Section>
                      <Header>Squads &amp; groups</Header>
                      {targets
                        .filter((t) => t.kind === "squad")
                        .map((t) => (
                          <ListBox.Item key={t.id} id={targetKey(targetOf(t))} textValue={t.name}>
                            {t.name}
                            {/* The role already reads "Squad — led by X", so it names
                                the actual recipient without a second lookup. */}
                            <span className="selector__who">{t.role}</span>
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                        ))}
                    </ListBox.Section>
                    <Separator />
                    <ListBox.Section>
                      <Header>Agents</Header>
                      {targets
                        .filter((t) => t.kind === "agent")
                        .map((t) => (
                          <ListBox.Item key={t.id} id={targetKey(targetOf(t))} textValue={t.name}>
                            {t.name}
                            <span className="selector__who">{t.role}</span>
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                        ))}
                    </ListBox.Section>
                  </ListBox>
                </Select.Popover>
              </Select>
            )}
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
