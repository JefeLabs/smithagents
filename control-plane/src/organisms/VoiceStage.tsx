import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ChatMessage } from "../hooks/useBrokerChat";
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
}

export function VoiceStage({
  micLive,
  onMicToggle,
  messages,
  brokerConnected,
  onSend,
  soundOn,
  onSoundToggle,
}: VoiceStageProps) {
  const chatActive = messages.length > 0;
  const reduceMotion = useReducedMotion();
  const spring = reduceMotion ? { duration: 0 } : { type: "spring" as const, duration: 0.5, bounce: 0 };

  return (
    <main className={chatActive ? "chat-active" : undefined}>
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
            <MicHero live={micLive} onToggle={onMicToggle} />
          </motion.div>
        )}
      </AnimatePresence>
      {chatActive && (
        <motion.div
          key="log"
          className="chat-log"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={spring}
        >
          <Transcript messages={messages} />
        </motion.div>
      )}
      <motion.div layout className="composer-dock" transition={spring}>
        <Composer
          onSend={onSend}
          disabled={!brokerConnected}
          micLive={micLive}
          onMicToggle={onMicToggle}
          soundOn={soundOn}
          onSoundToggle={onSoundToggle}
        />
      </motion.div>
    </main>
  );
}
