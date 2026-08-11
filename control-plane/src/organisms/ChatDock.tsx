import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import type { ChatMessage, RosterAgent, Target } from "../api/types";
import type { ArtifactKind } from "../lib/artifactKinds";
import type { ComposerVariant } from "../lib/composerLayout";
import { Composer } from "../molecules/Composer";
import { MicHero } from "../molecules/MicHero";
import { Transcript } from "../molecules/Transcript";

export interface ChatDockProps {
  /** How the dock is positioned; `hidden` never mounts (the shell renders nothing). */
  variant: Exclude<ComposerVariant, "hidden">;
  messages: ChatMessage[];
  // biome-ignore lint/suspicious/noConfusingVoidType: void (not undefined) keeps sync block-bodied handlers assignable
  onSend: (text: string, target?: Target) => void | Promise<string | null>;
  /** Rail entries the composer may direct a message to. */
  targets?: RosterAgent[];
  brokerConnected: boolean;
  micLive: boolean;
  onMicToggle: () => void;
  soundOn: boolean;
  onSoundToggle: () => void;
  sttEnabled?: boolean;
  onVoiceBlocked?: () => void;
  /** The `/` empty-hero MicHero; false hides it AND drops the composer's mic buttons. */
  showMicHero?: boolean;
  voiceNotice?: string | null;
  onPolish?: (text: string) => Promise<string | null>;
  onPickKind?: (kind: ArtifactKind) => void;
  activeKind?: ArtifactKind;
  /** The active session's artifact shelf — only rendered in the `full` variant. */
  shelf?: ReactNode;
}

/**
 * The one persistent chat box — transcript + composer as a single unit — mounted
 * once in the shell (HomePage) and repositioned by route. `full` reproduces the
 * old VoiceStage (hero when the conversation is empty, transcript when it isn't,
 * composer at the bottom, kind buttons, artifact shelf); `dock`/`center` drop the
 * hero and shelf and stack a scrolling transcript over the composer, with the
 * kind row collapsed to a `<select>` in the narrow right dock.
 */
export function ChatDock({
  variant,
  messages,
  onSend,
  targets,
  brokerConnected,
  micLive,
  onMicToggle,
  soundOn,
  onSoundToggle,
  sttEnabled = true,
  onVoiceBlocked,
  showMicHero = true,
  voiceNotice = null,
  onPolish,
  onPickKind,
  activeKind,
  shelf,
}: ChatDockProps) {
  const reduceMotion = useReducedMotion();
  const spring = reduceMotion ? { duration: 0 } : { type: "spring" as const, duration: 0.5, bounce: 0 };
  const chatActive = messages.length > 0;

  const composer = (
    <Composer
      onSend={onSend}
      targets={targets}
      disabled={!brokerConnected}
      micLive={micLive}
      onMicToggle={showMicHero ? onMicToggle : undefined}
      soundOn={soundOn}
      onSoundToggle={onSoundToggle}
      sttEnabled={sttEnabled}
      onVoiceBlocked={onVoiceBlocked}
      onPolish={onPolish}
      onPickKind={onPickKind}
      activeKind={activeKind}
      kindControl={variant === "dock" ? "select" : "buttons"}
    />
  );

  // `full` keeps the voice-stage class so it inherits that layout verbatim — the
  // point of retiring VoiceStage is to move its markup, not change how / looks.
  if (variant === "full") {
    return (
      <section className={`stage chat-dock chat-dock--full${chatActive ? " chat-active" : ""}`} aria-label="Chat">
        {shelf}
        <AnimatePresence mode="popLayout" initial={false}>
          {!chatActive && (
            <motion.div
              key="hero"
              className="hero-intro"
              initial={{ opacity: 0, scale: 0.92, y: 24 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.92, y: -24 }}
              transition={spring}
            >
              <h1 className="greeting">
                The mic is yours, <em>Edwin</em>
              </h1>
              {showMicHero && (
                <MicHero
                  live={micLive}
                  onToggle={onMicToggle}
                  sttEnabled={sttEnabled}
                  onVoiceBlocked={onVoiceBlocked}
                />
              )}
            </motion.div>
          )}
          {chatActive && (
            <motion.div
              key="log"
              className="chat-log"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={spring}
            >
              <Transcript messages={messages} />
            </motion.div>
          )}
        </AnimatePresence>
        {voiceNotice && (
          <p className="transcript__notice" role="status">
            {voiceNotice}
          </p>
        )}
        <motion.div layout className="composer-dock" transition={spring}>
          {composer}
        </motion.div>
      </section>
    );
  }

  // dock + center: a scrolling transcript over the composer, no hero, no shelf.
  return (
    <section className={`chat-dock chat-dock--${variant}`} aria-label="Chat">
      <div className="chat-dock__log">
        <Transcript messages={messages} />
      </div>
      {voiceNotice && (
        <p className="transcript__notice" role="status">
          {voiceNotice}
        </p>
      )}
      <div className="composer-dock">{composer}</div>
    </section>
  );
}
