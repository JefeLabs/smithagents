import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ChatMessage } from "../api/types";
import { Composer } from "../molecules/Composer";
import { MicHero } from "../molecules/MicHero";
import { Transcript } from "../molecules/Transcript";

interface VoiceStageProps {
  micLive: boolean;
  onMicToggle: () => void;
  messages: ChatMessage[];
  brokerConnected: boolean;
  onSend: (text: string) => void;
  soundOn: boolean;
  onSoundToggle: () => void;
  /** STT capability gate (spec §3) — false dims the mic controls and reroutes presses to onVoiceBlocked. */
  sttEnabled?: boolean;
  onVoiceBlocked?: () => void;
  /** Hide-inactive (spec §3): false hides the mic hero and drops the composer's mic buttons entirely. */
  showMicHero?: boolean;
  /** Transient hint (e.g. the blocked-press notice) shown above the composer. */
  voiceNotice?: string | null;
  /** Rewrites the draft in place; the composer's polish action renders only when this is wired. */
  onPolish?: (text: string) => Promise<string | null>;
}

export function VoiceStage({
  micLive,
  onMicToggle,
  messages,
  brokerConnected,
  onSend,
  soundOn,
  onSoundToggle,
  sttEnabled = true,
  onVoiceBlocked,
  showMicHero = true,
  voiceNotice = null,
  onPolish,
}: VoiceStageProps) {
  const chatActive = messages.length > 0;
  const reduceMotion = useReducedMotion();
  const spring = reduceMotion ? { duration: 0 } : { type: "spring" as const, duration: 0.5, bounce: 0 };

  return (
    <section className={chatActive ? "stage chat-active" : "stage"} aria-label="Voice">
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
              <MicHero live={micLive} onToggle={onMicToggle} sttEnabled={sttEnabled} onVoiceBlocked={onVoiceBlocked} />
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
        <Composer
          onSend={onSend}
          disabled={!brokerConnected}
          micLive={micLive}
          onMicToggle={showMicHero ? onMicToggle : undefined}
          soundOn={soundOn}
          onSoundToggle={onSoundToggle}
          sttEnabled={sttEnabled}
          onVoiceBlocked={onVoiceBlocked}
          onPolish={onPolish}
        />
      </motion.div>
    </section>
  );
}
