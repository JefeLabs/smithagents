import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import type { ChatMessage } from "../api/types";

interface TranscriptProps {
  messages: ChatMessage[];
}

/** Rolling meeting transcript — user utterances right, broker speech left. */
export function Transcript({ messages }: TranscriptProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (messages.length > 0) endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages.length]);

  if (messages.length === 0) return null;

  return (
    <div className="transcript" role="log" aria-label="Conversation transcript">
      {messages.map((m) => {
        if (m.role === "notice") {
          return (
            <p key={m.id} className="transcript__notice" role="status">
              {m.text}
            </p>
          );
        }
        // Broker speech is speaker-prefixed ("Manuel: On it.") — render the name as a label.
        const spoken = m.role === "broker" ? /^([A-Z][\w-]{1,24}):\s+(.*)$/s.exec(m.text) : null;
        return (
          <motion.div
            key={m.id}
            className={`msg ${m.role}`}
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
          >
            {spoken ? (
              <>
                <b className="speaker">{spoken[1]}</b> {spoken[2]}
              </>
            ) : (
              m.text
            )}
          </motion.div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
